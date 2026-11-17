/**
 * 第一阶段异常路径回归：
 *   node test/regression.test.mjs
 *
 * 这些用例故意覆盖失败注入与迟到响应；生产修复前可以失败，失败项会全部列出。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const silent = { info() {}, warn() {}, error() {}, log() {} }
const clientCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient(ReactStub) {
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
    RTCPeerConnection: class {},
  }
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = { load: (definition) => (sandbox.__definition = definition) }
  vm.runInContext(clientCode, vm.createContext(sandbox), { filename: 'client.js' })
  const definition = sandbox.__definition
  assert.ok(definition, 'client.js 应注册模块定义')
  const mod = definition.factory(() => ReactStub)
  mod.__sandbox = sandbox
  return mod
}

const basicReact = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }

function makeController(call, mod = loadClient(basicReact)) {
  const controller = new mod.__internals.Controller({}, call)
  controller.state.identity = { signedIn: true, accountId: 'acct-local', name: 'Local' }
  controller.state.nickname = 'Local'
  controller.state.channels = [{ id: 'lobby', name: '大厅' }]
  controller.state.activeChannelId = 'lobby'
  controller.state.members = [{ memberId: 'member-peer', accountId: 'acct-peer', name: 'Peer', isSelf: false }]
  const sent = []
  controller.mesh = {
    peers: new Map([['member-peer', { accountId: 'acct-peer', remoteName: 'Peer' }]]),
    onlineCount: () => 0,
    sendTo(memberId, payload) {
      sent.push({ memberId, payload })
      return true
    },
    broadcast: () => 0,
    dispose() {},
  }
  return { controller, sent }
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('等待异步夹具就绪超时')
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

/** 用实际组件入口渲染一遍 Panel，检查 Composer 的本地状态。 */
function createPanelHarness(call) {
  const instances = new Map()
  let current = null
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      assert.ok(current, 'useState 必须在组件渲染中调用')
      const instance = current
      const index = current.index++
      if (!(index in current.hooks)) current.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [current.hooks[index], (next) => {
        instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next
      }]
    },
    useRef(initial) {
      assert.ok(current, 'useRef 必须在组件渲染中调用')
      const index = current.index++
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect() {},
  }
  const mod = loadClient(ReactStub)
  // 组件名足够作为 key：夹具状态只有一个 Panel/Composer 实例。
  const renderElement = (element) => {
    if (!element || typeof element !== 'object') return element
    if (typeof element.type === 'function') {
      const key = element.type.name
      const instance = instances.get(key) ?? { hooks: [], index: 0 }
      instances.set(key, instance)
      instance.index = 0
      const previous = current
      current = instance
      const result = element.type(element.props ?? {})
      current = previous
      return renderElement(result)
    }
    return { ...element, children: (element.children ?? []).map(renderElement) }
  }

  const registrations = []
  mod.apply({
    connection: {
      rpc: {
        call: async (_channel, op, payload) => {
          try {
            return { ok: true, value: await call(op, payload) }
          } catch (error) {
            return { ok: false, error: { message: error?.message ?? String(error) } }
          }
        },
      },
    },
    slots: {
      inject(_key, callback) {
        callback()
      },
      register(options, render) {
        registrations.push({ options, render })
        return () => {}
      },
    },
    effect() {},
  })
  const controller = mod.__sandbox.__tuBubbles.controller
  assert.ok(controller, '应用入口应创建 Controller')
  const main = registrations.find(({ options }) => options.name === 'main')
  assert.ok(main, '应注册 main 面板')
  return { controller, render: () => renderElement(main.render()), findNode }
}

