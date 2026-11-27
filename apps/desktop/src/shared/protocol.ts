/**
 * 信令类型。与 server/relay.py、agent/rpty_agent.py 共用的那一套 JSON。
 *
 * 分成两个方向：
 *   控制端 -> relay -> agent   SESSION_CREATE / SESSION_CLOSE / SESSION_RESIZE / PING
 *   agent -> relay -> 控制端   SESSION_CREATED / SESSION_EXIT / SESSION_LIST / ERROR / PONG
 */

export type SessionState = 'connecting' | 'active' | 'disconnected' | 'exited' | 'error'

/** 控制端发出：请 agent 开一个新 PTY。dataToken 由控制端生成。 */
export interface SessionCreateMessage {
  type: 'SESSION_CREATE'
  session_id: string
  data_token: string
  cols: number
  rows: number
  shell?: string
}

export interface SessionCloseMessage {
  type: 'SESSION_CLOSE'
  session_id: string
}

export interface SessionResizeMessage {
  type: 'SESSION_RESIZE'
  session_id: string
  cols: number
  rows: number
}

/** agent 回来：PTY 已就绪。 */
export interface SessionCreatedMessage {
  type: 'SESSION_CREATED'
  session_id: string
  data_token: string
  pid?: number
  title?: string
}

export interface SessionExitMessage {
  type: 'SESSION_EXIT'
  session_id: string
  exit_code?: number
}

export interface SessionListMessage {
  type: 'SESSION_LIST'
  hostname?: string
  platform?: string
  sessions: Array<{
    session_id: string
    data_token: string
    cols: number
    rows: number
  }>
}

export interface HelloMessage {
  type: 'HELLO'
  agent_online: boolean
  server_time: number
  version: string
}

export interface RelayErrorMessage {
  type: 'ERROR'
  code: string
  message: string
  ref?: string
}

export interface PongMessage {
  type: 'PONG'
  at: number
}

export type InboundMessage =
  | HelloMessage
  | SessionCreatedMessage
  | SessionExitMessage
  | SessionListMessage
  | RelayErrorMessage
  | PongMessage
  | { type: 'AGENT_ONLINE' }
  | { type: 'AGENT_OFFLINE' }
  | { type: 'CTL_ONLINE' }
  | { type: 'CTL_OFFLINE' }
