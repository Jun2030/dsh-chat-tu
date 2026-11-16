/**
 * 吐泡泡 · 局域网信令中继（host 进程）
 *
 * 为什么信令跑在 host 而不是渲染层：
 *  1. 渲染层是安全上下文（dsh-app://app），连 ws://192.168.x.x 会被当混合内容拦掉；
 *  2. DSH 自带 webServer 绑在 127.0.0.1，跨机器不可达。
 * 所以：渲染层只负责 RTCPeerConnection，SDP/ICE 交给本模块用 TCP 在局域网里中继。
 *
 * 协议：一行一个 JSON（UTF-8，\n 分隔），房主 authoritative。
 *   guest → host  { t:'join', code, member }         // member = { memberId, accountId, name, address }
 *   host  → guest { t:'welcome', roomCode, self, members } | { t:'reject', reason }
 *   host  → all   { t:'members', members }
 *   host  → all   { t:'closed', reason:'host-left' }  // 房主退出，各端自行选举
 *   any   → host  { t:'relay', to, payload }         // to 为 memberId 或 '*'
 *   host  → member{ t:'relay', from, payload }
 *
 * 成员标识用 memberId（形如 `<accountId>:<设备后缀>`），而不是 accountId：
 * 同一账号开两台机器也能同时在线、不会互相顶 socket。
 *
 * 房主退出后自动选举新房主（见 #promote / #startElection）：
 *  - 每个 hub 一启动就在 0.0.0.0 上监听一个固定端口（standby），并且在成员表里广播自己的
 *    `address = <局域网IP>:<该端口>`，所以任何成员都随时可能被推举为新房主；
 *  - 房主退出（主动断开或进程崩溃）时，各成员用同一份成员表算出唯一继任者
 *    （除房主外 memberId 字典序最小者），继任者在自己原来的端口上接管同一个房间码，
 *    其他人连过去继续用同一个房间码开会话。
 */
import { createServer, connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'

const MAX_LINE_BYTES = 1024 * 1024
const JOIN_ATTEMPTS_PER_SOCKET = 8
const QUEUE_LIMIT = 500
/** 房主主动离开后，等这么久再选举，给其他成员的「closed」消息一点时间。 */
const ELECTION_DELAY_MS = 300
/** 继任者能不能连上，最多试这些候选 + 轮次。 */
const ELECTION_ROUNDS = 3
/** 断线后先原地重连房主：次数与间隔（总计约 3 秒）。 */
const RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1000

/** 生成人类可读的加入码，去掉容易混淆的 0/O/1/I。 */
export function makeRoomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 本机所有非回环 IPv4 地址（用于生成邀请串）。 */
export function lanAddresses() {
  const out = []
  const interfaces = networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push({ name, address: entry.address })
    }
  }
  return out
}

function encodeLine(object) {
  const text = JSON.stringify(object)
  return Buffer.byteLength(text) > MAX_LINE_BYTES ? null : `${text}\n`
}

/** 一行一行地读 JSON，超长行直接掐断连接（防止内存被撑爆）。 */
function attachLineReader(socket, onMessage, onClose) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      socket.destroy()
      return
    }
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line))
        } catch {
          /* 忽略非法行，保持连接 */
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  socket.on('close', () => onClose())
  socket.on('error', () => {
    /* close 事件里统一处理 */
  })
}

export class SignalingHub {
  #queue = []
  #standby = null
  #standbyPromise = null
  #sockets = new Map() // host 视角：memberId → socket
  #guestLink = null
  #reconnectTimer = null
  #electionTimer = null
  #closed = false
  #leaving = false
  #electing = false
  #reconnecting = false

  #guestInvite = null
  #selfDraft = null

  constructor({ logger = console } = {}) {
    this.logger = logger
    /** @type {'host'|'guest'|null} */
    this.role = null
    this.roomCode = null
    this.self = null
    this.members = new Map() // memberId → { memberId, accountId, name, address, online }
    this.port = null // 房主时 = 监听端口；加入者时为 null
    this.listenPort = null // standby 监听端口（任何人都可能有）
    this.hostAddress = null
    this.hostMemberId = null
    this.lastError = null
  }