async function uninstallFailureKeepsData() {
  const root = mkdtempSync(join(tmpdir(), 'tu-uninstall-regression-'))
  try {
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    const dataDir = join(dshHome, 'storages', 'tu-bubbles')
    const binDir = join(root, 'bin')
    const marker = join(root, 'dsh-invoked.txt')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(dataDir, 'chat.db'), 'keep me')
    writeFileSync(join(binDir, 'dsh.cmd'), `@echo off\r\necho invoked>"${marker}"\r\nexit /b 17\r\n`)

    // Windows PowerShell 5.1 只可靠识别带 BOM 的 UTF-8；测试夹具复制脚本字节，不改生产文件。
    const scriptWithBom = join(root, 'uninstall-utf8bom.ps1')
    writeFileSync(scriptWithBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(resolve('scripts/uninstall.ps1'))]))
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptWithBom, '-ProfileName', 'desktop'],
      {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome, PATH: `${binDir};${process.env.PATH ?? ''}` },
      },
    )
    assert.ok(existsSync(marker), `测试夹具未调用 mock dsh：${result.stdout}\n${result.stderr}`)
    assert.notEqual(result.status, 0, 'dsh remove 非零时卸载脚本必须失败')
    assert.ok(existsSync(join(dataDir, 'chat.db')), '卸载失败时不得删除聊天数据')
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /卸载完成/, '卸载失败时不得输出成功')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function uninstallExplicitRemovalDeletesOnlyWhenRequested() {
  const root = mkdtempSync(join(tmpdir(), 'tu-uninstall-explicit-'))
  try {
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    const dataDir = join(dshHome, 'storages', 'tu-bubbles')
    const binDir = join(root, 'bin')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(dataDir, 'chat.db'), 'delete me')
    writeFileSync(join(binDir, 'dsh.cmd'), '@echo off\r\nexit /b 0\r\n')
    const scriptWithBom = join(root, 'uninstall-utf8bom.ps1')
    writeFileSync(scriptWithBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(resolve('scripts/uninstall.ps1'))]))
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptWithBom, '-ProfileName', 'desktop', '-RemoveData'],
      { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome, PATH: `${binDir};${process.env.PATH ?? ''}` } },
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(existsSync(dataDir), false, '只有显式 -RemoveData 才删除数据目录')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function assertReceiveFailure(message, reason, requireAppend) {
  const calls = []
  const { controller, sent } = makeController(async (op, payload) => {
    calls.push({ op, payload })
    if (op === 'channels/ensure') return { id: 'lobby', name: '大厅' }
    if (op === 'messages/append') throw new Error(reason)
    throw new Error(`unexpected op: ${op}`)
  })
  try {
    await controller.handleIncoming({ t: 'msg', message }, 'member-peer')
    assert.equal(controller.state.messages.length, 0, `${reason} 不得进入消息 UI`)
    assert.equal(sent.length, 0, `${reason} 不得发送 ACK`)
    if (requireAppend) assert.ok(calls.some(({ op }) => op === 'messages/append'), '持久化失败夹具应命中 messages/append')
  } finally {
    controller.dispose()
  }
}

async function invalidBodyDoesNotAckOrDisplay() {
  await assertReceiveFailure(
    { id: 'invalid-body', channelId: 'lobby', channelName: '大厅', senderId: 'acct-peer', senderName: 'Peer', kind: 'text', body: { nope: true }, sentAt: 1 },
    'invalid body',
    false,
  )
}

async function persistenceFailureDoesNotAckOrDisplay() {
  await assertReceiveFailure(
    { id: 'store-failure', channelId: 'lobby', channelName: '大厅', senderId: 'acct-peer', senderName: 'Peer', kind: 'text', body: '需要持久化', sentAt: 1 },
    'database unavailable',
    true,
  )
}

async function mismatchedSenderIsRejected() {
  const calls = []
  const { controller, sent } = makeController(async (op, payload) => {
    calls.push({ op, payload })
    if (op === 'channels/ensure') return { id: 'lobby', name: '大厅' }
    if (op === 'messages/append') {
      return { inserted: true, message: { ...payload.message } }
    }
    throw new Error(`unexpected op: ${op}`)
  })
  try {
    await controller.handleIncoming(
      {
        t: 'msg',
        message: {
          id: 'forged-sender',
          channelId: 'lobby',
          channelName: '大厅',
          senderId: 'acct-attacker',
          senderName: 'Attacker',
          kind: 'text',
          body: '冒充消息',
        },
      },
      'member-peer',
    )
    assert.equal(calls.filter(({ op }) => op === 'messages/append').length, 0, '信封 sender 与连接成员不一致时不得落库')
    assert.equal(controller.state.messages.length, 0, '冒充消息不得进入 UI')
    assert.equal(sent.length, 0, '冒充消息不得发送 ACK')
  } finally {
    controller.dispose()
  }
}

