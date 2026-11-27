# 任务

- [x] 1.1 渲染层拆出 `pane__wrap`，镜像端改为锁 PTY 尺寸 + 等比缩放，不再 fit
- [x] 1.2 fit 前检查容器尺寸（<40px 直接跳过），避免 0 尺寸量出 10x5
- [x] 1.3 ResizeObserver / window.resize 用 rAF 防抖，避免中间态缩放卡住
- [x] 2.1 客户端新增 `session:resized` IPC（`onResized`），渲染层据此更新 `sizeLock`
- [x] 2.2 `syncFromList` 刷新已有会话的 cols/rows；创建端以本地为权威，不一致时重发 `SESSION_RESIZE`
- [x] 2.3 客户端 `resize()` 拒收 `cols<20 || rows<5`
- [x] 3.1 relay 收到 `SESSION_RESIZE` 后更新 `last_list` 并广播 `SESSION_RESIZED`
- [x] 3.2 relay 丢弃异常尺寸并记录 warning
- [x] 4.1 两端同尺寸窗口：screen 均 960×760，PTY 120×38
- [x] 4.2 全屏 TUI：两端 ROWS=38 COLS=120，末行贴底
- [x] 4.3 容器 620px：scale 0.6333，内容完整

## 实施记录（2026-11-28）

- 现场数据：修复前 A `xterm-screen` 952×760（自身 fit），B 928×900（锁在陈旧的 113×53，垂直溢出容器 134px）。
- 修复后：两端均 960×760，`/healthz` + `SESSION_LIST` 均为 120×38。
- 诊断中发现的意外：mini 宿主上有个 PTY 被压成 `10x5`，该会话两端完全黑屏（输入也进不去），印证了"尺寸被错误值带偏后整块终端不可用"。
- 顺带修：mini 宿主有僵尸子进程（defunct）不影响主流程；`kill` 后残留进程抢 `node_id` 需 `kill -9`。
