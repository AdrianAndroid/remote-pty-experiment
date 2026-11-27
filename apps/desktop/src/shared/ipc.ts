/**
 * 主进程 <-> 渲染进程的 IPC 契约。
 *
 * 与阶段 1 的单会话契约不同，这里所有方法都带 leafId —— 一个在渲染层
 * 生成的稳定 UUID，重排标签、断线重连都不会变。agent 那边认的是
 * sessionId，两者在主进程里做映射。
 */

import type { SessionState } from './protocol'

export const IpcChannel = {
  /** 渲染 -> 主：连接 relay */
  RelayConnect: 'relay:connect',
  /** 渲染 -> 主：断开 */
  RelayDisconnect: 'relay:disconnect',
  /** 渲染 -> 主：连接状态查询 */
  RelayStatus: 'relay:status',
  /** 渲染 -> 主：读取已保存的地址与「是否有 token」 */
  ConfigInfo: 'config:info',

  /** 渲染 -> 主：开一个会话 */
  SessionCreate: 'session:create',
  SessionWrite: 'session:write',
  SessionResize: 'session:resize',
  SessionClose: 'session:close',
  SessionList: 'session:list',
  /** 渲染 -> 主：拉当前所有会话（窗口加载晚于 relay 连接时，adopt 事件已经过去了） */
  SessionSnapshot: 'session:snapshot',
  /** 渲染 -> 主：这个面板的 xterm 已经挂好了，可以开始灌字节 */
  SessionReady: 'session:ready',

  /** 只读模式：渲染 -> 主 查询/切换，主 -> 渲染 广播 */
  ReadOnlyGet: 'readonly:get',
  ReadOnlySet: 'readonly:set',
  ReadOnlyChanged: 'readonly:changed',

  /** 主 -> 渲染：推送 */
  /** 主 -> 渲染：发现被控端上已有会话（别的客户端开的），自动挂上去镜像 */
  SessionAdopted: 'session:adopted',
  SessionData: 'session:data',
  SessionStateChanged: 'session:state',
  SessionExit: 'session:exit',
  RelayStatusChanged: 'relay:status-changed',
  RelayError: 'relay:error',
  /** 主 -> 渲染：菜单命令 */
  MenuCommand: 'menu:command'
} as const

export type MenuCommand = 'new-tab' | 'close-tab' | 'next-tab' | 'prev-tab' | 'goto-tab' | 'toggle-sidebar' | 'toggle-readonly'

export interface ConfigInfo {
  url: string
  hasToken: boolean
}

export interface RelayConfig {
  url: string
  token: string
}

export type ConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline' | 'error'

export interface RelayStatus {
  phase: ConnectionPhase
  agentOnline: boolean
  /** 被控端上报的主机名，连上后才有 */
  hostname?: string
  message?: string
}

export interface SessionCreateOptions {
  leafId: string
  cols: number
  rows: number
  shell?: string
}

export interface SessionCreateResult {
  ok: boolean
  sessionId?: string
  pid?: number
  title?: string
  error?: string
}

export interface SessionDataPayload {
  leafId: string
  /** 终端原始字节。用 Uint8Array 而非 string，避免多字节字符被截断。 */
  data: Uint8Array
}

export interface SessionStatePayload {
  leafId: string
  state: SessionState
  message?: string
}

export interface SessionAdoptedPayload {
  leafId: string
  sessionId: string
  cols: number
  rows: number
  /** true = 这个 PTY 是本窗口建的；false = 别的窗口建的，这里只是镜像 */
  owned: boolean
  /** 被控机上的全局序号，两端标签靠它对齐 */
  index: number
}

export interface SessionExitPayload {
  leafId: string
  exitCode?: number
}

export interface RelayErrorPayload {
  code: string
  message: string
}

/** 通过 contextBridge 暴露到 window.rpty 的能力集合。 */
export interface RptyBridge {
  connect(config: RelayConfig): Promise<RelayStatus>
  disconnect(): Promise<void>
  getStatus(): Promise<RelayStatus>
  getConfigInfo(): Promise<ConfigInfo>

  create(options: SessionCreateOptions): Promise<SessionCreateResult>
  write(leafId: string, data: string): void
  resize(leafId: string, cols: number, rows: number): void
  close(leafId: string): Promise<void>
  list(): Promise<string[]>
  snapshotSessions(): Promise<SessionAdoptedPayload[]>
  ready(leafId: string): void

  /** 只读：连上了、画面在刷，但键盘/粘贴/尺寸都不发给被控端 */
  getReadOnly(): Promise<boolean>
  setReadOnly(readOnly: boolean): Promise<boolean>
  onReadOnly(handler: (readOnly: boolean) => void): () => void

  onData(handler: (payload: SessionDataPayload) => void): () => void
  onState(handler: (payload: SessionStatePayload) => void): () => void
  onExit(handler: (payload: SessionExitPayload) => void): () => void
  onAdopted(handler: (payload: SessionAdoptedPayload) => void): () => void
  onStatus(handler: (payload: RelayStatus) => void): () => void
  onError(handler: (payload: RelayErrorPayload) => void): () => void
  onMenu(handler: (command: MenuCommand, arg?: number) => void): () => void
}