async function localSaveFailureKeepsComposerDraft() {
  const harness = createPanelHarness(async (op) => {
    if (op === 'messages/append') throw new Error('database unavailable')
    throw new Error(`unexpected op: ${op}`)
  })
  const { controller } = harness
  controller.state.identity = { signedIn: true, accountId: 'acct-local', name: 'Local' }
  controller.state.nickname = 'Local'
  controller.state.status = 'ready'
  controller.state.channels = [{ id: 'lobby', name: '大厅' }]
  controller.state.activeChannelId = 'lobby'
  try {
    assert.equal(await controller.sendText('直接调用也失败'), false, '本地落库失败时 sendText 必须返回 false')
    let tree = harness.render()
    let textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    assert.ok(textarea, `应找到消息输入框：${JSON.stringify(tree, (_key, value) => (typeof value === 'function' ? value.name : value))}`)
    textarea.props.onChange({ target: { value: '落库失败也要保留' } })
    tree = harness.render()
    const send = harness.findNode(tree, (node) => node.type === 'button' && String(node.props.className).includes('tub-send'))
    assert.ok(send, '应找到发送按钮')
    await send.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = harness.render()
    textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    assert.equal(textarea.props.value, '落库失败也要保留', '本地保存失败后草稿必须仍可编辑')
  } finally {
    controller.dispose()
  }
}

async function composerKeepsNewDraftDuringSuccessfulSave() {
  let appendRequest
  const harness = createPanelHarness(async (op, payload) => {
    if (op === 'messages/append') {
      const pending = deferred()
      appendRequest = { payload, pending }
      return pending.promise
    }
    if (op === 'messages/status') {
      return { ...appendRequest.payload.message, status: payload.status }
    }
    throw new Error(`unexpected op: ${op}`)
  })
  const { controller } = harness
  controller.state.identity = { signedIn: true, accountId: 'acct-local', name: 'Local' }
  controller.state.nickname = 'Local'
  controller.state.status = 'ready'
  controller.state.channels = [{ id: 'lobby', name: '大厅' }]
  controller.state.activeChannelId = 'lobby'
  try {
    let tree = harness.render()
    let textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    textarea.props.onChange({ target: { value: '原始草稿' } })
    tree = harness.render()
    const send = harness.findNode(tree, (node) => node.type === 'button' && String(node.props.className).includes('tub-send'))
    const sending = send.props.onClick()
    await waitFor(() => Boolean(appendRequest))

    textarea = harness.findNode(harness.render(), (node) => node.type === 'textarea')
    assert.equal(textarea.props.value, '原始草稿', '等待本地保存期间不得提前清空原草稿')
    textarea.props.onChange({ target: { value: '用户后来输入的新草稿' } })
    appendRequest.pending.resolve({
      inserted: true,
      message: { ...appendRequest.payload.message, direction: 'out', status: 'sending' },
    })
    assert.equal(await sending, undefined, 'Composer 点击处理器可不暴露内部结果')
    tree = harness.render()
    textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    assert.equal(textarea.props.value, '用户后来输入的新草稿', '成功保存旧草稿时不得清空用户后来输入的内容')
  } finally {
    controller.dispose()
  }
}

async function composerClearsUnchangedDraftAfterSuccessfulSave() {
  const harness = createPanelHarness(async (op, payload) => {
    if (op === 'messages/append') return { inserted: true, message: { ...payload.message, direction: 'out', status: 'sending' } }
    if (op === 'messages/status') return { ...payload.message, status: payload.status }
    throw new Error(`unexpected op: ${op}`)
  })
  const { controller } = harness
  controller.state.identity = { signedIn: true, accountId: 'acct-local', name: 'Local' }
  controller.state.nickname = 'Local'
  controller.state.status = 'ready'
  controller.state.channels = [{ id: 'lobby', name: '大厅' }]
  controller.state.activeChannelId = 'lobby'
  try {
    let tree = harness.render()
    let textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    textarea.props.onChange({ target: { value: '成功发送后清空' } })
    tree = harness.render()
    const send = harness.findNode(tree, (node) => node.type === 'button' && String(node.props.className).includes('tub-send'))
    await send.props.onClick()
    tree = harness.render()
    textarea = harness.findNode(tree, (node) => node.type === 'textarea')
    assert.equal(textarea.props.value, '', '本地保存成功且草稿未变化时应清空输入')
  } finally {
    controller.dispose()
  }
}

