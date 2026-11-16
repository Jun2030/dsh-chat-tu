/**
 * 客户端逻辑端到端测试（Node，无需浏览器）
 *
 * 用「假 RTCPeerConnection」模拟 WebRTC 连接：SDP 仍然真的经过两个 host 之间的
 * 真实 TCP 信令中继，DataChannel 的 send 直接投递给对端的 onmessage。
 * 这样能验证：offer/answer 流程、消息落库、送达回执、频道同步、昵称同步、
 * 表情（内置 + 自定义二进制）传输，而不需要真的开渲染进程。
 *
 *   node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { Store } from '../host/store.js'
import { SignalingHub } from '../host/signaling.js'
import { createRouter } from '../host/rpc.js'

const silent = { info() {}, warn() {}, error() {}, log() {} }
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------- 假 WebRTC 基础设施 */

const pcs = new Map()
let pcSeq = 0

class FakeDataChannel {
  constructor(label) {
    this.label = label
    this.readyState = 'connecting'
    this.peer = null
    this.onopen = null
    this.onclose = null
    this.onmessage = null
    this.listeners = {}
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  emit(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('datachannel not open')
    const peer = this.peer
    queueMicrotask(() => {
      peer?.onmessage?.({ data })
      peer?.emit('message', { data })
    })
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
  open(peer) {
    this.readyState = 'open'
    this.peer = peer
    queueMicrotask(() => {
      this.onopen?.()
      this.emit('open', {})
    })
  }
}

class FakePeerConnection {
  constructor() {
    this.id = `pc${++pcSeq}`
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.iceGatheringState = 'complete'
    this.local = null
    this.remote = null
    this.channels = []
    this.remotePeer = null
    this.listeners = {}
    pcs.set(this.id, this)
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn)
  }
  emit(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  createDataChannel(label) {
    const channel = new FakeDataChannel(label)
    this.channels.push(channel)
    return channel
  }
  async createOffer() {
    this.signalingState = 'have-local-offer'
    return { type: 'offer', sdp: `offer:${this.id}` }
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer:${this.id}` }
  }
  get localDescription() {
    return this.local
  }
  get remoteDescription() {
    return this.remote
  }
  async setLocalDescription(description) {
    this.local = description
  }
  async setRemoteDescription(description) {
    this.remote = description
    const [kind, id] = String(description?.sdp ?? '').split(':')
    const other = pcs.get(id)
    if (!other) return
    this.remotePeer = other
    other.remotePeer = other.remotePeer ?? this
    this.signalingState = kind === 'offer' ? 'have-remote-offer' : 'stable'
    this.connectIfReady()
  }
  /** 两端都拿到 local+remote 后接通（模拟 ICE 成功）。 */
  connectIfReady() {
    const other = this.remotePeer
    if (!other || !this.local || !other.local) return
    if (this.connectionState === 'connected' || other.connectionState === 'connected') return
    const [offerer, answerer] = other.local.type === 'offer' ? [other, this] : [this, other]
    const outgoing = offerer.channels[0]
    if (outgoing) {
      const incoming = new FakeDataChannel('tu-bubbles')
      // 先让接收端挂好 handler，再 open，避免丢事件。
      answerer.emit('datachannel', { channel: incoming })
      outgoing.open(incoming)
      incoming.open(outgoing)
    }
    for (const pc of [offerer, answerer]) {
      pc.connectionState = 'connected'
      pc.emit('connectionstatechange', {})
    }
  }
  close() {
    this.connectionState = 'closed'
    this.emit('connectionstatechange', {})
  }
}

/* --------------------------------------------------------- 客户端加载环境 */

function loadClient() {
  const sandbox = {
    console: silent,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    window: {
      localStorage: {
        store: new Map(),
        getItem(key) {
          return this.store.has(key) ? this.store.get(key) : null
        },
        setItem(key, value) {
          this.store.set(key, String(value))
        },
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, set textContent(value) {}, id: '' }),
      head: { appendChild() {} },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    RTCPeerConnection: FakePeerConnection,
  }
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load(definition) {
      sandbox.__definition = definition
    },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(code, context, { filename: 'client.js' })
  const definition = sandbox.__definition
  assert.ok(definition, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-tu-bubbles')

  const ReactStub = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const moduleExports = definition.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未知模块 ${name}`)
  })
  assert.ok(moduleExports?.apply, '客户端模块需要导出 apply')
  return moduleExports
}

