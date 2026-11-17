# 吐泡泡 · Tu Bubbles

DSH 桌面端插件：**局域网内的点对点聊天**。左侧栏点一下气泡图标进入，创建房间后把邀请串发给同事，
两个人（或多个人）之间就能直接聊——消息走 WebRTC DataChannel 点对点传输，
全部落在**本地 SQLite**，重启 DSH 后还在。

- 登录方式：只用 DeepSeek Harness 账号，没有第二套账号体系
- 频道：默认 `#大厅`，可创建 / 重命名 / 切换 / 归档，消息按频道归属
- 消息：文字 + 表情；表情内置 40 个 unicode，也可上传自己的 PNG / GIF / WebP
- 存储：`node:sqlite`（Node 24 内置），零第三方依赖、零构建

---

## 1. 目录结构

```
dsh-chat-tu/
├── package.json              # 插件清单：bundle.patch + client 入口 + locale/icon 导出
├── cordis.patch.yml          # 往 profile 里插入 tu-bubbles 服务
├── index.js                  # 【host 入口】apply(ctx)：开库、起信令、注册 RPC
├── host/
│   ├── store.js              # 【host】SQLite：建表/迁移/幂等写入/表情 BLOB
│   ├── signaling.js          # 【host】局域网信令：TCP 中继、成员表、重连
│   └── rpc.js                # 【host】endpoint 路由与参数校验
├── client.js                 # 【渲染层】唯一客户端模块：Controller + Mesh + React UI
├── locale/
│   ├── zh.json               # 插件元数据（中文）
│   └── en.json               # 插件元数据（英文）
├── icon.svg                  # 插件图标
├── docs/
│   ├── ARCHITECTURE.md       # 架构、时序、通道设计、限制
│   ├── SCHEMA.md             # SQLite 表结构（逐列说明）
│   └── adr/                  # 5 条架构决策记录
├── GLOSSARY.md               # 术语表（memberId / 落库 / 邀请串 / offer 方…）
├── scripts/
│   ├── install.ps1           # 命令行安装到 profile
│   └── uninstall.ps1         # 卸载（可选保留数据）
└── test/
    ├── store.test.mjs        # 存储层单元测试（真实 SQLite）
    ├── signaling.test.mjs    # 信令层集成测试（真实 127.0.0.1 TCP）
    ├── client.test.mjs       # 端到端：两个「本机」直连、收发、落库、重开库
    └── registration.test.mjs # 槽位注册契约（侧栏入口 ↔ 主面板 id 对齐）
```

## 2. 整体架构与技术选型

### 2.1 DSH 插件接入方式

一个包同时提供 host 与 client 两个入口：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| host | `exports["."]` → `index.js` | 导出 `apply(ctx, config)` + `inject: ['connection']`，由 `cordis.patch.yml` 插入 profile |
| client | `exports["./client"]` → `client.js` | `window.__ModuleLoader__.load({ id, factory(require) })`，注册 `main` + `sidebar.panellist` 两个槽位 |

- 左侧栏：`sidebar.panellist` 注册一条 `{ id: 'tu-bubbles', order: 12, label: () => '吐泡泡' }`，
  侧栏会**自动**把同名 `main` 面板切进来，插件不需要自己写点击逻辑；
- 主界面：`main` 槽位 `{ key: 'tu-bubbles' }`，一个 React 组件；
- 插件停用时 `ctx.effect` 收尾（停轮询、关 PeerConnection、退订）。

> **样式 token 的坑（实测）**：插件 CSS 要用主题里**真实存在**的变量名，写错名字不会报错，
> 只会静默走 fallback。当前 DSH 用的是 `--dsw-alias-label-primary` / `-label-secondary`、
> `--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2`、`--dsw-alias-border-l1`、
> `--dsw-alias-button-primary-fill`、`--dsw-alias-label-primary-inverted`、`--dsw-alias-link`；
> `--dsw-alias-text-primary` 之类的名字**并不存在**。另外深色主题下 `button-primary-fill` 是白色，
> 按钮上的文字要用 `label-primary-inverted` 才看得见。

