# 任务

- [x] 1.1 `RelayClient.disconnect()` 补全清理（数据通道 / 缓冲 / ready / index / 节点定时器 / 节点表）
- [x] 1.2 新增 `RelayClient.reconnect()`，用已保存的地址与 token 重连
- [x] 1.3 新增 IPC `relay:reconnect` + preload `window.rpty.reconnect()`
- [x] 2.1 侧栏底部加「断开连接」按钮，`⌘⇧D` 同样触发
- [x] 2.2 断开会话：清标签、清 activeId、回连接页并进入「已断开」态
- [x] 2.3 连接页「重新连接」按钮：调用 `reconnect()`，成功后恢复工作区
- [x] 2.4 「视图」菜单加「断开连接 ⌘⇧D」
- [x] 3.1 实测：断开后 `ctls` 3→2，重连 2→3，8 个会话回来且不重复
- [x] 3.2 实测：重连后归属正确，宿主 PTY pid 不变（80327）

## 实施记录（2026-11-28）

- 菜单命令复用 `MenuCommand` 新增 `disconnect`，渲染层 `handleDisconnect` 与按钮同一条路径。
- 重连走 `relay.connect({url,token})`（主进程从 `loadConfig()` 取），不把 token 回传渲染层。
- `handleDisconnect` 在 App 里必须声明在菜单 `useEffect` 之前，否则 `tsc` 报 used-before-declaration（已按此顺序排布）。
- B（镜像端）：断开 `ctls 3→2 / viewers 24→16`，重连 `2→3 / 16→24`，8 标签回来全带「共享」（正确）。
- A（创建端 / primary）：断开→重连后 8 标签**全无**「共享」，归属认领保留。
- PTY 未中断：断开前 `HOST-CHECK ... pid=80327`，重连后 `echo AFTER-RECONNECT shell=$$` → `80327`。
