/**
 * 吐泡泡 · 本地存储层（host 进程）
 *
 * 只使用 Electron/Node 内置的 `node:sqlite`（Node 24 自带 SQLite，无需原生编译），
 * 因此本插件没有任何第三方依赖，安装时不需要 prebuild / 构建脚本审批。
 *
 * 表结构与字段含义见 docs/SCHEMA.md。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const SCHEMA_VERSION = 1
/** 默认频道：任何账号首次进入时自动加入（Q3 决策：无密码、默认 #大厅）。 */
export const DEFAULT_CHANNEL = { id: 'lobby', name: '大厅' }

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  direction   TEXT NOT NULL,
  status      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_status  ON messages (status);

CREATE TABLE IF NOT EXISTS profiles (
  account_id TEXT PRIMARY KEY,
  nickname   TEXT,
  avatar_url TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emojis (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS peers (
  account_id TEXT PRIMARY KEY,
  name       TEXT,
  last_seen  INTEGER NOT NULL
);
`

function now() {
  return Date.now()
}

/** 把 node:sqlite 返回的 Uint8Array 统一成 Buffer，便于 IPC 序列化。 */
function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

export class Store {
  /** @param {string} file SQLite 文件绝对路径 */
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    // 多个宿主进程（如桌面版 + `dsh web`）可能共用同一个 DSH home / 同一个库文件。
    // node:sqlite 默认不等待锁，这里给 5s 的 busy 等待，避免瞬时 SQLITE_BUSY 直接失败。
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA_SQL)
    this.#migrate()
    this.#seed()
  }

  #migrate() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const current = row ? Number(row.value) : 0
    if (current < SCHEMA_VERSION) {
      // 目前只有 v1；未来结构变更在这里按版本号逐级迁移。
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION))
    }
  }

  #seed() {
    this.ensureChannel(DEFAULT_CHANNEL)
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭则忽略 */
    }
  }

  /* ---------------------------------------------------------------- 频道 */

  ensureChannel({ id, name, createdBy = null }) {
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO channels (id, name, created_by, created_at, archived, sort) VALUES (?, ?, ?, ?, 0, ?) ' +
          'ON CONFLICT(id) DO NOTHING',
      )
      .run(id, name, createdBy, ts, ts)
    return this.getChannel(id)
  }

  getChannel(id) {
    return this.db.prepare('SELECT id, name, created_by AS createdBy, created_at AS createdAt, archived, sort FROM channels WHERE id = ?').get(id) ?? null
  }

  /** 频道列表：未归档在前，按 sort/创建时间排序。 */
  listChannels(includeArchived = false) {
    const sql = includeArchived
      ? 'SELECT id, name, created_by AS createdBy, created_at AS createdAt, archived, sort FROM channels ORDER BY archived ASC, sort ASC, created_at ASC'
      : 'SELECT id, name, created_by AS createdBy, created_at AS createdAt, archived, sort FROM channels WHERE archived = 0 ORDER BY sort ASC, created_at ASC'
    return this.db.prepare(sql).all()
  }

  createChannel({ id = `ch-${randomUUID().slice(0, 8)}`, name, createdBy = null }) {
    const ts = now()
    this.db
      .prepare('INSERT INTO channels (id, name, created_by, created_at, archived, sort) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, name, createdBy, ts, ts)
    return this.getChannel(id)
  }

  renameChannel(id, name) {
    this.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id)
    return this.getChannel(id)
  }

  /** 归档而不是删除：历史消息保留，界面上标 archived（Q3 决策）。 */
  archiveChannel(id) {
    if (id === DEFAULT_CHANNEL.id) throw new Error('默认频道不可归档')
    this.db.prepare('UPDATE channels SET archived = 1 WHERE id = ?').run(id)
    return this.getChannel(id)
  }

  /* ---------------------------------------------------------------- 消息 */

  /**
   * 写入一条消息；id 冲突（对端重发/重连补发）时忽略，保证幂等。
   * @param {{id?: string, channelId: string, senderId: string, senderName: string,
   *          kind: 'text'|'emoji', body: string, sentAt?: number,
   *          direction: 'in'|'out', status?: string, source?: string}} message
   */
  insertMessage(message) {
    const row = {
      id: message.id ?? randomUUID(),
      channelId: message.channelId,
      senderId: message.senderId,
      senderName: message.senderName,
      kind: message.kind,
      body: message.body,
      sentAt: message.sentAt ?? now(),
      direction: message.direction,
      status: message.status ?? (message.direction === 'out' ? 'sent' : 'delivered'),
      source: message.source ?? 'local',
    }
    const result = this.db
      .prepare(
        'INSERT INTO messages (id, channel_id, sender_id, sender_name, kind, body, sent_at, direction, status, source) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(row.id, row.channelId, row.senderId, row.senderName, row.kind, row.body, row.sentAt, row.direction, row.status, row.source)
    return { message: this.getMessage(row.id), inserted: result.changes > 0 }
  }

  getMessage(id) {
    const row = this.db
      .prepare(
        'SELECT id, channel_id AS channelId, sender_id AS senderId, sender_name AS senderName, kind, body, ' +
          'sent_at AS sentAt, direction, status, source FROM messages WHERE id = ?',
      )
      .get(id)
    return row ?? null
  }

  /** 最近消息（升序返回，方便直接渲染）。 */
  listMessages(channelId, { limit = 200, before = null } = {}) {
    const rows = before === null
      ? this.db
          .prepare(
            'SELECT id, channel_id AS channelId, sender_id AS senderId, sender_name AS senderName, kind, body, ' +
              'sent_at AS sentAt, direction, status, source FROM messages WHERE channel_id = ? ' +
              'ORDER BY sent_at DESC, rowid DESC LIMIT ?',
          )
          .all(channelId, limit)
      : this.db
          .prepare(
            'SELECT id, channel_id AS channelId, sender_id AS senderId, sender_name AS senderName, kind, body, ' +
              'sent_at AS sentAt, direction, status, source FROM messages WHERE channel_id = ? AND sent_at < ? ' +
              'ORDER BY sent_at DESC, rowid DESC LIMIT ?',
          )
          .all(channelId, before, limit)
    return rows.reverse()
  }

  updateMessageStatus(id, status) {
    this.db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id)
    return this.getMessage(id)
  }

  countMessages(channelId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId).n
  }

  /* ------------------------------------------------------ 昵称 / 本地人物 */

  getProfile(accountId) {
    return this.db
      .prepare('SELECT account_id AS accountId, nickname, avatar_url AS avatarUrl, updated_at AS updatedAt FROM profiles WHERE account_id = ?')
      .get(accountId) ?? null
  }

  setNickname(accountId, nickname) {
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO profiles (account_id, nickname, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(account_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at',
      )
      .run(accountId, nickname, ts)
    return this.getProfile(accountId)
  }

  upsertPeer({ accountId, name }) {
    this.db
      .prepare(
        'INSERT INTO peers (account_id, name, last_seen) VALUES (?, ?, ?) ' +
          'ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen',
      )
      .run(accountId, name, now())
  }

  listPeers() {
    return this.db.prepare('SELECT account_id AS accountId, name, last_seen AS lastSeen FROM peers ORDER BY last_seen DESC').all()
  }

  /* ---------------------------------------------------------------- 表情 */

  /** 表情列表只返回元数据；图片字节按需 getEmoji 取，避免一次回传几十 MB。 */
  listEmojis() {
    return this.db
      .prepare('SELECT id, name, mime, length(bytes) AS size, created_at AS createdAt FROM emojis ORDER BY created_at ASC')
      .all()
  }

  getEmoji(id) {
    const row = this.db.prepare('SELECT id, name, mime, bytes FROM emojis WHERE id = ?').get(id)
    if (!row) return null
    return { id: row.id, name: row.name, mime: row.mime, bytes: toBuffer(row.bytes) }
  }

  /**
   * 上传自定义表情：id 由内容哈希决定，天然去重（同一张图重复上传/对端落地都不会重复）。
   * @param {{name: string, mime: string, bytes: Buffer|Uint8Array}} emoji
   */
  addEmoji({ name, mime, bytes }) {
    const buffer = toBuffer(bytes)
    const id = `e-${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}`
    this.db
      .prepare('INSERT INTO emojis (id, name, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, mime, buffer, now())
    return { id, name, mime, size: buffer.length }
  }

  deleteEmoji(id) {
    const result = this.db.prepare('DELETE FROM emojis WHERE id = ?').run(id)
    return result.changes > 0
  }

  /* ---------------------------------------------------------------- meta */

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }
}

/** 打开数据库；失败时抛出带路径的错误，方便在日志里定位。 */
export function openStore(file) {
  try {
    return new Store(file)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`tu-bubbles: 无法打开本地数据库 ${file}：${message}`)
  }
}
