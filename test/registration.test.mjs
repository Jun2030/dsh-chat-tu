/**
 * 注册契约测试：验证 client.js 在 DSH 的槽位契约下注册了正确的入口。
 *
 * 不需要浏览器：用 vm 假装 `window.__ModuleLoader__`，用假的 ctx.slots 记录注册项，
 * 断言「左侧栏入口 + 主面板」的 id/key 对齐（DSH 要求 panellist.id 与 main.key 同名，
 * 侧栏才会自动切面板）。
 *
 *   node test/registration.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const sandbox = {
  console: { info() {}, warn() {}, error() {}, log() {} },
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  window: { localStorage: { getItem: () => null, setItem() {} } },
  document: {
    getElementById: () => ({}), // 样式已注入 → injectStyles 提前返回
    createElement: () => ({ style: {}, setAttribute() {}, set textContent(v) { this._t = v }, get textContent() { return this._t }, id: '' }),
    head: { appendChild() {} },
  },
  navigator: {},
  RTCPeerConnection: class {
    constructor() {
      throw new Error('注册测试不应该建立 PeerConnection')
    }
  },
}
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = { load: (definition) => (sandbox.__definition = definition) }

vm.runInContext(code, vm.createContext(sandbox), { filename: 'client.js' })

const definition = sandbox.__definition
assert.ok(definition, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(definition.id, 'dsh-tu-bubbles', '模块 id 必须等于包名')

const mod = definition.factory((name) => {
  if (name === 'react') return { createElement: () => null, useEffect() {}, useState: (v) => [v, () => {}] }
  throw new Error(`未知模块 ${name}`)
})

assert.deepEqual([...mod.inject], ['slots', 'connection'], '客户端模块要声明 slots 与 connection')

/* ---------------------------------------------------------------- 假槽位 */
const registrations = []
const injects = []
const slotCtx = {
  slots: {
    inject(key, cb) {
      injects.push(key)
      cb()
    },
    register(options) {
      registrations.push(options)
      return () => {}
    },
  },
}

const disposers = []
const ctx = {
  slots: slotCtx.slots,
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
}

mod.apply(ctx)

assert.deepEqual(injects.sort(), ['main', 'sidebar.panellist'], '两个槽位都要 inject')

const main = registrations.find((r) => r.name === 'main')
const icon = registrations.find((r) => r.name === 'sidebar.panellist')

assert.ok(main, '必须注册 main 面板')
assert.equal(main.key, 'tu-bubbles')
assert.ok(icon, '必须注册左侧栏入口')
assert.equal(icon.id, main.key, 'panellist.id 必须与 main.key 一致，侧栏才会自动切面板')
assert.equal(icon.order, 12)
assert.equal(typeof icon.label, 'function', 'label 用函数形式，随语言切换')
assert.equal(icon.label(), '吐泡泡')

assert.equal(disposers.length, 1, '必须通过 ctx.effect 注册收尾函数，插件停用时清理')

console.log('✓ registration.test.mjs 全部通过')
