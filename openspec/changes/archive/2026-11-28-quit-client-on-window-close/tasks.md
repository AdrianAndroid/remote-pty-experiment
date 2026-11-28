# 任务

## 1. 客户端生命周期

- [x] 1.1 `window-all-closed` 在 macOS 上也要退出：去掉 `process.platform !== 'darwin'` 的例外
- [x] 1.2 `before-quit` 挡住一次退出，`await relay.disconnect()` 后再 `app.exit(0)`，保证 ctl 是主动关的、`CTL_LEAVE` 发得出去

## 2. 验证

- [x] 2.1 本机 CDP 触发窗口关闭，`/healthz` 的 `clients` 里这条客户端消失（3→2，f366 消失）
- [x] 2.2 另一台机器上正看着该客户端的窗口回到在线列表，并出现「已断开中继」提示
- [x] 2.3 重新打开客户端能正常认领宿主、把会话镜像回来（f366 回来仍带 2 个终端）

## 3. 归档

- [x] 3.1 `openspec/specs/pty-relay/spec.md` 追加「关窗即下线」要求
- [x] 3.2 变更归档到 `openspec/changes/archive/2026-11-28-quit-client-on-window-close/`
