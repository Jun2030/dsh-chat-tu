# 术语表（GLOSSARY）

> 这个文件只收录「在本项目里有特定含义」的词。日常汉语里的普通用法不重复解释。

## 身份

**accountId**
DSH 账号 id，来自 `deepseekAccount.getProfile().id`。是 peer 的**逻辑身份**：同一个人换设备、
改昵称、重装插件，`accountId` 不变。

**memberId**
`<accountId>:<设备后缀>`，形如 `acc_9f3:lwp5n3`。是**一次会话的连接身份**。
同账号可以在两台机器上同时在线（两个 memberId），互不顶号。
设备后缀存在渲染层 `localStorage`，清掉就等于换了台「设备」。

**昵称（nickname）**
本机账号给自己起的显示名，存 `profiles` 表，键是 `accountId`。最长 24 字符。
别人看到的名字来自房间成员表，不是你库里那一行。

**未登录 / 已登录**
`deepseekAccount.getState().status` 只有两个值：`signed-out`、`credential-stored`。
本插件把后者视为已登录。**不提供任何其他登录方式**（Q4 决策）。

## 网络

**房间（room）**
一次 WebRTC 组网的范围。一个房间有一个房主、N 个加入者，所有人两两直连。
同一个人同一时刻只在一个房间里。

**房主（host）**
创建房间的那一端。它的**宿主进程**在 `0.0.0.0:<端口>` 上监听 TCP，负责把 SDP/ICE 转发给其他人。
房主退出后不会散房：其余成员会自动选一个新**房主**（见下文「房主选举」）。

**standby 监听**
每个成员进房间时就开好的一个常驻 TCP 监听端口，地址广播在成员表里。
平时它不收连接（不在房间/不是房主时直接断开），一旦被选为新**房主**就在**原端口**上接管。

**房主选举**
房主离开后，所有成员用同一份成员表算出唯一继任者：**除旧房主外 `memberId` 字典序最小者**。
继任者沿用原房间码与自己的 standby 端口；其他人按「候选地址/原房间码」重连。
已建立的 DataChannel 不重建（ADR 0006）。

**加入者（guest）**
用邀请串连到房主信令端口的一端。断线后先原地重连房主（3 次、约 3s），连不上才参与房主选举。

**邀请串**
`192.168.1.5:51820/ABC123`，即 `IP:端口/房间码`。房主把本机局域网地址拼好后复制给对端。
房间码 6 位，去掉了易混的 `0/O/1/I`。

**信令（signaling）**
交换 SDP 与 ICE 候选的过程。**注意：信令走宿主 TCP，聊天内容不写信令。**

**信封（envelope）**
DataChannel 上传输的 JSON 对象，用 `t` 字段区分类型：`hello` / `msg` / `ack` / `channels` / `nickname`。

**offer 方**
`memberId` 字典序更小的那一端。由它发 offer，也由它负责断线重连——两端规则一致，避免同时发 offer（glare）。

**非 trickle ICE**
等 ICE 收集完成（`iceGatheringState === 'complete'`，上限 2.5 秒）后，把完整 SDP 一次性发出去，
而不是逐条发候选。同网段足够快，且让信令报文保持「一条 offer、一条 answer」。

## 消息

**频道（channel）**
消息的分区，类似 IRC 的 channel。默认频道是 `#大厅`（`id = 'lobby'`），不可归档。
**频道不是连接**：所有频道共用一条 DataChannel（ADR 0004）。

**落库**
把消息写进本机 SQLite。对方发来的消息也会落库，所以断网/重启后仍可读（验收标准之一）。

**送达（delivered）**
本机消息状态机：`sending`（已落库）→ `sent`（已写入 DataChannel）→ `delivered`（收到对端 `ack`）。
无在线成员时直接 `failed`，可点重试。

**内置表情**
客户端常量表里的 unicode 表情（40 个），不需要落库，消息 `body` 是 `{"unicode":"🐷"}`。

**自定义表情**
用户上传的图片（PNG/GIF/WebP ≤ 256 KiB），存 `emojis` 表 BLOB，
id 是内容的 `sha256` 前 16 位（`e-…`），所以同一张图双端落地不会重复（ADR 0005）。
