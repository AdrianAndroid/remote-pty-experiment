# relay 状态收口：一张在线表，行里带着它连着谁

## 为什么

`Relay.__init__` 里现在有 **13 个容器 + 4 个标量**，其中大多数不是新的概念，
而是同一个对象被按键拆成了好几本字典：

| 现在的键 | 容器 | 其实是什么 |
| --- | --- | --- |
| ws | `ctls` / `ctl_client` / `ctl_name` / `ctl_host` | 一个 Client 的 4 个字段 |
| sid | `sid_token` / `sid_node` / `sid_owner` / `sid_index` / `sid_claimed` | 一个 Session 的 5 个字段 |
| token | `channels` / `token_node` | 一条数据通道 + 它的宿主机 |
| cid | `viewers` | 快照定向用的反查索引 |

根因不是"设计复杂"，是**没有建类型**：`websockets` 交给 `handle()` 的是裸 `ws`，
手里没有对象可以挂字段，只能 `self.ctl_client[ws] = ...`、`self.ctl_name[ws] = ...`，
一条连接就被摊成四本字典。宿主那边有 `Session` 类（`rpty_agent.py:60`），
relay 这边没有同名类型，它的属性就散成了五本 `sid_*`。

代价已经连续以 bug 的形式付过三次：

- `fix(client): 关窗即下线` —— "在线"由三本字典加一个 Set 共同决定，漏清一边就是僵尸卡
- `fix(relay): 终端数改成按 owner 统计` —— "谁是主人"在 `sid_owner` 和本地文件两处各有一份
- `claim-legacy-owner` 整套机制 —— 归属会被重启打断，只能事后打补丁认领

## 变成什么样

三张主表 + 两张必要的索引：

```
Client   { id, conns[], name, host, pair }
Node     { id, ws, name, platform, last_list }
Session  { id, token, node, owner, index, cols, rows, claimed }

by_ws    : ws       → Client     （连接事件 O(1) 找到人）
viewers  : cid      → Viewer     （快照按 cid 定向投递）
```

- `Client.conns` 是集合：同一个 client id 开两个窗口时，它们是**同一个客户端的两条连接**，
  不是两个客户端。任一条断开只摘掉自己；最后一条断开才把这个人从在线表移除。
- 匿名连接（不带 `client=` 的老客户端）归到 `clients[""]` 这个桶里：照常收广播，但不进在线列表。
- `pair` 从 `pairs: Dict[str, Dict]` 变成 `Client.pair` 一个字段，"我进了谁"不再需要另查一张表。
- `sessions` 一份记录同时承担路由（`node` 找宿主）、仲裁（`owner` 判归属）、发号（`index`）。
- 状态文件格式**保持兼容**：仍然是 `{owners, index, claimed, claimant, claimant_primary}`，
  线上 `/data/relay-state.json` 不需要迁移。

## 不变的部分（这次一个字都不动）

- 三条端点与全部信令类型、字段名。
- 数据面 1:N 多播、`VIEWER_JOINED` → `SESSION_SNAPSHOT(cid)` 定向补快照、排队增量顺序。
- 尺寸仲裁（创建端权威、镜像端只锁不抢、异常尺寸丢弃）。
- 归属认领规则（`primary` 优先、只迁移 `claimed` 里的会话）。
- `/healthz` 的输出字段。
- 单文件 `server/relay.py`，不拆包（见 `openspec/project.md` 的约定）。

## 代价

- relay.py 会有一轮大改（约 1074 行整体重排），diff 很大但都是机械替换。
- 为兜住行为，同步补一组针对 relay 状态机的集成测（当前仓库零测试）。
  测试用假 ws 直接驱动 `handle_agent / handle_ctl / handle_data`，
  不需要起服务、不需要端口，可在 CI 里裸跑。

## 落地记录

### 结果

- `server/relay.py`：1074 → 1174 行，仍是单文件。新增 5 个 dataclass，状态从 13 容器 + 4 标量
  收到 **6 容器 + 3 标量**（多出的 `by_ws` 是 `ws → Client` 反查索引，不是新的状态）。
- `Relay.__init__` 里现在只剩这些：

  | 容器 | 键 | 值 |
  | --- | --- | --- |
  | `nodes` | node id | `Node`（宿主进程：ws、名字、平台、最近一次 SESSION_LIST） |
  | `clients` | client id | `Client`（在线表一行：名字、host、pair、conns） |
  | `sessions` | sid | `Session`（token、node、owner、index、cols/rows、claimed） |
  | `channels` | data token | `Channel`（agent 连接、viewers 连接、creator） |
  | `viewers` | cid | `Viewer`（快照回来时按 cid 找连接，纯反查） |
  | `by_ws` | ws | `Client`（收包时反查这是谁，纯索引） |

  标量：`seq` / `default_claimant` / `claimant_primary`。
- 14 个旧容器被这 6 个替代：`ctls`→`by_ws`，`ctl_client`/`ctl_name`/`ctl_host`→`Client` 字段，
  `sid_*` 五本→`Session` 字段，`token_node`→`Channel.node`，`pairs`→`Client.pair`。
- 语义保持：同一 client id 的多条 `/ctl` 合并成一个实体（`Client.conns` 集合），
  最后一条断开才从表里删；匿名连接进 `clients[""]` 桶、照收广播但不进在线列表。
- 状态文件键未变，线上 `/data/relay-state.json` 免迁移。
- 一处小改进：`SESSION_CREATE` 到达时就把 `data_token` 记进 `Session`，不再依赖
  `SESSION_CREATED` / `SESSION_LIST` 回填——数据通道可能要更早被寻址。

### 验证

- `python3.12 -m unittest discover -s tests` → 18 个用例全绿（3.0s）。
  `python3.12 -m py_compile server/relay.py` 通过。
- 端到端冒烟：本地 8801 起新 relay + agent，用脚本走
  `HELLO → SESSION_CREATE → /d/<token> 取快照 → 发按键 → 收回显 → SESSION_CLOSE`，
  结果为 `SESSION_CREATED / 快照 118 字节 / 按下标记原样回传 / SESSION_CLOSED`。
- 同脚本对重构前的 relay（`git show HEAD:server/relay.py`，另起 8802 端口）做 A/B：
  两边结果一致；两边都偶发「新 viewer 首包快照超时」，属重构前就有的时序抖动，
  不是这次引入的（新代码保留 `call_later(2.5, _force_ready)` 兜底，超时后照常放增量）。

### 顺手发现（未在本变更内处理）

- `server/requirements.txt` 锁 `websockets==12.0`，但 `agent/rpty_agent.py` 两处
  `websockets.connect(..., proxy=None)` 的参数是 14+ 才有的：用 12.0 跑 agent 必报
  `create_connection() got an unexpected keyword argument 'proxy'`。
  反过来，12.0 的 `process_request(path, headers)` 签名在 15.x 已经变成连接对象，
  用 15 跑 relay 会在 `/healthz` 上报 `'ServerConnection' object has no attribute 'decode'`。
  也就是说 **agent 与 relay 被钉在了互相矛盾的版本区间**，线上能跑大概是手工装的环境。
  建议单独开一个变更把依赖收敛到同一版本，并让 `process_request` 兼容两种签名。
- 本机默认 `python3`（3.14）无 `websockets`，测试统一用 `python3.12`。
