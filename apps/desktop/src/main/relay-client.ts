/**
 * 问本机的 agent「你是谁」，拿到它认领的 node id。
 *
 * 走 ~/.rpty/agents/ 下的注册文件找到 unix socket，连上去问一句 whoami。
 * 本机没跑 agent（或 socket 不在）就返回空串 —— 这个客户端就"没有宿主"，
 * 列表里会显示「宿主未上线」，而不是去猜哪台机器是自己。
 */
function askLocalAgent(): Promise<string> {
  const dir = process.env.RPTY_REGISTRY || join(os.homedir(), '.rpty', 'agents')
  return new Promise((resolve) => {
    let entries: { file: string; startedAt: number }[] = []
    try {
      entries = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((file) => {
          let startedAt = 0
          try {
            const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { started_at?: number }
            startedAt = Number(raw.started_at ?? 0)
          } catch {
            // 坏文件就当没这个 agent
          }
          return { file, startedAt }
        })
        // 老的先问：同机多开时，先起来的那台就是这台机器的"正统"宿主
        .sort((a, b) => a.startedAt - b.startedAt)
    } catch {
      resolve('')
      return
    }
    if (entries.length === 0) {
      resolve('')
      return
    }

    const tryNext = (index: number): void => {
      if (index >= entries.length) {
        resolve('')
        return
      }
      const sock = join(dir, entries[index].file.replace(/\.json$/, '.sock'))
      let done = false
      let buffer = ''
      const socket = netConnect(sock)
      const finish = (node: string): void => {
        if (done) return
        done = true
        socket.destroy()
        if (node) resolve(node)
        else tryNext(index + 1)
      }
      socket.setTimeout(500, () => finish(''))
      socket.on('error', () => finish(''))
      socket.on('close', () => finish(''))
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const line = buffer.split('\n')[0]
        if (!line) return
        try {
          const info = JSON.parse(line) as { ok?: boolean; node?: string }
          finish(info.ok && info.node ? String(info.node) : '')
        } catch {
          finish('')
        }
      })
      socket.on('connect', () => {
        socket.write(JSON.stringify({ op: 'whoami' }) + '\n')
      })
    }
    tryNext(0)
  })
}

/**
 * 控制端到 relay 的连接管理。
 *
 * 两条连接类型：
 *   /ctl          一条，长连接，只走 JSON 信令
 *   /d/<token>    每个会话一条，只走二进制
 *
 * 断线策略：ctl 断了就退避重连；重连成功后对每个已知会话重发
 * SESSION_CREATE（同一个 session_id 与 data_token）。agent 那边对重复的
 * session_id 是幂等的 —— 不新建 PTY，只回一条 SESSION_CREATED，于是控制端
 * 重新连上数据通道就能拿到 agent 重放的环形缓冲，画面原样恢复。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import WebSocket from 'ws'
import type {
  ClientInfo, JoinResult, NodeInfo, PasswordInfo, RelayConfig, RelayStatus, RoomView
} from '../shared/ipc'
import type { SessionState } from '../shared/protocol'
import { DEFAULT_PASSWORD, loadPassword, savePassword } from './password'
import { getProfile } from './profile'

interface RemoteSession {
  leafId: string
  sessionId: string
  dataToken: string
  cols: number
  rows: number
  state: SessionState
  dataWs: WebSocket | null
  dataTimer: NodeJS.Timeout | null
  /** 数据通道还没连上时收到的写入，先攒着。 */
  pending: Buffer[]
  /** true = 这个 PTY 是本端建的（能改尺寸、能重连时补 SESSION_CREATE）；false = 镜像别人的。 */
  owned: boolean
  /** 这个 PTY 跑在哪个节点上 */
  node: string
  /** 这个 PTY 属于哪个客户端（谁的桌面）：界面按它分桌面，各看各的 */
  owner: string
  /** 本端第一次看到这个会话的时间。列表还没回来时不急着判它死了。 */
  createdAt: number
}

export interface RelayHandlers {
  onStatus(status: RelayStatus): void
  onData(leafId: string, data: Uint8Array): void
  onState(leafId: string, state: SessionState, message?: string): void
  onExit(leafId: string, exitCode?: number): void
  onAdopted(
    leafId: string,
    sessionId: string,
    cols: number,
    rows: number,
    owned: boolean,
    index: number,
    node: string,
    owner: string
  ): void
  onError(code: string, message: string): void
  /** 会话归属变了（relay 告诉了我们谁是主人，或者别的窗口关了它）。 */
  onOwned(leafId: string, owned: boolean): void
  /** PTY 尺寸变了：创建端改了窗口，镜像端得跟着锁到新尺寸。 */
  onResized(leafId: string, cols: number, rows: number): void
  /** 整个节点的终端都没了（宿主退出 / 离线超时）：标签要真删掉，不是变灰。 */
  onRemoved(leafId: string): void
  /** 房间关了（对方离开 / 我主动离开 / 宽限超时）：带原因、对方名字、是不是我走的。 */
  onRoomClosed(reason: string, peerName: string, byMe: boolean): void
}

const CONNECT_TIMEOUT = 12_000

export class RelayClient {
  private config: RelayConfig | null = null
  private ctl: WebSocket | null = null
  private sessions = new Map<string, RemoteSession>()
  private bySessionId = new Map<string, RemoteSession>()

  private phase: RelayStatus['phase'] = 'idle'
  private agentOnline = false
  private hostname = ''
  /** 在线客户端列表（relay 的内存表，断开即消失） */
  private clients: ClientInfo[] = []
  /** 当前所在的一对一房间。null = S2（待配对），非空 = S3（一对一）。 */
  private room: RoomView | null = null
  /** 我刚发起配对的是谁：房间打开时用它判断「这局是我发起的」 */
  private joiningPeer = ''
  /** 自己的通话密码（明文，只在本地）；连上就上报给 relay 存哈希 */
  private password = loadPassword()
  /** relay 说我还用着默认密码 admin123 */
  private passwordIsDefault = this.password === DEFAULT_PASSWORD

