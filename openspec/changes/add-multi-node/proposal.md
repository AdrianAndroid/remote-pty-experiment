# 变更：多节点与角色互换

## Why

Stage 1 的角色是部署时固定的：跑宿主进程的那台是宿主，跑客户端的那台是控制端。relay 只有一个 agent 槽位，两台机器不能同时在线，更不可能互相开终端。

实际需要的是 **Tab 级选择**：同一个客户端里，有的 Tab 开在本机（共享给别人），有的 Tab 开在对方机器（远程操作）。

## What Changes

### relay
- `self.agent` 单槽位 → `self.nodes: {node_id: Node}`，不同 node 互不顶替
- `/agent?node=<id>` 注册，宿主进程首帧 `HELLO{node_id,name,platform}`
- `SESSION_CREATE` / `SESSION_CLOSE` / `SESSION_RESIZE` 按 `target` 路由
- 会话编号 `index` 改由 relay 全局分配（原为宿主进程内部 seq，多节点会撞号）
- 新增下行 `NODES`（在线节点）与 `SESSIONS`（按节点分组的会话合并视图）
- healthz 报每个节点的在线状态与会话数

### 宿主进程
- 新增 `--node <id>` 参数，默认取主机名
- 连上后先发 `HELLO`
- `SESSION_LIST` 带 `node_id`
- 去掉内部 `seq`，改用 relay 回传的 `index`

### 客户端
- 新建 Tab 时选择目标节点：只有一个节点在线则直接创建（单机行为不变）
- 多节点时弹选择框：本机 / 各远端节点
- `RemoteSession` 增加 `node` 字段，`SESSION_*` 信令带上 `target`
- Tab 标记规则不变：本窗口建的**无标记**，别人建的显示灰色「共享」
- **不在 Tab 上显示机器名**（用户明确要求）

### 部署
- 每台需要"当宿主"的机器都要跑宿主进程，包括客户端所在的机器
- 客户端与本机宿主进程之间不直连，统一经 relay

## Impact

- 受影响的规格：`pty-relay` 中与角色、会话列表、编号相关的 Requirement
- 受影响的代码：`server/relay.py`、`agent/rpty_agent.py`、`apps/desktop/src/main/relay-client.ts`、`apps/desktop/src/shared/ipc.ts`、`apps/desktop/src/renderer/src/App.tsx`、`components/session-list.tsx`
- 不受影响：镜像机制（多播、快照定向、owner 锁尺寸）、只读开关

## 风险

- **编号语义变化**：全局递增后编号不连续（mini 建 1、pc 建 2、mini 再建 3）。可接受，换来的是跨节点不撞号。
- **单 token 覆盖面扩大**：一个 token 现在是所有节点的钥匙。两台自有机器可接受，多用户场景需重新设计。
- **本机宿主进程成为前置依赖**：没跑就没有「本机共享」。UI 必须给出明确提示而不是静默失败。

## 不在本次范围

- Tab 上标机器名
- 每节点独立 token / node_id + ACL
- 会话迁移
- 本机 localhost 直连
- 节点中继链（A → B → C）