async function deliveredStatusDoesNotRevertToSent() {
  const message = { id: 'status-race', channelId: 'lobby', channelName: '大厅', senderId: 'acct-local', senderName: 'Local', kind: 'text', body: '状态竞态', sentAt: 1 }
  const sentResponse = deferred()
  let sentStatusRequested = false
  const { controller } = makeController(async (op, payload) => {
    if (op === 'messages/append') return { inserted: true, message: { ...payload.message } }
    if (op === 'messages/status' && payload.status === 'sent') {
      sentStatusRequested = true
      return sentResponse.promise
    }
    if (op === 'messages/status' && payload.status === 'delivered') {
      return { ...message, direction: 'out', status: 'delivered' }
    }
    throw new Error(`unexpected op: ${op}`)
  })
  controller.mesh.onlineCount = () => 1
  controller.mesh.broadcast = () => 1
  try {
    const dispatching = controller.dispatch(message, null)
    await waitFor(() => sentStatusRequested)
    await controller.handleIncoming({ t: 'ack', id: message.id }, 'member-peer')
    assert.equal(controller.state.messages.find((item) => item.id === message.id)?.status, 'delivered', 'ACK 应先把状态推进到 delivered')
    sentResponse.resolve({ ...message, direction: 'out', status: 'sent' })
    await dispatching
    assert.equal(controller.state.messages.find((item) => item.id === message.id)?.status, 'delivered', '迟到的 sent 响应不得覆盖 delivered')
  } finally {
    controller.dispose()
  }
}

async function lateAppendDoesNotLeakAcrossChannels() {
  const appendResponse = deferred()
  const { controller } = makeController(async (op, payload) => {
    if (op === 'messages/append') return appendResponse.promise
    if (op === 'messages/list') return { messages: [] }
    if (op === 'messages/status') return { ...payload, status: 'failed' }
    throw new Error(`unexpected op: ${op}`)
  })
  controller.state.channels = [
    { id: 'lobby', name: '大厅' },
    { id: 'other', name: '另一个频道' },
  ]
  controller.state.activeChannelId = 'lobby'
  const message = { id: 'late-channel', channelId: 'lobby', channelName: '大厅', senderId: 'acct-local', senderName: 'Local', kind: 'text', body: '迟到响应' }
  try {
    const dispatching = controller.dispatch(message, null)
    await controller.selectChannel('other')
    appendResponse.resolve({ inserted: true, message: { ...message, direction: 'out', status: 'sending' } })
    await dispatching
    assert.equal(controller.state.activeChannelId, 'other')
    assert.equal(controller.state.messages.length, 0, '旧频道的迟到落库响应不得串入当前频道')
  } finally {
    controller.dispose()
  }
}

