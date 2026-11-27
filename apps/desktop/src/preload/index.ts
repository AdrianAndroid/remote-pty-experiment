/**
 * preload：只把白名单方法挂到 window.rpty，不暴露 ipcRenderer 本身。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConfigInfo,
  MenuCommand,
  RelayConfig,
  RelayStatus,
  RptyBridge,
  SessionCreateOptions,
  SessionCreateResult
} from '../shared/ipc'
import { IpcChannel } from '../shared/ipc'

function subscribe<T>(channel: string): (handler: (payload: T) => void) => () => void {
  return (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: RptyBridge = {
  connect: (config: RelayConfig) => ipcRenderer.invoke(IpcChannel.RelayConnect, config),
  disconnect: () => ipcRenderer.invoke(IpcChannel.RelayDisconnect),
  getStatus: () => ipcRenderer.invoke(IpcChannel.RelayStatus),
  getConfigInfo: (): Promise<ConfigInfo> => ipcRenderer.invoke(IpcChannel.ConfigInfo),

  create: (options: SessionCreateOptions): Promise<SessionCreateResult> =>
    ipcRenderer.invoke(IpcChannel.SessionCreate, options),
  write: (leafId: string, data: string) =>
    ipcRenderer.send(IpcChannel.SessionWrite, { leafId, data }),
  resize: (leafId: string, cols: number, rows: number) =>
    ipcRenderer.send(IpcChannel.SessionResize, { leafId, cols, rows }),
  close: (leafId: string) => ipcRenderer.invoke(IpcChannel.SessionClose, leafId),
  list: () => ipcRenderer.invoke(IpcChannel.SessionList),

  onData: subscribe(IpcChannel.SessionData),
  onState: subscribe(IpcChannel.SessionStateChanged),
  onExit: subscribe(IpcChannel.SessionExit),
  onStatus: subscribe<RelayStatus>(IpcChannel.RelayStatusChanged),
  onError: subscribe(IpcChannel.RelayError),
  onMenu: (handler: (command: MenuCommand, arg?: number) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { command: MenuCommand; arg?: number }
    ): void => handler(payload.command, payload.arg)
    ipcRenderer.on(IpcChannel.MenuCommand, listener)
    return () => ipcRenderer.removeListener(IpcChannel.MenuCommand, listener)
  }
}

contextBridge.exposeInMainWorld('rpty', bridge)
