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

  /** 主 -> 渲染：推送 */
  SessionData: 'session:data',
  SessionStateChanged: 'session:state',
  SessionExit: 'session:exit',
  RelayStatusChanged: 'relay:status-changed',
  RelayError: 'relay:error',
  /** 主 -> 渲染：菜单命令 */
  MenuCommand: 'menu:command'
} as const

export type MenuCommand = 'new-tab' | 'close-tab' | 'next-tab' | 'prev-tab' | 'goto-tab' | 'toggle-sidebar'

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

  onData(handler: (payload: SessionDataPayload) => void): () => void
  onState(handler: (payload: SessionStatePayload) => void): () => void
  onExit(handler: (payload: SessionExitPayload) => void): () => void
  onStatus(handler: (payload: RelayStatus) => void): () => void
  onError(handler: (payload: RelayErrorPayload) => void): () => void
  onMenu(handler: (command: MenuCommand, arg?: number) => void): () => void
}