async function stalePollingDoesNotRestoreRoom() {
  const pending = deferred()
  let syncCalls = 0
  const { controller } = makeController(async (op) => {
    if (op === 'sync') {
      syncCalls += 1
      return pending.promise
    }
    throw new Error(`unexpected op: ${op}`)
  })
  try {
    controller.startPolling()
    await waitFor(() => syncCalls === 1)
    controller.stopPolling()
    pending.resolve({ room: { role: 'host', roomCode: 'STALE' }, events: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(controller.state.room, null, '退出后迟到 sync 不得恢复旧房间')
  } finally {
    controller.dispose()
  }
}

async function staleRoomOperationDoesNotRestoreRoom() {
  const pending = deferred()
  let createCalls = 0
  const { controller } = makeController(async (op) => {
    if (op === 'room/create') {
      createCalls += 1
      return pending.promise
    }
    if (op === 'room/leave') return null
    throw new Error(`unexpected op: ${op}`)
  })
  try {
    const creating = controller.createRoom()
    await waitFor(() => createCalls === 1)
    await controller.leaveRoom()
    pending.resolve({ role: 'host', roomCode: 'STALE' })
    await creating
    assert.equal(controller.state.room, null, '离开后迟到的 createRoom 不得恢复旧房间')
  } finally {
    controller.dispose()
  }
}

async function staleLeaveDoesNotClearNewRoom() {
  const firstLeave = deferred()
  let leaveCalls = 0
  let createCalls = 0
  const { controller } = makeController(async (op) => {
    if (op === 'room/leave') {
      leaveCalls += 1
      return leaveCalls === 1 ? firstLeave.promise : null
    }
    if (op === 'room/create') {
      createCalls += 1
      return { role: 'host', roomCode: 'NEW', epoch: 2, members: [] }
    }
    if (op === 'sync') return { events: [], room: { role: 'host', roomCode: 'NEW', epoch: 2, members: [] } }
    throw new Error(`unexpected op: ${op}`)
  })
  controller.state.room = { role: 'host', roomCode: 'OLD', epoch: 1, members: [] }
  try {
    const leaving = controller.leaveRoom()
    await waitFor(() => leaveCalls === 1)
    const creating = controller.createRoom()
    await waitFor(() => createCalls === 1)
    firstLeave.resolve(null)
    await Promise.all([leaving, creating])
    controller.stopPolling()
    assert.equal(controller.state.room?.roomCode, 'NEW', '迟到 leave 响应不得清空新房间')
  } finally {
    controller.dispose()
  }
}

async function relayMetadataFallbackConverges() {
  const { controller } = makeController(async (op) => {
    if (op === 'channels/ensure') return { id: 'lobby', name: '改名后' }
    if (op === 'channels/list') return { channels: [{ id: 'lobby', name: '改名后' }] }
    throw new Error(`unexpected op: ${op}`)
  })
  controller.state.channels = [{ id: 'lobby', name: '大厅' }]
  try {
    await controller.handleEvent({ kind: 'signal', payload: { kind: 'channel-renamed', channel: { id: 'lobby', name: '改名后' } } })
    assert.equal(controller.state.channels[0].name, '改名后', '信令中继改名事件应绕过 Mesh 业务层收敛')
    await controller.handleEvent({ kind: 'signal', payload: { kind: 'nickname', accountId: 'acct-peer', name: '新昵称' } })
    assert.equal(controller.state.members.find((member) => member.accountId === 'acct-peer')?.name, '新昵称')
  } finally {
    controller.dispose()
  }
}

const tests = [
  ['卸载 CLI 失败保留数据', uninstallFailureKeepsData],
  ['显式删除参数才清理数据', uninstallExplicitRemovalDeletesOnlyWhenRequested],
  ['非法 body 不 ACK/不显示', invalidBodyDoesNotAckOrDisplay],
  ['持久化失败不 ACK/不显示', persistenceFailureDoesNotAckOrDisplay],
  ['连接身份与信封 sender 不一致时拒绝', mismatchedSenderIsRejected],
  ['本地落库失败保留草稿', localSaveFailureKeepsComposerDraft],
  ['成功保存期间保留新草稿', composerKeepsNewDraftDuringSuccessfulSave],
  ['成功保存后清空原草稿', composerClearsUnchangedDraftAfterSuccessfulSave],
  ['ACK 先到时状态不回退', deliveredStatusDoesNotRevertToSent],
  ['切频道时迟到响应不串显', lateAppendDoesNotLeakAcrossChannels],
  ['退出后迟到轮询不恢复旧房间', stalePollingDoesNotRestoreRoom],
  ['离开后迟到建房不恢复旧房间', staleRoomOperationDoesNotRestoreRoom],
  ['新建房后迟到离开不清空新房间', staleLeaveDoesNotClearNewRoom],
  ['信令中继元数据可回退收敛', relayMetadataFallbackConverges],
]

const failures = []
for (const [name, test] of tests) {
  try {
    await test()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`✗ ${name}: ${error?.message ?? error}`)
  }
}

if (failures.length) {
  console.error(`回归测试失败 ${failures.length}/${tests.length}；生产修复后运行 node test/regression.test.mjs 复验。`)
  process.exitCode = 1
} else {
  console.log('✓ regression.test.mjs 全部通过')
}
