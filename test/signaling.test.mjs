/**
 * 信令中继集成测试：两个 Hub 在本机走真实 TCP（127.0.0.1），验证
 * 加入 → 成员表 → 单播 SDP → 广播 → 离开 的完整链路。
 *   node test/signaling.test.mjs
 */
import assert from 'node:assert/strict'
import { connect, createServer } from 'node:net'
import { SignalingHub, parseInvite } from '../host/signaling.js'

const silent = { info() {}, warn() {}, error() {} }
const tick = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

// 未加入房间时不能发信令
const solo = new SignalingHub({ logger: silent })
assert.throws(() => solo.relay({ to: '*', payload: {} }), /尚未加入房间/)

// 房主
const host = new SignalingHub({ logger: silent })
const hostStatus = await host.createRoom({ memberId: 'acct-a:1', accountId: 'acct-a', name: '小明' })
assert.equal(hostStatus.role, 'host')
assert.ok(hostStatus.port > 0)
assert.ok(hostStatus.invites.length >= 1, '应至少有一个局域网邀请串')
assert.match(hostStatus.invites[0].invite, /^\d+\.\d+\.\d+\.\d+:\d+\/[A-Z0-9]{6}$/)
assert.equal(host.drain('window-a').some((event) => event.kind === 'room'), true, '第一个窗口应读到房间事件')
assert.equal(host.drain('window-b').some((event) => event.kind === 'room'), true, '第二个窗口不应抢走房间事件')

const invite = `127.0.0.1:${hostStatus.port}/${hostStatus.roomCode}`
assert.deepEqual(parseInvite(invite), { host: '127.0.0.1', port: hostStatus.port, code: hostStatus.roomCode })
assert.equal(parseInvite('192.168.1.5:8080'), null)
assert.equal(parseInvite('nonsense'), null)

// 客人加入
const guest = new SignalingHub({ logger: silent })
const guestStatus = await guest.joinRoom({ invite, memberId: 'acct-b:1', accountId: 'acct-b', name: '小红' })
assert.equal(guestStatus.role, 'guest')
assert.equal(guestStatus.members.length, 2)

await tick()
const hostSawJoin = host.drain().some((event) => event.kind === 'member-online' && event.memberId === 'acct-b:1')
assert.ok(hostSawJoin, '房主应收到新成员事件')
assert.equal(host.status().members.length, 2)

// 单播：客人 → 房主（offer）
guest.relay({ to: 'acct-a:1', payload: { kind: 'offer', sdp: 'v=0 offer' } })
await tick()
const offer = host.drain().find((event) => event.kind === 'signal' && event.payload?.kind === 'offer')
assert.ok(offer, '房主应收到 offer')
assert.equal(offer.from, 'acct-b:1')

// 单播：房主 → 客人（answer）
host.relay({ to: 'acct-b:1', payload: { kind: 'answer', sdp: 'v=0 answer' } })
await tick()
const answer = guest.drain().find((event) => event.kind === 'signal' && event.payload?.kind === 'answer')
assert.ok(answer, '客人应收到 answer')
assert.equal(answer.from, 'acct-a:1')

// 广播：房主 → 所有人
host.relay({ to: '*', payload: { kind: 'channel-created', channel: { id: 'ch-1', name: '摸鱼' } } })
await tick()
assert.ok(guest.drain().some((event) => event.payload?.channel?.name === '摸鱼'), '客人应收到广播')

// 第三个端：同账号第二台机器可以并存（memberId 不同）
const guest2 = new SignalingHub({ logger: silent })
await guest2.joinRoom({ invite, memberId: 'acct-b:2', accountId: 'acct-b', name: '小红(备用机)' })
await tick()
assert.equal(host.status().members.length, 3)
assert.equal(guest.status().members.length, 3)

// 断开后成员离线
guest2.leave()
await tick()
assert.equal(host.status().members.length, 3)
const offline = host.drain().find((event) => event.kind === 'member-offline')
assert.ok(offline, '房主应收到成员离线事件')

host.dispose()
guest.dispose()
guest2.dispose()

