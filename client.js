/**
 * 吐泡泡 · 客户端（渲染进程）
 *
 * 这是 DSH 客户端模块，由 `window.__ModuleLoader__.load` 包装，不能用 import：
 *   - React 从宿主模块表拿（require('react')）
 *   - 组件通过 ctx.slots 注册进 `main` 与 `sidebar.panellist`
 *   - 所有与 host 的通信走 ctx.connection.rpc.call('/api', 'tu-bubbles/<op>', …)
 *
 * WebRTC 只在这里跑：一条 RTCPeerConnection + 一条 DataChannel 承载房间内全部频道；
 * 聊天内容不进 host，只有 SDP 信令经 host 的 TCP 中继交换（原因见 docs/ARCHITECTURE.md）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tu-bubbles',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与包名一致：侧栏条目 id、主面板 key、locale 命名空间都用它。 */
    const PANEL_ID = 'tu-bubbles'
    const MAX_TEXT = 4000
    const MAX_EMOJI_BYTES = 256 * 1024
    const POLL_ACTIVE_MS = 500
    const POLL_IDLE_MS = 1500

    /** 内置表情（Q5：内置一套基础表情，自定义的走 SQLite BLOB）。 */
    const BUILTIN_EMOJIS = [
      '😀', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂',
      '😉', '😊', '😍', '😘', '😜', '🤪', '🤗', '🤔',
      '😐', '😴', '😪', '😮', '😢', '😭', '😤', '😡',
      '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥', '💯',
      '❤️', '💔', '🌚', '🌝', '🍉', '🍗', '☕', '🐷',
    ]

    /* ------------------------------------------------------------------ 工具 */

    function uuid() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        /* 忽略：退化到下面 */
      }
      return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    function safeJson(text) {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    function formatTime(ts) {
      const date = new Date(ts)
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    }

    function deviceSuffix() {
      const KEY = 'tu-bubbles:device'
      try {
        const existing = window.localStorage.getItem(KEY)
        if (existing && /^[a-z0-9]{6,12}$/.test(existing)) return existing
        const created = Math.random().toString(36).slice(2, 8)
        window.localStorage.setItem(KEY, created)
        return created
      } catch {
        return 'local'
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : '')
        }
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    /** 非 trickle ICE：等候选收集完（或超时）再一次性交换 SDP，跨机器的 NAT/防火墙更省心。 */
    function waitIceComplete(pc, timeout = 2500) {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve()
          return
        }
        let done = false
        const finish = () => {
          if (done) return
          done = true
          pc.removeEventListener('icegatheringstatechange', onChange)
          clearTimeout(timer)
          resolve()
        }
        const onChange = () => {
          if (pc.iceGatheringState === 'complete') finish()
        }
        const timer = setTimeout(finish, timeout)
        pc.addEventListener('icegatheringstatechange', onChange)
      })
    }

    /* -------------------------------------------------------------- RPC 封装 */

    function createCall(ctx) {
      /** 本插件独占的 RPC 通道，见 index.js 的注册处。 */
      const CHANNEL = '/tu-bubbles'
      return async function call(op, payload) {
        // connection 服务由 dsh-client-connection 提供；这里惰性取，避免插件激活被它阻塞。
        const connection = ctx.connection
        if (!connection?.rpc || typeof connection.rpc.call !== 'function') {
          throw new Error('连接服务不可用（dsh-client-connection 未就绪），请重新打开面板')
        }
        const result = await connection.rpc.call(CHANNEL, op, payload ?? {})
        if (!result || typeof result !== 'object') throw new Error('宿主返回了无效响应')
        if (!result.ok) {
          const error = new Error(result.error?.message ?? '操作失败')
          error.code = result.error?.code ?? 'unknown'
          error.details = result.error?.details ?? {}
          throw error
        }
        return result.value
      }
    }

    /* ------------------------------------------------------------ WebRTC 网格 */

    /**
     * 房间内的点对点网格。每个成员一条 PeerConnection、一条 DataChannel。
     * 谁发起 offer：memberId 字典序更小的一端（两端规则一致，避免同时发 offer 打架）。
     */
    class Mesh {
      constructor({ call, onPeerChange, onData }) {
        this.call = call
        this.onPeerChange = onPeerChange
        this.onData = onData
        this.self = null
        this.peers = new Map()
        this.disposed = false
      }

      setSelf(self) {
        this.self = self
      }

      blank(memberId) {
        return { memberId, pc: null, dc: null, state: 'connecting', attempts: 0, timer: null, remoteName: null }
      }

      emitPeer(memberId) {
        const entry = this.peers.get(memberId)
        this.onPeerChange?.(memberId, entry ? entry.state : 'offline', entry?.remoteName ?? null)
      }

      /** 根据房间成员表增删连接（成员表由 host 维护）。 */
      sync(members) {
        if (this.disposed || !this.self) return
        const selfId = this.self.memberId
        const wanted = new Set((members ?? []).map((m) => m.memberId).filter((id) => id && id !== selfId))
        for (const id of wanted) {
          if (!this.peers.has(id)) {
            this.peers.set(id, this.blank(id))
            this.emitPeer(id)
            if (selfId < id) this.offer(id)
          }
        }
        for (const id of [...this.peers.keys()]) {
          if (!wanted.has(id)) {
            this.teardown(id)
            this.peers.delete(id)
            this.emitPeer(id)
          }
        }
      }

      teardown(memberId) {
        const entry = this.peers.get(memberId)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = null
        try {
          entry.dc?.close()
        } catch {
          /* 已关闭 */
        }
        try {
          entry.pc?.close()
        } catch {
          /* 已关闭 */
        }
        entry.dc = null
        entry.pc = null
      }

      createPeer(memberId, entry) {
        const pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 })
        pc.addEventListener('connectionstatechange', () => {
          const status = pc.connectionState
          if (status === 'connected') {
            entry.state = 'online'
            entry.attempts = 0
            this.emitPeer(memberId)
            return
          }
          if (status === 'failed' || status === 'disconnected') {
            entry.state = 'offline'
            this.emitPeer(memberId)
            this.scheduleRetry(memberId)
          }
        })
        pc.addEventListener('datachannel', (event) => this.attachChannel(memberId, entry, event.channel))
        entry.pc = pc
        return pc
      }

      attachChannel(memberId, entry, dc) {
        entry.dc = dc
        dc.addEventListener('open', () => {
          entry.state = 'online'
          this.emitPeer(memberId)
          this.sendTo(memberId, {
            t: 'hello',
            memberId: this.self?.memberId ?? null,
            accountId: this.self?.accountId ?? null,
            name: this.self?.name ?? null,
          })
          // 连上后把本地频道表推给对端，避免对方看不到我建的频道。
          this.onData?.({ t: 'open', memberId }, memberId)
        })
        dc.addEventListener('close', () => {
          entry.state = 'offline'
          this.emitPeer(memberId)
        })
        dc.addEventListener('message', (event) => {
          const data = safeJson(event.data)
          if (data) this.onData?.(data, memberId)
        })
      }

      async offer(memberId) {
        const entry = this.peers.get(memberId)
        if (!entry || this.disposed) return
        this.teardown(memberId)
        const pc = this.createPeer(memberId, entry)
        const dc = pc.createDataChannel('tu-bubbles', { ordered: true })
        this.attachChannel(memberId, entry, dc)
        try {
          await pc.setLocalDescription(await pc.createOffer())
          await waitIceComplete(pc)
          entry.state = 'connecting'
          this.emitPeer(memberId)
          await this.call('room/relay', { to: memberId, payload: { kind: 'offer', sdp: pc.localDescription } })
        } catch (error) {
          entry.state = 'offline'
          this.emitPeer(memberId)
          this.scheduleRetry(memberId)
          console.warn('[tu-bubbles] offer 失败', error)
        }
      }

      /** 断线后由「offer 方」重连，退避 1.5s/3s/4.5s…最多 6 次。 */
      scheduleRetry(memberId) {
        const entry = this.peers.get(memberId)
        if (!entry || this.disposed || !this.self) return
        if (this.self.memberId > memberId) return // 由对端发起，等它的 offer
        if (entry.timer) return
        if (entry.attempts >= 6) return
        entry.attempts += 1
        entry.timer = setTimeout(() => {
          entry.timer = null
          this.offer(memberId)
        }, 1500 * entry.attempts)
      }

      async handleSignal(from, payload) {
        if (!payload || typeof payload !== 'object' || this.disposed) return
        if (payload.kind === 'offer') {
          let entry = this.peers.get(from)
          if (!entry) {
            entry = this.blank(from)
            this.peers.set(from, entry)
          }
          if (entry.pc && entry.pc.signalingState !== 'stable') return
          this.teardown(from)
          const pc = this.createPeer(from, entry)
          try {
            await pc.setRemoteDescription(payload.sdp)
            await pc.setLocalDescription(await pc.createAnswer())
            await waitIceComplete(pc)
            entry.state = 'connecting'
            this.emitPeer(from)
            await this.call('room/relay', { to: from, payload: { kind: 'answer', sdp: pc.localDescription } })
          } catch (error) {
            console.warn('[tu-bubbles] 处理 offer 失败', error)
          }
          return
        }
        if (payload.kind === 'answer') {
          const entry = this.peers.get(from)
          if (!entry?.pc || entry.pc.signalingState !== 'have-local-offer') return
          try {
            await entry.pc.setRemoteDescription(payload.sdp)
          } catch (error) {
            console.warn('[tu-bubbles] 处理 answer 失败', error)
          }
        }
      }

      sendTo(memberId, data) {
        const entry = this.peers.get(memberId)
        if (!entry?.dc || entry.dc.readyState !== 'open') return false
        try {
          entry.dc.send(JSON.stringify(data))
          return true
        } catch {
          return false
        }
      }

      broadcast(data) {
        let sent = 0
        for (const memberId of this.peers.keys()) {
          if (this.sendTo(memberId, data)) sent += 1
        }
        return sent
      }

      onlineCount() {
        let count = 0
        for (const entry of this.peers.values()) {
          if (entry.dc?.readyState === 'open') count += 1
        }
        return count
      }

      dispose() {
        this.disposed = true
        for (const memberId of [...this.peers.keys()]) this.teardown(memberId)
        this.peers.clear()
      }
    }

    /* ---------------------------------------------------------------- 控制器 */

    /** 把「数据 + 异步动作」放在 React 之外，避免轮询/事件回调读到过期闭包。 */
    class Controller {
      constructor(ctx, call) {
        this.ctx = ctx
        this.call = call
        this.state = {
          status: 'idle',
          error: null,
          identity: null,
          nickname: '',
          channels: [],
          activeChannelId: null,
          messages: [],
          emojis: [],
          emojiData: {},
          room: null,
          members: [],
          peerStates: {},
          toast: null,
          debug: null,
          sending: false,
        }
        this.listeners = new Set()
        this.emojiInflight = new Set()
        this.polling = false
        this.pollTimer = null
        this.toastTimer = null
        this.disposed = false
        this.mesh = new Mesh({
          call,
          onPeerChange: (memberId, state, remoteName) => {
            const peerStates = { ...this.state.peerStates, [memberId]: state }
            this.emit({ peerStates })
            if (remoteName) {
              const members = this.state.members.map((m) => (m.memberId === memberId ? { ...m, name: remoteName } : m))
              this.emit({ members })
            }
          },
          onData: (data, fromMemberId) => this.handleIncoming(data, fromMemberId),
        })
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      emit(patch) {
        if (patch) Object.assign(this.state, patch)
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      }

      toast(message) {
        this.emit({ toast: message })
        if (this.toastTimer) clearTimeout(this.toastTimer)
        this.toastTimer = setTimeout(() => this.emit({ toast: null }), 3200)
      }

      memberId() {
        const accountId = this.state.identity?.accountId ?? 'anonymous'
        return `${accountId}:${deviceSuffix()}`
      }

      activeChannel() {
        return this.state.channels.find((c) => c.id === this.state.activeChannelId) ?? null
      }

      channelName(channelId) {
        return this.state.channels.find((c) => c.id === channelId)?.name ?? channelId
      }

      /* ------------------------------------------------------------- 初始化 */

      async init() {
        if (this.state.status !== 'idle') return
        this.emit({ status: 'loading' })
        try {
          const identity = await this.call('identity')
          const nickname = identity?.name ?? '我'
          this.emit({ identity, nickname })
          if (!identity?.signedIn) {
            this.emit({ status: 'ready' })
            return
          }
          const [{ channels, defaultChannelId }, { emojis }, room] = await Promise.all([
            this.call('channels/list'),
            this.call('emojis/list'),
            this.call('room/status'),
          ])
          const activeChannelId = this.state.activeChannelId ?? defaultChannelId ?? channels[0]?.id ?? null
          this.emit({ channels, emojis, activeChannelId })
          await this.loadMessages(activeChannelId)
          this.applyRoom(room)
          this.emit({ status: 'ready' })
          if (room?.role) this.startPolling()
        } catch (error) {
          this.emit({ status: 'error', error: error?.message ?? String(error) })
        }
      }

      /** 登录状态可能刚变化：重置后重新跑一次 init。 */
      async reload() {
        if (this.state.status === 'loading') return
        this.emit({ status: 'idle', error: null })
        await this.init()
      }

      async loadMessages(channelId) {
        if (!channelId) return
        try {
          const { messages } = await this.call('messages/list', { channelId, limit: 200 })
          if (channelId !== this.state.activeChannelId) return
          this.emit({ messages })
        } catch (error) {
          this.toast(`读取消息失败：${error.message}`)
        }
      }

      async refreshChannels() {
        const { channels } = await this.call('channels/list')
        const activeChannelId = channels.some((c) => c.id === this.state.activeChannelId)
          ? this.state.activeChannelId
          : (channels[0]?.id ?? null)
        this.emit({ channels, activeChannelId })
        if (activeChannelId !== this.state.activeChannelId) await this.loadMessages(activeChannelId)
      }

      async refreshEmojis() {
        const { emojis } = await this.call('emojis/list')
        this.emit({ emojis })
      }

      /* --------------------------------------------------------------- 频道 */

      async selectChannel(channelId) {
        if (channelId === this.state.activeChannelId) return
        this.emit({ activeChannelId: channelId, messages: [] })
        await this.loadMessages(channelId)
      }

      async createChannel(name) {
        const trimmed = String(name ?? '').trim()
        if (!trimmed) return this.toast('频道名不能为空')
        try {
          const channel = await this.call('channels/create', { name: trimmed })
          await this.refreshChannels()
          this.emit({ activeChannelId: channel.id, messages: [] })
          await this.loadMessages(channel.id)
          this.mesh.broadcast({ t: 'channels', channels: [{ id: channel.id, name: channel.name, createdBy: channel.createdBy }] })
        } catch (error) {
          this.toast(error.message)
        }
      }

      async renameChannel(channelId, name) {
        const trimmed = String(name ?? '').trim()
        if (!trimmed) return
        try {
          const channel = await this.call('channels/rename', { id: channelId, name: trimmed })
          await this.refreshChannels()
          this.mesh.broadcast({ t: 'channels', channels: [{ id: channel.id, name: channel.name, createdBy: channel.createdBy }] })
        } catch (error) {
          this.toast(error.message)
        }
      }

      async archiveChannel(channelId) {
        try {
          await this.call('channels/archive', { id: channelId })
          await this.refreshChannels()
          this.mesh.broadcast({ t: 'channels', channels: [] })
        } catch (error) {
          this.toast(error.message)
        }
      }

      /* --------------------------------------------------------------- 昵称 */

      async setNickname(nickname) {
        const trimmed = String(nickname ?? '').trim()
        if (!trimmed) return this.toast('昵称不能为空')
        try {
          const result = await this.call('nickname/set', { nickname: trimmed })
          this.emit({ nickname: result.nickname })
          this.mesh.setSelf({ ...(this.state.room?.self ?? {}), memberId: this.memberId(), accountId: this.state.identity?.accountId, name: result.nickname })
          this.mesh.broadcast({ t: 'nickname', name: result.nickname })
          this.toast('昵称已更新')
        } catch (error) {
          this.toast(error.message)
        }
      }

      /* --------------------------------------------------------------- 消息 */

      appendMessage(message) {
        const existing = this.state.messages.some((m) => m.id === message.id)
        if (existing) return this.patchMessage(message)
        const messages = [...this.state.messages, message].sort((a, b) => a.sentAt - b.sentAt)
        this.emit({ messages })
      }

      patchMessage(message) {
        if (!message) return
        const messages = this.state.messages.map((m) => (m.id === message.id ? message : m))
        this.emit({ messages })
      }

      async sendText(text) {
        const body = String(text ?? '').trim()
        if (!body) return
        if (body.length > MAX_TEXT) return this.toast(`消息不能超过 ${MAX_TEXT} 字`)
        const channel = this.activeChannel()
        if (!channel) return this.toast('请先选择频道')
        const message = {
          id: uuid(),
          channelId: channel.id,
          channelName: channel.name,
          senderId: this.state.identity.accountId,
          senderName: this.state.nickname,
          kind: 'text',
          body,
          sentAt: Date.now(),
        }
        await this.dispatch(message, null)
      }

      async sendEmoji(item) {
        const channel = this.activeChannel()
        if (!channel) return this.toast('请先选择频道')
        const base = {
          id: uuid(),
          channelId: channel.id,
          channelName: channel.name,
          senderId: this.state.identity.accountId,
          senderName: this.state.nickname,
          kind: 'emoji',
          sentAt: Date.now(),
        }
        if (item.unicode) {
          await this.dispatch({ ...base, body: JSON.stringify({ unicode: item.unicode }) }, null)
          return
        }
        try {
          const emoji = await this.call('emojis/get', { id: item.id })
          const body = JSON.stringify({ emojiId: emoji.id, name: emoji.name })
          await this.dispatch({ ...base, body }, { name: emoji.name, mime: emoji.mime, data: emoji.data })
        } catch (error) {
          this.toast(`发送表情失败：${error.message}`)
        }
      }

      async dispatch(message, emojiPayload) {
        let stored
        try {
          stored = await this.call('messages/append', {
            message: { ...message, direction: 'out', status: 'sending' },
          })
        } catch (error) {
          this.toast(`保存消息失败：${error.message}`)
          return
        }
        this.appendMessage(stored.message)
        if (this.mesh.onlineCount() === 0) {
          const failed = await this.call('messages/status', { id: message.id, status: 'failed' }).catch(() => null)
          if (failed) this.patchMessage(failed)
          this.toast('当前没有在线成员，消息只保存在本地')
          return
        }
        const envelope = { t: 'msg', message }
        if (emojiPayload) envelope.emoji = emojiPayload
        const sent = this.mesh.broadcast(envelope)
        const status = sent > 0 ? 'sent' : 'failed'
        const updated = await this.call('messages/status', { id: message.id, status }).catch(() => null)
        if (updated) this.patchMessage(updated)
      }

      async retryMessage(message) {
        if (!this.state.identity?.signedIn) return this.toast('请先登录账号')
        if (this.mesh.onlineCount() === 0) return this.toast('当前没有在线成员')
        let emojiPayload = null
        if (message.kind === 'emoji') {
          const parsed = safeJson(message.body)
          if (parsed?.emojiId) {
            try {
              const emoji = await this.call('emojis/get', { id: parsed.emojiId })
              emojiPayload = { name: emoji.name, mime: emoji.mime, data: emoji.data }
            } catch {
              return this.toast('本地表情已丢失，无法重发')
            }
          }
        }
        const envelope = {
          t: 'msg',
          message: { ...message, channelName: this.channelName(message.channelId) },
        }
        if (emojiPayload) envelope.emoji = emojiPayload
        const sent = this.mesh.broadcast(envelope)
        const updated = await this.call('messages/status', {
          id: message.id,
          status: sent > 0 ? 'sent' : 'failed',
        }).catch(() => null)
        if (updated) this.patchMessage(updated)
      }

      /** 收到对端 DataChannel 数据。 */
      async handleIncoming(data, fromMemberId) {
        if (this.disposed || !data) return
        if (data.t === 'hello') {
          const entry = this.mesh.peers.get(fromMemberId)
          if (entry) entry.remoteName = data.name ?? null
          this.sendChannelsTo(fromMemberId)
          return
        }
        if (data.t === 'channels') {
          let changed = false
          for (const channel of data.channels ?? []) {
            if (!channel?.id) continue
            try {
              await this.call('channels/ensure', {
                id: channel.id,
                name: channel.name ?? '未命名频道',
                createdBy: channel.createdBy ?? null,
              })
              changed = true
            } catch {
              /* 单个频道失败不阻塞 */
            }
          }
          if (changed) await this.refreshChannels()
          return
        }
        if (data.t === 'ack') {
          const updated = await this.call('messages/status', { id: data.id, status: 'delivered' }).catch(() => null)
          if (updated) this.patchMessage(updated)
          return
        }
        if (data.t === 'nickname') {
          const entry = this.mesh.peers.get(fromMemberId)
          if (entry) entry.remoteName = data.name ?? null
          const members = this.state.members.map((m) => (m.memberId === fromMemberId ? { ...m, name: data.name ?? m.name } : m))
          this.emit({ members })
          return
        }
        if (data.t === 'msg') {
          await this.receiveMessage(data, fromMemberId)
        }
      }

      sendChannelsTo(memberId) {
        const channels = this.state.channels.map((c) => ({ id: c.id, name: c.name, createdBy: c.createdBy }))
        this.mesh.sendTo(memberId, { t: 'channels', channels })
      }

      async receiveMessage(envelope, fromMemberId) {
        const message = envelope.message
        if (!message || typeof message.id !== 'string') return
        try {
          await this.call('channels/ensure', {
            id: message.channelId,
            name: message.channelName ?? '未命名频道',
            createdBy: message.senderId ?? null,
          })
          // 表情消息：把对端的表情字节落到本地库（id 是内容哈希，天然去重）。
          if (message.kind === 'emoji' && envelope.emoji?.data) {
            try {
              await this.call('emojis/add', envelope.emoji)
              await this.refreshEmojis()
            } catch {
              /* 重复或超限都忽略，消息仍可显示占位 */
            }
          }
          const stored = await this.call('messages/append', {
            message: { ...message, direction: 'in', status: 'delivered' },
          })
          this.mesh.sendTo(fromMemberId, { t: 'ack', id: message.id })
          if (stored.inserted && message.channelId === this.state.activeChannelId) {
            this.appendMessage(stored.message)
          } else if (stored.inserted) {
            await this.refreshChannels()
          }
        } catch (error) {
          console.warn('[tu-bubbles] 落库失败', error)
          // 落库失败（例如另一个 DSH 进程正在写同一个库）不能静默丢消息：
          // 先在内存里显示出来并回执，再提示用户这条没有持久化。
          const displayed = { ...message, direction: 'in', status: 'delivered' }
          if (message.channelId === this.state.activeChannelId) this.appendMessage(displayed)
          this.mesh.sendTo(fromMemberId, { t: 'ack', id: message.id })
          this.toast('消息已显示，但写入本地数据库失败（可能有另一个 DSH 进程正在使用同一个库）')
        }
      }

      /* --------------------------------------------------------------- 表情 */

      ensureEmoji(id) {
        if (!id || this.state.emojiData[id] || this.emojiInflight.has(id)) return
        this.emojiInflight.add(id)
        this.call('emojis/get', { id })
          .then((emoji) => {
            this.emit({ emojiData: { ...this.state.emojiData, [id]: `data:${emoji.mime};base64,${emoji.data}` } })
          })
          .catch(() => {})
          .finally(() => this.emojiInflight.delete(id))
      }

      async uploadEmoji(file) {
        if (!file) return
        if (!['image/png', 'image/gif', 'image/webp'].includes(file.type)) {
          return this.toast('只支持 PNG / GIF / WebP 图片')
        }
        if (file.size > MAX_EMOJI_BYTES) return this.toast('表情不能超过 256KB')
        try {
          const data = await fileToBase64(file)
          const name = (file.name.replace(/\.[^.]+$/, '') || '表情').slice(0, 24)
          const emoji = await this.call('emojis/add', { name, mime: file.type, data })
          await this.refreshEmojis()
          this.ensureEmoji(emoji.id)
          this.toast('表情已添加')
        } catch (error) {
          this.toast(`上传失败：${error.message}`)
        }
      }

      async deleteEmoji(id) {
        try {
          await this.call('emojis/delete', { id })
          await this.refreshEmojis()
        } catch (error) {
          this.toast(error.message)
        }
      }

      /* --------------------------------------------------------------- 房间 */

      applyRoom(room) {
        if (!room || typeof room !== 'object') return
        const self = room.self ?? null
        if (self?.memberId) {
          this.mesh.setSelf({
            memberId: self.memberId,
            accountId: self.accountId ?? this.state.identity?.accountId ?? null,
            name: this.state.nickname,
          })
        }
        const selfId = self?.memberId ?? null
        const members = (room.members ?? []).map((m) => ({
          memberId: m.memberId,
          accountId: m.accountId ?? null,
          name: m.name ?? m.accountId ?? m.memberId,
          isSelf: m.memberId === selfId,
        }))
        // 本地昵称覆盖房间里的旧名字（同一个 accountId 只保留最新昵称）。
        if (self) {
          const mine = members.find((m) => m.memberId === selfId)
          if (mine) mine.name = this.state.nickname
        }
        this.emit({ room, members })
        this.mesh.sync(room.members ?? [])
      }

      async createRoom() {
        if (!this.state.identity?.signedIn) return this.toast('请先登录账号')
        try {
          const room = await this.call('room/create', { memberId: this.memberId() })
          this.applyRoom(room)
          this.startPolling()
          this.toast(room.invites?.length ? '房间已创建，把邀请串发给对方' : '房间已创建')
        } catch (error) {
          this.toast(`创建房间失败：${error.message}`)
        }
      }

      async joinRoom(invite) {
        const text = String(invite ?? '').trim()
        if (!text) return this.toast('请粘贴邀请串')
        try {
          const room = await this.call('room/join', { invite: text, memberId: this.memberId() })
          this.applyRoom(room)
          this.startPolling()
        } catch (error) {
          this.toast(`加入房间失败：${error.message}`)
        }
      }

      async leaveRoom() {
        this.stopPolling()
        this.mesh.dispose()
        this.mesh = new Mesh({
          call: this.call,
          onPeerChange: (memberId, state) => {
            this.emit({ peerStates: { ...this.state.peerStates, [memberId]: state } })
          },
          onData: (data, fromMemberId) => this.handleIncoming(data, fromMemberId),
        })
        try {
          await this.call('room/leave')
        } catch {
          /* 忽略 */
        }
        this.emit({ room: null, members: [], peerStates: {} })
      }

      /* ----------------------------------------------------------- 事件轮询 */

      startPolling() {
        if (this.polling) return
        this.polling = true
        const tick = async () => {
          if (!this.polling || this.disposed) return
          try {
            const { events, room } = await this.call('sync')
            this.applyRoom(room)
            for (const event of events ?? []) await this.handleEvent(event)
          } catch (error) {
            // 单次失败不影响下一轮；记一条日志，避免「连不上」时完全无线索。
            console.warn('[tu-bubbles] 同步失败', error)
          }
          if (!this.polling) return
          const interval = this.state.room?.role ? POLL_ACTIVE_MS : POLL_IDLE_MS
          this.pollTimer = setTimeout(tick, interval)
        }
        tick()
      }

      stopPolling() {
        this.polling = false
        if (this.pollTimer) clearTimeout(this.pollTimer)
        this.pollTimer = null
      }

      async handleEvent(event) {
        if (!event || typeof event !== 'object') return
        switch (event.kind) {
          case 'signal':
            await this.mesh.handleSignal(event.from, event.payload)
            break
          case 'channel-created':
          case 'channel-renamed':
          case 'channel-archived':
            await this.refreshChannels()
            break
          case 'nickname': {
            const members = this.state.members.map((m) =>
              m.accountId === event.accountId ? { ...m, name: event.name ?? m.name } : m,
            )
            this.emit({ members })
            break
          }
          case 'error':
            this.toast(event.message ?? '信令错误')
            break
          case 'host-changed': {
            // 房主走了：继任者已用同一个房间码接管（可能就是我们自己）。
            // 已建立的 DataChannel 是端到端的，不需要重建；这里只刷新房间与成员，
            // 让 Mesh 按新的成员表补连或断开。
            this.applyRoom(event.room ?? (await this.call('room/status').catch(() => this.state.room)))
            this.toast(event.self ? '原房主已离开，本机已接管房间' : '房主已更换，已连上新房主')
            break
          }
          case 'reconnected':
            // 断线后原地重连上了原房主：成员表可能已经变化，刷新一下即可。
            this.applyRoom(await this.call('room/status').catch(() => this.state.room))
            break
          case 'member-offline':
          case 'peer-left':
            this.applyRoom(await this.call('room/status').catch(() => this.state.room))
            break
          default:
            // members / member-online / joined / room：房间状态已随 sync 更新
            break
        }
      }

      async loadDebugInfo() {
        try {
          this.emit({ debug: await this.call('debug/info') })
        } catch (error) {
          this.toast(`读取调试信息失败：${error.message}`)
        }
      }

      dispose() {
        this.disposed = true
        this.stopPolling()
        this.mesh.dispose()
        if (this.toastTimer) clearTimeout(this.toastTimer)
        this.listeners.clear()
      }
    }

    /* -------------------------------------------------------------- React UI */

    function useSnapshot(controller) {
      const [, force] = React.useState(0)
      React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [controller])
      return controller.state
    }

    function PanelIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 6, cy: 7, r: 3.4 }),
        h('circle', { cx: 11.2, cy: 11, r: 2.2 }),
        h('path', { d: 'M4.4 6.2c.5.4 1 .6 1.6.6s1.1-.2 1.6-.6' }),
      )
    }

    const STATUS_TEXT = {
      sending: '发送中',
      sent: '已发送',
      delivered: '已送达',
      failed: '发送失败',
    }

    function EmojiContent({ controller, body, size = 26 }) {
      const parsed = safeJson(body) ?? {}
      const unicode = typeof parsed.unicode === 'string' ? parsed.unicode : null
      const emojiId = parsed.emojiId ?? null
      const src = emojiId ? controller.state.emojiData[emojiId] : null
      // 钩子必须无条件调用：unicode 表情没有图片，但也走同一条 effect。
      React.useEffect(() => {
        if (emojiId && !src) controller.ensureEmoji(emojiId)
      }, [emojiId, src, controller])
      if (unicode) {
        return h('span', { className: 'tub-emoji-unicode', style: { fontSize: size } }, unicode)
      }
      if (!src) return h('span', { className: 'tub-emoji-missing' }, `[${parsed.name ?? '表情'}]`)
      return h('img', { className: 'tub-emoji-img', src, alt: parsed.name ?? '表情', draggable: false })
    }

    /** 单个自定义表情格子：图片按需从 host 取（列表只回元数据）。 */
    function CustomEmojiCell({ controller, emoji, onPick }) {
      const src = controller.state.emojiData[emoji.id]
      React.useEffect(() => {
        if (!src) controller.ensureEmoji(emoji.id)
      }, [emoji.id, src, controller])
      return h(
        'button',
        {
          className: 'tub-emoji-cell',
          title: `${emoji.name}（右键删除）`,
          onClick: () => onPick({ id: emoji.id, name: emoji.name }),
          onContextMenu: (event) => {
            event.preventDefault()
            controller.deleteEmoji(emoji.id)
          },
        },
        src ? h('img', { className: 'tub-emoji-img', src, alt: emoji.name }) : h('span', { className: 'tub-emoji-placeholder' }, '…'),
      )
    }

    function MessageRow({ controller, message, showSender }) {
      const mine = message.senderId === controller.state.identity?.accountId && message.direction !== 'in'
      return h(
        'div',
        { className: `tub-msg ${mine ? 'tub-msg-mine' : ''}` },
        showSender && !mine
          ? h('div', { className: 'tub-msg-sender' }, message.senderName)
          : null,
        h(
          'div',
          { className: 'tub-msg-bubble' },
          message.kind === 'emoji'
            ? h(EmojiContent, { controller, body: message.body })
            : h('span', { className: 'tub-msg-text' }, message.body),
        ),
        h(
          'div',
          { className: 'tub-msg-meta' },
          h('span', null, formatTime(message.sentAt)),
          mine ? h('span', { className: `tub-status tub-status-${message.status}` }, STATUS_TEXT[message.status] ?? message.status) : null,
          mine && message.status === 'failed'
            ? h('button', { className: 'tub-link', onClick: () => controller.retryMessage(message) }, '重试')
            : null,
        ),
      )
    }

    function NicknameEditor({ controller }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(controller.state.nickname)
      React.useEffect(() => setDraft(controller.state.nickname), [controller.state.nickname])
      if (!editing) {
        return h(
          'button',
          {
            className: 'tub-nickname',
            title: '修改昵称',
            onClick: () => {
              setDraft(controller.state.nickname)
              setEditing(true)
            },
          },
          controller.state.nickname || '未命名',
          h('span', { className: 'tub-nickname-edit' }, '改'),
        )
      }
      const submit = () => {
        controller.setNickname(draft)
        setEditing(false)
      }
      return h(
        'span',
        { className: 'tub-nickname-editing' },
        h('input', {
          className: 'tub-input tub-nickname-input',
          value: draft,
          maxLength: 24,
          autoFocus: true,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') setEditing(false)
          },
        }),
        h('button', { className: 'tub-btn tub-btn-primary', onClick: submit }, '保存'),
        h('button', { className: 'tub-btn', onClick: () => setEditing(false) }, '取消'),
      )
    }

    function ChannelList({ controller }) {
      const state = controller.state
      const [creating, setCreating] = React.useState(false)
      const [name, setName] = React.useState('')
      const [renamingId, setRenamingId] = React.useState(null)
      const [renameDraft, setRenameDraft] = React.useState('')
      const [confirmArchiveId, setConfirmArchiveId] = React.useState(null)

      const submitCreate = () => {
        if (!name.trim()) return
        controller.createChannel(name)
        setName('')
        setCreating(false)
      }

      return h(
        'aside',
        { className: 'tub-channels' },
        h(
          'div',
          { className: 'tub-section-title' },
          h('span', null, '频道'),
          h(
            'button',
            { className: 'tub-icon-btn', title: '新建频道', onClick: () => setCreating((v) => !v) },
            '+',
          ),
        ),
        creating
          ? h(
              'div',
              { className: 'tub-create-row' },
              h('input', {
                className: 'tub-input',
                placeholder: '频道名',
                value: name,
                maxLength: 32,
                autoFocus: true,
                onChange: (event) => setName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitCreate()
                  if (event.key === 'Escape') setCreating(false)
                },
              }),
              h('button', { className: 'tub-btn tub-btn-primary', onClick: submitCreate }, '建'),
            )
          : null,
        h(
          'div',
          { className: 'tub-channel-scroll' },
          state.channels.map((channel) => {
            const active = channel.id === state.activeChannelId
            const isRenaming = renamingId === channel.id
            return h(
              'div',
              {
                key: channel.id,
                className: `tub-channel ${active ? 'tub-channel-active' : ''}`,
                onClick: () => controller.selectChannel(channel.id),
                onDoubleClick: () => {
                  setRenamingId(channel.id)
                  setRenameDraft(channel.name)
                },
                title: '双击重命名',
              },
              isRenaming
                ? h(
                    'span',
                    { className: 'tub-create-row', onClick: (event) => event.stopPropagation() },
                    h('input', {
                      className: 'tub-input',
                      value: renameDraft,
                      maxLength: 32,
                      autoFocus: true,
                      onChange: (event) => setRenameDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          controller.renameChannel(channel.id, renameDraft)
                          setRenamingId(null)
                        }
                        if (event.key === 'Escape') setRenamingId(null)
                      },
                    }),
                  )
                : h(
                    'span',
                    { className: 'tub-channel-name' },
                    h('span', { className: 'tub-hash' }, '#'),
                    channel.name,
                  ),
              !isRenaming && channel.id !== 'lobby'
                ? h(
                    'span',
                    { className: 'tub-channel-actions' },
                    confirmArchiveId === channel.id
                      ? h(
                          'button',
                          {
                            className: 'tub-link tub-danger',
                            onClick: (event) => {
                              event.stopPropagation()
                              controller.archiveChannel(channel.id)
                              setConfirmArchiveId(null)
                            },
                          },
                          '确认归档',
                        )
                      : h(
                          'button',
                          {
                            className: 'tub-icon-btn',
                            title: '归档频道（仅创建者可用）',
                            onClick: (event) => {
                              event.stopPropagation()
                              setConfirmArchiveId(channel.id)
                            },
                          },
                          '×',
                        ),
                  )
                : null,
            )
          }),
        ),
        h(
          'div',
          { className: 'tub-channels-foot' },
          h('span', null, `共 ${state.channels.length} 个频道`),
        ),
      )
    }

    function EmojiPicker({ controller, onPick, onClose }) {
      const state = controller.state
      const [tab, setTab] = React.useState('builtin')
      const inputRef = React.useRef(null)
      return h(
        'div',
        { className: 'tub-emoji-panel' },
        h(
          'div',
          { className: 'tub-emoji-tabs' },
          h(
            'button',
            {
              className: `tub-tab ${tab === 'builtin' ? 'tub-tab-active' : ''}`,
              onClick: () => setTab('builtin'),
            },
            '内置',
          ),
          h(
            'button',
            {
              className: `tub-tab ${tab === 'custom' ? 'tub-tab-active' : ''}`,
              onClick: () => setTab('custom'),
            },
            `自定义 ${state.emojis.length}`,
          ),
          h(
            'span',
            { className: 'tub-emoji-tabs-right' },
            tab === 'custom'
              ? h(
                  'button',
                  { className: 'tub-btn tub-btn-small', onClick: () => inputRef.current?.click() },
                  '上传',
                )
              : null,
            h('button', { className: 'tub-icon-btn', title: '关闭', onClick: onClose }, '×'),
          ),
        ),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: 'image/png,image/gif,image/webp',
          style: { display: 'none' },
          onChange: async (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) await controller.uploadEmoji(file)
          },
        }),
        tab === 'builtin'
          ? h(
              'div',
              { className: 'tub-emoji-grid' },
              BUILTIN_EMOJIS.map((unicode) =>
                h(
                  'button',
                  { key: unicode, className: 'tub-emoji-cell', onClick: () => onPick({ unicode }) },
                  unicode,
                ),
              ),
            )
          : h(
              'div',
              { className: 'tub-emoji-grid' },
              state.emojis.length === 0
                ? h('div', { className: 'tub-empty' }, '还没有自定义表情，点「上传」加一个（≤256KB）')
                : state.emojis.map((emoji) =>
                    h(CustomEmojiCell, { key: emoji.id, controller, emoji, onPick }),
                  ),
            ),
        tab === 'custom'
          ? h('div', { className: 'tub-hint' }, '提示：右键点击自定义表情可删除；上传的图片存进本地 SQLite。')
          : null,
      )
    }

    function Composer({ controller }) {
      const [text, setText] = React.useState('')
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const textareaRef = React.useRef(null)
      const channel = controller.activeChannel()

      const send = () => {
        const value = text
        if (!value.trim()) return
        setText('')
        controller.sendText(value)
        textareaRef.current?.focus()
      }

      return h(
        'div',
        { className: 'tub-composer' },
        pickerOpen
          ? h(EmojiPicker, {
              controller,
              onPick: (item) => {
                controller.sendEmoji(item)
                setPickerOpen(false)
              },
              onClose: () => setPickerOpen(false),
            })
          : null,
        h(
          'div',
          { className: 'tub-composer-row' },
          h(
            'button',
            {
              className: 'tub-icon-btn tub-emoji-toggle',
              title: '表情',
              disabled: !channel,
              onClick: () => setPickerOpen((v) => !v),
            },
            '☺',
          ),
          h('textarea', {
            ref: textareaRef,
            className: 'tub-textarea',
            placeholder: channel ? `发送到 #${channel.name}（Enter 发送，Shift+Enter 换行）` : '请先选择频道',
            value: text,
            rows: 1,
            maxLength: MAX_TEXT,
            disabled: !channel,
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h(
            'button',
            { className: 'tub-btn tub-btn-primary tub-send', disabled: !channel || !text.trim(), onClick: send },
            '发送',
          ),
        ),
      )
    }

    function ChatPane({ controller }) {
      const state = controller.state
      const channel = controller.activeChannel()
      const listRef = React.useRef(null)
      React.useEffect(() => {
        const node = listRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [state.messages.length, state.activeChannelId])

      if (!channel) {
        return h('section', { className: 'tub-chat' }, h('div', { className: 'tub-empty tub-empty-center' }, '没有可用的频道'))
      }

      return h(
        'section',
        { className: 'tub-chat' },
        h(
          'header',
          { className: 'tub-chat-head' },
          h('div', { className: 'tub-chat-title' }, h('span', { className: 'tub-hash' }, '#'), channel.name),
          h(
            'div',
            { className: 'tub-chat-sub' },
            state.members.filter((m) => !m.isSelf).length,
            ' 位在线成员 · 消息存本地 SQLite',
          ),
        ),
        h(
          'div',
          { className: 'tub-messages', ref: listRef },
          state.messages.length === 0
            ? h('div', { className: 'tub-empty tub-empty-center' }, '还没有消息，说点什么吧')
            : state.messages.map((message, index) => {
                const previous = state.messages[index - 1]
                const showSender = !previous || previous.senderId !== message.senderId
                return h(MessageRow, { key: message.id, controller, message, showSender })
              }),
        ),
        h(Composer, { controller }),
      )
    }

    function InviteBlock({ controller }) {
      const room = controller.state.room
      const [copied, setCopied] = React.useState(null)
      if (!room?.invites?.length) return null
      const copy = async (invite) => {
        try {
          await navigator.clipboard.writeText(invite)
          setCopied(invite)
          setTimeout(() => setCopied(null), 1600)
        } catch {
          controller.toast('复制失败，请手动选择文本复制')
        }
      }
      return h(
        'div',
        { className: 'tub-invites' },
        h('div', { className: 'tub-hint' }, '把这个邀请串发给对方，对方粘贴到「加入房间」即可：'),
        room.invites.map((item) =>
          h(
            'div',
            { key: item.invite, className: 'tub-invite' },
            h('code', { className: 'tub-invite-code' }, item.invite),
            h(
              'button',
              { className: 'tub-btn tub-btn-small', onClick: () => copy(item.invite) },
              copied === item.invite ? '已复制' : '复制',
            ),
          ),
        ),
      )
    }

    function RoomPanel({ controller }) {
      const state = controller.state
      const [invite, setInvite] = React.useState('')
      const [debugOpen, setDebugOpen] = React.useState(false)
      const room = state.room
      const isHost = room?.role === 'host'

      return h(
        'aside',
        { className: 'tub-room' },
        h('div', { className: 'tub-section-title' }, h('span', null, '房间')),
        room?.role
          ? h(
              'div',
              { className: 'tub-room-card' },
              h(
                'div',
                { className: 'tub-room-line' },
                h('span', { className: 'tub-room-badge' }, isHost ? '房主' : '成员'),
                h('span', { className: 'tub-room-code' }, room.roomCode ?? ''),
              ),
              isHost ? h(InviteBlock, { controller }) : h('div', { className: 'tub-hint' }, `已连接到房主的信令服务（${room.hostAddress ?? '本机'}）`),
              h(
                'button',
                { className: 'tub-btn tub-btn-danger tub-btn-block', onClick: () => controller.leaveRoom() },
                '断开房间',
              ),
            )
          : h(
              'div',
              { className: 'tub-room-card' },
              h('div', { className: 'tub-hint' }, '两台机器都能聊天，需要先建立一个房间：创建后把邀请串发给对方。'),
              h(
                'button',
                { className: 'tub-btn tub-btn-primary tub-btn-block', onClick: () => controller.createRoom() },
                '创建房间（本机做信令主机）',
              ),
              h('div', { className: 'tub-join-row' },
                h('input', {
                  className: 'tub-input',
                  placeholder: '粘贴邀请串 192.168.1.5:7357/AB12CD',
                  value: invite,
                  onChange: (event) => setInvite(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      controller.joinRoom(invite)
                      setInvite('')
                    }
                  },
                }),
                h(
                  'button',
                  {
                    className: 'tub-btn',
                    onClick: () => {
                      controller.joinRoom(invite)
                      setInvite('')
                    },
                  },
                  '加入',
                ),
              ),
            ),
        h(
          'div',
          { className: 'tub-members' },
          h('div', { className: 'tub-section-title' }, h('span', null, '成员')),
          state.members.length === 0
            ? h('div', { className: 'tub-empty' }, '还没有加入房间')
            : state.members.map((member) => {
                const peerState = member.isSelf ? 'online' : state.peerStates[member.memberId]
                const status = peerState === 'online' ? '已连接' : peerState === 'connecting' ? '连接中' : '未连接'
                return h(
                  'div',
                  { key: member.memberId, className: 'tub-member' },
                  h('span', { className: `tub-dot tub-dot-${status === '已连接' ? 'online' : status === '连接中' ? 'pending' : 'offline'}` }),
                  h('span', { className: 'tub-member-name' }, member.name, member.isSelf ? '（我）' : ''),
                  h('span', { className: 'tub-member-state' }, status),
                )
              }),
        ),
        h(
          'div',
          { className: 'tub-debug' },
          h(
            'button',
            {
              className: 'tub-link',
              onClick: async () => {
                const next = !debugOpen
                setDebugOpen(next)
                if (next) await controller.loadDebugInfo()
              },
            },
            debugOpen ? '收起调试信息' : '调试信息',
          ),
          debugOpen
            ? h(
                'pre',
                { className: 'tub-debug-body' },
                state.debug
                  ? `数据库：${state.debug.dbFile}\n结构版本：${state.debug.schemaVersion}\n频道数：${state.debug.channels}\n表情数：${state.debug.emojis}\n历史人物：${state.debug.peers}`
                  : '读取中…',
              )
            : null,
        ),
      )
    }

    function SignedOutView({ controller }) {
      return h(
        'div',
        { className: 'tub-signedout' },
        h('div', { className: 'tub-signedout-card' },
          h('div', { className: 'tub-signedout-icon' }, h(PanelIcon, { size: 40 })),
          h('h2', null, '请先登录 DeepSeek Harness 账号'),
          h('p', null, '吐泡泡只使用 DeepSeek Harness 的登录身份，不提供其它登录方式。'),
          h(
            'ol',
            { className: 'tub-steps' },
            h('li', null, '打开「设置 → 账号」'),
            h('li', null, '用 DeepSeek 账号完成登录'),
            h('li', null, '回到这里，点下面的「刷新状态」'),
          ),
          controller.state.identity?.reason
            ? h('p', { className: 'tub-hint' }, `当前状态：${controller.state.identity.reason}`)
            : null,
          h(
            'button',
            {
              className: 'tub-btn tub-btn-primary',
              onClick: () => controller.reload(),
            },
            '刷新状态',
          ),
        ),
      )
    }

    function Panel({ controller }) {
      const state = useSnapshot(controller)

      React.useEffect(() => {
        controller.init()
      }, [controller])

      if (state.status === 'loading' || state.status === 'idle') {
        return h('div', { className: 'tub-root tub-loading' }, '正在读取本地数据…')
      }
      if (state.status === 'error') {
        return h(
          'div',
          { className: 'tub-root tub-loading' },
          h('div', { className: 'tub-error' }, `插件启动失败：${state.error}`),
          h('div', { className: 'tub-hint' }, '检查插件日志：设置 → 插件 → 吐泡泡；数据库文件位置可在「调试信息」里看到。'),
        )
      }
      if (!state.identity?.signedIn) {
        return h('div', { className: 'tub-root' }, h(SignedOutView, { controller }))
      }

      return h(
        'div',
        { className: 'tub-root' },
        h(
          'header',
          { className: 'tub-header' },
          h('div', { className: 'tub-brand' }, h(PanelIcon, { size: 22 }), h('span', { className: 'tub-brand-name' }, '吐泡泡')),
          h('div', { className: 'tub-brand-sub' }, '局域网 · WebRTC 直连 · 本地 SQLite'),
          h('div', { className: 'tub-header-right' },
            h(NicknameEditor, { controller }),
            h('span', { className: `tub-room-pill ${state.room?.role ? 'tub-room-pill-on' : ''}` },
              state.room?.role ? (state.room.role === 'host' ? `房主 · ${state.room.roomCode ?? ''}` : '已加入房间') : '未加入房间',
            ),
          ),
        ),
        h(
          'div',
          { className: 'tub-body' },
          h(ChannelList, { controller }),
          h(ChatPane, { controller }),
          h(RoomPanel, { controller }),
        ),
        state.toast ? h('div', { className: 'tub-toast' }, state.toast) : null,
      )
    }

    /* ------------------------------------------------------------------ 样式 */

    const STYLE_ID = 'tu-bubbles-style'
    const CSS = `
.tub-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1b1b1f);font-size:13px}
.tub-loading{align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-secondary,#666)}
.tub-header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e6ea);flex:none}
.tub-brand{display:flex;align-items:center;gap:6px;font-weight:600;font-size:15px}
.tub-brand-sub{color:var(--dsw-alias-label-secondary,#777);font-size:12px}
.tub-header-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.tub-nickname{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 7px;color:inherit;cursor:pointer;font-size:13px}
.tub-nickname:hover{border-color:var(--dsw-alias-border-l1,#ddd);background:var(--dsw-alias-bg-layer-2,#f5f5f7)}
.tub-nickname-edit{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.tub-nickname-editing{display:inline-flex;gap:6px;align-items:center}
.tub-nickname-input{width:130px}
.tub-room-pill{font-size:11px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f1f1f4);color:var(--dsw-alias-label-secondary,#666)}
.tub-room-pill-on{background:rgba(52,168,83,.14);color:#2f8f4e}
.tub-body{display:flex;flex:1;min-height:0}
.tub-channels{width:190px;flex:none;border-right:1px solid var(--dsw-alias-border-l1,#e6e6ea);display:flex;flex-direction:column;min-height:0;padding:8px}
.tub-section-title{display:flex;align-items:center;justify-content:space-between;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#888);padding:4px 4px 8px;text-transform:uppercase}
.tub-channel-scroll{overflow-y:auto;flex:1;min-height:0}
.tub-channel{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:7px;cursor:pointer;position:relative}
.tub-channel:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f7)}
.tub-channel-active{background:var(--dsw-alias-bg-layer-2,#ececf1);font-weight:600}
.tub-channel-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.tub-hash{color:var(--dsw-alias-label-secondary,#999);margin-right:2px}
.tub-channel-actions{display:none;gap:2px}
.tub-channel:hover .tub-channel-actions{display:flex}
.tub-channels-foot{padding-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#999);border-top:1px solid var(--dsw-alias-border-l1,#eee);margin-top:6px}
.tub-create-row{display:flex;gap:4px;padding:2px 0 6px}
.tub-chat{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.tub-chat-head{display:flex;align-items:baseline;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee);flex:none}
.tub-chat-title{font-weight:600;font-size:14px}
.tub-chat-sub{color:var(--dsw-alias-label-secondary,#888);font-size:11px}
.tub-messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:0}
.tub-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:74%}
.tub-msg-mine{align-self:flex-end;align-items:flex-end}
.tub-msg-sender{font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-bottom:2px}
.tub-msg-bubble{background:var(--dsw-alias-bg-layer-2,#f3f3f6);border-radius:10px;padding:7px 10px;word-break:break-word;white-space:pre-wrap;line-height:1.5}
.tub-msg-mine .tub-msg-bubble{background:var(--dsw-alias-button-primary-fill,#3b6ef6);color:var(--dsw-alias-label-primary-inverted,#0f1115)}
.tub-msg-emoji .tub-msg-bubble{background:transparent;padding:0}
.tub-msg-meta{display:flex;gap:6px;align-items:center;font-size:10px;color:var(--dsw-alias-label-secondary,#999);margin-top:3px}
.tub-status-failed{color:#d33}
.tub-status-delivered{color:#2f8f4e}
.tub-emoji-unicode{line-height:1}
.tub-emoji-img{width:26px;height:26px;object-fit:contain;vertical-align:middle}
.tub-emoji-missing{color:var(--dsw-alias-label-secondary,#999);font-size:11px}
.tub-composer{border-top:1px solid var(--dsw-alias-border-l1,#eee);padding:10px 14px;position:relative;flex:none}
.tub-composer-row{display:flex;gap:8px;align-items:flex-end}
.tub-textarea{flex:1;resize:none;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;padding:8px 10px;font:inherit;line-height:1.5;max-height:120px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f2f2f5);outline:none}
.tub-textarea:focus{border-color:var(--dsw-alias-link,#3b6ef6)}
.tub-send{flex:none}
.tub-emoji-toggle{font-size:16px;line-height:1}
.tub-emoji-panel{position:absolute;left:14px;bottom:58px;width:300px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e2e2e8);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);z-index:5;padding:8px}
.tub-emoji-tabs{display:flex;align-items:center;gap:4px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}
.tub-emoji-tabs-right{margin-left:auto;display:flex;align-items:center;gap:4px}
.tub-tab{background:transparent;border:none;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary,#777)}
.tub-tab-active{background:var(--dsw-alias-bg-layer-2,#f0f0f4);color:var(--dsw-alias-label-primary,#222);font-weight:600}
.tub-emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding-top:6px;max-height:190px;overflow-y:auto}
.tub-emoji-cell{border:none;background:transparent;font-size:19px;line-height:1;padding:4px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.tub-emoji-cell:hover{background:var(--dsw-alias-bg-layer-2,#f0f0f4)}
.tub-emoji-placeholder{color:var(--dsw-alias-label-secondary,#bbb);font-size:12px}
.tub-room{width:230px;flex:none;border-left:1px solid var(--dsw-alias-border-l1,#e6e6ea);padding:8px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.tub-room-card{background:var(--dsw-alias-bg-layer-2,#f6f6f9);border-radius:9px;padding:10px;display:flex;flex-direction:column;gap:8px}
.tub-room-line{display:flex;align-items:center;gap:6px;font-size:12px}
.tub-room-badge{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e2e2e8);border-radius:999px;padding:1px 7px;font-size:11px}
.tub-room-code{font-family:ui-monospace,Consolas,monospace;font-weight:600;letter-spacing:.08em}
.tub-invite{display:flex;align-items:center;gap:6px;margin-top:4px}
.tub-invite-code{flex:1;font-size:11px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e2e2e8);border-radius:6px;padding:4px 6px;overflow-x:auto;white-space:nowrap}
.tub-join-row{display:flex;gap:4px}
.tub-members{display:flex;flex-direction:column;gap:2px}
.tub-member{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;font-size:12px}
.tub-member-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tub-member-state{font-size:10px;color:var(--dsw-alias-label-secondary,#999)}
.tub-dot{width:7px;height:7px;border-radius:50%;flex:none}
.tub-dot-online{background:#34a853}
.tub-dot-pending{background:#e8a33d}
.tub-dot-offline{background:#bbb}
.tub-debug{font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-top:auto}
.tub-debug-body{white-space:pre-wrap;background:var(--dsw-alias-bg-layer-2,#f6f6f9);border-radius:6px;padding:6px;font-size:10px;word-break:break-all}
.tub-btn{border:1px solid var(--dsw-alias-border-l1,#d9d9df);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f2f2f5);border-radius:7px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.tub-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f2f2f5)}
.tub-btn:disabled{opacity:.5;cursor:default}
.tub-btn-small{padding:2px 7px;font-size:11px}
.tub-btn-primary{background:var(--dsw-alias-button-primary-fill,#3b6ef6);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#0f1115)}
.tub-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-button-primary-fill,#3b6ef6)}
.tub-btn-danger{color:#c33;border-color:rgba(204,51,51,.35)}
.tub-btn-block{width:100%}
.tub-icon-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:15px;line-height:1;padding:2px 5px;border-radius:5px}
.tub-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#eee)}
.tub-input{border:1px solid var(--dsw-alias-border-l1,#d9d9df);border-radius:6px;padding:4px 7px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-layer-2,#2a2a2e);color:var(--dsw-alias-label-primary,#f2f2f5);outline:none;min-width:0;flex:1}
.tub-input:focus{border-color:var(--dsw-alias-link,#3b6ef6)}
.tub-link{border:none;background:transparent;color:var(--dsw-alias-link,#3b6ef6);cursor:pointer;font:inherit;font-size:11px;padding:0}
.tub-danger{color:#c33}
.tub-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#888)}
.tub-empty{padding:14px;text-align:center;color:var(--dsw-alias-label-secondary,#999);font-size:12px}
.tub-empty-center{margin:auto}
.tub-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(30,30,34,.92);color:#fff;font-size:12px;padding:8px 14px;border-radius:999px;z-index:50;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.tub-signedout{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.tub-signedout-card{max-width:420px;display:flex;flex-direction:column;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,#e6e6ea);border-radius:14px;padding:22px;background:var(--dsw-alias-bg-layer-1,#fff)}
.tub-signedout-icon{color:var(--dsw-alias-link,#3b6ef6)}
.tub-signedout-card h2{margin:0;font-size:16px}
.tub-signedout-card p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.6}
.tub-steps{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.8}
.tub-error{color:#c33;font-size:13px}
`

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ 入口 */

    return {
      /**
       * connection 必须写进 inject：客户端 Cordis 上下文读服务属性时会检查注入表，
       * 只在 apply 里「碰巧」拿到 ctx.connection 会在渲染时报
       * cannot get property "connection" without inject。
       */
      inject: ['slots', 'connection'],

      /** 测试钩子：test/client.test.mjs 用它们在 Node 里跑同一套逻辑。 */
      __internals: { Controller, Mesh, createCall },

      apply(ctx) {
        injectStyles()

        const call = createCall(ctx)
        const controller = new Controller(ctx, call)

        // 调试抓手：在 DevTools 控制台里可以 `__tuBubbles.controller.state` 看状态，
        // `__tuBubbles.controller.mesh.peers` 看每条连接。生产上无副作用。
        try {
          globalThis.__tuBubbles = { controller }
        } catch {
          /* 只读环境忽略 */
        }

        const registerUi = (slotCtx) => {
          slotCtx.slots.inject('main', () =>
            slotCtx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { controller })),
          )
          slotCtx.slots.inject('sidebar.panellist', () =>
            slotCtx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => '吐泡泡' },
              PanelIcon,
            ),
          )
        }

        try {
          if (ctx.slots) registerUi(ctx)
          else if (typeof ctx.inject === 'function') ctx.inject(['slots'], registerUi)
          else console.warn('[tu-bubbles] 当前宿主没有 slots 服务，插件界面未注册')
        } catch (error) {
          console.error('[tu-bubbles] 注册界面失败', error)
        }

        // 插件停用时收尾（轮询、PeerConnection、订阅）。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => controller.dispose())
        } else if (typeof ctx.on === 'function') {
          ctx.on('dispose', () => controller.dispose())
        }
      },
    }
  },
})
