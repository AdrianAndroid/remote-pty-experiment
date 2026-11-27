# 27 · 多节点与角色互换

> 状态：**设计讨论中，未实施。**
> 关联变更：`openspec/changes/add-multi-node`
> 前置：`26-stage-1-archive.md`（单宿主机 + 多客户端镜像）

---

## 1. 问题

Stage 1 里角色是**部署时固定**的：跑宿主进程的那台是宿主，跑客户端的那台是控制端。relay 只有一个 agent 槽位（`server/relay.py` 的 `self.agent`），新连上来的会把旧的顶掉。

用户要的是 **Tab 级**的角色选择：

| 操作 | shell 在哪 | 谁建的 | Tab 标记 |
| --- | --- | --- | --- |
| 本机共享 | 我 | 我 | 无 |
| 对方控制 | 对方 | 我 | 无 |
| 对方宿主 | 对方 | 对方 | 「共享」 |

第四种（对方在我机器上开）不需要我选，被动出现即可。

---

## 2. 核心结论

**这不是三个功能，是一个功能 + 一套标记规则。**

- 功能只有一个：`SESSION_CREATE` 带 `target`，能把 shell 开在任意在线节点上。
- 标记规则只有一条：**不是本窗口建的，就写「共享」**（沿用 Stage 1 的 `owned` 字段）。

「本机共享」和「对方宿主」是同一件事的两端：A 点「本机共享」建出来，B 那边自动出现的就是「对方宿主」，带「共享」标。

---

## 3. 部署形态

每台机器跑**两个进程**，都只出站连 relay：

```
┌─ Mac mini ────────────────┐        ┌─ 台式机 192.168.2.2 ──────┐
│ 宿主进程  node=mini        │        │ 宿主进程  node=pc          │
│ 客户端    (Electron)       │        │ 客户端    (Electron)       │
└───────────┬───────────────┘        └───────────┬───────────────┘
            │                                    │
            └──────── wss://rpty.zhaojian.xin ───┘
                              │
                     ┌────────┴────────┐
                     │      relay      │
                     │ nodes{mini,pc}  │
                     └─────────────────┘
```

关键点：**客户端所在的机器也必须跑宿主进程**，否则「本机共享」没有 PTY 可开。
宿主机和客户端是两个独立进程，客户端不需要知道"自己这台也在被控"，它只是连 relay 的一个 ctl。

---

## 4. relay 改造

### 4.1 从单槽位到节点表

```python
# 现在
self.agent: Optional[WebSocketServerProtocol] = None

# 改为
self.nodes: Dict[str, Node] = {}      # node_id -> Node
# Node = { ws, name, platform, last_list, sessions: set }
```

- `/agent?node=<id>&token=...` 注册；同 `node_id` 重复连接才顶掉旧的
- 不同 `node_id` 各自独立，互不影响——这是"不再互顶"的关键

### 4.2 信令路由

```
ctl ──SESSION_CREATE{target:"pc"}──▶ relay ──▶ nodes["pc"].ws
                                         └──▶ 不发给自己，避免自己接到自己的会话
```

`SESSION_CLOSE` / `SESSION_RESIZE` 同理，按 `target` 路由。客户端需要在 `bySessionId` 里记住每个会话的 `node`。

### 4.3 会话编号改由 relay 分配

现在 `index` 是宿主进程内部的 `self.seq`，两个节点必然都从 1 开始，撞号。

改为 relay 维护全局 `seq`，`SESSION_CREATE` 时分配，回 `SESSION_CREATED{index}`。全局唯一，不用在标签上标机器名也不会撞。

### 4.4 合并视图

宿主进程上报 `SESSION_LIST{node_id, sessions}` → relay 存进 `nodes[id].last_list` → 对所有 ctl 广播合并结果：

```json
{"type":"SESSIONS","nodes":[
  {"node":"mini","name":"Mac mini","online":true,
   "sessions":[{"session_id":"...","index":1,"cols":80,"rows":24}]},
  {"node":"pc","name":"台式机","online":true,
   "sessions":[{"session_id":"...","index":2,...}]}
]}
```

新 ctl 一连上就收到全量。

---

## 5. 协议变更表

