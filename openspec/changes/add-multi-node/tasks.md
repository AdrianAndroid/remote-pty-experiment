# Tasks: add-multi-node

依赖 `make-peers-symmetric` 的结论（角色是通道属性而非连接身份），但**不采用**其密钥/ACL 方案，本期沿用单 token。

## 1. relay：多节点

- [ ] 1.1 `self.agent` → `self.nodes: Dict[str, Node]`，Node 含 `ws` / `name` / `platform` / `last_list`
- [ ] 1.2 `/agent` 接受 `?node=<id>`，缺省回退到 `default`（兼容旧客户端）
- [ ] 1.3 同 `node_id` 重连才顶替旧的；不同 node 独立共存
- [ ] 1.4 宿主首帧 `HELLO` 覆盖注册信息（兼作心跳）
- [ ] 1.5 `SESSION_CREATE` / `SESSION_CLOSE` / `SESSION_RESIZE` 按 `target` 路由，`target` 缺省取唯一在线节点
- [ ] 1.6 目标节点不在线 → `ERROR{code:node_offline}`，不回落到别的节点
- [ ] 1.7 全局 `seq` 分配 `index`，随 `SESSION_CREATED` 回给发起方
- [ ] 1.8 合并视图 `SESSIONS{nodes:[{node,name,online,sessions}]}`，在任一节点列表变化与 ctl 新连上时下发
- [ ] 1.9 healthz 增加 `nodes:{id:{online,sessions}}`，保留 `channels` / `viewers`
- [ ] 1.10 清理死代码：`pair_timeout` 与 `RPty_PAIR_TIMEOUT`

## 2. 宿主进程

- [ ] 2.1 `--node <id>` 参数，默认取 `socket.gethostname()`
- [ ] 2.2 连上 `/agent?node=<id>` 后发 `HELLO{node_id,name,platform}`
- [ ] 2.3 `SESSION_LIST` 每项带 `node_id`
- [ ] 2.4 删除 `Agent.seq`，`index` 改用 relay 回传值；relay 未回时暂用本地占位并在 `SESSION_CREATED` 后修正

## 3. 客户端主进程

- [ ] 3.1 `RemoteSession.node`，`create()` 增加 `target` 参数
- [ ] 3.2 `SESSION_*` 信令带上 `target`
- [ ] 3.3 处理 `NODES` / `SESSIONS`，维护 `nodes` 状态，通过 IPC 推给渲染层
- [ ] 3.4 `syncFromList` 适配合并视图，跨节点 adopt
- [ ] 3.5 本机会话识别：`node === 本机 node_id` 时标记 `local: true`（供 UI 判断可用性）
- [ ] 3.6 `node_offline` 错误上报到对应 Tab

## 4. 客户端渲染层

- [ ] 4.1 「+ 新建终端」：单节点直接建，多节点弹目标选择
- [ ] 4.2 目标选择项：本机 / 各远端节点，显示节点名与在线状态
- [ ] 4.3 本机节点不在线时「本机」置灰，附启动命令提示
- [ ] 4.4 Tab 标记维持：`owned=false` → 「共享」徽标；**不加机器名**
- [ ] 4.5 创建失败（node_offline / agent_offline）在 Tab 上显示错误态

## 5. 验证

- [ ] 5.1 单机回归：只有 mini 一个节点时，行为与 Stage 1 完全一致（不弹窗、编号连续）
- [ ] 5.2 双节点在线：`NODES` 正确，两个节点同时可用
- [ ] 5.3 本机共享：A 在 mini 上建 Tab → B 端出现带「共享」的同一会话，双向输入同步
- [ ] 5.4 对方控制：A 建在 pc 上 → `hostname` 回 `pc` 的主机名
- [ ] 5.5 编号不撞：mini 与 pc 各建一个，编号全局唯一
- [ ] 5.6 节点掉线：杀掉 pc 宿主 → 对应 Tab 错误态，不静默
- [ ] 5.7 本机宿主未启动：客户端启动后「本机」项置灰
- [ ] 5.8 healthz 多节点字段正确

## 6. 归档

- [ ] 6.1 更新 `docs/25-runbook.md`（双节点启动顺序、node_id 冲突排查）
- [ ] 6.2 `docs/27-multi-node.md` 状态改为已实施
- [ ] 6.3 打标签 `stage-2`