/** 一台「本机」：真实 Store + 真实 SignallingHub + 真实 RPC 路由 + 一个客户端 Controller。 */
function makeHost({ accountId, name }) {
  const dir = mkdtempSync(join(tmpdir(), 'tu-cli-'))
  const store = new Store(join(dir, 'chat.db'))
  const hub = new SignalingHub({ logger: silent })
  const identity = async () => ({ signedIn: true, accountId, name, avatarUrl: null })
  const handler = createRouter({ store, hub, identity, logger: silent })
  const rpc = { call: async (_channel, endpoint, payload) => handler(endpoint, payload) }
  const ctx = { connection: { rpc } }
  const clientModule = loadClient()
  const controller = new clientModule.__internals.Controller(ctx, clientModule.__internals.createCall(ctx))
  const cleanup = () => {
    try {
      controller.dispose()
    } catch {
      /* 已结束 */
    }
    try {
      hub.dispose()
    } catch {
      /* 已结束 */
    }
    try {
      store.close()
    } catch {
      /* 已关闭 */
    }
    // Windows 下 SQLite 文件句柄释放有延迟，给 rmSync 一点重试余地。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch (error) {
      console.warn('[tu-bubbles] 临时目录清理失败', error.message)
    }
  }
  return { dir, store, hub, controller, cleanup }
}