| 帧 | 方向 | 变化 |
| --- | --- | --- |
| `HELLO` | agent → relay | 新增。`node_id` / `name` / `platform` |
| `NODES` | relay → ctl | 新增。在线节点列表 |
| `SESSIONS` | relay → ctl | 新增。按节点分组的会话合并视图 |
| `SESSION_CREATE` | ctl → relay | **+ `target`** |
| `SESSION_CREATED` | relay → ctl | **+ `index`**（relay 分配） |
| `SESSION_LIST` | agent → relay | **+ `node_id`** |
| 数据通道 | | `/d/<token>?role=ctl` 不变，token 本身已全局唯一 |

---

## 6. 客户端改造

### 6.1 新建 Tab 选目标

右下角「+ 新建终端」保持一个按钮。点击后：

- **只有一个节点在线** → 直接建，不弹窗（沿用现在的行为，单机场景零变化）
- **多个节点在线** → 弹出两项：

```
┌────────────────────────────┐
│  在哪里开终端？              │
│                            │
│  ▸ 本机  Mac mini           │  shell 跑在你这台，对方能看到
│  ▸ 台式机  pc               │  shell 跑在对方那台，你远程操作
└────────────────────────────┘
```

### 6.2 标记规则（按用户确定）

| Tab 情况 | 标记 |
| --- | --- |
| 本窗口创建的（本机或对方） | 无标记 |
| 别的窗口创建的，我接上来的 | 灰色「共享」徽标 |

**不显示机器名。** 沿用 Stage 1 的实现，只是数据源从单节点变多节点。

### 6.3 已知代价

「本机共享」和「对方控制」两种 Tab 视觉上完全一样，都是无标记。误判的后果是：以为在操作本机，实际在操作对方机器。

缓解（可选，不占文字）：非本机节点的 Tab 标题左侧加一条 2px 竖线，颜色区分。用户暂未要求。

---

## 7. 边界情况

| 情况 | 处理 |
| --- | --- |
| 本机宿主进程没跑 | 「本机」项置灰，提示「本机宿主未运行」；给出启动命令 |
| 目标节点在创建过程中掉线 | relay 回 `ERROR{code:node_offline}`，客户端在 Tab 上显示红色错误，保留标签可重试 |
| 两个客户端同时在同一节点建 Tab | 各自独立，编号由 relay 全局分配不冲突 |
| 同一 node_id 的两个进程同时连（装了两份） | 后者顶掉前者，日志警告 |
| 客户端只有一个节点 | 不弹窗，行为与 Stage 1 完全一致 |

---

## 8. 安全

**沿用单 token**（每台 agent 与客户端共用一个 `RPty_TOKEN`）。

风险要说清：多节点后这一个 token 等于**所有机器的钥匙**，配置文件里是明文（chmod 600）。单机时丢了只丢一台，多机时丢全部。

后续若要多用户或换机器，再上「每节点独立 token」或「node_id + ACL」，但**不建议一开始就做**——目前是两台自己的机器，ACL 的复杂度换不来实际收益。

---

## 9. 不做什么

- 不做 Tab 上标机器名（用户明确否掉）
- 不做通道级加密（Stage 1 的 TLS 已覆盖传输，relay 能看到明文但只看到字节流）
- 不做本机 localhost 直连优化（都走 relay，多 30ms，终端无感）
- 不做会话迁移（把跑在 A 上的 shell 搬到 B）
- 不改镜像机制（多播、快照定向、owner 锁尺寸全部原样复用）

---

## 10. 工作量

| 层 | 内容 | 估计 |
| --- | --- | --- |
| relay | nodes 表、路由、`HELLO`/`NODES`/`SESSIONS`、全局 seq、healthz | ~120 行 |
| 宿主进程 | `--node` 参数、`HELLO`、`SESSION_LIST` 带 node | ~20 行 |
| 客户端主进程 | `target` 透传、nodes 状态、会话按 node 记 | ~80 行 |
| 客户端渲染层 | 节点选择弹窗、错误态 | ~120 行 |
| 文档与验证 | 双机实测 | 半天 |

合计约 **1.5 天**，其中验证占一半（要动台式机）。
