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
  /** 渲染 -> 主：用已保存的地址与 token 重连（断开之后回来） */
  RelayReconnect: 'relay:reconnect',
  /** 渲染 -> 主：连接状态查询 */
  RelayStatus: 'relay:status',
  /** 渲染 -> 主：读取已保存的地址与「是否有 token」 */
  ConfigInfo: 'config:info',
  /** 渲染 -> 主：进入 / 离开一台设备（null = 回设备列表，不为任何会话开数据通道） */
  NodeActivate: 'node:activate',

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
  /** 主 -> 渲染：会话归属变了（relay 认出了主人，或另一个窗口开了/关了它） */
  SessionOwned: 'session:owned',
  /** 主 -> 渲染：整个节点的终端都没了（宿主退出 / 离线超时），把标签一起摘掉 */
  SessionRemoved: 'session:removed',
  /** 主 -> 渲染：PTY 尺寸变了（创建端改了窗口），镜像端要跟着锁到新尺寸 */
  SessionResized: 'session:resized',
  SessionData: 'session:data',
  SessionStateChanged: 'session:state',
  SessionExit: 'session:exit',
  RelayStatusChanged: 'relay:status-changed',
  /** 主 -> 渲染：配对的另一端主动断开了链路 */
  RelayPeerClosed: 'relay:peer-closed',
  RelayError: 'relay:error',
  /** 主 -> 渲染：菜单命令 */
  MenuCommand: 'menu:command'
} as const

export type MenuCommand =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'goto-tab'
  | 'toggle-sidebar'
  | 'toggle-readonly'
  | 'devices'
  | 'disconnect'

export interface ConfigInfo {
  url: string
  hasToken: boolean
}

export interface RelayConfig {
  url: string
  token: string
}

export type ConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline' | 'error'

/** 一台可被开终端的机器（跑着宿主进程）。 */
export interface NodeInfo {
  /** 节点标识，创建会话时作为 target */
  node: string
  /** 展示名，通常是主机名 */
  name: string
  platform?: string
  online: boolean
  /** 这台机器上现有的会话数 */
  sessions: number
  /** 是不是本机 —— 由客户端配置推算，relay 不知道 */
  local?: boolean
}

export interface RelayStatus {
  phase: ConnectionPhase
  agentOnline: boolean
  /** 被控端上报的主机名，连上后才有 */
  hostname?: string
  /** 当前在线的所有节点（多机场景） */
  nodes?: NodeInfo[]
  /** 这个客户端自己的名字：首次运行生成，不删数据目录就不变 */
  clientName?: string
  message?: string
}

export interface SessionCreateOptions {
  leafId: string
  cols: number
  rows: number
  shell?: string
  /** 在哪个节点上开。省略时由 relay 决定（只有一个节点在线就用它） */
  target?: string
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
  /** 全局序号（relay 分配），所有客户端靠它对齐 */
  index: number
  /** 这个会话属于哪个节点 */
  node?: string
}

export interface SessionResizedPayload {
  leafId: string
  cols: number
  rows: number
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
  /** 断开之后回来：用保存的地址与 token 重连，不需要重新输入 */
  reconnect(): Promise<RelayStatus>
  getStatus(): Promise<RelayStatus>
  getConfigInfo(): Promise<ConfigInfo>
  /** 进入某台设备（node），或传 null 回到设备列表 */
  activateNode(node: string | null): Promise<void>

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
  onOwned(handler: (payload: { leafId: string; owned: boolean }) => void): () => void
  onRemoved(handler: (payload: { leafId: string }) => void): () => void
  onResized(handler: (payload: SessionResizedPayload) => void): () => void
  onStatus(handler: (payload: RelayStatus) => void): () => void
  /** 另一端点了「断开连接」：本端跟着断，需要用户点「重新连接」才回来 */
  onPeerClosed(handler: (payload: { by?: string; name?: string }) => void): () => void
  onError(handler: (payload: RelayErrorPayload) => void): () => void
  onMenu(handler: (command: MenuCommand, arg?: number) => void): () => void
}
