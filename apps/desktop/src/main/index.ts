/**
 * 主进程入口。
 *
 * 启动时用上次保存的 relay 地址与 token 自动连一次；连不上就停在连接页，
 * 用户重新填。token 只在主进程里存在，永远不回传渲染层。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import type { MenuCommand, RelayConfig } from '../shared/ipc'
import { IpcChannel } from '../shared/ipc'
import { RelayClient } from './relay-client'
import {
  initProfile,
  nextProfileName,
  profilesRoot,
  seedProfile
} from './profile'
import { loadConfig, saveConfig, saveReadOnly } from './store'

let win: BrowserWindow | null = null

// 打包后 app.getName() 会变成 productName（rpty），userData 目录会跟着换，
// 导致开发版填过的 relay 地址和 token 在 .app 里读不到。这里固定成开发时的名字。
//
// 一个 profile = 一个客户端 = 一个 userData 目录：
//   默认 profile 还是老路径（老用户零迁移），其余在 <根>/profiles/<名字>。
//   RPTY_USERDATA 仍认，映射成名字叫 custom 的非默认 profile（开发用）。
const profile = initProfile(profilesRoot(app.getPath('appData')), {
  profile: process.env.RPTY_PROFILE,
  userData: process.env.RPTY_USERDATA
})
app.setPath('userData', profile.dir)
// 新 profile 目录可能还不存在：client-id / client-name 都是直接写文件的，
// 目录不在就会退化成"每次启动换一个 id"的临时身份。
mkdirSync(profile.dir, { recursive: true })

// 同一 profile 只允许一个进程：第二次启动不再起一份，只把已有窗口提到前面。
// 锁的作用范围就是 userData 目录，所以不同 profile 天然各锁各的。
// 想要第二个客户端走「新建客户端…」菜单，别靠双击。
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

const relay = new RelayClient({
  onStatus: (status) => send(IpcChannel.RelayStatusChanged, status),
  onData: (leafId, data) => send(IpcChannel.SessionData, { leafId, data }),
  onState: (leafId, state, message) =>
    send(IpcChannel.SessionStateChanged, { leafId, state, message }),
  onExit: (leafId, exitCode) => send(IpcChannel.SessionExit, { leafId, exitCode }),
  onAdopted: (leafId, sessionId, cols, rows, owned, index, node, owner) =>
    send(IpcChannel.SessionAdopted, {
      leafId,
      sessionId,
      cols,
      rows,
      owned,
      index,
      node,
      owner
    }),
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
    // 同机多个 profile 同时开着时，Mission Control / Dock / 窗口菜单里要分得清谁是谁。
    title: profile.isDefault ? 'rpty' : `rpty · ${profile.name}`,
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

/**
 * 起一个独立客户端：新 profile 目录 + 新进程。
 *
 * 不采用「同一进程再开一个窗口」：一个进程只持有一个 client_id，
 * 多开窗口只会变成同一个客户端的两条连接，反而互相覆盖本地记录。
 */
function createClient(): void {
  const root = profilesRoot(app.getPath('appData'))
  const name = nextProfileName(root)
  const dir = seedProfile(root, name, profile.dir)
  const args = process.defaultApp ? [app.getAppPath(), ...process.argv.slice(2)] : []
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      RPTY_PROFILE: name,
      // 清掉开发后门，否则会盖过 RPTY_PROFILE 之外的判断。
      RPTY_USERDATA: ''
    },
    detached: true,
    stdio: 'ignore'
  })
  child.unref()

  void dialog.showMessageBox({
    type: 'info',
    message: `已新建客户端「${name}」`,
    detail:
      `它会出现在设备列表里，名字带 ${name} 后缀；终端和标签跟当前这个客户端互不影响。\n\n` +
      `数据目录：${dir}`,
    buttons: ['好']
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
        // 不起眼，但找得到：这是「再开一个客户端」的唯一入口。
        // 起的是独立进程、独立 userData、独立 client_id，和当前这个互不影响。
        {
          label: '新建客户端…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            void createClient()
          }
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

// 窗口全关 = 这个客户端下线。macOS 的「关窗不退」会让 relay 一直认为它还在线，
// 于是在线列表里留一条点不开也进不去的僵尸卡片。终端不受影响：PTY 在本地 agent 里。
app.on('window-all-closed', () => {
  app.quit()
})

// 退出前先跟 relay 有序告别：CTL_LEAVE 让配对的另一端也知道，再关 ctl，
// 避免进程被直接收掉、relay 只能等 TCP 超时。
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void relay.disconnect().finally(() => {
    // disconnect() 里已经等过 80ms；这里再留一点余量给 relay 广播下线。
    setTimeout(() => app.exit(0), 120)
  })
})