  /* ------------------------------------------------------------ 事件队列 */

  #push(event) {
    this.#queue.push(event)
    if (this.#queue.length > QUEUE_LIMIT) this.#queue.splice(0, this.#queue.length - QUEUE_LIMIT)
  }

  /** 渲染层轮询一次，取走自上次以来的所有事件。 */
  drain() {
    if (this.#queue.length === 0) return []
    const events = this.#queue
    this.#queue = []
    return events
  }

  #membersList() {
    return [...this.members.values()]
  }

  #broadcastRaw(object) {
    if (this.role !== 'host') return
    const line = encodeLine(object)
    if (!line) return
    for (const socket of this.#sockets.values()) if (!socket.destroyed) socket.write(line)
  }

  #broadcastMembers() {
    if (this.role !== 'host') return
    this.#broadcastRaw({ t: 'members', members: this.#membersList() })
    this.#push({ kind: 'members', members: this.#membersList() })
  }

  /** 本机对外地址，形如 `192.168.1.5:51820`；没有网卡时退回回环。 */
  get selfAddress() {
    if (!this.listenPort) return null
    return `${lanAddresses()[0]?.address ?? '127.0.0.1'}:${this.listenPort}`
  }

  /* ------------------------------------------------------------ 房间状态 */

  status() {
    const hosting = this.role === 'host' && this.port
    return {
      role: this.role,
      roomCode: this.roomCode,
      port: this.port,
      listenPort: this.listenPort,
      selfAddress: this.selfAddress,
      hostAddress: this.hostAddress,
      self: this.self,
      members: this.#membersList(),
      invites: hosting
        ? lanAddresses().map((a) => ({ address: a.address, iface: a.name, invite: `${a.address}:${this.port}/${this.roomCode}` }))
        : [],
      error: this.lastError,
    }
  }

  /* ---------------------------------------------------------- standby 监听 */

  /**
   * 每个 hub 第一次进房间时就开一个常驻监听（standby）。
   * 它既是房主的服务端口，也是「万一被选为新房主」时随时可以接管的端口。
   * 不在房间里时收到连接一律断开，避免被别人误当成房主。
   */
  #ensureStandby() {
    if (this.#standbyPromise) return this.#standbyPromise
    this.#standbyPromise = new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        if (this.role !== 'host' || !this.roomCode) {
          socket.destroy()
          return
        }
        this.#acceptGuest(socket, this.roomCode)
      })
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => {
        server.off('error', reject)
        this.#standby = server
        this.listenPort = server.address().port
        this.logger.info?.(`[tu-bubbles] 信令 standby 监听 0.0.0.0:${this.listenPort}`)
        resolve(this.listenPort)
      })
    })
    return this.#standbyPromise
  }

  /* ------------------------------------------------------------ 房主 */

  /** 创建房间：本机成为信令主机，复用 standby 端口。 */
  async createRoom({ memberId, accountId, name, port = 0 }) {
    if (this.role) this.leave()
    this.lastError = null
    await this.#ensureStandby()
    const code = makeRoomCode()
    this.role = 'host'
    this.roomCode = code
    this.port = this.listenPort
    this.self = { memberId, accountId, name, address: this.selfAddress }
    this.hostMemberId = memberId
    this.hostAddress = this.selfAddress
    this.members = new Map([[memberId, { memberId, accountId, name, address: this.selfAddress, online: true }]])
    this.logger.info?.(`[tu-bubbles] 信令主机已启动 0.0.0.0:${this.port} 房间 ${code}`)
    this.#push({ kind: 'room', state: this.status() })
    return this.status()
  }

  #acceptGuest(socket, code) {
    let attempts = 0
    let memberId = null
    socket.on('close', () => {
      if (memberId && this.#sockets.get(memberId) === socket) {
        this.#sockets.delete(memberId)
        const member = this.members.get(memberId)
        if (member) member.online = false
        this.#push({ kind: 'member-offline', memberId })
        this.#broadcastMembers()
      }
    })
    attachLineReader(
      socket,
      (message) => {
        if (message.t === 'join') {
          attempts += 1
          if (attempts > JOIN_ATTEMPTS_PER_SOCKET) {
            socket.destroy()
            return
          }
          if (message.code !== code || !message.member?.memberId || !message.member?.accountId) {
            socket.write(encodeLine({ t: 'reject', reason: '房间码不匹配' }) ?? '')
            socket.destroy()
            return
          }
          memberId = String(message.member.memberId)
          const previous = this.#sockets.get(memberId)
          if (previous && previous !== socket) previous.destroy()
          this.#sockets.set(memberId, socket)
          this.members.set(memberId, {
            memberId,
            accountId: String(message.member.accountId),
            name: String(message.member.name ?? '未命名'),
            address: typeof message.member.address === 'string' ? message.member.address : null,
            online: true,
          })
          socket.write(
            encodeLine({
              t: 'welcome',
              roomCode: this.roomCode,
              self: this.self,
              members: this.#membersList(),
            }) ?? '',
          )
          this.#push({ kind: 'member-online', memberId, name: this.members.get(memberId).name })
          this.#broadcastMembers()
          return
        }

        if (!memberId) return

        if (message.t === 'relay') {
          if (message.to === this.self.memberId) {
            this.#push({ kind: 'signal', from: memberId, payload: message.payload })
            return
          }
          const line = encodeLine({ t: 'relay', from: memberId, payload: message.payload })
          if (!line) return
          if (message.to === '*') {
            for (const [id, peer] of this.#sockets) if (id !== memberId && !peer.destroyed) peer.write(line)
            if (this.self.memberId !== memberId) this.#push({ kind: 'signal', from: memberId, payload: message.payload })
            return
          }
          const target = this.#sockets.get(message.to)
          if (target && !target.destroyed) target.write(line)
        }
      },
      () => {
        /* 清理在 socket close 里做 */
      },
    )
  }

  /* ------------------------------------------------------------ 加入者 */

  /**
   * 加入房间：连房主的 TCP 信令端口，用邀请串里的房间码换成员表。
   * @param {{ invite: string, memberId: string, accountId: string, name: string }} options
   */
  async joinRoom({ invite, memberId, accountId, name }) {
    // 本机正在当房主时不能再去加入别的房间：以前这里会先 leave()，
    // 结果同一个宿主进程里另一个窗口点「加入」就把房主的房间拆掉了（实测发现）。
    if (this.role === 'host') {
      throw new Error('本机正在作为房主，不能同时加入房间：请让**另一台机器**加入，或先断开当前房间')
    }
    if (this.role) this.leave()
    this.lastError = null
    const parsed = parseInvite(invite)
    if (!parsed) throw new Error('邀请串格式应为 192.168.1.5:51820/ABC123')
    await this.#ensureStandby()

    this.#guestInvite = parsed
    this.#selfDraft = { memberId, accountId, name }
    await this.#connectAsGuest(parsed, this.#selfDraft)
    this.role = 'guest'
    this.roomCode = parsed.code
    this.hostAddress = `${parsed.host}:${parsed.port}`
    this.self = { ...this.#selfDraft, address: this.selfAddress }
    this.#push({ kind: 'room', state: this.status() })
    return this.status()
  }

  #connectAsGuest(parsed, { memberId, accountId, name }) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: parsed.host, port: parsed.port })
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      socket.setNoDelay(true)
      socket.once('connect', () => {
        socket.write(
          encodeLine({
            t: 'join',
            code: parsed.code,
            member: { memberId, accountId, name, address: this.selfAddress },
          }) ?? '',
        )
      })
      socket.once('error', fail)
      attachLineReader(
        socket,
        (message) => {
          if (message.t === 'welcome') {
            if (!settled) {
              settled = true
              resolve()
            }
            this.hostMemberId = message.self?.memberId ?? null
            this.members = new Map((message.members ?? []).map((m) => [m.memberId, { ...m, online: true }]))
            this.members.set(memberId, {
              memberId,
              accountId,
              name,
              address: this.selfAddress,
              online: true,
            })
            this.#push({ kind: 'joined', members: this.#membersList() })
            return
          }
          if (message.t === 'reject') {
            fail(new Error(`加入被拒绝：${message.reason ?? '未知原因'}`))
            return
          }
          if (message.t === 'members') {
            this.members = new Map(message.members.map((m) => [m.memberId, m]))
            this.#push({ kind: 'members', members: this.#membersList() })
            return
          }
          if (message.t === 'closed') {
            // 房主主动退出：立刻选举，不用等 socket close。
            this.#push({ kind: 'peer-left', message: '房主已离开，正在选举新房主…' })
            this.#startElection(ELECTION_DELAY_MS)
            return
          }
          if (message.t === 'relay') {
            this.#push({ kind: 'signal', from: message.from, payload: message.payload })
          }
        },
        () => {
          if (settled) {
            if (this.#leaving || this.#closed) return
            // 先当成「网络抖一下」：原地重连房主几次；实在连不上再进入选举。
            // 不这么做的话，一次瞬时断线就会让所有成员各自接管，出现两间「同码房」。
            this.#push({ kind: 'peer-left', message: '与信令主机的连接已断开，正在重连…' })
            void this.#reconnectOrElect()
          } else {
            fail(new Error('连接信令主机失败'))
          }
        },
      )
      this.#guestLink = socket
    })
  }

  /* -------------------------------------------------------- 房主选举 */

  /**
   * 断线后的处理顺序：先原地重连原房主（最多 3 次、每次间隔 1s），
   * 连不上才认为房主真的走了，进入选举。
   * 这样「网线抖一下」不会让所有人各自变成房主。
   */
  async #reconnectOrElect() {
    if (this.#closed || this.#leaving || this.role !== 'guest' || this.#electing) return
    if (this.#reconnecting) return
    this.#reconnecting = true
    try {
      const target = this.hostAddress ? parseInvite(`${this.hostAddress}/${this.roomCode}`) : null
      if (!target || !this.#selfDraft) {
        this.#startElection(ELECTION_DELAY_MS)
        return
      }
      for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
        if (this.#closed || this.#leaving || this.role !== 'guest') return
        try {
          await this.#connectAsGuest(target, this.#selfDraft)
          this.#push({ kind: 'reconnected' })
          return
        } catch {
          if (attempt < RECONNECT_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS))
        }
      }
      if (this.#closed || this.#leaving || this.role !== 'guest') return
      this.#push({ kind: 'peer-left', message: '房主已失联，正在选举新房主…' })
      this.#startElection(ELECTION_DELAY_MS)
    } finally {
      this.#reconnecting = false
    }
  }

  /**
   * 房主不见了：所有成员用同一份成员表算出唯一继任者。
   * 继任者 = 除旧房主外 memberId 字典序最小的成员；选到自己就直接接管。
   */
  #startElection(delay) {
    if (this.#closed || this.#leaving || this.#electing || this.role !== 'guest') return
    this.#electing = true
    const run = async () => {
      this.#electionTimer = null
      if (this.#closed || this.#leaving) {
        this.#electing = false
        return
      }
      const hostId = this.hostMemberId
      const candidates = [...this.members.values()]
        .filter((m) => m.memberId !== hostId)
        .sort((a, b) => (a.memberId < b.memberId ? -1 : 1))
      const successor = candidates[0]
      if (!successor || successor.memberId === this.self?.memberId) {
        this.#promote()
        return
      }
      for (let round = 0; round < ELECTION_ROUNDS; round += 1) {
        for (const candidate of candidates) {
          if (!candidate.address) continue
          const parsed = parseInvite(`${candidate.address}/${this.roomCode}`)
          if (!parsed) continue
          try {
            await this.#connectAsGuest(parsed, this.#selfDraft)
            this.hostMemberId = candidate.memberId
            this.hostAddress = candidate.address
            this.role = 'guest'
            this.#electing = false
            this.#push({ kind: 'host-changed', self: false, hostMemberId: candidate.memberId, room: this.status() })
            return
          } catch {
            /* 换下一个候选 */
          }
        }
        await new Promise((r) => setTimeout(r, 1200 * (round + 1)))
        if (this.#closed || this.#leaving) {
          this.#electing = false
          return
        }
      }
      this.#electing = false
      this.lastError = '房主已离开，且没能连上任何继任者'
      this.#push({ kind: 'error', message: this.lastError })
    }
    if (delay > 0) {
      if (this.#electionTimer) clearTimeout(this.#electionTimer)
      this.#electionTimer = setTimeout(run, delay)
    } else {
      run()
    }
  }

  /** 自己接管房间：沿用原房间码与 standby 端口，其余成员随后会连过来。 */
  #promote() {
    const selfId = this.self?.memberId
    const members = new Map(this.members)
    if (this.hostMemberId) members.delete(this.hostMemberId)
    if (selfId) {
      const mine = members.get(selfId) ?? { memberId: selfId, accountId: this.self.accountId, name: this.self.name }
      members.set(selfId, { ...mine, address: this.selfAddress, online: true })
    }
    this.members = members
    this.role = 'host'
    this.hostMemberId = selfId
    this.port = this.listenPort
    this.hostAddress = this.selfAddress
    this.self = { ...this.self, address: this.selfAddress }
    this.#electing = false
    this.logger.info?.(`[tu-bubbles] 本机接管房间 ${this.roomCode}（0.0.0.0:${this.port}）`)
    this.#push({ kind: 'host-changed', self: true, hostMemberId: selfId, room: this.status() })
    this.#broadcastMembers()
  }

  /* ------------------------------------------------------------ 中继 */

  /** 发给某个成员（'*' 表示广播）；由本机渲染层调用。 */
  relay({ to, payload, from = null }) {
    const sender = from ?? this.self?.memberId
    if (!sender) throw new Error('尚未加入房间')
    if (this.role === 'host') {
      if (to === '*') {
        const line = encodeLine({ t: 'relay', from: sender, payload })
        if (line) for (const peer of this.#sockets.values()) if (!peer.destroyed) peer.write(line)
        return
      }
      if (to === sender) return
      const target = this.#sockets.get(to)
      const line = encodeLine({ t: 'relay', from: sender, payload })
      if (target && line && !target.destroyed) target.write(line)
      return
    }
    if (this.role === 'guest') {
      const line = encodeLine({ t: 'relay', to, payload })
      if (line && this.#guestLink && !this.#guestLink.destroyed) this.#guestLink.write(line)
      return
    }
    throw new Error('尚未加入房间')
  }

  /* ------------------------------------------------------------ 生命周期 */

  leave() {
    this.#leaving = true
    if (this.#electionTimer) {
      clearTimeout(this.#electionTimer)
      this.#electionTimer = null
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    // 房主离开前先广播一声，让其余成员立刻开始选举（而不是等 TCP 超时）。
    if (this.role === 'host') this.#broadcastRaw({ t: 'closed', reason: 'host-left' })
    for (const socket of this.#sockets.values()) socket.destroy()
    this.#sockets.clear()
    if (this.#guestLink) {
      this.#guestLink.destroy()
      this.#guestLink = null
    }
    // standby 监听常驻，不随 leave 关闭（随时可能被选为新房主）。
    this.role = null
    this.roomCode = null
    this.port = null
    this.hostAddress = null
    this.hostMemberId = null
    this.self = null
    this.members = new Map()
    this.#guestInvite = null
    this.#selfDraft = null
    this.#electing = false
    this.#leaving = false
  }

  /** 插件卸载时调用：置 closed 防止选举/重连定时器再拉起连接。 */
  dispose() {
    this.#closed = true
    this.leave()
    this.#closed = true
    if (this.#standby) {
      this.#standby.close()
      this.#standby = null
    }
  }
}

/** 解析 `192.168.1.5:51820/ABC123` 或 `192.168.1.5:51820`（无房间码时返回 null）。 */
export function parseInvite(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const match = /^([^\s/:]+):(\d{1,5})\/([A-Za-z0-9]{4,12})$/.exec(trimmed)
  if (!match) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: match[1], port, code: match[3].toUpperCase() }
}
