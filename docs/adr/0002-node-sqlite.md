# ADR 0002：用 `node:sqlite`，不用第三方驱动

- 状态：已采纳
- 日期：2026-11-16

## 背景

需求要求「会话内容存储在本地 SQLite 数据库」。可选：

1. `better-sqlite3` / `sqlite3`：生态成熟，但都是原生模块，需要 prebuild 与 pnpm 构建脚本审批；
   DSH 安装包里也没有预装任何第三方 SQLite 驱动（实测 `MODULE_NOT_FOUND`）。
2. `sql.js`（WASM）：免编译，但数据在内存里，要自己负责落盘，并发与事务语义弱。
3. `node:sqlite`：Node 24 内置（Electron 44 自带的 SQLite 3.53.4），`import { DatabaseSync }` 即用，
   无需 flag、无需编译。

## 决策

用 `node:sqlite` 的 `DatabaseSync`。插件保持**零第三方依赖**。

## 后果

- 安装不需要构建脚本，也不触发 pnpm 的 `onlyBuiltDependencies` 审批；
- 需要 Node ≥ 22.19（`package.json` 的 `engines.node`），DSH 桌面版满足；
- SQLite 能力受内置版本限制（无扩展加载、无 `loadExtension`），当前需求用不到；
- 单元测试直接在 Node 26 下跑（`node test/store.test.mjs`），不需要 Electron。

## 被否掉的方案

- `ctx.storageDomain`：后端是 JSON 文件，不满足「SQLite」这条验收标准。
- 自己实现文件存储：重复造轮子，且事务/索引能力更差。