  /** 我认领的宿主 node id：本机 agent，认领后不再变 */
  private hostNode = ''

  /** 当前在线的节点列表（多机）。单机时只有一项。 */
  private nodes: NodeInfo[] = []
  /** 本机节点标识，用来判断「本机共享」是否可用。默认取主机名短名。 */
  private backoff = 600
  /**
   * 渲染层的 xterm 是后挂载的（窗口加载晚于 relay 连接），早到的字节必须先攒住，
   * 否则新挂上来的镜像端会是一片空白 —— 尤其是快照，一来就一次性发完。
   */
  private readyLeaves = new Set<string>()
  private buffered = new Map<string, Buffer[]>()
  /** 面板比会话先就绪时（新建终端就是这种顺序），先把 leafId 记着。 */
  private pendingReady = new Set<string>()
  /** sessionId -> 被控机上的序号 */
  private indexLeaves = new Map<string, number>()
  /** 只读：连上了、画面在刷，但键盘输入与尺寸变更都不发给被控端。 */
  private readOnly = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private resyncTimer: NodeJS.Timeout | null = null
  /** 节点离线后等多久算「宿主真的没了」。网络抖动不该把标签清掉。 */
  private static readonly NODE_GONE_MS = 30000
  private readonly nodeGoneTimers = new Map<string, NodeJS.Timeout>()
  /** 本端主动"撤掉画面"的镜像会话。PTY 还在宿主上，只是这边不想看了。 */
  private readonly detached = new Set<string>()
  /**
   * 当前进入的设备（节点 id）。null = 停在设备列表 —— 一条数据通道都不开。
   *
   * 这是「先连中继、再选机器」的关键：连上 WSS 只代表能收到节点上下线，
   * 不等于要把所有机器上的所有终端都镜像过来。
   */
  private activeNode: string | null = null
  /** 各节点最近一次上报的会话列表。没进入设备也记着，点进去立刻能挂上。 */
  private readonly lastLists = new Map<string, unknown[]>()
  private manualClose = false
  /**
   * 这个客户端自己的身份证。存储在 userData 里，重启不变 ——
   * 不靠它，客户端一重启就忘了哪些终端是自己开的，Tab 会整片变成「共享」。
   */
  private readonly clientId = loadClientId()
  /** 客户端自我名：首次运行生成，不删数据目录就不变（同机多开也各是各的） */
  private readonly clientName = loadClientName()
  /** 自己开过的 sessionId。relay 重启会丢归属，这里留一份兜底。 */
  private readonly ownedIds = loadOwned()

  constructor(private readonly handlers: RelayHandlers) {}

  // ------------------------------------------------------------ 状态

  get status(): RelayStatus {
    return {
      phase: this.phase,
      agentOnline: this.agentOnline,
      hostname: this.hostname,
      nodes: this.nodes,
      clientName: this.clientName,
      clientId: this.clientId,
      clients: this.clients,
      room: this.room,
      passwordIsDefault: this.passwordIsDefault
    }
  }

  private setStatus(phase: RelayStatus['phase'], message?: string): void {
    this.phase = phase
    this.handlers.onStatus({
      phase,
      agentOnline: this.agentOnline,
      hostname: this.hostname,
      nodes: this.nodes,
      clientName: this.clientName,
      clientId: this.clientId,
      clients: this.clients,
      room: this.room,
      passwordIsDefault: this.passwordIsDefault,
      message
    })
  }

  private setAgentOnline(online: boolean): void {
    if (this.agentOnline === online) return
    this.agentOnline = online
    this.handlers.onStatus({
      phase: this.phase,
      agentOnline: online,
      hostname: this.hostname,
      nodes: this.nodes,
      clientName: this.clientName,
      clientId: this.clientId,
      clients: this.clients,
      room: this.room,
      passwordIsDefault: this.passwordIsDefault
    })
  }

  /**
   * 更新节点表。
   *
   * relay 只在节点上下线、改名、会话数变化时推，不是高频操作。
   */
  private updateNodes(raw: unknown): void {
    if (!Array.isArray(raw)) return
    this.nodes = raw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((n) => ({
        node: String(n.node ?? ''),
        name: String(n.name ?? n.node ?? ''),
        platform: n.platform ? String(n.platform) : undefined,
        online: Boolean(n.online),
        sessions: Number(n.sessions ?? 0) || 0
      }))

    // 左上角那个「宿主 xxx」：只有一台在线时直接写它，多台就写个数，不猜"哪台是我"。
    const online = this.nodes.filter((n) => n.online)
    const label =
      online.length === 1
        ? online[0].name
        : online.length > 1
          ? `${online.length} 个节点`
          : ''
    if (label) this.hostname = label

    this.setAgentOnline(online.length > 0)

    // 自己是谁的宿主，只问过一次（connect 时）。如果那次 agent 还没起来，
    // 之后就一直空着 —— 列表上自己那张卡永远写「宿主未上线」，「我的终端」也没有。
    // 节点表一推就说明 relay 手里至少有一台在线的，这时候补问一次。
    if (!this.hostNode && online.length > 0) {
      void askLocalAgent().then((node) => {
        if (node) this.claimHost(node)
      })
    }

    this.setStatus(this.phase)
  }

  /** 让上层（刷新按钮 / 重连）有机会重新问一次「我是谁的宿主」。 */
  async refreshHost(): Promise<string> {
    if (this.hostNode) return this.hostNode
    const node = await askLocalAgent()
    if (node) this.claimHost(node)
    return node
  }

