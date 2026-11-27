# 任务：Electron 客户端外壳与本地终端

## 0. 准备（30 分钟）

- [ ] `pnpm install`（`.npmrc` 已配 npmmirror 的 electron 镜像）
- [ ] `pnpm rebuild`（`electron-rebuild -f -w node-pty`），确认 `node-pty` 能加载
- [ ] `pnpm typecheck` 通过（当前只有 `ipc.ts` 与 `pty-session.ts`）

## 1. 主进程（P0 核心）

- [ ] `src/main/index.ts`
  - [ ] `app.whenReady()` 后创建 `BrowserWindow`，`contextIsolation: true`、`nodeIntegration: false`、`preload` 指向编译产物
  - [ ] 窗口尺寸 1100×720，`titleBarStyle: 'hiddenInset'`（macOS 红绿灯内嵌）
  - [ ] `app.on('window-all-closed')` 在 macOS 上不退出（为后台保活留位）
  - [ ] 注册 IPC handlers
- [ ] `src/main/ipc/handlers.ts`
  - [ ] `pty:create` → 新建 `PtySession`，返回 `{ id, pid }`
  - [ ] `pty:write` / `pty:resize` / `pty:dispose`
  - [ ] PTY 的 `onData` / `onExit` 通过 `webContents.send` 推给渲染进程
  - [ ] 窗口销毁时清理所有会话（v1 先做"退出即结束"）

## 2. preload

- [ ] `src/preload/index.ts` 用 `contextBridge.exposeInMainWorld('rpty', bridge)`
- [ ] 只暴露 `RptyBridge` 的七个方法，不暴露 `ipcRenderer` 本身
- [ ] `src/renderer/src/global.d.ts` 声明 `window.rpty`

## 3. 渲染进程

- [ ] `index.html` + `main.tsx` + `App.tsx` 能挂载
- [ ] `lib/terminal-options.ts` 照抄 `docs/24` §5.4 的参数，逐项核对
- [ ] `components/terminal-view.tsx`
  - [ ] `new Terminal(options)` → `open(ref)` → **再** `loadAddon(new WebglAddon())`
  - [ ] `FitAddon` 在 `ResizeObserver` 里调用，且**延迟一帧**再 fit
  - [ ] `onData` → `window.rpty.write(id, data)`
  - [ ] 挂载 `unicode11` 并 `terminal.unicode.activeVersion = '11'`
- [ ] `lib/key-policy.ts`
  - [ ] `attachCustomKeyEventHandler`：返回 `false` 才冒泡
  - [ ] `Cmd+C` 有选区走剪贴板，无选区发 `\x03`
  - [ ] `Cmd+V` 走 `window.rpty` 之外的剪贴板 API，内容做 bracketed paste 包装
- [ ] `styles.css` 深色主题，色值取 `docs/24` §9.4

## 4. 自测（P0 验收）

- [ ] `pnpm dev` 起来能看到 zsh 提示符
- [ ] `vim` 打开文件，方向键、`Esc`、`:wq` 正常
- [ ] `htop` 正常渲染，`q` 能退出
- [ ] `Ctrl+C` 能中断 `ping`
- [ ] 拖拽窗口大小，不花屏、不错行
- [ ] 输入中文（拼音）显示正常，无乱码
- [ ] 选中文本复制，粘贴回终端

## 5. 收尾

- [ ] `pnpm typecheck` 通过，无 `any`
- [ ] `.gitignore` 已含 `node_modules/`、`out/`、`dist/`
- [ ] 提交：`feat(desktop): Electron 外壳与本地终端`
- [ ] 在 `docs/05` 的 ADR-005 上加"已被 add-electron-client 推翻"的注记
