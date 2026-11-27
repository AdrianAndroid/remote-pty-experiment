/**
 * 主进程入口。
 *
 * 启动时用上次保存的 relay 地址与 token 自动连一次；连不上就停在连接页，
 * 用户重新填。token 只在主进程里存在，永远不回传渲染层。
 */

import { join } from 'node:path'
import { BrowserWindow, Menu, app, ipcMain, shell } from 'electron'
import type { MenuCommand, RelayConfig } from '../shared/ipc'
import { IpcChannel } from '../shared/ipc'
import { RelayClient } from './relay-client'
import { loadConfig, saveConfig, saveReadOnly } from './store'

let win: BrowserWindow | null = null

// 打包后 app.getName() 会变成 productName（rpty），userData 目录会跟着换，
// 导致开发版填过的 relay 地址和 token 在 .app 里读不到。这里固定成开发时的名字。
// 同一台机器要跑两个实例时，用 RPTY_USERDATA 指到另一个目录，避免缓存目录互锁。
app.setPath(
  'userData',
  process.env.RPTY_USERDATA || join(app.getPath('appData'), 'rpty-desktop')
)

const relay = new RelayClient({
  onStatus: (status) => send(IpcChannel.RelayStatusChanged, status),
  onData: (leafId, data) => send(IpcChannel.SessionData, { leafId, data }),
  onState: (leafId, state, message) =>
    send(IpcChannel.SessionStateChanged, { leafId, state, message }),
  onExit: (leafId, exitCode) => send(IpcChannel.SessionExit, { leafId, exitCode }),
  onAdopted: (leafId, sessionId, cols, rows, owned, index, node) =>
    send(IpcChannel.SessionAdopted, { leafId, sessionId, cols, rows, owned, index, node }),
  onError: (code, message) => send(IpcChannel.RelayError, { code, message }),
  onOwned: (leafId, owned) => send(IpcChannel.SessionOwned, { leafId, owned }),
  onRemoved: (leafId) => send(IpcChannel.SessionRemoved, { leafId }),
  onResized: (leafId, cols, rows) => send(IpcChannel.SessionResized, { leafId, cols, rows }),
  onPeerClosed: (by, name) => send(IpcChannel.RelayPeerClosed, { by, name })
})

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function sendMenu(command: MenuCommand, arg?: number): void {
  send(IpcChannel.MenuCommand, { command, arg })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f1017',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'rpty',
      submenu: [
        { role: 'about', label: '关于 rpty' },
        { type: 'separator' },
        {
          label: '重新连接 relay',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendMenu('new-tab')
        },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 rpty' },
        { role: 'quit', label: '退出 rpty' }
      ]
    },
    {
      label: '终端',
      submenu: [
        { label: '新建终端', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('new-tab') },
        {
          label: '关闭当前终端',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenu('close-tab')
        },
        { type: 'separator' },
        { label: '下一个终端', accelerator: 'CmdOrCtrl+Shift+]', click: () => sendMenu('next-tab') },
        { label: '上一个终端', accelerator: 'CmdOrCtrl+Shift+[', click: () => sendMenu('prev-tab') },
        { type: 'separator' },
        {
          label: '收起 / 展开标签列',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenu('toggle-sidebar')
        },
        { type: 'separator' },
        {
          label: '只读模式（只看不动）',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => sendMenu('toggle-readonly')
        },
        { type: 'separator' },
        {
          label: '返回设备列表（终端继续跑）',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendMenu('devices')
        },
        {
          label: '断开连接（可再连回）',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendMenu('disconnect')
        }
      ]
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  ]

  // Cmd+1..9 直接跳标签，由渲染层自己处理更简单，菜单里只做占位说明。
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.ConfigInfo, () => {
    const saved = loadConfig()
    return { url: saved.url ?? '', hasToken: Boolean(saved.token) }
  })

  ipcMain.handle(IpcChannel.RelayConnect, async (_event, config: RelayConfig) => {
    const saved = loadConfig()
    const url = (config.url || saved.url || '').trim()
    const token = (config.token || '').trim() || saved.token || ''
    if (!url || !token) {
      return { phase: 'error', agentOnline: false, message: '请填写 relay 地址与 token' }
    }
    try {
      const status = await relay.connect({ url, token })
      saveConfig({ url, token, readOnly: relay.isReadOnly() })
      return status
    } catch (error) {
      return {
        phase: 'error',
        agentOnline: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(IpcChannel.RelayDisconnect, async () => {
    await relay.disconnect()
  })

  // 断开之后回来：地址和 token 都在主进程手里，渲染层不需要再问用户要一遍。
  ipcMain.handle(IpcChannel.RelayReconnect, async () => {
    const saved = loadConfig()
    const url = (saved.url ?? '').trim()
    const token = (saved.token ?? '').trim()
    if (!url || !token) {
      return { phase: 'error', agentOnline: false, message: '还没有保存 relay 地址与 token' }
    }
    try {
      // 走 connect：它内部会先关掉旧 ctl（幂等），并顺带刷新保存的配置。
      return await relay.connect({ url, token })
    } catch (error) {
      return {
        phase: 'error',
        agentOnline: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(IpcChannel.RelayStatus, () => relay.status)

  ipcMain.handle(
    IpcChannel.NodeActivate,
    async (_event, payload: { node: string | null; client?: string | null } | null) => {
      await relay.setActiveNode(payload?.node ?? null, payload?.client ?? null)
    }
  )

  ipcMain.handle(IpcChannel.SessionCreate, async (_event, options) => {
    const result = await relay.create(
      options.leafId,
      options.cols,
      options.rows,
      options.shell,
      options.target
    )
    return result.ok
      ? { ok: true, sessionId: result.sessionId }
      : { ok: false, error: result.error }
  })

  ipcMain.on(IpcChannel.SessionWrite, (_event, payload: { leafId: string; data: string }) => {
    relay.write(payload.leafId, payload.data)
  })

  ipcMain.on(
    IpcChannel.SessionResize,
    (_event, payload: { leafId: string; cols: number; rows: number }) => {
      relay.resize(payload.leafId, payload.cols, payload.rows)
    }
  )

  ipcMain.handle(IpcChannel.SessionClose, (_event, leafId: string) => {
    relay.close(leafId)
  })

  ipcMain.handle(IpcChannel.SessionList, () => relay.list())
  ipcMain.handle(IpcChannel.SessionSnapshot, () => relay.snapshot())

  ipcMain.on(IpcChannel.SessionReady, (_event, leafId: string) => relay.markReady(leafId))

  ipcMain.handle(IpcChannel.ReadOnlyGet, () => relay.isReadOnly())

  ipcMain.handle(IpcChannel.ReadOnlySet, (_event, value: boolean) => {
    const next = Boolean(value)
    relay.setReadOnly(next)
    saveReadOnly(next)
    send(IpcChannel.ReadOnlyChanged, next)
    return next
  })
}

app.whenReady().then(() => {
  // 开发时跑的是 electron 本体，Dock 里会是 Electron 的默认图标；
  // 显式换成本项目的图标，打包后则由 build/icon.icns 接管。
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(join(__dirname, '../../build/icon.png'))
  }
  registerIpc()
  buildMenu()
  createWindow()

  // 有保存过的配置就静默尝试一次，失败也留在连接页。
  const saved = loadConfig()
  // 只读开关在连之前就要生效，否则第一屏的键盘输入会漏出去。
  relay.setReadOnly(Boolean(saved.readOnly))
  if (saved.url && saved.token) {
    relay.connect({ url: saved.url, token: saved.token }).catch(() => undefined)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void relay.disconnect()
})