### 2.2 客户端 ↔ 宿主通道

用 DSH 现成的连接层，不自建 HTTP。注意：共享 `/api` 通道全局只允许一个 interceptor，
第三方插件要用 **`handle()` 开独立通道**：

```js
// index.js（host）
export const inject = ['connection']
ctx.inject(['connection', 'webServer'], (webContext) => {
  const owner = webContext.extend({ webServer: webContext.get('webServer') }) // handle() 要读读取者上下文的 webServer
  const dispose = owner.connection.rpc.handle('/tu-bubbles', handler)
  ctx.effect(() => dispose, 'tu-bubbles: rpc')
})

// client.js
const result = await ctx.connection.rpc.call('/tu-bubbles', 'messages/list', { channelId })
```

返回统一是 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
理由见 [ADR 0003](docs/adr/0003-plugin-rpc-channel.md)：复用认证与重连，插件里没有鉴权代码。

### 2.3 WebRTC 信令方案（重点）

渲染层是 `dsh-app://app` 安全上下文，**Chromium 会拦截到私网的 `ws://192.168.x.x`**（混合内容）；
DSH 自带的 webserver 又只绑 `127.0.0.1`。所以：

```
渲染层 ──RPC──▶ 本机 host ──TCP(JSON lines)──▶ 对端 host ──RPC──▶ 对端渲染层
        (本地，HTTP)       (0.0.0.0:随机端口)          (本地，HTTP)
        └──────────────── RTCPeerConnection（点对点，DTLS-SRTP 加密）────────────────┘
```

- 房主创建房间时，宿主在 `0.0.0.0` 上监听一个随机端口，显示 `IP:端口/房间码`；
- 对端把邀请串粘进来 → 它的宿主连过去，交换 SDP/ICE；
- **非 trickle ICE**：等收集完成（≤2.5s）发一条完整 SDP，报文简单、好排查；
- 同网段只需要 host candidate，`iceServers: []`，不依赖 STUN/TURN；
  Chromium 默认会把 host candidate 换成本机 `.local` 域名（mDNS），同网段可以正常解析，实测可连通；
- 一条连接承载所有频道（[ADR 0004](docs/adr/0004-single-connection-multi-channel.md)），
  offer 由 `memberId` 字典序小的一端发起，避免 glare；
- 断线：加入者先原地重连房主（3 次、约 3s），连不上才进入选举；offer 方按 1.5s×次数退避重连
  DataChannel，最多 6 次；
- **房主退出会自动选新房主**：每个成员都在 `0.0.0.0` 上常驻一个信令监听端口，并在成员表里广播
  `地址 = 局域网IP:端口`；房主离开时各端用同一份成员表算出唯一继任者（除旧房主外 `memberId` 字典序
  最小者），继任者在**原端口**上接管**同一个房间码**，其余人自动连过去，已建立的 DataChannel 不受影响
  （见 [ADR 0006](docs/adr/0006-host-election.md)）。最短断流约 0.3s，最长按选举轮次退避；
