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
  reconnect: () => ipcRenderer.invoke(IpcChannel.RelayReconnect),
  getStatus: () => ipcRenderer.invoke(IpcChannel.RelayStatus),
  activateNode: (node: string | null, client?: string | null) =>
    ipcRenderer.invoke(IpcChannel.NodeActivate, { node, client: client ?? null }),
  getConfigInfo: (): Promise<ConfigInfo> => ipcRenderer.invoke(IpcChannel.ConfigInfo),

  create: (options: SessionCreateOptions): Promise<SessionCreateResult> =>
    ipcRenderer.invoke(IpcChannel.SessionCreate, options),
  write: (leafId: string, data: string) =>
    ipcRenderer.send(IpcChannel.SessionWrite, { leafId, data }),
  resize: (leafId: string, cols: number, rows: number) =>
    ipcRenderer.send(IpcChannel.SessionResize, { leafId, cols, rows }),
  close: (leafId: string) => ipcRenderer.invoke(IpcChannel.SessionClose, leafId),
  list: () => ipcRenderer.invoke(IpcChannel.SessionList),
  snapshotSessions: () => ipcRenderer.invoke(IpcChannel.SessionSnapshot),
  ready: (leafId: string) => ipcRenderer.send(IpcChannel.SessionReady, leafId),

  getReadOnly: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.ReadOnlyGet),
  setReadOnly: (readOnly: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.ReadOnlySet, readOnly),
  onReadOnly: subscribe<boolean>(IpcChannel.ReadOnlyChanged),

  onData: subscribe(IpcChannel.SessionData),
  onState: subscribe(IpcChannel.SessionStateChanged),
  onExit: subscribe(IpcChannel.SessionExit),
  onAdopted: subscribe(IpcChannel.SessionAdopted),
  onOwned: subscribe(IpcChannel.SessionOwned),
  onRemoved: subscribe(IpcChannel.SessionRemoved),
  onResized: subscribe(IpcChannel.SessionResized),
  onPeerClosed: subscribe(IpcChannel.RelayPeerClosed),
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
