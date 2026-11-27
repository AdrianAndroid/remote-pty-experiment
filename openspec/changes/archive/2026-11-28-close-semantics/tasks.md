# 任务

## 1. 客户端关闭语义（detach vs kill）

- [x] 1.1 `close()` 分岔：`owned` 发 `SESSION_CLOSE`；非 `owned` 只本端移除
- [x] 1.2 新增 `detached` 集合，记录本端主动撤掉的镜像会话
- [x] 1.3 `syncFromList` 跳过 `detached` 中的会话
- [x] 1.4 `HELLO` 时清空 `detached`（重连即重新对表）
- [x] 1.5 新增 `dropSession()`，统一摘除会话并 `onRemoved` 通知渲染层
- [x] 1.6 `SESSION_CLOSED` / `SESSION_EXIT` / 列表缺失 统一走 `dropSession`（不再置灰保留）
- [x] 1.7 `NODE_GONE` / 离线 30 秒超时 → `removeNode` 内部复用 `dropSession`

## 2. relay

- [x] 2.1 `SESSION_CLOSE` 杀 PTY + 从 `last_list` 摘除 + 广播 `SESSION_CLOSED`
- [x] 2.2 处理宿主 `HOST_EXIT`，清空该节点列表并广播 `NODE_GONE`
- [x] 2.3 镜像端 detach 不发信号，relay 无需感知

## 3. agent

- [x] 3.1 正常退出前发送 `HOST_EXIT`

## 4. 验证

- [x] 4.1 镜像端（B）点 × → B 标签消失，A 标签仍在，PTY 存活，relay 会话数不变
- [x] 4.2 镜像端 detach 后重启客户端 → 标签重新出现并恢复镜像
- [x] 4.3 创建端（A）点 × → 两端标签都消失，relay 该节点会话数归零
- [x] 4.4 detach 后其它会话触发列表广播 → 被撤掉的标签不自动装回
- [x] 4.5 宿主 `HOST_EXIT` → 该节点标签立即整批移除
- [x] 4.6 宿主 `kill -9` → 30 秒离线超时后整批移除

## 实施记录（2026-11-28）

实测序列（`zhaojiandeMac-mini` 节点）：

1. A 主窗口建「终端 13」，B 出现对应的「终端 27」（共享标）。
2. B 点 × → B 列表少一项，A 的终端 13 照常，`/healthz` 里 mini 会话数仍为 1。
3. 重启 B（等同重新连上）→ 终端 27 自己回来，内容接上。
4. A 点 × 终端 13 → A、B 同时消失，mini 会话数归 0。
5. 再建「终端 14 / 28」，B 撤掉 28 后由 A 新建终端 15 触发列表广播 → B 只多出终端 29，28 没有回来。

早前验证（同一语义的相邻路径）：

- 假节点 `fake-probe` 上报会话后发 `HOST_EXIT` → 标签立即消失，日志 `节点 fake-probe 消失，摘掉 1 个标签`。
- `kill -9` mini 宿主 → 该节点标签先 `disconnected`，30 秒后整批移除。