// TCP 已连接但永不发送 welcome 时，应用握手必须有截止时间。
const silentSockets = new Set()
const silentServer = createServer((socket) => {
  silentSockets.add(socket)
  socket.once('close', () => silentSockets.delete(socket))
})
await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve))
const silentPort = silentServer.address().port
const timeoutGuest = new SignalingHub({ logger: silent })
try {
  const started = Date.now()
  await assert.rejects(
    () => timeoutGuest.joinRoom({ invite: `127.0.0.1:${silentPort}/${hostStatus.roomCode}`, memberId: 'acct-timeout:1', accountId: 'acct-timeout', name: 'timeout' }),
    /超时|失败/,
  )
  assert.ok(Date.now() - started < 5000, '静默握手应在截止时间内结束')
} finally {
  timeoutGuest.dispose()
  for (const socket of silentSockets) socket.destroy()
  await new Promise((resolve) => silentServer.close(resolve))
}

// 并发房间操作只允许最后一次生效，旧操作不能迟到覆盖状态。
const raceHub = new SignalingHub({ logger: silent })
try {
  const first = raceHub.createRoom({ memberId: 'acct-race:1', accountId: 'acct-race', name: 'first' })
  const second = raceHub.createRoom({ memberId: 'acct-race:2', accountId: 'acct-race', name: 'second' })
  await assert.rejects(first, /取消/)
  const winner = await second
  assert.equal(raceHub.roomCode, winner.roomCode)
  raceHub.drain('room-session')
  raceHub.drain('room-session', { reset: true })
  const next = await raceHub.createRoom({ memberId: 'acct-race:3', accountId: 'acct-race', name: 'next' })
  const events = raceHub.drain('room-session')
  assert.ok(events.some((event) => event.kind === 'room' && event.state?.roomCode === next.roomCode), '新房间会话不应读取旧事件')
  assert.equal(events.some((event) => event.kind === 'room' && event.state?.roomCode === winner.roomCode), false)
} finally {
  raceHub.dispose()
}

// reset 只隔离旧房间事件，不能丢掉当前会话已排队的信令。
const resetHost = new SignalingHub({ logger: silent })
const resetGuest = new SignalingHub({ logger: silent })
try {
  const room = await resetHost.createRoom({ memberId: 'acct-reset-host:1', accountId: 'acct-reset-host', name: 'host' })
  await resetGuest.joinRoom({ invite: `127.0.0.1:${room.port}/${room.roomCode}`, memberId: 'acct-reset-guest:1', accountId: 'acct-reset-guest', name: 'guest' })
  await tick()
  const epoch = resetHost.status().epoch
  resetHost.drain('reset-session', { reset: true, epoch })
  resetGuest.relay({ to: 'acct-reset-host:1', payload: { kind: 'offer', sdp: 'queued-offer' } })
  await tick()
  const currentEvents = resetHost.drain('reset-session', { reset: true, epoch })
  assert.ok(currentEvents.some((event) => event.kind === 'signal' && event.payload?.sdp === 'queued-offer'), 'reset 不得丢当前会话信令')
  assert.equal(resetHost.drain('reset-session', { epoch }).some((event) => event.payload?.sdp === 'queued-offer'), false, 'reset 返回的事件不应重复消费')
} finally {
  resetHost.dispose()
  resetGuest.dispose()
}

// 旧房间 socket 在 leave 后发送 join 时必须被拒绝，不能污染新成员表。
const lateHost = new SignalingHub({ logger: silent })
let lateSocket
try {
  const room = await lateHost.createRoom({ memberId: 'acct-late-host:1', accountId: 'acct-late-host', name: 'host' })
  lateSocket = connect({ host: '127.0.0.1', port: room.port })
  await new Promise((resolve, reject) => {
    lateSocket.once('connect', resolve)
    lateSocket.once('error', reject)
  })
  lateHost.leave()
  lateSocket.write(`${JSON.stringify({ t: 'join', code: room.roomCode, member: { memberId: 'late:t', accountId: 'late', name: 'late' } })}\n`)
  await tick()
  assert.equal(lateHost.members.size, 0, '旧 socket 不得在离房后写入成员')
} finally {
  lateSocket?.destroy()
  lateHost.dispose()
}
console.log('✓ signaling.test.mjs 全部通过')
