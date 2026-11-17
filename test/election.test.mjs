/**
 * 房主选举测试：房主退出后，剩余成员要能自动推出唯一继任者并继续用同一个房间码开会话。
 *
 * 这里不掺 UI，直接用 SignalingHub 在 127.0.0.1 上跑真实 TCP，覆盖：
 *  1. A 建房、B/C 加入；
 *  2. A 退出 → B（memberId 字典序更小）接管，房间码不变；
 *  3. C 自动重连到 B；
 *  4. 新来的 D 用「B 的地址 + 原房间码」仍能加入。
 *
 * 运行：node test/election.test.mjs
 */
import assert from 'node:assert/strict'
import { SignalingHub } from '../host/signaling.js'

const silent = { info() {}, warn() {}, error: console.error }

function member(id, name = id) {
  return { memberId: `${id}:t`, accountId: id, name }
}

/** 收集 hub 事件，直到 predicate 成立或超时。label 可以是函数，超时时才求值。 */
async function waitFor(hub, predicate, label, timeout = 15000) {
  const started = Date.now()
  const seen = []
  while (Date.now() - started < timeout) {
    const events = hub.drain()
    for (const event of events) {
      seen.push(event)
      if (predicate(event, seen)) return event
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等待超时：${typeof label === 'function' ? label() : label}\n已收到事件：${JSON.stringify(seen, null, 2)}`)
}

const hubs = []
function makeHub() {
  const hub = new SignalingHub({ logger: silent })
  hubs.push(hub)
  return hub
}

const a = makeHub()
const b = makeHub()
const c = makeHub()

try {
  /* 1. A 建房，B/C 加入 ------------------------------------------------ */
  const roomA = await a.createRoom({ ...member('acct-a', 'A'), port: 0 })
  assert.equal(roomA.role, 'host')
  const code = roomA.roomCode
  assert.match(code, /^[A-Z0-9]{6}$/)

  const inviteA = `127.0.0.1:${roomA.port}/${code}`
  await b.joinRoom({ invite: inviteA, ...member('acct-b', 'B') })
  await c.joinRoom({ invite: inviteA, ...member('acct-c', 'C') })

  // 等 A 看到三个人
  await waitFor(a, () => a.members.size === 3, 'A 的成员表应有三人')
  assert.equal(a.role, 'host')
  assert.equal(b.role, 'guest')
  assert.equal(c.role, 'guest')

  // 信令能中继（B → C 走 A 转发）
  b.relay({ to: 'acct-c:t', payload: { hello: 'from-b' } })
  await waitFor(c, (e) => e.kind === 'signal' && e.from === 'acct-b:t', 'C 应收到 B 的中继')

  /* 2. A 退出 → B 接管 ------------------------------------------------ */
  a.leave()
  const promoted = await waitFor(
    b,
    (e) => e.kind === 'host-changed' && e.self === true,
    () =>
      `B 应被选为新房主（b.role=${b.role} hostMemberId=${b.hostMemberId} roomCode=${b.roomCode} members=${JSON.stringify([...b.members.keys()])} c.role=${c.role}）`,
  )
  assert.equal(promoted.hostMemberId, 'acct-b:t')
  assert.equal(b.role, 'host')
  // 房间码与监听端口不变，其他人才能继续连同一个房间
  assert.equal(b.roomCode, code)
  assert.equal(b.port, b.listenPort)
  assert.equal(b.hostMemberId, 'acct-b:t')

  // C 会自己重连到 B
  const cMoved = await waitFor(c, (e) => e.kind === 'host-changed' && e.self === false, 'C 应连上 B')
  assert.equal(cMoved.hostMemberId, 'acct-b:t')
  assert.equal(c.role, 'guest')

  // B 看到 C 重新连进来
  await waitFor(b, () => b.members.size === 2 && b.members.get('acct-c:t')?.online === true, 'B 应看到 C 在线')

  // 中继在新房主下继续可用（C → B）
  c.relay({ to: 'acct-b:t', payload: { hello: 'after-election' } })
  await waitFor(b, (e) => e.kind === 'signal' && e.from === 'acct-c:t', 'B 应收到 C 的中继')

  /* 3. 新成员 D 用原房间码加入 B 的房间 ------------------------------- */
  const d = makeHub()
  await d.joinRoom({ invite: `${b.selfAddress}/${code}`, ...member('acct-d', 'D') })
  assert.equal(d.role, 'guest')
  await waitFor(b, () => b.members.size === 3 && b.members.get('acct-d:t')?.online === true, 'B 应看到 D 在线')
  await waitFor(d, (e) => e.kind === 'joined', 'D 应收到 welcome')

  console.log('✓ election.test.mjs 全部通过')
} finally {
  for (const hub of hubs) {
    try {
      hub.dispose()
    } catch {
      /* 忽略 */
    }
  }
}

// 已知最小候选离线时，下一候选应直接接管，不被离线地址阻塞。
const offlineHost = makeHub()
const offlineCandidate = makeHub()
const offlineSuccessor = makeHub()
try {
  const room = await offlineHost.createRoom({ ...member('acct-offline-host', 'host'), port: 0 })
  const invite = `127.0.0.1:${room.port}/${room.roomCode}`
  await offlineCandidate.joinRoom({ invite, ...member('acct-offline-a', 'a') })
  await offlineSuccessor.joinRoom({ invite, ...member('acct-offline-z', 'z') })
  await waitFor(offlineHost, () => offlineHost.members.size === 3, '离线候选测试成员加入')
  offlineCandidate.leave()
  await waitFor(offlineSuccessor, () => offlineSuccessor.members.get('acct-offline-a:t')?.online === false, '继任者应看到候选离线')
  offlineHost.leave()
  const promoted = await waitFor(offlineSuccessor, (event) => event.kind === 'host-changed' && event.self === true, '离线候选后的继任者接管')
  assert.equal(promoted.hostMemberId, 'acct-offline-z:t')
  assert.equal(offlineSuccessor.role, 'host')
} finally {
  offlineHost.dispose()
  offlineCandidate.dispose()
  offlineSuccessor.dispose()
}
