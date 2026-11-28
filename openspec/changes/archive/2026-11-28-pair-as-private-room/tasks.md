# 任务

> P1–P4 全部实现完毕（2026-11-28）。每期的验证方式写在对应小节下面。
> 未做项与原因见文末「已知边界」。

## P1 · 服务端房间与可见域

- [x] `relay.py` 新增 `Room` dataclass：`{id, a, b, state, sessions, created_at}`，`Client.room`、`Session.room`
- [x] 三步握手：`ROOM_INVITE` / `ROOM_ACCEPT` / `ROOM_DECLINE` / `ROOM_OPEN` / `ROOM_CLOSED`
- [x] 排他：任一方已在房间 → 拒绝邀请（含错误码与原因）
- [x] `pairs_summary` 不再广播；配对关系只投给房间成员
- [x] 会话出站消息按可见域过滤：`SESSION_LIST` / `SESSION_CREATED` / `SESSION_CLOSED` / 快照
- [x] 缓存本身仍是一份（`node.last_list`），**在出口处按可见域过滤**；连 `handle_ctl` 里
      "直接把 last_list 甩给新连接"的那条快路径也一起补上（这是最容易漏的一处）
- [x] 30 秒宽限：一方 ws 断 → 房间进入 `half_closed`，重连即恢复，超时才关
- [x] 房间状态随会话一起落盘（`RPTY_STATE_FILE` 加 `rooms` 键），relay 重启不丢房间
- [x] 测试：三客户端 + 一房间，断言房间外的收件箱里从不出现房间内 sid（这是隐私红线）
- [x] 测试：排他、双向同意、宽限期重连、超时关闭

## P1.5 · 三态收敛（渲染层）

- [x] `RoomStatus` 从主进程透传到渲染层，`room` 为 `null` / 有值
- [x] 屏幕分叉改成只看两个东西：`phase`（S1 or not）、`room`（S2 or S3）
- [x] 删掉 `activeNode` / `activeClientId` / `showWorkspace` 这三处本地状态
      （`activeClientId` 整套删除；`privateNode` 只表达「我的终端」，与 `room` 互斥）
- [x] `detached` 降级为"回到 S1 的原因"，只影响连接页文案
- [x] S2 保留「进我自己的桌面」入口（私有域），界面上仍是待配对那一屏

## P2 · 数据面鉴权

- [x] `/d/<token>` 建 viewer 时校验 `client_id ∈ room.members` 或 `session.owner == client_id`
- [x] 未授权返回 4003 并记日志（不要静默断开，否则难排查）
- [x] 测试：拿 token 直连被拒；房间内两人都能同时收字节
- [x] 断线重连时 viewer 重新鉴权（不要缓存上一次的授权）
      实现上每次 `/d` 连接都重新走 `_session_visible`，没有授权缓存

## P3 · 客户端

- [x] `DevicesScreen`：点卡片 = 发起配对邀请；对方弹窗同意/拒绝
- [x] 收到邀请的窗口：弹窗显示"某某请求建立私密会话"，同意 → 进房间
- [x] 房间工作区：左侧标签列 = 房间内全部会话（两边宿主合并）
- [x] `ROOM_CLOSED` → 拆数据连接、清标签列、回列表，提示原因
- [x] 离开房间（关窗 / 点离开）要显式发 `ROOM_LEAVE`，不等 ws 超时
- [x] 单机不进房间的用法保留：自己的桌面、私有会话、标签落盘照旧

## P4 · 下线旁观路径与文档

- [x] `enterDevice` 里"进别人客户端桌面镜像同看"的分支删除
      （`enterDevice` 整条路径被 `openMine` 取代，只进自己的宿主）
- [x] `pairedWith` 那套"已配对"显示改成房间状态（侧栏「通话 X」+「通话中」）
- [x] `docs/10-symmetric-peer.md`、`docs/15-presence-and-pairing.md` 标注同看能力取消
- [x] `docs/12-concept-model.md` 增加术语「房间 room」，并说明私有域 / 房间域两种可见域
- [x] `docs/34-client-identity.md` 的配对描述同步

## 收尾

- [x] `data-plane-one-to-one` 目录里加一行"已被 `pair-as-private-room` 取代，不实施"
- [x] 归档本变更到 `openspec/changes/archive/<日期>-pair-as-private-room/`
- [x] 提交（P1–P4 是否合成一个 commit，提交时再定）

## 验证记录（2026-11-28）

| 层 | 手段 | 结果 |
| --- | --- | --- |
| relay 单测 | `pytest tests/ -q`（35 例，websockets 15.0.1 与 12.0 各一遍） | 全绿 |
| 协议端到端 | `/tmp/rpty-e2e/room_e2e.py`：真 relay + 真 agent + 3 个真 ws 客户端 | 15 项全 PASS |
| 客户端 | 同机两个 profile（demo-a / demo-b）真机走完 邀请 → 同意 → 建房 → 双端看同一终端 → 离开回列表 | 通过 |
| 静态 | `pnpm typecheck`、`pnpm build`、`flake8 --max-line-length=110` | 干净 |

## 已知边界

- **应用层隔离，不是系统隔离**：relay 管理员、宿主机 `ps`/`lsof` 仍能看见房间里有几个 PTY。
  房间保护的是"别的客户端看不到"，不是"服务端看不到"。
- **relay 必须先于老客户端升级**：老客户端发 `CTL_PAIR` 会收到 `pair_removed`，
  等于进不去任何别人的桌面。这份 relay 要么和客户端一起上，要么别单独部署。
- **房间不跨 relay 重启保留终端**：房间本身落盘（`rooms` / `session_room`），
  但重启瞬间正在跑的数据连接会断，重连会重新挂回来。
- **节点卡片上的终端数含房间内会话**（只数量、无 id）：仍是轻微可见性泄露，
  要在 `clients_summary` 里按可见域重算才能消，P3 之后再处理。

## 补充：建房时借用已有终端（同日验收后补）

- [x] `Room.borrowed` 记"借进来的" session_id
- [x] `_open_room` 把两人的私有会话 `room` 指向房间，`owner` 保留
- [x] `_close_room` 对 borrowed 只清 `room` + 收尾数据面，不发 `SESSION_CLOSE`
- [x] `rooms` 落盘带 `borrowed`，重启后仍知道哪些要还
- [x] 测试 3 条：借进来两边都看得见 / 散场归还且不杀 PTY / 房里现开的随房销毁（38 passed）
