# 架构与实现说明

## 1. 先说结论：三条硬约束决定了这个插件的形状

写代码之前先把 DSH 桌面端的机制摸了一遍（用 Electron 的 fs 直接读 `app.asar` 源码），
有三个事实直接决定了架构，不能绕：

1. **渲染层不能直接连对端的局域网信令端口。**
   桌面页面是 `dsh-app://app`（注册为 privileged/secure context），Chromium 会按「混合内容」规则
   拦掉 `ws://192.168.x.x`；`ws://127.0.0.1` 有豁免，但那是本机。
   而 DSH 自己的 webserver 只绑 `127.0.0.1`，把它暴露到局域网既不安全也不是插件的职责。
   → **信令必须由本机 host 进程代跑**：`host/signaling.js` 用 `node:net` 在 `0.0.0.0` 上起一个
   JSON-lines TCP 中继，渲染层只跟本地宿主说话。

2. **渲染层拿不到任何 Node 能力，也读不到账号 token。**
   `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；凭据在
   `~/.dsh/.credentials.yaml`，只有 host 能读。
   → **SQLite 与账号资料都在 host 进程**，客户端通过 RPC 请求。

3. **客户端插件与宿主之间已经有一条现成的、带认证的通道。**
   `dsh-client-connection` 把 `connection` 服务 `provide` 给客户端；host 侧可以
   `ctx.connection.rpc.handle('/tu-bubbles', handler)` 开一条**独立通道**（DSH 的共享
   `/api` 通道全局只允许一个 interceptor，第三方插件抢不到）。
   → 不自建 HTTP 服务器、不走 typert 代码生成，**用这条通道传所有数据**。

一句话概括数据面：

```
渲染层（React UI + WebRTC）  ──RPC(/tu-bubbles)──  host（SQLite + 信令 TCP + 账号）
        │                                                   │
        └──────── RTCPeerConnection / DataChannel ──────────┘
                      （聊天内容点对点直连，不过服务器）
