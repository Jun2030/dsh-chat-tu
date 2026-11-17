/**
 * 吐泡泡 · host 侧 RPC 路由
 *
 * 注册方式：用连接服务的**独立通道** /tu-bubbles（共享 /api 只允许一个 interceptor）：
 *   ctx.connection.rpc.handle('/tu-bubbles', handler)
 * 渲染层用法：
 *   ctx.connection.rpc.call('/tu-bubbles', 'messages/list', { channelId }, signal)
 *   → { ok: true, value } | { ok: false, error: { code, message, details } }
 *
 * 这里只做三件事：读写 SQLite、管房间、转发信令。聊天内容不经信令中继转发，
 * 本地持久化仍由渲染层通过 RPC 交给 host。
 */
import { DEFAULT_CHANNEL } from './store.js'

const MAX_EMOJI_BYTES = 256 * 1024
const ALLOWED_EMOJI_MIME = new Set(['image/png', 'image/gif', 'image/webp'])
const MAX_TEXT_LENGTH = 4000
const MAX_CHANNEL_NAME = 32

export class RpcError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

function bad(message) {
  return new RpcError('invalid-request', message)
}

function requireString(value, field, { max = 1000, min = 1 } = {}) {
  if (typeof value !== 'string') throw bad(`字段 ${field} 必须是字符串`)
  const trimmed = field === 'body' ? value : value.trim()
  if (trimmed.length < min) throw bad(`字段 ${field} 不能为空`)
  if (trimmed.length > max) throw bad(`字段 ${field} 超过 ${max} 字符`)
  return trimmed
}

/**
 * 本机在房间里的成员标识：`<accountId>:<设备后缀>`。
 * 同一账号开两台机器时用后缀区分，避免互相顶掉信令连接。
 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_$.:-]{1,96}$/

function memberIdFor(account, payload) {
  const raw = payload?.memberId
  if (raw === undefined || raw === null || raw === '') return `${account.accountId}:local`
  const value = String(raw)
  if (!MEMBER_ID_PATTERN.test(value)) throw bad('memberId 非法')
  if (!value.startsWith(`${account.accountId}:`)) throw bad('必须属于当前账号')
  return value
}

/**
 * @param {{ store: import('./store.js').Store, hub: import('./signaling.js').SignalingHub,
 *           identity: () => Promise<{signedIn: boolean, accountId: string|null, name: string|null,
 *                                    avatarUrl?: string|null, reason?: string}>,
 *           logger: Pick<Console, 'info'|'warn'|'error'> }} deps
 */