  /** 认领宿主并把归属告诉 relay —— 之后列表按客户端展示，进入就是进它。 */
  private claimHost(node: string): void {
    // 每次握手都重报一次：relay 的内存表随重启清空，只发一次会丢归属
    if (!node) return
    this.hostNode = node
    const ws = this.ctl
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'CTL_HOST', host: node }))
      } catch {
        // ctl 刚断，下次 HELLO 后 updateNodes 会再报
      }
    }
  }

  // ------------------------------------------------------------ 连接

  async connect(config: RelayConfig): Promise<RelayStatus> {
    this.config = config
    this.manualClose = false
    this.clearReconnect()
    this.closeCtl()

    // 先问本机 agent「你是谁」：认领宿主是事实，不是从主机名推断出来的。
    if (!this.hostNode) this.hostNode = await askLocalAgent()
    await this.openCtl()
    return this.status
  }

  /**
   * 主动断开：这是「整台客户端退出链路」，不是 kill 也不是单块终端的 detach。
   *
   * 宿主上的 PTY 一个都不动，只是这边不再收不发。所以本地状态要**清干净**，
   * 否则重连时旧 leafId、旧字节缓冲、旧节点定时器会和 relay 新推的列表打架。
   */
  /**
   * 进 / 离开自己的桌面（私有域）。
   *
   * 只在自己的宿主上开终端、只看自己名下的会话。房间是另一条路（见 enterRoom）：
   * 两者互斥，进入其中一个之前会先把另一个的订阅撤干净，否则两边的会话会混在一个标签列里。
   */
  async setActiveNode(node: string | null): Promise<void> {
    if (this.room) this.dropAllSessions()
    this.activeNode = node
    this.dropAllSessions()
    if (!node) return
    const cached = this.lastLists.get(node)
    if (cached) this.syncFromList(cached, node)
  }

  get currentDevice(): string | null {
    return this.activeNode
  }

  /** 进入房间的观看范围：房间覆盖双方宿主，两个人都能看房间里全部终端。 */
  private enterRoom(room: RoomView): void {
    this.activeNode = null
    this.room = room
    this.dropAllSessions()
    // 房间里可能已经有终端（对方在我掉线期间开的）：主动要一遍，别等下次变更。
    this.resyncSessions()
    this.setStatus(this.phase)
  }

  private leaveRoomLocal(): void {
    this.room = null
    this.dropAllSessions()
    this.setStatus(this.phase)
  }

  private dropAllSessions(): void {
    for (const session of [...this.sessions.values()]) {
      this.closeData(session)
      this.sessions.delete(session.leafId)
      this.bySessionId.delete(session.sessionId)
      this.readyLeaves.delete(session.leafId)
      this.buffered.delete(session.leafId)
      this.pendingReady.delete(session.leafId)
      this.handlers.onState(session.leafId, 'disconnected')
    }
  }

  // ------------------------------------------------------------ 房间

  /**
   * 输密码直接配对。密码对了 relay 立刻建房，双方同时收到 ROOM_OPEN ——
   * 不再有「对方点同意」这一步，对方甚至不需要在键盘前。
   */
  async joinRoom(clientId: string, password: string): Promise<JoinResult> {
    if (!this.ctl || this.ctl.readyState !== 1) {
      return { ok: false, code: 'offline', message: '中继没连上，先重新连接' }
    }
    if (!clientId || clientId === this.clientId) {
      return { ok: false, code: 'self', message: '不能连自己' }
    }
    if (!password) return { ok: false, code: 'empty', message: '请输入对方的通话密码' }
    this.joiningPeer = clientId
    this.sendSignal({ type: 'ROOM_JOIN', to: clientId, password })
    return { ok: true }
  }

  /** 自己的密码：界面上要能看见，也要知道是不是还在用默认值。 */
  getPasswordInfo(): PasswordInfo {
    return { password: this.password, isDefault: this.passwordIsDefault }
  }

  /** 改自己的密码：落盘 → 立刻上报 relay，旧密码立即失效。 */
  async setPassword(password: string): Promise<JoinResult> {
    const saved = savePassword(password)
    if (!saved.ok) return { ok: false, code: 'password_short', message: saved.error }
    this.password = password.trim()
    this.syncPassword()
    this.setStatus(this.phase)
    return { ok: true }
  }

  /** 把密码报给 relay（连上就报，改完再报一次）。relay 只存哈希。 */
  private syncPassword(): void {
    if (!this.password) return
    this.sendSignal({ type: 'CTL_PASSWORD', password: this.password })
  }

  /** 主动离开：relay 会同时关掉对方那头，两个人一起回列表。 */
  async leaveRoom(): Promise<void> {
    if (!this.room) return
    this.sendSignal({ type: 'ROOM_LEAVE' })
    this.leaveRoomLocal()
  }

  /**
   * 主动断开：这是「整台客户端退出链路」，不是 kill 也不是单块终端的 detach。
   *
   * 宿主上的 PTY 一个都不动，只是这边不再收不发。所以本地状态要**清干净**，
   * 否则重连时旧 leafId、旧字节缓冲、旧节点定时器会和 relay 新推的列表打架。
   */
  async disconnect(): Promise<void> {
    // 先跟 relay 说一声「我主动走的」，它会把房间里另一端也通知到。
    // 网络异常掉线不走这条消息，所以不会误伤别人。
    this.notifyLeave()
    await new Promise((resolve) => setTimeout(resolve, 80))
    this.manualClose = true
    this.resetLocalState()
    this.closeCtl()
    this.setStatus('idle')
  }

  /** 告诉 relay 我是主动断开，不是断网。 */
  private notifyLeave(): void {
    const ws = this.ctl
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify({ type: 'CTL_LEAVE', by: this.clientId }))
    } catch {
      // ctl 已经没了，无所谓
    }
  }

  /** 清掉本地与这次链路相关的全部状态，PTY 一个都不碰。 */
  private resetLocalState(): void {
    this.clearReconnect()
    this.clearResync()
    for (const timer of this.nodeGoneTimers.values()) clearTimeout(timer)
    this.nodeGoneTimers.clear()
    for (const session of this.sessions.values()) {
      this.closeData(session)
      this.handlers.onState(session.leafId, 'disconnected')
    }
    this.sessions.clear()
    this.bySessionId.clear()
    this.readyLeaves.clear()
    this.buffered.clear()
    this.pendingReady.clear()
    this.indexLeaves.clear()
    this.detached.clear()
    this.activeNode = null
    this.room = null
    this.joiningPeer = ''
    this.lastLists.clear()
    this.hostname = ''
    this.nodes = []
    this.agentOnline = false
  }

  /** 断开之后回来：用上次保存的地址与 token 重连，用户不用重新输。 */
  async reconnect(): Promise<RelayStatus> {
    if (!this.config?.url || !this.config?.token) throw new Error('还没有可用的 relay 地址')
    this.backoff = 600
    return this.connect(this.config)
  }

  private closeCtl(): void {
    const ws = this.ctl
    this.ctl = null
    if (ws) {
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        // 已关闭
      }
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private wsUrl(path: string): string {
    const base = (this.config?.url ?? '').replace(/\/+$/, '')
    const sep = path.includes('?') ? '&' : '?'
    const params = [`token=${encodeURIComponent(this.config?.token ?? '')}`]
    // 每个端点都要带 client 身份：
    // - /ctl：relay 靠它记「我是谁」，列表、房间、归属全挂在它上面
    // - /d/<token>：数据面也要校验可见域，不报身份一律 4003（小黑屋的门在数据面这一侧）
    params.push(`client=${encodeURIComponent(this.clientId)}`)
    if (path.startsWith('/ctl')) {
      params.push(`name=${encodeURIComponent(this.clientName)}`)
      if (this.hostNode) params.push(`host=${encodeURIComponent(this.hostNode)}`)
      // primary=1：这个客户端用的是默认数据目录，是自己这台机器上的"主窗口"。
      // relay 用它来决定无主会话归谁 —— 主窗口无标，副本窗口标共享，两边不会都标。
      if (getProfile().isDefault) params.push('primary=1')
    }
    return `${base}${path}${sep}${params.join('&')}`
  }

  private openCtl(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        reject(new Error('未设置 relay 地址'))
        return
      }

      this.setStatus('connecting')
      const ws = new WebSocket(this.wsUrl('/ctl'), {
        handshakeTimeout: CONNECT_TIMEOUT,
        perMessageDeflate: false
      })
      this.ctl = ws

      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }

      const timer = setTimeout(() => {
        settle(new Error('连接超时'))
        try {
          ws.terminate()
        } catch {
          // ignore
        }
      }, CONNECT_TIMEOUT)

      ws.on('open', () => {
        // 等 HELLO 再算真正在线。
      })

      ws.on('message', (raw, isBinary) => {
        if (isBinary) return
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        this.handleSignal(msg)
        if (msg.type === 'HELLO') {
          clearTimeout(timer)
          settle()
        }
      })

      ws.on('close', () => {
        clearTimeout(timer)
        if (this.ctl === ws) this.ctl = null
        if (!settled) settle(new Error('relay 拒绝连接，请检查地址与 token'))
        this.onCtlClosed()
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timer)
        if (!settled) settle(err)
      })
    })
  }

  private onCtlClosed(): void {
    if (this.manualClose) return
    this.setAgentOnline(false)
    for (const session of this.sessions.values()) {
      if (session.state === 'active') {
        this.handlers.onState(session.leafId, 'disconnected', '信令连接断开')
      }
    }
    this.setStatus('offline', '正在重连…')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 15_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.manualClose || !this.config) return
      this.openCtl()
        .then(() => {
          this.backoff = 600
        })
        .catch(() => this.scheduleReconnect())
    }, delay)
  }

  // ------------------------------------------------------------ 信令

  private handleSignal(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'HELLO':
        // 重新连上 = 重新和宿主对表：之前手动撤掉的镜像会话，只要 PTY 还在就再挂回来。
        this.detached.clear()
        if (Array.isArray(msg.clients)) this.clients = msg.clients as ClientInfo[]
        if (msg.nodes) this.updateNodes(msg.nodes)
        else this.setAgentOnline(Boolean(msg.agent_online))
        this.setStatus('online')
        this.backoff = 600
        if (this.hostNode) this.claimHost(this.hostNode)
        // 每次握手都重报：relay 重启后只存内存，不重报就没人能连进来。
        this.syncPassword()
        // 重连后如果还在房间里，relay 会补一条 ROOM_OPEN(resumed) —— 房间是它的状态，
        // 不需要客户端这边重新申报。
        this.resyncSessions()
        break

      case 'NODES':
        this.updateNodes(msg.nodes)
        break

      case 'CLIENTS':
        if (Array.isArray(msg.clients)) {
          this.clients = msg.clients as ClientInfo[]
          // 房间开着、但对方名字空着（它比我后重连，relay 当时还没有它的卡片）：
          // 用这份在线列表补上，别让标题栏一直挂着裸 client id。
          if (this.room && !this.room.peer.name) {
            const peer = this.clients.find((item) => item.client === this.room?.peer.client)
            if (peer?.name) this.room = { ...this.room, peer: { ...this.room.peer, name: peer.name } }
          }
          this.setStatus(this.phase)
        }
        break

      case 'NODE_ONLINE':
        this.cancelNodeGone(String(msg.node ?? ''))
        this.setAgentOnline(true)
        this.resyncSessions()
        break

      case 'NODE_OFFLINE': {
        const node = String(msg.node ?? '')
        for (const session of this.sessions.values()) {
          if (node && session.node !== node) continue
          if (session.state === 'active') {
            this.handlers.onState(session.leafId, 'disconnected', `节点 ${node || ''} 离线`)
          }
        }
        // 先留着（可能只是断网），超时还没回来就当宿主没了。
        this.scheduleNodeGone(node)
        break
      }

      // 兼容单节点老 relay
      case 'AGENT_ONLINE':
        this.setAgentOnline(true)
        this.resyncSessions()
        break

      case 'AGENT_OFFLINE':
        for (const session of this.sessions.values()) {
          if (session.state === 'active') {
            this.handlers.onState(session.leafId, 'disconnected', '被控端离线')
          }
        }
        break

      case 'SESSION_LIST': {
        const node = String(msg.node ?? '')
        // 节点还活着，撤掉「宿主没了」的倒计时。
        this.cancelNodeGone(node)
        this.syncFromList(msg.sessions, node)
        break
      }

      case 'SESSION_CREATED': {
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        // 主进程自己也要记状态：节点掉线时要靠它判断「这个会话是不是真的断了」。
        session.state = 'active'
        this.handlers.onState(session.leafId, 'active')
        break
      }

      case 'SESSION_RESIZED': {
        // 创建端改了窗口：PTY 行列变了，镜像端跟着换锁。
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        const cols = Number(msg.cols ?? 0)
        const rows = Number(msg.rows ?? 0)
        if (!cols || !rows) break
        if (cols === session.cols && rows === session.rows) break
        session.cols = cols
        session.rows = rows
        this.handlers.onResized(session.leafId, cols, rows)
        break
      }

      case 'SESSION_CLOSED': {
        // 创建端点了 ×：宿主上那块 PTY 已经没了，标签跟着消失。
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        this.dropSession(session)
        break
      }

      case 'NODE_GONE': {
        // 宿主走了：这台机器上的终端全部作废，标签整批摘掉。
        this.cancelNodeGone(String(msg.node ?? ''))
        this.removeNode(String(msg.node ?? ''))
        break
      }

      case 'SESSION_EXIT': {
        // shell 自己 exit 了：PTY 没了，标签也一起收走。
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        this.handlers.onExit(session.leafId, Number(msg.exit_code ?? 0))
        this.dropSession(session)
        break
      }

      case 'ROOM_OPEN': {
        const peer = (msg.peer ?? {}) as Record<string, unknown>
        const room: RoomView = {
          id: String(msg.room ?? ''),
          peer: {
            client: String(peer.client ?? ''),
            name: String(peer.name ?? ''),
            host: peer.host ? String(peer.host) : ''
          },
          phase: 'open',
          initiator: this.joiningPeer === String(peer.client ?? '')
        }
        this.joiningPeer = ''

        this.enterRoom(room)
        break
      }

      case 'ROOM_CLOSED': {
        const peerName = this.room?.peer.name ?? ''
        const reason = String(msg.reason ?? 'left')
        // 走的是我自己还是对方：文案不一样（「你已离开」vs「某某离开了」）。
        const byMe = String(msg.by ?? '') === this.clientId
        this.leaveRoomLocal()
        this.handlers.onRoomClosed(reason, peerName, byMe)
        break
      }

      case 'ROOM_PEER_GONE': {
        if (!this.room) break
        // 对方掉线：房间还在，宽限期内等它回来。界面显示「重连中」，不是「已断开」。
        this.room = {
          ...this.room,
          phase: 'half',
          grace: Number(msg.grace ?? 30) || 30
        }
        this.setStatus(this.phase)
        break
      }

      case 'ROOM_PEER_BACK': {
        if (!this.room) break
        this.room = { ...this.room, phase: 'open', grace: undefined }
        this.setStatus(this.phase)
        break
      }

      case 'PASSWORD_SET': {
        // relay 只回一句「你是不是还在用默认密码」，不回任何密码内容。
        this.passwordIsDefault = Boolean(msg.default)
        this.setStatus(this.phase)
        break
      }

      case 'ERROR': {
        const code = String(msg.code ?? 'unknown')
        // 配对相关错误：这次尝试结束了，别让 joiningPeer 挂在那儿影响下一次判断。
        if (
          code === 'bad_password' ||
          code === 'peer_busy' ||
          code === 'busy' ||
          code === 'offline' ||
          code === 'no_password'
        ) {
          this.joiningPeer = ''
        }
        this.handlers.onError(code, String(msg.message ?? ''))
        break
      }

      default:
        break
    }
  }

  private clearResync(): void {
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = null
    }
  }

  /** ctl 重连后，把已知会话重新要一遍。 */
  private resyncSessions(): void {
    if (!this.agentOnline) return
    // 晚一点点再补：让各节点先把 SESSION_LIST 报上来，relay 才能把旧编号捞回去，
    // 否则重连瞬间新建的会话会从「终端 1」重新开始，和活着的旧会话撞号。
    if (!this.resyncTimer) {
      this.resyncTimer = setTimeout(() => {
        this.resyncTimer = null
        this.doResync()
      }, 900)
    }
  }

  private doResync(): void {
    if (!this.agentOnline) return
    for (const session of this.sessions.values()) {
      if (session.state === 'exited') continue
      if (session.owned) {
        // 只有自己建的才补 SESSION_CREATE；镜像别人的会话一旦回补，
        // 万一 agent 那边已经没了，就等于凭空再造一个 PTY，语义全错。
        this.sendSignal({
          type: 'SESSION_CREATE',
          session_id: session.sessionId,
          data_token: session.dataToken,
          cols: session.cols,
          rows: session.rows,
          target: session.node || undefined
        })
      }
      this.openData(session)
    }
  }

  private sendSignal(payload: Record<string, unknown>): void {
    if (!this.ctl || this.ctl.readyState !== WebSocket.OPEN) return
    try {
      this.ctl.send(JSON.stringify(payload))
    } catch {
      // 发送失败由 close 事件兜底。
    }
  }

  /**
   * 被控端上已经有会话（通常是另一个客户端开的）就挂上去当 viewer。
   *
   * 这才是「同步」：两个窗口看的是同一个 PTY，谁敲键盘都进同一个 shell，
   * 画面一模一样。不是各开一个、各看各的。
   */
  private syncFromList(raw: unknown, node = ''): void {
    if (!Array.isArray(raw)) return
    // 没进入设备也要记下来：点进去的那一刻才有东西可挂。
    this.lastLists.set(node, raw)
    // 房间：relay 已经按可见域逐行筛过，这里收到的就是我能看的，全部挂上。
    // 私有桌面：只挂我进入的那台机器。
    // 停在列表页（两样都没有）：只看不挂 —— 这也是启动时的状态。
    const inScope = this.room
      ? true
      : this.activeNode !== null && (!node || node === this.activeNode)
    if (!inScope) return
    const seen = new Set<string>()
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const sid = String(entry.session_id ?? '')
      const token = String(entry.data_token ?? '')
      if (!sid || !token) continue
      seen.add(sid)
      // 本端主动撤掉的镜像会话：PTY 还在，但这次别自动装回来。
      if (this.detached.has(sid)) continue
      const ownerId = String(entry.owner ?? '')
      const existing = this.bySessionId.get(sid)
      if (existing) {
        // 归属会变：可能是这个客户端重启前开的（relay 有记录），
        // 也可能是另一个窗口开的。变了就得把「共享」标撕掉或贴上。
        const owned = this.isMine(sid, ownerId)
        if (existing.owned !== owned) {
          existing.owned = owned
          this.handlers.onOwned(existing.leafId, owned)
        }
        // 创建端改过窗口：PTY 尺寸跟着变了，本端（镜像）要换锁，
        // 否则还按老行列渲染，换行位置就和宿主对不上。
        const cols = Number(entry.cols ?? 0) || existing.cols
        const rows = Number(entry.rows ?? 0) || existing.rows
        if (cols !== existing.cols || rows !== existing.rows) {
          if (existing.owned) {
            // 创建端才是尺寸权威：宿主记的和本地不一样，说明它被错误的值带偏了，
            // 把本地的再发一次纠回来。
            this.sendSignal({
              type: 'SESSION_RESIZE',
              session_id: existing.sessionId,
              cols: existing.cols,
              rows: existing.rows
            })
          } else {
            existing.cols = cols
            existing.rows = rows
            this.handlers.onResized(existing.leafId, cols, rows)
          }
        }
        // 列表里还有它，说明之前那次「消失」只是列表晚到，把假死拉回来。
        if (existing.state === 'exited') {
          existing.state = 'active'
          this.handlers.onState(existing.leafId, 'active')
          this.openData(existing)
        }
        continue
      }
      this.adopt(
        sid,
        token,
        Number(entry.cols ?? 80) || 80,
        Number(entry.rows ?? 24) || 24,
        Number(entry.index ?? 0) || 0,
        node,
        ownerId
      )
    }

    // 镜像的会话在远端没了（另一端关掉了），这边如实下线，别留着死标签骗人。
    // 多节点时必须只看本次上报的那个节点，否则 A 节点的列表会把 B 节点的会话全清掉。
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      if (seen.has(session.sessionId)) continue
      if (node && session.node !== node) continue
      // 刚建的会话可能还在等下一份列表，别急着判死。
      if (now - session.createdAt < 3000) continue
      // 列表里没有 = 宿主上这块 PTY 已经不存在了。标签只是它的视图，
      // 没有 PTY 就没有理由继续留在列表里。
      this.dropSession(session)
    }
  }

  /** 节点离线后开始倒计时；链路恢复（NODE_ONLINE / SESSION_LIST）就撤销。 */
  private scheduleNodeGone(node: string): void {
    if (!node || this.nodeGoneTimers.has(node)) return
    const timer = setTimeout(() => {
      this.nodeGoneTimers.delete(node)
      const alive = this.nodes.some((item) => item.node === node && item.online)
      if (!alive) this.removeNode(node)
    }, RelayClient.NODE_GONE_MS)
    this.nodeGoneTimers.set(node, timer)
  }

  private cancelNodeGone(node: string): void {
    const timer = node ? this.nodeGoneTimers.get(node) : undefined
    if (timer) {
      clearTimeout(timer)
      this.nodeGoneTimers.delete(node)
    }
  }

  /** 从本端彻底摘掉一个会话：PTY 已经不存在了，标签不该留。 */
  private dropSession(session: RemoteSession): void {
    this.closeData(session)
    this.sessions.delete(session.leafId)
    this.bySessionId.delete(session.sessionId)
    this.readyLeaves.delete(session.leafId)
    this.buffered.delete(session.leafId)
    this.pendingReady.delete(session.leafId)
    if (this.ownedIds.delete(session.sessionId)) saveOwned(this.ownedIds)
    this.detached.delete(session.sessionId)
    this.handlers.onRemoved(session.leafId)
  }

  /**
   * 整台机器的终端都没了（宿主退出 / 离线超时）：标签批量摘掉。
   *
   * 这是唯一会「真删除」用户标签的地方。控制端关掉单个终端不走到这儿 ——
   * 那种情况留灰标签，让用户自己决定什么时候清掉。
   */
  private removeNode(node: string): void {
    let removed = 0
    for (const session of [...this.sessions.values()]) {
      if (node && session.node !== node) continue
      this.dropSession(session)
      removed += 1
    }
    if (removed > 0) {
      console.log(`[rpty] 节点 ${node || '(unknown)'} 消失，摘掉 ${removed} 个标签`)
    }
  }

  private isMine(sessionId: string, ownerId: string): boolean {
    // relay 的归属最权威；relay 重启过、还没重新认领的，退回本地那份记录。
    return (!!ownerId && ownerId === this.clientId) || this.ownedIds.has(sessionId)
  }

  private adopt(
    sessionId: string,
    dataToken: string,
    cols: number,
    rows: number,
    index: number,
    node = '',
    ownerId = ''
  ): void {
    // 镜像会话直接用 sessionId 当 leafId：它本来就在全局唯一，不需要再造一个。
    const leafId = sessionId
    if (this.sessions.has(leafId)) return
    const session: RemoteSession = {
      leafId,
      sessionId,
      dataToken,
      cols,
      rows,
      state: 'active',
      dataWs: null,
      dataTimer: null,
      pending: [],
      owned: this.isMine(sessionId, ownerId),
      owner: ownerId || this.clientId,
      node,
      createdAt: Date.now()
    }
    this.sessions.set(leafId, session)
    this.bySessionId.set(sessionId, session)
    if (this.pendingReady.delete(leafId)) this.markReady(leafId)
    this.indexLeaves.set(sessionId, index)
    this.handlers.onAdopted(
      leafId,
      sessionId,
      cols,
      rows,
      session.owned,
      index,
      node,
      session.owner
    )
    this.openData(session)
  }

  // ------------------------------------------------------------ 会话

  async create(
    leafId: string,
    cols: number,
    rows: number,
    shell?: string,
    target?: string
  ): Promise<{
    ok: boolean
    sessionId?: string
    error?: string
  }> {
    if (this.phase !== 'online') return { ok: false, error: '尚未连接 relay' }
    if (!this.agentOnline) return { ok: false, error: '没有可用的宿主节点' }
    if (this.sessions.size >= 20) return { ok: false, error: '已达 20 个会话上限' }

    // 没指定目标：只有一台在线就它，多台则要求显式选择（避免开错机器）。
    const online = this.nodes.filter((n) => n.online)
    let nodeId = target ?? ''
    if (!nodeId && this.room) {
      // 房间里：优先开在自己的机器上（那是我的 shell），自己没有宿主就开在对方的。
      const own = online.find((n) => n.node === this.hostNode)?.node ?? ''
      nodeId = own || this.room.peer.host || ''
      if (!nodeId) return { ok: false, error: '双方宿主都不在线，开不了终端' }
    }
    if (!nodeId) {
      if (online.length === 1) nodeId = online[0].node
      else if (online.length === 0) return { ok: false, error: '没有可用的宿主节点' }
      else return { ok: false, error: '有多台机器在线，请选择在哪台开终端' }
    } else if (!online.some((n) => n.node === nodeId)) {
      return { ok: false, error: `节点 ${nodeId} 不在线` }
    }

    const sessionId = randomUUID()
    const dataToken = randomUUID()

    const session: RemoteSession = {
      leafId,
      sessionId,
      dataToken,
      cols,
      rows,
      state: 'connecting',
      dataWs: null,
      dataTimer: null,
      pending: [],
      owned: true,
      // 归属由 relay 决定：房间里的终端挂房间（owner 为空），私有桌面上的挂我自己。
      owner: this.room ? '' : this.clientId,
      node: nodeId,
      createdAt: Date.now()
    }
    this.sessions.set(leafId, session)
    this.bySessionId.set(sessionId, session)
    this.ownedIds.add(sessionId)
    saveOwned(this.ownedIds)
    if (this.pendingReady.delete(leafId)) this.markReady(leafId)

    this.sendSignal({
      type: 'SESSION_CREATE',
      session_id: sessionId,
      data_token: dataToken,
      cols,
      rows,
      shell,
      target: nodeId
    })
    this.openData(session)

    return { ok: true, sessionId }
  }

  /**
   * 切换只读。拦在这一层而不是只在渲染层拦，是因为渲染层能被绕过
   * （DevTools、粘贴事件、addon），主进程是唯一收口的地方。
   */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly
  }

  isReadOnly(): boolean {
    return this.readOnly
  }

  write(leafId: string, data: string): void {
    if (this.readOnly) return
    const session = this.sessions.get(leafId)
    if (!session) return
    const buf = Buffer.from(data, 'utf8')
    if (session.dataWs && session.dataWs.readyState === WebSocket.OPEN) {
      session.dataWs.send(buf)
    } else if (session.pending.length < 512) {
      session.pending.push(buf)
    }
  }

  resize(leafId: string, cols: number, rows: number): void {
    // 只读端不去改被控端的 PTY 尺寸，否则会和控制端互相抢，画面来回跳。
    if (this.readOnly) return
    const session = this.sessions.get(leafId)
    if (!session) return
    // 镜像端不改被控端的 PTY 尺寸：多端尺寸不同会互相拉扯，画面来回跳。
    if (!session.owned) return
    // 窗口还没布局好时 fit() 会量出 10x5 这种鬼尺寸，发出去就把 PTY 压坏了，
    // 之后所有端（包括创建端自己）都得按这个错尺寸排版，画面全乱。
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 5) return
    if (session.cols === cols && session.rows === rows) return
    session.cols = cols
    session.rows = rows
    if (session.state === 'active' || session.state === 'disconnected') {
      this.sendSignal({ type: 'SESSION_RESIZE', session_id: session.sessionId, cols, rows })
    }
  }

  close(leafId: string): void {
    const session = this.sessions.get(leafId)
    if (!session) return

    if (!session.owned) {
      // 镜像端点 ×：只撤掉自己这块画面，不杀宿主的 PTY。
      // 记进 detached，免得下一份列表又把它装回来；重连时会清空，
      // 那时宿主还在的话它就该重新出现、重新镜像。
      this.detached.add(session.sessionId)
      this.closeData(session)
      this.sessions.delete(leafId)
      this.bySessionId.delete(session.sessionId)
      this.readyLeaves.delete(leafId)
      this.buffered.delete(leafId)
      this.pendingReady.delete(leafId)
      return
    }

    this.sendSignal({ type: 'SESSION_CLOSE', session_id: session.sessionId })
    this.closeData(session)
    this.sessions.delete(leafId)
    this.bySessionId.delete(session.sessionId)
    this.readyLeaves.delete(leafId)
    if (this.ownedIds.delete(session.sessionId)) saveOwned(this.ownedIds)
    this.buffered.delete(leafId)
    this.pendingReady.delete(leafId)
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  /** 渲染层面板就绪：把攒下的字节按到达顺序吐出去，之后转为实时推送。 */
  markReady(leafId: string): void {
    if (!this.sessions.has(leafId)) {
      // 渲染层乐观插了标签、xterm 已经 open，但 create 的 IPC 还没到这一层。
      // 直接 return 会让之后所有字节永远卡在 buffered 里，画面一片空白。
      this.pendingReady.add(leafId)
      return
    }
    this.readyLeaves.add(leafId)
    const queue = this.buffered.get(leafId)
    if (!queue) return
    this.buffered.delete(leafId)
    for (const chunk of queue) {
      this.handlers.onData(leafId, new Uint8Array(chunk))
    }
  }

  /**
   * 画面卸掉了（回列表、切走标签、房间散了）。
   *
   * 关键：一定要把「已就绪」撤掉。leafId 就是 sessionId，重新进房时还是同一个
   * leafId，如果这里还记着就绪，新画面挂上之前到达的快照会被当成实时数据直接
   * 推给渲染层 —— 那时还没有 xterm 接，字节就进了黑洞，用户看到的是一块黑屏。
   */
  markUnready(leafId: string): void {
    this.readyLeaves.delete(leafId)
    this.pendingReady.delete(leafId)
    if (this.sessions.has(leafId)) this.buffered.set(leafId, [])
  }

  /** 当前所有会话的完整信息，供后加载的渲染层一次性补齐标签。 */
  snapshot(): Array<{
    leafId: string
    sessionId: string
    cols: number
    rows: number
    owned: boolean
    owner: string
    index: number
  }> {
    return [...this.sessions.values()]
      .filter((session) => session.state !== 'exited')
      .map((session) => ({
        leafId: session.leafId,
        sessionId: session.sessionId,
        cols: session.cols,
        rows: session.rows,
        owned: session.owned,
        owner: session.owner,
        index: this.indexLeaves.get(session.sessionId) ?? 0,
        node: session.node
      }))
  }

  // ------------------------------------------------------------ 数据通道

  private openData(session: RemoteSession): void {
    if (session.dataWs && session.dataWs.readyState <= WebSocket.OPEN) return
    this.closeData(session)

    const ws = new WebSocket(this.wsUrl(`/d/${session.dataToken}?role=ctl`), {
      handshakeTimeout: CONNECT_TIMEOUT,
      perMessageDeflate: false
    })
    session.dataWs = ws

    ws.on('open', () => {
      if (session.state === 'disconnected') {
        this.handlers.onState(session.leafId, 'active')
      }
      // 补发连接建立前攒下的按键。
      const queued = session.pending.splice(0)
      for (const chunk of queued) {
        try {
          ws.send(chunk)
        } catch {
          break
        }
      }
    })

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return
      // 复制一份，避免底层 buffer 被复用后渲染层拿到脏数据。
      const buf = Buffer.from(raw as Buffer)
      if (!this.readyLeaves.has(session.leafId)) {
        const queue = this.buffered.get(session.leafId) ?? []
        // 上限 1MB，超了从头丢：宁可少一段历史也不能把内存吃干。
        queue.push(buf)
        let total = queue.reduce((sum, item) => sum + item.length, 0)
        while (total > 1024 * 1024 && queue.length > 1) {
          total -= queue.shift()!.length
        }
        this.buffered.set(session.leafId, queue)
        return
      }
      this.handlers.onData(session.leafId, new Uint8Array(buf))
    })

    ws.on('close', () => {
      if (session.dataWs === ws) session.dataWs = null
      if (session.state === 'exited') return
      // agent 会自己重连；控制端这边也定时重试，两端都会重放缓冲。
      if (session.dataTimer) return
      session.dataTimer = setTimeout(() => {
        session.dataTimer = null
        if (session.state === 'exited') return
        if (this.phase === 'online') this.openData(session)
      }, 1200)
    })

    ws.on('error', () => {
      // close 会跟着触发。
    })
  }

  private closeData(session: RemoteSession): void {
    if (session.dataTimer) {
      clearTimeout(session.dataTimer)
      session.dataTimer = null
    }
    const ws = session.dataWs
    session.dataWs = null
    if (ws) {
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 客户端自己的名字，生成一次写进 userData。
 *
 * 默认 profile：`<主机名短名>-<4 位 hex>`（和以前一样，老用户的名字不变）。
 * 其它 profile：`<主机名短名>-<profile 名>` —— 同机多开时设备列表里一眼分得清，
 * 否则两个都是 `mini-a1b2` 这种，像两台不同的机器。
 */
function loadClientName(): string {
  const file = join(app.getPath('userData'), 'client-name')
  const profile = getProfile()
  const short = os.hostname().split('.')[0] || 'client'
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved) return saved
    }
    const created = profile.isDefault
      ? `${short}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
      : `${short}-${profile.name}`
    writeFileSync(file, created, 'utf8')
    return created
  } catch {
    return `${short}-${randomUUID().slice(0, 4)}`
  }
}

function loadClientId(): string {
  const file = join(app.getPath('userData'), 'client-id')
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved) return saved
    }
    const created = randomUUID()
    writeFileSync(file, created, 'utf8')
    return created
  } catch {
    return randomUUID()
  }
}

function loadOwned(): Set<string> {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'owned-sessions.json'), 'utf8')
    const list = JSON.parse(raw)
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveOwned(ids: Set<string>): void {
  try {
    writeFileSync(join(app.getPath('userData'), 'owned-sessions.json'), JSON.stringify([...ids]), 'utf8')
  } catch {
    // 写不进去就算了，最多是下次重启少认回几个终端。
  }
}