```

## 2. 模块划分

| 文件 | 进程 | 职责 |
| --- | --- | --- |
| `index.js` | host | 插件入口：读配置、开库、起信令 hub、注册 RPC；`ctx.effect` 保证释放 |
| `host/store.js` | host | SQLite 全部读写（建表、迁移、幂等写入、表情 BLOB） |
| `host/signaling.js` | host | 局域网信令：房主监听 TCP、成员表、单播/广播中继、断线 3s 重连 |
| `host/rpc.js` | host | endpoint 路由：校验参数、鉴权（必须登录）、调 store/hub |
| `client.js` | 渲染层 | 唯一客户端模块：Controller（状态机）+ Mesh（WebRTC 网格）+ React UI |
| `locale/*.json` | — | 插件元数据（名称/描述/详情），中英各一份 |
| `icon.svg` | — | 插件图标（侧栏入口用的是内联 SVG，不依赖它） |

## 3. 通道设计

### 3.1 宿主 RPC

客户端调用：

```js
const result = await ctx.connection.rpc.call('/tu-bubbles', 'messages/list', { channelId, limit })
if (!result.ok) throw new Error(result.error.message)
const { messages } = result.value
```

宿主注册：

```js
export const inject = ['connection']

ctx.inject(['connection', 'webServer'], (webContext) => {
  // connection.rpc.handle() 内部要读「读取者上下文」的 webServer，
  // 只声明 inject 不够：必须把 webServer 显式 extend 到同一上下文上。
  const owner = webContext.extend({ webServer: webContext.get('webServer') })
  const dispose = owner.connection.rpc.handle('/tu-bubbles', handler)
  ctx.effect(() => dispose, 'tu-bubbles: rpc')
})
```

- 通道名 `/tu-bubbles`，endpoint 即 RPC 操作名（`identity`、`messages/list`、`room/join`…）；
- endpoint 按 `/` 切段校验，每段 `[A-Za-z0-9_$.-]`，所以操作名可以带斜杠；
- 返回统一封装 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`；
- 未登录时写操作抛 `account-required`，读操作仍可用（历史消息不因登出丢失）。

完整 endpoint 列表见 `README.md` 的「RPC 一览」。

### 3.2 信令协议（TCP，JSON-lines）

房主 → 加入者：`{ t: 'welcome', roomCode, self, members }`
加入者 → 房主：`{ t: 'join', code, member: { memberId, accountId, name, address } }`
中继：`{ t: 'relay', to, payload }` → `{ t: 'relay', from, payload }`
成员变化：`{ t: 'members', members }`；拒绝：`{ t: 'reject', reason }`
房主退出：`{ t: 'closed', reason: 'host-left' }`（随后各端自行选举，见 §3.5）

- `memberId = <accountId>:<设备后缀>`：**同账号多端可同时在线**，不会互相顶掉；
- 房间码 6 位，字母表去掉 `0/O/1/I`，邀请串格式 `192.168.1.5:51820/ABC123`；
- 单行上限 1 MB（SDP 不会超过），每连接最多 8 次 join 尝试，事件队列上限 500 条。

### 3.3 WebRTC

- 一条 `RTCPeerConnection` + 一条 `DataChannel('tu-bubbles')` **承载所有频道**；
  频道只是消息分区，切换频道不重连（ADR 0004）。
- 房间成员两两建连：`Mesh.sync(members)` 按成员表增删连接。
- **谁发 offer**：`memberId` 字典序更小的一端。两端规则一致，避免同时 offer 打架（glare）。
- **非 trickle ICE**：等 `iceGatheringState === 'complete'`（最多 2.5s）后一次性发出完整 SDP。
  同网段只需要 host candidate，`iceServers: []`，不需要 STUN/TURN。
- 断线：仅 offer 方按 1.5s × 尝试次数退避重连，最多 6 次；接收方等待新 offer。
- 信封格式（应用层）：

```json
{ "t": "msg", "body": { "id": "…", "channelId": "lobby", "kind": "text", "body": "你好", "sentAt": 1763… } }
```

握手用 `{t:'hello'}` 交换身份、`{t:'channels'}` 同步频道表、`{t:'ack', ids:[…]}` 回送达、
`{t:'nickname'}` 同步改名。

### 3.5 房主选举（房主离开后自动接管）

信令是「房主中转」模型，房主一退出就会断；这里给每个成员都留了接管能力：

1. **常驻 standby 监听**：任何 hub 第一次进房间时都在 `0.0.0.0:0` 上开一个 `node:net` 服务，
   端口记在 `listenPort`，并在成员表里广播自己的 `address = <局域网IP>:<listenPort>`。
   不在房间里时收到连接直接 `destroy`，不会被误当房主。
2. **房主退出**：`leave()` 先广播 `{t:'closed', reason:'host-left'}`（让其他人立刻反应，不用等 TCP 超时），
   再销毁所有连接。standby 服务**不关**——随时可能被选为新房主。
3. **各端选举**（`#startElection`，延迟 300ms 让 closed 消息先到位）：
   候选 = 成员表里除旧房主外的所有人，按 `memberId` 字典序排序；第一个就是继任者。
   所有成员看到同一份表，因此**结论唯一**，不需要投票协议。
   注意顺序：如果只是**连接断了但没收到 `closed`**（网络抖动、房主进程卡住），
   先原地重连原房主最多 3 次（每次间隔 1s），都失败才进入选举 —— 否则一次抖动会让
   所有人各自接管，出现两间同码房。
4. **自己就是继任者** → `#promote()`：沿用原 `roomCode` 与自己的 `listenPort` 直接接管，
   把旧房主从成员表删掉，广播 `members`。
5. **别人是继任者** → 按候选顺序 `parseInvite(候选.address + '/' + 原房间码)` 重连，
   失败换下一个，最多 3 轮（每轮 1200ms × 轮次退避）。
6. 两侧都会给渲染层推 `{kind:'host-changed', self, hostMemberId, room}`，UI toast 提示并刷新成员表。

已经建立的 DataChannel 是端到端的，**不随房主更换重建**；只有新成员/离开成员会触发
`Mesh.sync` 增删连接。`test/election.test.mjs` 覆盖了「A 退出 → B 接管 → C 自动重连 → 新成员 D 仍能加入」。

### 3.4 事件轮询

宿主没有把事件「推」给渲染层的能力（跨进程没有事件总线），所以客户端用 `tu-bubbles/sync` 拉：

- 房间有效时 500 ms 一次，空闲 1500 ms 一次，不在房间完全不轮询；
- 宿主侧 `SignalingHub#drain()` 返回并清空事件队列，天然支持多面板/多次轮询不重复。

## 4. 一次完整的聊天时序

```
A(房主)                         宿主A                     宿主B                         B(加入者)
  │ createRoom ─────────────────▶ store+hub.listen(0.0.0.0) │                              │
  │ ◀── invites[{address,invite}]                            │                              │
  │  把 192.168.1.5:51820/ABC123 发给 B ─────────────────────────────────────────────────▶ │
  │                               │ ◀── room/join(invite) ── TCP join ──────────────────────  │
  │                               │ ──── members ──────────▶ │                              │
  │ poll sync ◀── members ───     │                          │ ◀── members ─── poll sync    │
  │ offer(memberId 小) ── relay ─▶ 转发 ──────────────────▶ │ ── relay ──▶ handleSignal     │
  │ ◀──────────────── answer ──── 转发 ◀──────────────────── │                              │
  │ ══════════════ DataChannel open ═══════════════════════════════════════════════════════  │
  │ sendText ─▶ 本地落库(sending) ─▶ DC ──────────────────▶ receiveMessage ─▶ 落地(in) ─▶ ack │
  │ ◀── ack ── status=delivered                              │                              │
```

## 5. 登录与身份

- 只用 DSH 账号：`ctx.get('deepseekAccount')` → `getState().status === 'credential-stored'`
  → `getProfile({version, locale, timezoneOffsetSeconds})` 拿 `{id, name, avatarUrl}`；
- 未登录时面板显示引导页（去「设置 → 账号」登录），不提供任何其他登录方式；
- **不做登录门槛拦截**：DSH 本身也没有全局强制登录，登录与否由 `deepseekAccount` 决定；
  本插件的写操作（发消息/建频道/建房）会校验登录，读历史不校验；
- 昵称存本地 `profiles` 表，键是账号 id —— 换昵称不需要联网，也不影响账号本身。

## 6. 已知限制与替代方案

| 限制 | 原因 | 替代方案 |
| --- | --- | --- |
| 不能跨 NAT / 公网 | 决策上不做 TURN，只靠 host candidate | 需要时在 `Mesh.createPeer` 的 `iceServers` 里加 STUN/TURN（一行改动） |
| 渲染层不直连对端 | 混合内容拦截（`ws://` 私网地址） | 已由宿主 TCP 中继代跑，无需改 |
| 没有消息推送 | 跨进程无事件总线 | 房间内 500 ms 轮询；不在房间不轮询 |
| 成员列表不含未连过的账号 | 无账号目录服务 | `peers` 表记录见过的对端 |
| 不支持多房间并行 | 一条连接/一个房间，避免状态机复杂化 | 断开重进；后续可在 host 侧建多 hub |
| 表情上限 256 KB | 走 DataChannel + SQLite BLOB，过大影响内存 | 超过会被拒绝并提示 |

## 7. 实测验证记录（2026-11-16）

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 宿主激活 | `plugin_manager set_plugin(include:tu-bubbles, enabled=true)` | `applied`，`warnings: []` |
| RPC 通道挂载 | 用浏览器会话 cookie 直接 POST `/tu-bubbles/identity` | 200，返回真实账号 `子俊` |
| 客户端产物 | 带 cookie 取启动页 `__DSH_BOOT__` 里的 `plugins/??dsh-tu-bubbles/client.js` | 200，67 KB，内容即仓库 `client.js` |
| 侧栏入口 + 面板 | Chrome headless + CDP：点侧栏「吐泡泡」 | 面板正常渲染（频道/消息/房间/成员/调试信息三栏） |
| WebRTC 直连 | 两个宿主（52514 桌面 / 52600 `dsh web`，各自独立 `dataDir`）建房 + 加入 | 双方 `pc=connected`、`ice=connected`、`dc=open` |
| 双向消息 | A 发文字 → B、B 回文字 → A | 双向即时到达；发送方状态 `已送达` |
| SQLite 落库 | 两端「调试信息」+ `storages/tu-bubbles/chat.db` | 各自落盘，重开页面仍在 |
| 频道（真实 UI） | 面板里点 `+` 建「摸鱼」，在该频道发一条消息，刷新页面 | 频道仍在；消息只出现在该频道，`#大厅` 里没有 |
| 昵称（真实 UI） | 点昵称 → 输入 → 保存 → 刷新 | 立即生效，刷新后从 `profiles` 表读回 |
| 表情（真实 UI） | 点笑脸 → 选内置 `🐷` | 消息即时发出，落库（属当时所在频道） |
| 房主选举（信令层） | `node test/election.test.mjs`：A 建房、B/C 加入，A `leave()` | B（字典序小）接管原房间码；C 自动重连；新成员 D 用 `B 地址/原码` 仍能加入 |

> 注意：同机两个宿主如果共用同一个 DSH home，会打开同一个 `chat.db`，接收方按消息 id 幂等写入
> 会变成空操作（看起来像「没收到」，实际上是从同一个库读）。同机验证务必配独立 `dataDir`。

## 8. 相关决策

- ADR 0001：渲染层跑 WebRTC、宿主跑信令中继（混合内容）
- ADR 0002：用 `node:sqlite`，不用第三方驱动 / `ctx.storageDomain`
- ADR 0003：自有 endpoint 走 `ctx.connection.rpc.handle('/tu-bubbles', …)` 独立通道，不用 typert/@Remote
- ADR 0004：一条连接承载全部频道
- ADR 0005：表情以 BLOB 存库 + 内容哈希 id 去重
- ADR 0006：房主离开后按成员表自动选举新房主（standby 监听 + 房间码沿用）
