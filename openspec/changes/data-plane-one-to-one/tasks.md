# 任务

> 状态：**方案待确认，代码未动。**

## 1. 服务端（relay）

- [ ] `Channel` 从 `viewers: Dict[cid, Viewer]` 收成 `viewer: Optional[Viewer]`
- [ ] 删掉 `cid` 体系：`_next_cid`、`self.viewers` 全局索引、`SESSION_SNAPSHOT` 的 cid 分支
- [ ] agent 字节只发 `channel.viewer`；viewer 按键只发 `channel.agent`
- [ ] 快照前增量仍要排队（挂通道上，上限沿用 `VIEWER_QUEUE_MAX` 改名 `PENDING_MAX`），
      `_force_ready` 2.5s 兜底保留
- [ ] 第二 viewer 进来：同 `client_id` → 顶掉旧的（`4002 replaced`）；不同 `client_id` → 关闭新连接 `4009 busy`
- [ ] `_drop_channel_if_idle` 判据改成 `agent is None and viewer is None`
- [ ] `/healthz` 的 `viewers` 字段改成 0/1（字段名不动，避免监控面板改配置）

## 2. agent

- [ ] `on_viewer_joined`：不再依赖 cid（收到就回快照，cid 原样带回）
- [ ] `SESSION_SNAPSHOT` 不再读 cid 做路由
- [ ] 环形缓冲与背压逻辑不动

## 3. 客户端

- [ ] `relay-client.ts`：数据连接 close code 4009 → `onState(leafId, 'disconnected', '该终端正被 <owner> 占用')`
- [ ] 同 client id 被顶替（4002）→ 提示「已被本机另一个窗口接管」
- [ ] 渲染层：「共享」标签文案改为「不可同时查看」，鼠标悬停给出原因
- [ ] 不改 resize / close 的归属逻辑

## 4. 测试

- [ ] 改写：数据面多播 → 单播；快照定向 → 直发；排队增量顺序；force_ready 兜底
- [ ] 新增：第二个 viewer（不同 client）被 4009 拒绝且原连接不受影响
- [ ] 新增：同 client 重连顶替旧 viewer，画面继续
- [ ] 新增：viewer 断开后通道释放、agent 侧不残留
- [ ] 两个 websockets 版本（12.0 / 15.0.1）都跑通

## 5. 文档与验收

- [ ] `docs/10-symmetric-peer.md`、`docs/15-presence-and-pairing.md` 标注「同看能力已取消」
- [ ] `openspec/specs/pty-relay/spec.md` 把多播要求替换成「数据通道 1:1」
- [ ] 端到端：单客户端开终端 → 断开重连续画面；第二客户端试图同看 → 收到 busy
- [ ] 归档到 `openspec/changes/archive/<日期>-data-plane-one-to-one/`
