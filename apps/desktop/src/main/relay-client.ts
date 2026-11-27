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
import WebSocket from 'ws'
import type { RelayConfig, RelayStatus } from '../shared/ipc'
import type { SessionState } from '../shared/protocol'

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
}

export interface RelayHandlers {
  onStatus(status: RelayStatus): void
  onData(leafId: string, data: Uint8Array): void
  onState(leafId: string, state: SessionState, message?: string): void
  onExit(leafId: string, exitCode?: number): void
  onError(code: string, message: string): void
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
  private backoff = 600
  /** 只读：连上了、画面在刷，但键盘输入与尺寸变更都不发给被控端。 */
  private readOnly = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private manualClose = false

  constructor(private readonly handlers: RelayHandlers) {}

  // ------------------------------------------------------------ 状态

  get status(): RelayStatus {
    return { phase: this.phase, agentOnline: this.agentOnline, hostname: this.hostname }
  }

  private setStatus(phase: RelayStatus['phase'], message?: string): void {
    this.phase = phase
    this.handlers.onStatus({ phase, agentOnline: this.agentOnline, hostname: this.hostname, message })
  }

  private setAgentOnline(online: boolean): void {
    if (this.agentOnline === online) return
    this.agentOnline = online
    this.handlers.onStatus({
      phase: this.phase,
      agentOnline: online,
      hostname: this.hostname
    })
  }

  // ------------------------------------------------------------ 连接

  async connect(config: RelayConfig): Promise<RelayStatus> {
    this.config = config
    this.manualClose = false
    this.clearReconnect()
    this.closeCtl()

    await this.openCtl()
    return this.status
  }

  async disconnect(): Promise<void> {
    this.manualClose = true
    this.clearReconnect()
    for (const session of this.sessions.values()) {
      this.closeData(session)
      this.handlers.onState(session.leafId, 'disconnected')
    }
    this.sessions.clear()
    this.bySessionId.clear()
    this.closeCtl()
    this.setStatus('idle')
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
    return `${base}${path}${sep}token=${encodeURIComponent(this.config?.token ?? '')}`
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
        this.setAgentOnline(Boolean(msg.agent_online))
        this.setStatus('online')
        this.backoff = 600
        this.resyncSessions()
        break

      case 'AGENT_ONLINE':
        this.setAgentOnline(true)
        this.resyncSessions()
        break

      case 'SESSION_LIST': {
        const host = String(msg.hostname ?? '')
        if (host && host !== this.hostname) {
          this.hostname = host
          this.handlers.onStatus({
            phase: this.phase,
            agentOnline: this.agentOnline,
            hostname: host
          })
        }
        break
      }

      case 'AGENT_OFFLINE':
        this.setAgentOnline(false)
        for (const session of this.sessions.values()) {
          if (session.state === 'active') {
            this.handlers.onState(session.leafId, 'disconnected', '被控端离线')
          }
        }
        break

      case 'SESSION_CREATED': {
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        this.handlers.onState(session.leafId, 'active')
        break
      }

      case 'SESSION_EXIT': {
        const sid = String(msg.session_id ?? '')
        const session = this.bySessionId.get(sid)
        if (!session) break
        session.state = 'exited'
        this.handlers.onExit(session.leafId, Number(msg.exit_code ?? 0))
        this.closeData(session)
        break
      }

      case 'ERROR':
        this.handlers.onError(String(msg.code ?? 'unknown'), String(msg.message ?? ''))
        break

      default:
        break
    }
  }

  /** ctl 重连后，把已知会话重新要一遍。 */
  private resyncSessions(): void {
    if (!this.agentOnline) return
    for (const session of this.sessions.values()) {
      if (session.state === 'exited') continue
      this.sendSignal({
        type: 'SESSION_CREATE',
        session_id: session.sessionId,
        data_token: session.dataToken,
        cols: session.cols,
        rows: session.rows
      })
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

  // ------------------------------------------------------------ 会话

  async create(leafId: string, cols: number, rows: number, shell?: string): Promise<{
    ok: boolean
    sessionId?: string
    error?: string
  }> {
    if (this.phase !== 'online') return { ok: false, error: '尚未连接 relay' }
    if (!this.agentOnline) return { ok: false, error: '被控端不在线' }
    if (this.sessions.size >= 20) return { ok: false, error: '已达 20 个会话上限' }

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
      pending: []
    }
    this.sessions.set(leafId, session)
    this.bySessionId.set(sessionId, session)

    this.sendSignal({
      type: 'SESSION_CREATE',
      session_id: sessionId,
      data_token: dataToken,
      cols,
      rows,
      shell
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
    this.sendSignal({ type: 'SESSION_CLOSE', session_id: session.sessionId })
    this.closeData(session)
    this.sessions.delete(leafId)
    this.bySessionId.delete(session.sessionId)
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  // ------------------------------------------------------------ 数据通道

  private openData(session: RemoteSession): void {
    if (session.dataWs && session.dataWs.readyState <= WebSocket.OPEN) return
    this.closeData(session)

    const ws = new WebSocket(this.wsUrl(`/d/${session.dataToken}`), {
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
      const buf = raw as Buffer
      // 复制一份，避免底层 buffer 被复用后渲染层拿到脏数据。
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
