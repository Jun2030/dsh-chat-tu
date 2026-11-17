# 数据结构（SQLite）

> 实现文件：`host/store.js`。SQLite 由 `node:sqlite`（Electron 44 / Node 24 内置，v3.53.4）驱动，
> 不引入任何第三方驱动，安装时不需要原生编译。

## 1. 库的存放位置

| 场景 | 路径 |
| --- | --- |
| 默认 | `<DSH_HOME>/storages/tu-bubbles/chat.db` |
| 未设置 `DSH_HOME` | `%USERPROFILE%\.dsh\storages\tu-bubbles\chat.db` |
| 插件配置了 `dataDir` | `<dataDir>/chat.db` |

`DSH_HOME` 优先读环境变量，其次回退到 `~/.dsh`，与 DSH 自己的 storages 目录规则一致。
WAL 模式（`journal_mode=WAL`）下会同时出现 `chat.db-wal` / `chat.db-shm`，属于正常现象。

- `SCHEMA_VERSION = 1`
- 版本号写在 `meta.schema_version`，未来结构变更在 `Store#migrate()` 里按版本逐级迁移
- 每个库首次打开都会确保默认频道 `#大厅`（`id = 'lobby'`）存在

## 2. 表结构

### 2.1 `meta` — 键值元数据

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `key` | TEXT PK | 键 |
| `value` | TEXT NOT NULL | 值 |

当前只存 `schema_version`。

### 2.2 `channels` — 频道

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 频道 id（`lobby` 为默认频道；用户建的频道由 host 生成） |
| `name` | TEXT NOT NULL | 频道名，最长 32 字符 |
| `created_by` | TEXT | 创建者 `accountId`（决定谁有归档权限） |
| `created_at` | INTEGER NOT NULL | 创建时间（Unix 毫秒） |
| `archived` | INTEGER NOT NULL DEFAULT 0 | 0/1。归档后不再出现在频道列表（可用 `debug/info` 或带 `includeArchived` 的查询看到），消息保留 |
| `sort` | INTEGER NOT NULL DEFAULT 0 | 预留排序字段 |

约束（在 `host/rpc.js` 里校验，不在 SQL 层）：

- `#大厅` 不可归档；
- 只有 `created_by` 本人能归档（`channels/archive` 返回 `forbidden`）；
- 频道名不得为空、不得重复（重复时 RPC 报 `channel-exists`）。

### 2.3 `messages` — 会话消息（本地持久化的唯一真源）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 消息 id。发送方生成，接收方沿用同一个 id → 重发/重连天然幂等 |
| `channel_id` | TEXT NOT NULL | 归属频道（对应 `channels.id`，逻辑外键） |
| `sender_id` | TEXT NOT NULL | 发送者 `accountId`（peer 身份，见 GLOSSARY） |
| `sender_name` | TEXT NOT NULL | 发送时的昵称快照（改昵称不回溯历史消息） |
| `kind` | TEXT NOT NULL | `text` \| `emoji` \| `system` |
| `body` | TEXT NOT NULL | `text`：正文；`emoji`：JSON（`{"unicode":"🐷"}` 或 `{"emojiId":"e-…","name":"猪猪"}`） |
| `sent_at` | INTEGER NOT NULL | 发送时间（Unix 毫秒） |
| `direction` | TEXT NOT NULL | `out`（本机发出）\| `in`（对端发来） |
| `status` | TEXT NOT NULL | `sending` \| `sent` \| `delivered` \| `failed` |
| `source` | TEXT NOT NULL DEFAULT 'local' | 预留：`local` \| 未来的导入来源 |

索引：

```sql
CREATE INDEX idx_messages_channel ON messages (channel_id, sent_at);
CREATE INDEX idx_messages_status  ON messages (status);
```

写入语义：

- `insertMessage()` 使用 `INSERT … ON CONFLICT(id) DO NOTHING`，返回 `{ message, inserted }`；
  同一消息重复投递不会产生第二条。
- 状态流转：`sending`（本地落库）→ `sent`（已写入 DataChannel）→ `delivered`（收到对端 ack）；无在线成员时直接 `failed`，可手动重试。

### 2.4 `profiles` — 本机账号资料（昵称）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `account_id` | TEXT PK | DSH 账号 id（`deepseekAccount.getProfile()` 返回的 `id`） |
| `nickname` | TEXT | 昵称，最长 24 字符；空则回退 DSH 账号名 |
| `avatar_url` | TEXT | 预留，当前不写入 |
| `updated_at` | INTEGER NOT NULL | 最后修改时间 |

昵称是**本机账号自己的**资料：只有本人这台机器的库里有这一行。别人看到的昵称来自房间成员表
（建房/加入时上报、改昵称后经 DataChannel 广播 `/nickname`），而不是你的库。

### 2.5 `emojis` — 自定义表情

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `e-<sha256 前 16 位>`，由图片字节决定 → 同一张图天然去重 |
| `name` | TEXT NOT NULL | 显示名，最长 16 字符 |
| `mime` | TEXT NOT NULL | 只允许 `image/png`、`image/gif`、`image/webp` |
| `bytes` | BLOB NOT NULL | 图片原始字节，≤ 256 KiB（`MAX_EMOJI_BYTES = 262144`） |
| `created_at` | INTEGER NOT NULL | 上传时间 |

读取策略：

- `emojis/list` 只回元数据（`id/name/mime/size/createdAt`），避免把几十 MB 图片塞进一次响应；
- 需要显示时按需 `emojis/get`，返回 base64；
- 发送自定义表情时，图片字节随 WebRTC 信封一起发出（`emoji: {name, mime, data}`），
  对端收到后用**同样的内容哈希 id** 落地 → 双方 id 一致，不会重复。

### 2.6 `peers` — 见过的人（成员列表的「历史人物」部分）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `account_id` | TEXT PK | 对端账号 id |
| `name` | TEXT | 最近一次见到的昵称 |
| `last_seen` | INTEGER NOT NULL | 最近在线时间 |

成员列表 = 房间当前在线成员（内存）+ 本表记录（离线但聊过的人）。
注意：本表只记录**曾经连上过**的对端，不做账号目录同步。

## 3. 一句话总结数据流

```
发送：UI → 本机 SQLite(status=sending) → DataChannel(信封) → status=sent → 对端落库 ack → status=delivered
接收：DataChannel → channels/ensure（陌生频道）→ emojis/add（表情字节落地）→ messages/append(direction=in) → 回 ack
```

频道归档只改变本地 `channels.archived`，不会广播给其他设备；消息历史仍保留。

详见 `docs/ARCHITECTURE.md`。
