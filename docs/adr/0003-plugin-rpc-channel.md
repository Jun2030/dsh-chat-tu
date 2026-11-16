# ADR 0003：自有 endpoint 走 `connection.rpc.handle('/tu-bubbles')` 独立通道

- 状态：已采纳（2026-11-16 修订：原方案用 `intercept('/api')`，实测被 DSH 拒绝）
- 日期：2026-11-16

## 背景

客户端插件要和宿主通信，DSH 里有三条现成路径：

1. `typert` + `@Remote` 装饰器（官方服务如 `deepseekAccount` 用这套）：需要 codegen 产物，
   第三方插件没有生成管线，硬上容易在升级时碎。
2. `ctx.webServer.register/registerUpgrade`：要自己处理鉴权；而且 DSH 的 `/api` 有
   cookie 认证与 Host/Origin trust fence，插件自建端口还得再解决一遍认证。
3. `ctx.connection.rpc`：客户端侧 `connection` 服务由 `dsh-client-connection` 提供，
   host 侧支持 `handle(channel, handler)` 与 `intercept('/api', matches, handler)`。

## 决策

host 用 `handle()` 开一条**独立通道** `/tu-bubbles`：

```js
export const inject = ['connection']

ctx.inject(['connection', 'webServer'], (webContext) => {
  // connection.rpc.handle() 内部执行 owner.effect(() => owner.webServer.register(route))，
  // owner 是「读取 connection 的那个上下文」。Cordis 读属性时检查该上下文的注入/自身属性表，
  // 只写 inject 不够，必须把 webServer 显式 extend 到同一上下文上（dsh-mnemon 同一手法）。
  const owner = webContext.extend({ webServer: webContext.get('webServer') })
  const dispose = owner.connection.rpc.handle('/tu-bubbles', handler)
  ctx.effect(() => dispose, 'tu-bubbles: rpc')
})
```

客户端用 `ctx.connection.rpc.call('/tu-bubbles', '<op>', payload)`，统一返回
`{ ok, value }` / `{ ok, error }`；endpoint 就是操作名（`messages/list`、`room/join`…）。

## 为什么不用 `intercept('/api')`（实测结论）

`dsh-client-connection` 的 host 实现里，`registerInterceptor` 只接受 `API_PATH`，且**一个通道只允许一个 interceptor**：

```
Error: connection: shared RPC channel "/api" already has an interceptor
```

DSH 自己（`dsh-api-gateway`）已经占了 `/api`，第三方插件抢不到。`handle()` 走的是
`register(owner, channel, handler)`，通道名自定，不会冲突。

## 后果

- 复用 DSH 已有的认证、重连、请求/响应封装，插件代码里没有一行鉴权代码；
- 注册用 `ctx.effect` 绑定 fiber，插件停用时自动摘除，不会残留路由；
- 依赖 `dsh-client-connection` 的存在（`package.json` 的 `dsh.client.inject` 已声明）；
- `rpc.handle()` 有一处非直观前置条件（见上），已用注释与探测脚本固定在代码里；
- 通道名 `tu-bubbles` 同时是插件 id，便于排障时在 DevTools 的 Network 里认出来。

## 被否掉的方案

- `intercept('/api')`：被上面的互斥检查直接拒绝。
- 默认导出 service class + `@Remote`：需要 typert 生成物，第三方维护成本高。
- 自建 HTTP 服务：要重新解决认证与端口占用，且增加防火墙/安全面。