const waitFor = async (predicate, timeout = 5000, label = '条件') => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${label}`)
}

/* ------------------------------------------------------------------ 用例 */

const hostA = makeHost({ accountId: 'acct-a', name: 'A' })
const hostB = makeHost({ accountId: 'acct-b', name: 'B' })

try {
  await hostA.controller.init()
  await hostB.controller.init()
  assert.equal(hostA.controller.state.identity.accountId, 'acct-a')
  assert.equal(hostB.controller.state.identity.accountId, 'acct-b')
  // 默认频道「大厅」自动加入（Q3）
  assert.equal(hostA.controller.state.activeChannelId, 'lobby')
  assert.deepEqual(hostA.controller.state.channels.map((c) => c.name), ['大厅'])

  /* ---------------------------------------------------------- 建房 / 加入 */
  await hostA.controller.createRoom()
  const room = hostA.controller.state.room
  assert.equal(room.role, 'host')
  assert.ok(room.invites.length >= 1, '房主应拿到邀请串')

  const invite = `127.0.0.1:${room.port}/${room.roomCode}`
  await hostB.controller.joinRoom(invite)
  assert.equal(hostB.controller.state.room.role, 'guest')

  // 两条 WebRTC 连接应该连上（真实 TCP 信令 + 假 RTC）
  await waitFor(() => hostA.controller.mesh.onlineCount() === 1, 6000, 'A 侧 DataChannel 打开')
  await waitFor(() => hostB.controller.mesh.onlineCount() === 1, 6000, 'B 侧 DataChannel 打开')
  assert.equal(hostA.controller.state.members.length, 2)
  assert.equal(hostB.controller.state.members.length, 2)

  /* -------------------------------------------------------------- 文字消息 */
  await hostA.controller.sendText('你好，吐泡泡')
  await waitFor(
    () => hostB.controller.state.messages.some((m) => m.body === '你好，吐泡泡' && m.kind === 'text'),
    5000,
    'B 收到文字消息',
  )
  const received = hostB.controller.state.messages.find((m) => m.body === '你好，吐泡泡')
  assert.equal(received.direction, 'in')
  assert.equal(received.senderId, 'acct-a')
  assert.equal(received.senderName, 'A')
  // 双方都落库（B 走 messages/append direction:'in'）
  assert.equal(hostA.store.listMessages('lobby').length, 1)
  assert.equal(hostB.store.listMessages('lobby').length, 1)

  // 送达回执：B 落库后回 ack，A 的状态应变成 delivered
  await waitFor(
    () => hostA.controller.state.messages.find((m) => m.body === '你好，吐泡泡')?.status === 'delivered',
    5000,
    'A 收到送达回执',
  )

  /* ---------------------------------------------------------------- 频道 */
  await hostA.controller.createChannel('摸鱼')
  const created = hostA.controller.state.channels.find((c) => c.name === '摸鱼')
  assert.ok(created, '房主应建出频道')
  await waitFor(
    () => hostB.controller.state.channels.some((c) => c.name === '摸鱼'),
    5000,
    'B 同步到新频道',
  )
  // 切到新频道发消息，验证频道归属
  await hostA.controller.selectChannel(created.id)
  await hostA.controller.sendText('频道隔离测试')
  await waitFor(
    () => hostB.controller.state.channels.find((c) => c.name === '摸鱼') && hostB.store.listMessages(created.id).length === 1,
    5000,
    'B 在「摸鱼」频道收到消息',
  )
  assert.equal(hostB.store.listMessages('lobby').length, 1, '频道消息不能串到大厅')
  assert.equal(hostA.controller.state.messages.filter((m) => m.body === '频道隔离测试').length, 1)

  /* -------------------------------------------------------------- 内置表情 */
  // 回到大厅，验证「切回频道仍能看到历史」
  await hostA.controller.selectChannel('lobby')
  await hostB.controller.selectChannel('lobby')
  await hostA.controller.sendEmoji({ unicode: '🐷' })
  await waitFor(
    () => hostB.controller.state.messages.some((m) => m.kind === 'emoji' && JSON.parse(m.body).unicode === '🐷'),
    5000,
    'B 收到内置表情消息',
  )

  /* ------------------------------------------------------------ 自定义表情 */
  // 1x1 PNG（真实的 PNG 字节，用来验证 BLOB 落地与内容哈希去重）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const added = await hostA.controller.call('emojis/add', {
    name: '猪猪',
    mime: 'image/png',
    data: png.toString('base64'),
  })
  await hostA.controller.refreshEmojis()
  assert.equal(hostA.controller.state.emojis.length, 1)

  await hostA.controller.sendEmoji({ id: added.id, name: '猪猪' })
  await waitFor(
    () => hostB.store.listMessages('lobby').some((m) => m.kind === 'emoji' && m.body.includes(added.id)),
    5000,
    'B 收到自定义表情消息',
  )
  // B 侧应把表情字节落到自己的 SQLite（内容哈希 id 相同 → 天然去重）
  const landed = hostB.store.getEmoji(added.id)
  assert.ok(landed, '自定义表情应落到对端 SQLite')
  assert.deepEqual(Buffer.from(landed.bytes), png)
  assert.equal(hostB.controller.state.emojis.length, 1)

  /* ---------------------------------------------------------------- 昵称 */
  await hostA.controller.setNickname('小明')
  await waitFor(
    () => hostB.controller.state.members.some((m) => m.accountId === 'acct-a' && m.name === '小明'),
    5000,
    'B 看到对方新昵称',
  )
  assert.equal(hostA.store.getProfile('acct-a').nickname, '小明')

  /* ---------------------------------------------------------- 重启后仍可读 */
  hostB.store.close()
  const reopened = new Store(join(hostB.dir, 'chat.db'))
  assert.equal(reopened.listMessages('lobby').length, 3)
  assert.equal(reopened.listMessages(created.id).length, 1)
  assert.ok(reopened.getEmoji(added.id))
  // 昵称存在「本机账号」自己的库里：A 的昵称在 A 的 SQLite（B 只通过房间成员表看到名字）
  hostA.store.close()
  const reopenedA = new Store(join(hostA.dir, 'chat.db'))
  assert.equal(reopenedA.getProfile('acct-a').nickname, '小明')
  reopenedA.close()
  reopened.close()

  console.log('✓ client.test.mjs 全部通过')
} finally {
  hostA.controller.dispose()
  hostB.controller.dispose()
  hostA.cleanup()
  hostB.cleanup()
}