- **一个宿主进程只有一间房**：房主不能再点「加入」（会提示先断开），同机两个窗口互聊请起第二个宿主
  （见 [§7 双宿主实测](#7-测试与调试)）。

详细时序见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 2.4 SQLite 存储方案

- 驱动：`node:sqlite` 的 `DatabaseSync`（Electron 44 / Node 24.21 内置 SQLite 3.53.4，免编译）；
- 位置：`<DSH_HOME>/storages/tu-bubbles/chat.db`（未设 `DSH_HOME` 则 `~/.dsh/...`）；
- WAL 模式 + `PRAGMA busy_timeout = 5000`；消息 id 由发送方生成，接收方沿用 → 重复投递天然幂等；
  > 如果同一台机器上跑了多个 DSH 进程（例如桌面端 + `dsh web`）且**共用同一个 DSH home**，
  > 它们会打开同一个 `chat.db`。消息 id 相同会让「接收方落库」变成空操作（对方其实是从同一个库读到的），
  > 并发写入也可能瞬时 `database is locked`。这种情况下请给第二个进程配独立的 `dataDir`（见 §5）。
- 表：`meta` / `channels` / `messages` / `profiles` / `emojis` / `peers`，
  逐列说明见 [docs/SCHEMA.md](docs/SCHEMA.md)。

## 3. 安装

### 方式 A：界面插件管理（推荐）

1. 打开 DSH → 插件管理 → 从本地目录安装 → 选这个仓库目录；
2. 确认「吐泡泡 / Tu Bubbles」处于启用状态；
3. 刷新页面，左侧栏出现气泡图标。

### 方式 B：命令行

```powershell
# 在仓库根目录
pwsh -File scripts/install.ps1
# 然后打开 DSH 的插件管理，确认已启用
```

> 装/改 profile 依赖前建议先退出 DeepSeek Harness（Desktop 会把配置写回磁盘）。

卸载：

```powershell
pwsh -File scripts/uninstall.ps1              # 默认只移除插件，保留聊天记录
pwsh -File scripts/uninstall.ps1 -RemoveData  # 明确删除默认 dataDir
pwsh -File scripts/uninstall.ps1 -DataDir D:\data\tu-bubbles -RemoveData
```

## 4. 使用

1. **登录**：如果面板显示「需要 DeepSeek Harness 账号登录」，去「设置 → 账号」登录，回到面板点「刷新」。
   （插件不提供任何其他登录方式。）
2. **建房**：点「创建房间」→ 得到邀请串，例如 `192.168.1.5:51820/4KQ7ZB`。
3. **加入**：对方在同一局域网，把邀请串粘进输入框 → 「加入」。两端状态变绿即连通。
4. **聊天**：输入框回车发送（`Shift+Enter` 换行）；每条消息有 `发送中/已发送/已送达/失败` 状态。
5. **频道**：左侧频道列表可「新建」、双击重命名、点垃圾桶归档（`#大厅` 不可归档）。
   频道只是分区，切换不会断开连接。
6. **昵称**：右上角点昵称直接改，改完对端立即看到（不影响历史消息里的旧名字）。
7. **表情**：输入框旁的笑脸 → 内置表情 / 我的表情；「上传」支持 PNG/GIF/WebP ≤ 256 KB。

## 5. 配置项

| 配置 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dataDir` | `cordis.patch.yml` 里 `tu-bubbles` 的 `config` | `<DSH_HOME>/storages/tu-bubbles` | 数据库所在目录；**同机跑多个 DSH 进程时给每个进程配不同目录**，否则会共用同一个 `chat.db` |
| `DSH_HOME` | 环境变量 | `~/.dsh` | 决定默认数据目录 |
| 信令端口 | 运行时 | `0`（系统分配） | 创建房间时监听，显示在邀请串里 |
| 防火墙 | 系统 | — | 首次监听 TCP 时 Windows 会弹放行提示，需允许「专用网络」 |
| 轮询间隔 | `client.js` 常量 `POLL_ACTIVE_MS` / `POLL_IDLE_MS` | 500 / 1500 ms | 房间内快轮询，空闲慢轮询 |
| 表情上限 | `MAX_EMOJI_BYTES` | 256 KiB | 服务端与客户端双重校验 |
| 文字上限 | `MAX_TEXT` | 4000 字 | 超出会被拒绝 |

改 `dataDir` 示例（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: tu-bubbles
      name: dsh-tu-bubbles
      config:
        dataDir: D:/data/tu-bubbles
```

## 6. RPC 一览（通道 `/tu-bubbles`，下表是 endpoint）

客户端调用形如 `ctx.connection.rpc.call('/tu-bubbles', 'messages/list', { channelId })`。
（`host/rpc.js` 同时兼容旧写法 `'tu-bubbles/messages/list'`，自己会剥前缀。）

| endpoint | 作用 |
| --- | --- |
| `identity` | 当前登录账号（`signedIn / accountId / name / avatarUrl`） |
| `nickname/set` | 改昵称（≤24 字），写 `profiles` |
| `channels/list` | 频道列表 + 默认频道 id |
| `channels/create` / `rename` / `ensure` / `archive` | 建/改名/幂等建（收到陌生频道消息时）/归档 |
| `messages/list` | 按频道取历史（`limit ≤ 500`，`before` 游标） |
| `messages/append` | 落库（幂等），返回 `{message, inserted}` |
| `messages/status` | 更新送达状态 |
| `emojis/list` / `get` / `add` / `delete` | 表情元数据 / 取图 / 上传 / 删除 |
| `room/create` / `join` / `leave` / `status` | 房间生命周期 |
| `room/relay` | 把 SDP/ICE 交给宿主中继 |
| `sync` | 拉事件队列 + 房间状态（客户端轮询） |
| `debug/info` | 库路径、表计数（面板「调试信息」用） |

## 7. 测试与调试

```powershell
npm test                        # 下面五个全跑
node test/store.test.mjs        # 存储层：建表/幂等/表情去重/重开库仍在
node test/signaling.test.mjs    # 信令：两台宿主走真实 TCP 建连、单播、广播、断线
node test/election.test.mjs     # 房主选举：房主退出 → 继任者接管原房间码 → 新成员仍能加入
node test/client.test.mjs       # 端到端：两个 Controller + 真实 SQLite + 真实 TCP
node test/registration.test.mjs # 注册契约：侧栏 id 与 main key 对齐、ctx.effect 收尾
```

`client.test.mjs` 的做法：Node 里用 `vm` 加载 `client.js`，用一个假的
`RTCPeerConnection`/`DataChannel`（自动配对、open、投递），两边各自建真实 Store + SignalingHub，
跑完「建房 → 加入 → DataChannel 通 → 发文字 → 建频道 → 频道隔离 → 内置表情 → 自定义表情落地 →
改昵称 → 关库重开仍可读」整条链。

调试技巧：

- 面板底部「调试信息」显示数据库路径与各表条数（确认落库位置）；
- DevTools（DSH 窗口 `Ctrl+Shift+I`）里有调试抓手：`__tuBubbles.controller.state` 看状态，
  `__tuBubbles.controller.mesh.peers` 看每条 PeerConnection 的 `pc/ice/sig/dc` 状态；
- 搜 `[tu-bubbles]` 前缀的日志（落库失败、offer/answer 失败都会打）；
- 连不上时先看：两端是否在同一网段、Windows 防火墙是否放行、邀请串里的 IP 是否是房主的局域网地址；
- 信令层面可以用 `node -e` 直接 `parseInvite` 验证邀请串格式。

### 同机模拟「两台机器」（双宿主，已实测通过）

一个宿主进程只能有一间房，所以同机验证要起第二个宿主，并让它用**独立的库目录**：

```powershell
# 第二个宿主：web profile，独立监听端口
dsh plugin --profile web add D:\JunRepos\dsh-chat-tu
# 在 C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml 末尾加：
#   - id: tu-bubbles
#     config:
#       dataDir: C:/Users/<你>/AppData/Local/Temp/dsh-home-b/storages/tu-bubbles
dsh web --port 52600 --no-open     # 注意：web 子命令已隐含 web profile，别再传 --profile
```

然后在两个浏览器里分别打开 `http://127.0.0.1:52514`（桌面宿主）和 `http://127.0.0.1:52600`，
各自进「吐泡泡」：A 建房间 → 复制邀请串 → B 点「断开房间」（如果还残留旧房间）→ 粘贴加入。

实测结果（2026-11-16）：双方 `pc/ice = connected`、`dc = open`，成员列表互相「已连接」，
A→B、B→A 双向文字消息都即时到达；两端数据库各自落盘。

验证完房主选举后，把第二个宿主清掉（**web profile 出厂不该带这个测试依赖**）：

```powershell
dsh plugin --profile web remove dsh-tu-bubbles
# 该命令会同时从 node_modules、pnpm-lock.yaml 与 dsh.profile.bundles 里删干净
```

在同机双宿主上验证选举：A 建房、B 加入 → 在 A 点「断开房间」→ B 应弹出「原房主已离开，本机已接管房间」，
成员列表里换成 B 当房主、房间码不变；此时再开第三个宿主用 `B 的地址/原房间码` 仍能加入。

## 8. 已知限制与替代方案

| 限制 | 原因 | 替代 |
| --- | --- | --- |
| 不能跨公网 / 跨 NAT | 只依赖 host candidate，无 STUN/TURN（需求内明确不做） | 在 `Mesh.createPeer` 的 `iceServers` 加 TURN 即可 |
| 房主退出会短暂断流 | 信令先断、再选举、再重连 | 已实现自动选举（[ADR 0006](docs/adr/0006-host-election.md)），约 0.3s 起；要更快可把信令放到固定机器 |
| 渲染层不能直连对端信令 | 混合内容拦截 + DSH webserver 只绑本机 | 已由宿主 TCP 中继实现 |
| 无消息推送 | 跨进程没有事件总线 | 房间内 500 ms 轮询（不在房间不轮询） |
| 成员列表不含未连过的人 | 没有账号目录服务 | `peers` 表记录「见过的人」 |
| 同一账号多端 | 允许，memberId 带设备后缀区分 | 若需互斥，可在 `room/join` 里加踢人策略 |
| 频道归档 | 仅隐藏当前设备上的本地频道，保留历史消息 | 若要房间级归档，需要先定义共享目录与权限 |
| 一个宿主只能一间房 | 信令中继是宿主内的单例 `SignalingHub` | 同机互聊请起第二个宿主（`dsh web --port`），并配独立 `dataDir` |
| 同机多进程共用 `chat.db` | 同一个 DSH home → 同一路径 | 给每个进程配独立 `dataDir`；落库失败时不 ACK，发送端可重试 |
| 表情 ≤ 256 KB | 走 DataChannel + SQLite BLOB | 超限拒绝并提示 |
| 同账号互发看不出「对方发的」 | 消息归属按 `senderId`（账号 id）+ `direction` 判定，同账号两端的消息气泡样式一致 | 两端用不同 DSH 账号即可正常区分左右 |

## 9. 未决 / 待确认

以下是在需求里没有明确、我按默认方案实现、需要产品确认的点：

1. **(待确认：频道密码)** 当前频道无密码，任何人进房间即可见全部频道；
2. **(待确认：成员管理)** 当前没有踢人/拉黑/管理员角色，成员 = 在线 peer + 见过的人；
3. **(待确认：默认频道名)** 固定 `#大厅`，不可改名、不可归档；
4. **(待确认：消息可见性)** 所有频道消息都会落到每个成员的本地库，只在 UI 上按频道过滤；
   如果要求「不在某频道就不留存它的消息」，需要改成订阅制（会牺牲「切回频道看历史」）；
5. **(待确认：登录入口)** 面板里的登录引导指向「设置 → 账号」，没有做一键跳转（未确认 settings 面板的
   key 是否稳定）；
6. ~~**(待确认：房主离开)**~~ 已按你的要求改为「房主离开自动选举新房主」，见
   [ADR 0006](docs/adr/0006-host-election.md)。

## 10. 设计决策

- [ADR 0001](docs/adr/0001-renderer-webrtc-host-signaling.md) WebRTC 在渲染层、信令中继在宿主
- [ADR 0002](docs/adr/0002-node-sqlite.md) 用 `node:sqlite`，零第三方依赖
- [ADR 0003](docs/adr/0003-plugin-rpc-channel.md) 自有 endpoint 走 `ctx.connection.rpc.handle('/tu-bubbles')` 独立通道
- [ADR 0004](docs/adr/0004-single-connection-multi-channel.md) 一条连接承载全部频道
- [ADR 0005](docs/adr/0005-emoji-blob-content-addressing.md) 表情 BLOB + 内容哈希去重
- [ADR 0006](docs/adr/0006-host-election.md) 房主离开后按成员表自动选举新房主

术语见 [GLOSSARY.md](GLOSSARY.md)。
