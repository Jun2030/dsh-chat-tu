/**
 * 存储层自测：直接用系统 Node 跑，不依赖 DSH 运行时。
 *   node test/store.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, DEFAULT_CHANNEL } from '../host/store.js'

const dir = mkdtempSync(join(tmpdir(), 'tu-bubbles-test-'))
const file = join(dir, 'chat.db')
let store = openStore(file)

// 默认频道
assert.equal(store.listChannels().length, 1)
assert.equal(store.listChannels()[0].id, DEFAULT_CHANNEL.id)

// 频道
const ch = store.createChannel({ name: '摸鱼', createdBy: 'acct-1' })
assert.equal(store.listChannels().length, 2)
assert.equal(store.renameChannel(ch.id, '摸鱼频道').name, '摸鱼频道')

// 消息 + 幂等
const m1 = store.insertMessage({
  id: 'm-fixed',
  channelId: ch.id,
  senderId: 'acct-1',
  senderName: '小明',
  kind: 'text',
  body: '你好',
  direction: 'out',
})
assert.equal(m1.inserted, true)
const m2 = store.insertMessage({
  id: 'm-fixed',
  channelId: ch.id,
  senderId: 'acct-1',
  senderName: '小明',
  kind: 'text',
  body: '你好',
  direction: 'out',
})
assert.equal(m2.inserted, false)
assert.equal(store.countMessages(ch.id), 1)
assert.equal(store.updateMessageStatus('m-fixed', 'delivered').status, 'delivered')
assert.equal(store.updateMessageStatus('m-fixed', 'sent').status, 'delivered', '消息状态不得从 delivered 回退')

// 同一毫秒的消息用复合游标分页，不得漏掉边界记录。
const page = store.createChannel({ name: '分页', createdBy: 'acct-1' })
for (const id of ['same-a', 'same-b', 'same-c']) {
  store.insertMessage({ id, channelId: page.id, senderId: 'acct-1', senderName: '小明', kind: 'text', body: id, sentAt: 100, direction: 'out' })
}
const firstPage = store.listMessages(page.id, { limit: 2 })
const secondPage = store.listMessages(page.id, { limit: 2, before: { sentAt: firstPage[0].sentAt, id: firstPage[0].id } })
assert.deepEqual([...firstPage, ...secondPage].map((message) => message.id).sort(), ['same-a', 'same-b', 'same-c'])
assert.equal(store.archiveChannel(page.id).archived, 1)

// 昵称
assert.equal(store.getProfile('acct-1'), null)
assert.equal(store.setNickname('acct-1', '泡泡侠').nickname, '泡泡侠')
assert.equal(store.setNickname('acct-1', '泡泡侠2').nickname, '泡泡侠2')

// 自定义表情（内容哈希去重）
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const e1 = store.addEmoji({ name: 'doge', mime: 'image/png', bytes: png })
const e2 = store.addEmoji({ name: 'doge-again', mime: 'image/png', bytes: png })
assert.equal(e1.id, e2.id)
assert.equal(store.listEmojis().length, 1)
assert.equal(store.listEmojis()[0].size, png.length)
assert.deepEqual(store.getEmoji(e1.id).bytes, png)
assert.equal(store.deleteEmoji(e1.id), true)
assert.equal(store.listEmojis().length, 0)

// 归档后消息仍在
assert.equal(store.archiveChannel(ch.id).archived, 1)
assert.equal(store.listChannels().length, 1)
assert.equal(store.listChannels(true).length, 3)
assert.equal(store.countMessages(ch.id), 1)

// 重启后仍可读取（持久化验证）
store.close()
store = openStore(file)
assert.equal(store.getProfile('acct-1').nickname, '泡泡侠2')
assert.equal(store.countMessages(ch.id), 1)
assert.equal(store.listChannels(true).length, 3)
store.close()

rmSync(dir, { recursive: true, force: true })
console.log('✓ store.test.mjs 全部通过')
