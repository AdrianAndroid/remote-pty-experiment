# 任务

> 方案待你确认。确认后从 P1 开始，每期结束都留一个可点的窗口给你验收。

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

- [ ] `RoomStatus` 从主进程透传到渲染层，`room` 为 `null` / 有值
- [ ] 屏幕分叉改成只看两个东西：`phase`（S1 or not）、`room`（S2 or S3）
- [ ] 删掉 `activeNode` / `activeClientId` / `showWorkspace` 这三处本地状态
- [ ] `detached` 降级为"回到 S1 的原因"，只影响连接页文案
- [ ] S2 保留「进我自己的桌面」入口（私有域），界面上仍是待配对那一屏


## P2 · 数据面鉴权

- [ ] `/d/<token>` 建 viewer 时校验 `client_id ∈ room.members` 或 `session.owner == client_id`
- [ ] 未授权返回 4003 并记日志（不要静默断开，否则难排查）
- [ ] 测试：拿 token 直连被拒；房间内两人都能同时收字节
- [ ] 断线重连时 viewer 重新鉴权（不要缓存上一次的授权）

## P3 · 客户端

- [ ] `DevicesScreen`：点卡片 = 发起配对邀请；对方弹窗同意/拒绝
- [ ] 收到邀请的窗口：弹窗显示"某某请求建立私密会话"，同意 → 进房间
- [ ] 房间工作区：左侧标签列 = 房间内全部会话（两边宿主合并）
- [ ] `ROOM_CLOSED` → 拆数据连接、清标签列、回列表，提示原因
- [ ] 离开房间（关窗 / 点离开）要显式发 `ROOM_LEAVE`，不等 ws 超时
- [ ] 单机不进房间的用法保留：自己的桌面、私有会话、标签落盘照旧

## P4 · 下线旁观路径与文档

- [ ] `enterDevice` 里"进别人客户端桌面镜像同看"的分支删除
- [ ] `pairedWith` 那套"已配对"显示改成房间状态
- [ ] `docs/10-symmetric-peer.md`、`docs/15-presence-and-pairing.md` 标注同看能力取消
- [ ] `docs/12-concept-model.md` 增加术语「房间 room」，并说明私有域 / 房间域两种可见域
- [ ] `docs/34-client-identity.md` 的配对描述同步

## 收尾

- [ ] `data-plane-one-to-one` 目录里加一行"已被 `pair-as-private-room` 取代，不实施"
- [ ] 归档本变更到 `openspec/changes/archive/<日期>-pair-as-private-room/`
- [ ] 提交（P1–P4 是否合成一个 commit，提交时再定）
