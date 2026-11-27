# 28 · 关闭语义归档（kill vs detach）

> 归档时间：2026-11-28
> 提交：`c508295`
> 变更：`openspec/changes/archive/2026-11-28-close-semantics/`
> 状态：**已实现、已实测，替换掉上一版「灰标签保留」方案。**

---

## 1. 一句话

标签只是 PTY 的视图：**创建端点 × 等于 kill（PTY 死，所有端都消失）；镜像端点 × 等于 detach（只撤自己这块画面，PTY 照跑，重连回来还是它）。**

上一版把"有人点了 ×"和"整台机器没了"混成两档，又给 × 留了灰标签占位 —— 那套已作废。

---

## 2. 语义

| 谁点的 × | 宿主上的 PTY | 本端 | 另一端 |
| --- | --- | --- | --- |
| 创建端（`owned`） | 终止 | 立即消失 | 在线立即消失；离线重连也不出现 |
| 镜像端（非 `owned`） | 继续运行 | 只撤掉画面 | 无感知 |
| 宿主侧 PTY 已不存在 | —— | 移除 | 移除 |

重连（收到 `HELLO`）时清空"主动撤掉"名单，再跟宿主列表对表：宿主还在的会话重新挂上并镜像，宿主不在的不出现。

---

## 3. 实现落点

**客户端 `apps/desktop/src/main/relay-client.ts`**

- `close(leafId)` 按 `session.owned` 分岔：`owned` 发 `SESSION_CLOSE`；否则只本地移除并把 sid 写进 `detached`，**不发信号**。
- `detached: Set<string>` 表示"本端主动撤掉画面的镜像会话"；`syncFromList` 遇到就 `continue`，`HELLO` 时清空。
- `dropSession(session)`：统一摘除 session / `bySessionId` / `ownedIds`（落盘）/ `closeData` / `buffered` / `pendingReady` / `detached`，最后 `onRemoved(leafId)` 通知渲染层。
- `SESSION_CLOSED`、`SESSION_EXIT`、列表里缺失 —— 三条路都走 `dropSession`，不再置灰。
- `removeNode(node)`（`NODE_GONE` / 离线 30 秒超时）内部改为逐条 `dropSession`。

**relay `server/relay.py`**：无需改动。`SESSION_CLOSE` 依旧是"杀 PTY + 从 `last_list` 摘除 + 广播 `SESSION_CLOSED`"；镜像端 detach 不发信号，relay 天然无感。

---

## 4. 实测（mini 节点，两端真机）

| # | 操作 | 结果 |
| --- | --- | --- |
| 1 | A 建「终端 13」 | B 出现「终端 27」，带共享标 |
| 2 | B 点 × | B 少一项，A 仍在，`/healthz` mini 会话数仍为 1 |
| 3 | 重启 B | 终端 27 自动回来，内容接上 |
| 4 | A 点 × 终端 13 | A、B 同时消失，mini 会话数归 0 |
| 5 | B 撤掉 28，A 新建终端触发列表广播 | B 只多出新终端，28 没有回来 |
| 6 | 假节点发 `HOST_EXIT` | 该节点标签立即整批移除 |
| 7 | `kill -9` 宿主 | 30 秒离线超时后整批移除 |

---

## 5. 边界与取舍

- **detach 不保留滚动历史**：重连恢复的是镜像，不是本地的回滚缓冲；改名、滚动位置也不保留。
- **幂等性**：镜像端 detach 后若创建端随后关掉该会话，本端已无此 session，`detached` 里会残留 sid —— 无害，下次 `HELLO` 清空。
- **离线窗口**：镜像端断网期间撤掉的标签，会在重连后按宿主列表重新出现（没有"离线操作队列"），这是"重连即对表"的直接结果。
- **`kill -9` 兜底**：宿主被强杀时发不出 `HOST_EXIT`，只能等 30 秒（`RelayClient.NODE_GONE_MS`）离线超时清标签。

---

## 6. 相关文件

- `apps/desktop/src/main/relay-client.ts`
- `apps/desktop/src/shared/ipc.ts`（`session:removed`）
- `apps/desktop/src/preload/index.ts`、`src/main/index.ts`、`src/renderer/src/App.tsx`（`onRemoved` 链路）
- `server/relay.py`（`SESSION_CLOSE` / `HOST_EXIT` 分支）
- `openspec/specs/pty-relay/spec.md`（新增「会话关闭语义（kill 与 detach 二分）」需求）
