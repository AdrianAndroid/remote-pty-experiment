> **已废弃（2026-11-28）**：本变更被 `pair-as-private-room` 取代，不实施。
> 原因：房间模型要求房间内两人同时看同一条终端，"每终端一个 viewer" 与之冲突；
> "别人不能旁观"改由服务端按房间过滤实现（更强）。其中"快照前增量排队 + 2.5s 兜底"
> 作为实现细节保留。

# 数据通道收成 1:1：一个 PTY 只对一条控制端连接

## 为什么

数据通道现在是 **1:N 多播**：一个 `data_token` 下一条 agent 连接 + 任意多条 viewer 连接，
relay 把 agent 的字节广播给所有 viewer，把任何 viewer 的按键汇总回 agent。

支持它的成本是可见的：

| 机制 | 存在理由 | 代价 |
| --- | --- | --- |
| `Channel.viewers: Dict[cid, Viewer]` | 多个 viewer | 每次收发都要遍历、每次进出都要维护 |
| `cid`（relay 自增的 viewer 编号） | 把快照**只**发给新来的那个人 | 多一个标识贯穿三条消息（`VIEWER_JOINED` / `SESSION_SNAPSHOT` / `viewers` 索引） |
| `Viewer.ready` + `Viewer.queue` + `VIEWER_QUEUE_MAX=512` | 快照没到之前增量先排队 | 每条通道各自维护状态机 |
| `_force_ready`（2.5s 兜底） | 快照没来不能无限等 | 一个定时器 + 一条旁路 |
| `viewers: Dict[cid, Viewer]`（全局索引） | 快照回来按 cid 找连接 | 第二张反查表 |

而这些机制**只服务一个场景**：镜像 —— 两个人看同一块终端。
按产品口径，一个 PTY 只有一个主人、一条控制端连接，那就应该按 1:1 建模：
`Channel { token, node, agent, viewer, creator }`，上面五行全部消失。

## 变成什么样

**数据面**

```
现在                                  改成
/d/<token>                            /d/<token>
  ├─ role=agent  ──► Channel.agent      ├─ role=agent ──► Channel.agent
  └─ role=ctl    ──► viewers[cid1]      └─ role=ctl   ──► Channel.viewer  （只允许一条）
                     viewers[cid2]
                     viewers[cid3] …
```

- agent 发来的字节：只发给 `Channel.viewer`（没有就丢，不再攒）。
- viewer 发来的按键：只发给 `Channel.agent`。
- 新 viewer 进来：请 agent 补一份快照，**直接发给这条连接**，不再需要 `cid` 定向。
- 快照之前到的增量：仍然要排队（否则增量会跑到历史前面），但队列挂在通道上，只有一条；
  2.5s 兜底保留。

**第二个 viewer 怎么办 —— 默认拒绝，不顶掉**

| 情况 | 处理 |
| --- | --- |
| 同一 `client` id 的第二条连接（自己重连/开新窗口） | 顶掉旧的（`4002 replaced`），这是现在 agent 侧的既有语义，复用 |
| 不同 `client` id 的第二条连接（别人想同看） | 关闭新连接 `4009`，reason `busy`，**不动正在看的那条** |

选拒绝而不是顶掉，理由：顶掉等于「抢椅子」—— 我进你的终端看我自己的，你屏幕当场断流；
拒绝至少让双方都保持可用，只是后来者看到一个明确的「该终端正被 <名字> 占用」。

**信令面（字段保留、依赖去掉）**

- `VIEWER_JOINED { data_token, cid }`：仍带 `cid`（免去 relay/agent 版本错位时的解析失败），
  但 relay 不再用它路由。
- `SESSION_SNAPSHOT { data_token, cid, data }`：同上。
- 新增一种关闭原因：`4009 busy`。这不算新信令类型，客户端按 close code 分派即可。

**客户端**

- 镜像标签（`session.owned === false`）的数据连接被拒时，落到已有的
  `onState(leafId, 'disconnected', message)` 通路，显示「该终端正被 <owner 名> 占用」。
- 「共享」标签的语义从「可以同时看」变成「**只能一个人看**」。
- `resize` 的 `!session.owned` 保护、`close` 的 detach 语义都不变（那是归属问题，不是通道问题）。

**agent**

- `on_viewer_joined` 不再需要拼 `cid`（收到就回，`SESSION_SNAPSHOT` 里原样带回）。
- 环形缓冲（`RING_BYTES=256KB`）保留 —— 它服务的是「重连补画面」，和几路 viewer 无关。
- `drain_loop` 的背压（`QUEUE_HIGH=256 / QUEUE_LOW=64`）保留。

## 影响面

| 文件 | 改动 | 量级 |
| --- | --- | --- |
| `server/relay.py` | 删 `viewers` 全局索引、`_next_cid`、`cid` 路由、`deliver_snapshot` 的 cid 分支、`Viewer` 的 dict 语义；`Channel.viewers` → `viewer`；新增 `4009` 拒绝分支与「同 client 顶替自己」判定 | 约 −90 / +40 行 |
| `agent/rpty_agent.py` | `on_viewer_joined` 去掉 cid 依赖 | 约 ±10 行 |
| `apps/desktop/src/main/relay-client.ts` | 镜像端处理 `4009`，落到 disconnected + 文案；其余不动 | 约 +15 行 |
| `apps/desktop/src/renderer` | 「共享」标签文案/提示 | 约 ±10 行 |
| `tests/test_relay.py` | 改写 4 个（多播、快照定向、排队增量、force_ready），新增 4 个（第二 viewer 被拒、同 client 顶替自己、owner 不被打断、通道释放） | 23 → 27 个用例 |
| `openspec/specs/pty-relay/spec.md` | 新增「数据通道 1:1」要求，替换原来的多播描述 | +1 条 |

**协议不新增类型、不改字段名**，只加一个 close code 语义 —— 老客户端连上来最多是「看到 busy 不知道怎么显示」，
不会解析失败。

## 要先想清楚的风险

1. **自己重连被自己挡住**：客户端崩溃时 TCP 半开，要等 relay 的 ping（20s）才发现连接死了。
   这期间同一 client 重连会撞上「已有 viewer」。所以必须按 `client id` 认人：
   同 id 一律顶替，跨 id 才拒绝。这条不做，1:1 会变成「断线后 20 秒连不回来」。
2. **镜像彻底消失**：`「进别人客户端 → 看到对方终端」` 从「能看能敲」变成「看到占用提示」。
   `docs/10-symmetric-peer.md`、`docs/15-presence-and-pairing.md` 里描述的能力要同步标注为已取消，
   否则文档会说一套、代码做一套。
3. **多窗口**：同一台机器开两个客户端窗口（同一个 `client_id`）会互相顶替数据连接 —— 和现在
   `SESSION_CREATE` 的「两个窗口看同一个终端」行为相比，第二个窗口会不停地抢。需要在客户端侧决定：
   同 id 顶替是「后开的赢」，那先开的那个窗口要显示「已被本机另一个窗口接管」。
4. **回滚**：改动集中在 `handle_data` 一个函数里，协议未变，`git revert` 单个提交即可恢复多播。

## 落地记录

- （实施后补）
