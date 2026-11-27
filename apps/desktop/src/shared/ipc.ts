/**
 * 渲染进程与主进程之间的 IPC 契约。
 *
 * 阶段 1 只有一条本地 PTY，所以契约是「单会话」的：create / write / resize / dispose。
 * 阶段 2 接 relay 时，这些方法会保留（本地宿主仍在用），远端会话另开一组通道。
 */

export const IpcChannel = {
  PtyCreate: 'pty:create',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyDispose: 'pty:dispose',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
  PtyError: 'pty:error'
} as const

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
}

export interface PtyCreateResult {
  pid: number
}

export interface PtyResizeOptions {
  cols: number
  rows: number
}

export interface PtyExitPayload {
  exitCode: number
  signal?: number
}

export interface PtyErrorPayload {
  message: string
}

/** 通过 contextBridge 暴露到 window.rpty 的能力集合。 */
export interface RptyBridge {
  create(options: PtyCreateOptions): Promise<PtyCreateResult>
  write(data: string): void
  resize(options: PtyResizeOptions): void
  dispose(): void
  onData(handler: (data: string) => void): () => void
  onExit(handler: (payload: PtyExitPayload) => void): () => void
  onError(handler: (payload: PtyErrorPayload) => void): () => void
}
