/**
 * 吐泡泡（tu-bubbles）· host 入口
 *
 * DSH bundle 插件的 host 侧：导出 apply(ctx, config)，在 apply 里注册并返回清理函数。
 * 负责三件事：
 *   1. 打开本地 SQLite（node:sqlite，零第三方依赖）；
 *   2. 起局域网 TCP 信令中继（房主时才真正监听端口）；
 *   3. 在 connection 服务的独立通道 /tu-bubbles 上挂 RPC 路由，供渲染层调用。
 *
 * 渲染层（client.js）负责 UI 与 WebRTC；聊天内容不经过这里。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './host/store.js'
import { SignalingHub } from './host/signaling.js'
import { createRouter } from './host/rpc.js'

export const name = 'tu-bubbles'
/**
 * 只强依赖 connection（注册 RPC 通道）。
 * webServer 在 apply 里用 ctx.inject 延后取：connection 的 rpc.handle() 会把通道挂到
 * **读取者上下文**的 webServer 上，而 Cordis 的服务访问会检查该上下文 fiber 的注入表，
 * 所以必须像 dsh-mnemon 那样把 webServer 显式 extend 到同一个上下文上（见下方 registerRpc）。
 * 账号服务用 ctx.get 软取（宿主版本差异时插件仍可加载）。
 */
export const inject = ['connection']

/**
 * @param {import('cordis').Context} ctx
 * @param {{ dataDir?: string, signalingPort?: number }} config
 */
export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('tu-bubbles')
    : (ctx.logger && typeof ctx.logger.info === 'function' ? ctx.logger : console)
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh')
  // (待确认：是否应该改用宿主 dataDir —— 目前 DSH 没有公开的 dataDir 服务，按 dsh-home-paths 约定放在 $DSH_HOME/storages 下。)
  const dataDir = config.dataDir ?? join(home, 'storages', 'tu-bubbles')
  const dbFile = join(dataDir, 'chat.db')

  const store = openStore(dbFile)
  ctx.effect(() => () => store.close(), 'tu-bubbles: sqlite')

  const hub = new SignalingHub({ logger })
  ctx.effect(() => () => hub.dispose(), 'tu-bubbles: signaling')

  /* ------------------------------------------------------------ 账号身份 */

  let cache = null
  let inFlight = null

  /** 统一的身份解析：只认 DeepSeek Harness 账号，不提供任何其他登录方式（Q4）。 */
  async function resolveIdentity() {
    if (cache && Date.now() - cache.at < 5000) return cache.value
    if (inFlight) return inFlight
    inFlight = (async () => {
      const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
      if (!account) {
        return { signedIn: false, accountId: null, name: null, reason: '宿主未加载账号服务（deepseekAccount）' }
      }
      try {
        const state = await account.getState()
        if (state?.status !== 'credential-stored') {
          return { signedIn: false, accountId: null, name: null, reason: '尚未登录 DeepSeek Harness 账号' }
        }
        const profile = await account.getProfile({
          version: '0.1.0',
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })
        if (!profile || profile.status !== 'ready' || !profile.value?.id) {
          return { signedIn: false, accountId: null, name: null, reason: '账号资料不可用，请重新登录' }
        }
        return {
          signedIn: true,
          accountId: String(profile.value.id),
          name: profile.value.name ?? null,
          avatarUrl: profile.value.avatarUrl ?? null,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn?.(`[tu-bubbles] 读取账号失败：${message}`)
        return { signedIn: false, accountId: null, name: null, reason: `读取账号失败：${message}` }
      }
    })()
    try {
      const value = await inFlight
      cache = { at: Date.now(), value }
      return value
    } finally {
      inFlight = null
    }
  }

  /* --------------------------------------------------------------- RPC */

  // DSH 的共享 /api 通道只允许一个 interceptor，所以本插件用**独立通道** /tu-bubbles：
  // host 侧 handle() 会把它挂成 /tu-bubbles 前缀路由，客户端用
  // connection.rpc.call('/tu-bubbles', 'messages/list', …) 调用，endpoint 即路由后半段。
  const handler = createRouter({ store, hub, identity: resolveIdentity, logger })
  ctx.inject(['connection', 'webServer'], (webContext) => {
    // connection.rpc.handle() 内部执行 `owner.effect(() => owner.webServer.register(route))`，
    // 其中 owner 是**读取 connection 的上下文**。Cordis 在读取该上下文的属性时会检查它
    // 自己的注入/自身属性表，只声明 inject 不够，必须把 webServer 显式挂到同一个上下文上
    // （与 dsh-mnemon 的 `webContext.extend({ webServer })` 同一手法）。
    const owner = webContext.extend({ webServer: webContext.get('webServer') })
    const dispose = owner.connection.rpc.handle('/tu-bubbles', handler)
    ctx.effect(() => dispose, 'tu-bubbles: rpc')
  })

  logger.info?.(`[tu-bubbles] 已加载，本地库 ${dbFile}`)
}
