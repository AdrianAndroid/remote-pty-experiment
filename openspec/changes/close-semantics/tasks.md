# 任务

## 1. relay

- [x] 1.1 `SESSION_CLOSE` 时从 `last_list` 摘除该会话
- [x] 1.2 广播 `SESSION_CLOSED {session_id, node, reason:"ctl"}`
- [x] 1.3 处理宿主 `HOST_EXIT`，清空该节点列表并广播 `NODE_GONE`

## 2. agent

- [x] 2.1 正常退出前发送 `HOST_EXIT`

## 3. 客户端

- [x] 3.1 `SESSION_CLOSED` → 置灰保留（不再按 owned 分岔）
- [x] 3.2 `NODE_GONE` → 移除该节点全部标签，新增 `session:removed` IPC
- [x] 3.3 `NODE_OFFLINE` 60 秒未恢复按 `NODE_GONE` 处理
- [x] 3.4 `syncFromList` 清理统一为置灰保留

## 4. 验证

- [x] 4.1 控制端关 A 的终端 → A 灰、标签在
- [x] 4.2 关掉宿主进程 → 两端该节点标签全部消失
- [x] 4.3 宿主被杀 -9 → 60 秒后标签消失
- [ ] 4.4 宿主恢复 → 会话重新出现

## 实施记录（2026-11-28）

- **控制端关闭**：B 点 × 关掉共用的「终端 22」→ B 自己移除，A 保留 `led--exited` 灰标签，relay 广播 `SESSION_CLOSED{reason:"ctl"}` 并把它从 `last_list` 摘掉（否则新连的客户端会 adopt 一个死会话）。
- **宿主主动退出**：用假节点 `fake-probe` 上报一条会话（客户端出现「终端 25」），随后发 `HOST_EXIT` → 标签**立即**消失，主进程日志 `节点 fake-probe 消失，摘掉 1 个标签`，没等超时。
- **宿主硬退出**：`kill -9` 掉 mini 宿主后，该节点标签先变 `disconnected`（30 秒宽限），超时后整批移除，日志 `节点 zhaojiandeMac-mini 消失，摘掉 3 个标签`。
- 宿主重启后 PTY 随之消失，标签不会再回来 —— 这是 PTY 生命周期决定的，不是标签逻辑的问题。
- 车上还有一个取舍：`NODE_OFFLINE` 的宽限期定成 30 秒（`RelayClient.NODE_GONE_MS`），网络抖动在 30 秒内恢复不会误删。
