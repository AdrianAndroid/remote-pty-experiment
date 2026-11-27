# 变更：Electron 客户端外壳与本地终端

## Why

早期选的客户端是「Python + 本地网页（`127.0.0.1:7700`）」，`docs/05` 的 ADR-005 明确写了"不用 Electron"。2026-11-27 复评后推翻：

- 用户以 orca（`stablyai/orca`）为体验基准，明确要求"按 orca 的技术方案来做，正好学习一下"
- 网页版做不出原生窗口的手感：没有真窗口、没有菜单栏、没有 `Cmd+W`/`Cmd+Q` 的原生语义
- 多终端需要主进程持有 PTY，网页版的"本地服务 + 浏览器"要多一层进程

本变更产出**能跑起来的最小客户端**：一个窗口、一个 xterm、本地 zsh。不联网。

## What Changes

| 新增 | 内容 |
| --- | --- |
| `apps/desktop/package.json` | already exists，微调 deps |
| `apps/desktop/electron.vite.config.ts` | already exists，main/preload externalize + renderer 别名 |
| `apps/desktop/src/main/index.ts` | 窗口创建、生命周期、IPC 注册 |
| `apps/desktop/src/main/pty-session.ts` | already exists（`node-pty` 封装 + 环境变量策略） |
| `apps/desktop/src/main/ipc/handlers.ts` | 把 IPC 通道接到 PtySession |
| `apps/desktop/src/preload/index.ts` | 只暴露 `RptyBridge`，`contextIsolation: true` |
| `apps/desktop/src/renderer/index.html` | 入口页 |
| `apps/desktop/src/renderer/src/main.tsx` / `App.tsx` | React 挂载 |
| `apps/desktop/src/renderer/src/components/terminal-view.tsx` | xterm 实例、先 open 再挂 WebGL |
| `apps/desktop/src/renderer/src/lib/terminal-options.ts` | 照抄 orca 的终端参数 |
| `apps/desktop/src/renderer/src/lib/key-policy.ts` | `attachCustomKeyEventHandler` 语义 |
| `apps/desktop/src/renderer/src/styles.css` | 深色主题 |

**明确不在本变更内**：多会话、WSS、relay、设置页、诊断页、打包签名。多会话见 `add-multi-session`。

## Impact

- **推翻 ADR-005**（"不用 Electron"），`docs/05` 需加注
- **推翻 ADR-002**（base64 承载二进制），已在 `docs/08` 被二进制帧取代
- **目录结构**：新增 `apps/desktop/src/{main,preload,renderer,shared}`
- **构建**：新增 `electron-rebuild`（node-pty 是原生模块），`out/` 进 `.gitignore`
- **不引入**：`@xterm/headless`、`@xterm/addon-serialize`、oxlint、Playwright（orca 有，我们不需要）

## 验收

打开窗口看到 zsh，能跑 `vim`、`htop`，方向键与 `Ctrl` 组合键正常，resize 窗口不花屏。
