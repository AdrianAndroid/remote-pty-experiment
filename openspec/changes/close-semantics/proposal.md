# 关闭语义：创建端删 = 杀 PTY，镜像端删 = 只撤画面

## 为什么

标签不是「一个记录」，而是「一个 PTY 的视图」。PTY 在，标签就该出现；PTY 没了，标签就不该留。谁点的 × 决定了 PTY 死不死：

> 如果那个 type 是宿主，把它删了，另一个端哪怕是连着或者重新连上，都要删除、不保留。
> 如果那个端是控制端（镜像端），删了之后重新连上，宿主还在这个 tab 就重新显示、重新镜像；宿主不存在了也删掉。

也就是 tmux 的 kill 与 detach 的差别，之前「关掉后另一端保留灰标签」的做法被作废。

## 两条规则

| 谁点的 × | 宿主上的 PTY | 本端标签 | 其它端标签 |
| --- | --- | --- | --- |
| 创建端（`owned`） | 杀掉 | 立刻消失 | 收到 `SESSION_CLOSED` 后消失，**不保留** |
| 镜像端（非 `owned`） | 继续跑 | 消失，sid 记入 `detached` | 完全无感知 |
| 宿主不存在（进程退出 / 节点消失 / 列表里没了） | —— | 全部移除 | 全部移除 |

重连规则：连接重建成功（收到 `HELLO`）时清空 `detached`，随后按宿主列表重新对表 —— 宿主还在的会话重新挂上、重新镜像；宿主不在的会话不出现。

## 怎么做

**客户端（`relay-client.ts`）**

- `close(leafId)` 分岔：`owned` 走原路（发 `SESSION_CLOSE`）；非 `owned` 只在本端移除，并把 sid 记进 `detached`，不发任何信号。
- `detached` 是「本端主动撤掉画面」的名单，`syncFromList` 遇到它 `continue`，避免下一份列表把它自动装回来；`HELLO` 时清空。
- 新增 `dropSession(session)`：移除 session / `bySessionId` / `ownedIds`（并落盘）/ `closeData` / `detached` 条目，最后 `onRemoved(leafId)` 通知渲染层摘标签。
- `SESSION_CLOSED`（创建端关掉）、`SESSION_EXIT`（shell 自己退出）、列表里缺失 —— 三条路统一走 `dropSession`。
- `NODE_GONE` / 离线 30 秒超时 → `removeNode(node)`，内部逐条 `dropSession`。

**relay**：维持现状。`SESSION_CLOSE` 一律杀 PTY 并从 `last_list` 摘除后广播 `SESSION_CLOSED`；`HOST_EXIT` → `NODE_GONE`。镜像端 detach 因为不发信号，relay 无感。

## 边界

- 镜像端 detach 之后、重连之前，若创建端把该会话关了，本端收不到（已无此 session），但 `detached` 里残留 sid 无害，重连清空。
- 宿主被 `kill -9` 时发不出 `HOST_EXIT`，靠 30 秒离线超时兜底清标签。
- 标签只是视图：重连后恢复的是「镜像」而不是「本地的滚动历史」，改名、滚动位置都不保留。
