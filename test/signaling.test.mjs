/**
 * 信令中继集成测试：两个 Hub 在本机走真实 TCP（127.0.0.1），验证
 * 加入 → 成员表 → 单播 SDP → 广播 → 离开 的完整链路。
 *   node test/signaling.test.mjs
 */
import assert from 'node:assert/strict'
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
console.log('✓ signaling.test.mjs 全部通过')