export function createRouter({ store, hub, identity, logger }) {
  /** 需要已登录的 op 统一从这里拿账号身份。 */
  async function requireAccount() {
    const info = await identity()
    if (!info.signedIn || !info.accountId) {
      throw new RpcError('account-required', info.reason ?? '请先使用 DeepSeek Harness 账号登录')
    }
    return info
  }

  const ops = {
    /* -------------------------------------------------------------- 身份 */

    async identity() {
      const info = await identity()
      if (info.signedIn && info.accountId) {
        const local = store.getProfile(info.accountId)
        if (local?.nickname) info.name = local.nickname
      }
      return info
    },

    async 'nickname/set'(payload) {
      const account = await requireAccount()
      const nickname = requireString(payload?.nickname, 'nickname', { max: 24 })
      const profile = store.setNickname(account.accountId, nickname)
      // 昵称变化要同步给房间里的其他人（他们用 accountId 做身份）。
      if (hub.role) {
        hub.relay({ to: '*', payload: { kind: 'nickname', accountId: account.accountId, name: nickname } })
      }
      return { nickname: profile.nickname, updatedAt: profile.updatedAt }
    },

    /* -------------------------------------------------------------- 频道 */

    async 'channels/list'() {
      const channels = store.listChannels()
      return { channels, defaultChannelId: DEFAULT_CHANNEL.id }
    },

    async 'channels/create'(payload) {
      const account = await requireAccount()
      const name = requireString(payload?.name, 'name', { max: MAX_CHANNEL_NAME })
      if (store.listChannels().some((c) => c.name === name)) {
        throw new RpcError('duplicate-channel', `频道「${name}」已存在`)
      }
      const channel = store.createChannel({ name, createdBy: account.accountId })
      if (hub.role) {
        hub.relay({ to: '*', payload: { kind: 'channel-created', channel } })
      }
      return channel
    },

    async 'channels/rename'(payload) {
      await requireAccount()
      const id = requireString(payload?.id, 'id', { max: 64 })
      const name = requireString(payload?.name, 'name', { max: MAX_CHANNEL_NAME })
      const channel = store.getChannel(id)
      if (!channel) throw new RpcError('not-found', '频道不存在')
      const updated = store.renameChannel(id, name)
      if (hub.role) {
        hub.relay({ to: '*', payload: { kind: 'channel-renamed', channel: updated } })
      }
      return updated
    },

    /** 收到别人创建频道的消息/事件时，确保本地也有这个频道（幂等）。 */
    async 'channels/ensure'(payload) {
      const id = requireString(payload?.id, 'id', { max: 64 })
      const name = requireString(payload?.name, 'name', { max: MAX_CHANNEL_NAME })
      return store.ensureChannel({ id, name, createdBy: payload?.createdBy ?? null })
    },

    async 'channels/archive'(payload) {
      const account = await requireAccount()
      const id = requireString(payload?.id, 'id', { max: 64 })
      const channel = store.getChannel(id)
      if (!channel) throw new RpcError('not-found', '频道不存在')
      if (channel.createdBy && channel.createdBy !== account.accountId) {
        throw new RpcError('forbidden', '只有创建者可以归档该频道')
      }
      const archived = store.archiveChannel(id)
      // 归档是本地隐藏语义，不广播远端，避免把各自历史库误当成共享目录。
      return archived
    },

    /* -------------------------------------------------------------- 消息 */

    async 'messages/list'(payload) {
      const channelId = requireString(payload?.channelId, 'channelId', { max: 64 })
      const limit = Math.min(Math.max(Number(payload?.limit ?? 200) || 200, 1), 500)
      const rawBefore = payload?.before
      const before = rawBefore === undefined || rawBefore === null
        ? null
        : rawBefore && typeof rawBefore === 'object'
          ? { sentAt: Number(rawBefore.sentAt), id: rawBefore.id }
          : Number(rawBefore)
      if (before !== null && (!Number.isFinite(before) && !(before && Number.isFinite(before.sentAt) && typeof before.id === 'string' && before.id))) {
        throw bad('before 游标非法')
      }
      return { messages: store.listMessages(channelId, { limit, before }) }
    },

    /** 任意方向的消息落地（本机发送后、或收到对端 DataChannel 消息后）。 */
    async 'messages/append'(payload) {
      const message = payload?.message
      if (!message || typeof message !== 'object') throw bad('缺少 message')
      const account = await requireAccount()
      const channelId = requireString(message.channelId, 'channelId', { max: 64 })
      const kind = message.kind === 'emoji' ? 'emoji' : 'text'
      const body = kind === 'text'
        ? requireString(message.body, 'body', { max: MAX_TEXT_LENGTH })
        : requireString(message.body, 'body', { max: MAX_EMOJI_BYTES })
      const result = store.insertMessage({
        id: typeof message.id === 'string' && message.id.length <= 64 ? message.id : undefined,
        channelId,
        senderId: message.senderId === account.accountId ? account.accountId : requireString(message.senderId, 'senderId', { max: 64 }),
        senderName: requireString(message.senderName, 'senderName', { max: 64 }),
        kind,
        body,
        sentAt: Number.isFinite(message.sentAt) ? Number(message.sentAt) : Date.now(),
        direction: message.direction === 'in' ? 'in' : 'out',
        status: typeof message.status === 'string' ? message.status : undefined,
        source: typeof message.source === 'string' ? message.source : 'local',
      })
      if (message.direction === 'in' && message.senderName && message.senderId) {
        store.upsertPeer({ accountId: message.senderId, name: message.senderName })
      }
      return result
    },

    async 'messages/status'(payload) {
      const id = requireString(payload?.id, 'id', { max: 64 })
      const status = requireString(payload?.status, 'status', { max: 16 })
      if (!['sending', 'sent', 'delivered', 'failed'].includes(status)) throw bad('非法状态')
      const message = store.updateMessageStatus(id, status)
      if (!message) throw new RpcError('not-found', '消息不存在')
      return message
    },

    /* -------------------------------------------------------------- 表情 */

    async 'emojis/list'() {
      return { emojis: store.listEmojis() }
    },

    async 'emojis/get'(payload) {
      const id = requireString(payload?.id, 'id', { max: 64 })
      const emoji = store.getEmoji(id)
      if (!emoji) throw new RpcError('not-found', '表情不存在')
      return { id: emoji.id, name: emoji.name, mime: emoji.mime, data: emoji.bytes.toString('base64') }
    },

    async 'emojis/add'(payload) {
      await requireAccount()
      const name = requireString(payload?.name, 'name', { max: 24 })
      const mime = requireString(payload?.mime, 'mime', { max: 40 })
      if (!ALLOWED_EMOJI_MIME.has(mime)) {
        throw new RpcError('unsupported-media', '只支持 PNG / GIF / WebP 表情')
      }
      const data = requireString(payload?.data, 'data', { max: MAX_EMOJI_BYTES * 2 })
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length === 0) throw bad('表情内容为空')
      if (bytes.length > MAX_EMOJI_BYTES) {
        throw new RpcError('too-large', `表情不能超过 ${MAX_EMOJI_BYTES / 1024}KB`)
      }
      return store.addEmoji({ name, mime, bytes })
    },

    async 'emojis/delete'(payload) {
      await requireAccount()
      const id = requireString(payload?.id, 'id', { max: 64 })
      return { deleted: store.deleteEmoji(id) }
    },

    /* -------------------------------------------------------------- 房间 */

    async 'room/create'(payload) {
      const account = await requireAccount()
      const memberId = memberIdFor(account, payload)
      const status = await hub.createRoom({ memberId, accountId: account.accountId, name: account.name ?? '我' })
      return status
    },

    async 'room/join'(payload) {
      const account = await requireAccount()
      const memberId = memberIdFor(account, payload)
      const invite = requireString(payload?.invite, 'invite', { max: 120 })
      const status = await hub.joinRoom({ invite, memberId, accountId: account.accountId, name: account.name ?? '我' })
      return status
    },

    async 'room/leave'() {
      hub.leave()
      return hub.status()
    },

    async 'room/status'() {
      return hub.status()
    },

    /** 渲染层把 SDP/ICE/业务广播塞进信令中继。 */
    async 'room/relay'(payload) {
      await requireAccount()
      const to = payload?.to === '*' ? '*' : requireString(payload?.to, 'to', { max: 64 })
      if (!hub.role) throw new RpcError('not-in-room', '尚未加入房间')
      hub.relay({ to, payload: payload?.payload ?? null })
      return { sent: true }
    },

    /** 长轮询替代：渲染层每 700ms 拉一次，取走队列里的事件。 */
    async sync(payload) {
      const consumerId = typeof payload?.consumerId === 'string' && payload.consumerId.length <= 96 ? payload.consumerId : 'default'
      const room = hub.status()
      return { events: hub.drain(consumerId, { reset: payload?.reset === true, epoch: room.epoch ?? null }), room }
    },

    /** 排障用：把本地库信息回给客户端，便于「设置 → 关于」里显示。 */
    async 'debug/info'() {
      return {
        dbFile: store.file,
        schemaVersion: store.getMeta('schema_version'),
        channels: store.listChannels(true).length,
        emojis: store.listEmojis().length,
        peers: store.listPeers().length,
      }
    },
  }

  return async function handle(endpoint, payload) {
    const suffix = endpoint.startsWith('tu-bubbles/') ? endpoint.slice('tu-bubbles/'.length) : endpoint
    const op = ops[suffix]
    if (!op) {
      return { ok: false, error: { code: 'unknown-op', message: `未知接口 ${endpoint}`, details: {} } }
    }
    try {
      const value = await op(payload ?? {})
      return { ok: true, value }
    } catch (error) {
      if (error instanceof RpcError) {
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.error?.(`[tu-bubbles] ${endpoint} 失败`, error)
      return { ok: false, error: { code: 'internal', message, details: {} } }
    }
  }
}
