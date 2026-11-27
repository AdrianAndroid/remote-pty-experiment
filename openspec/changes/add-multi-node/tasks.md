# Tasks: add-multi-node

依赖 `make-peers-symmetric` 的结论（角色是通道属性而非连接身份），但**不采用**其密钥/ACL 方案，本期沿用单 token。

## 1. relay：多节点

- [x] 1.1 `self.agent` → `self.nodes: Dict[str, Node]`，Node 含 `ws` / `name` / `platform` / `last_list`
- [x] 1.2 `/agent` 接受 `?node=<id>`，缺省回退到 `default`（兼容旧客户端）
- [x] 1.3 同 `node_id` 重连才顶替旧的；不同 node 独立共存
- [x] 1.4 宿主首帧 `HELLO` 覆盖注册信息（兼作心跳）
- [x] 1.5 `SESSION_CREATE` / `SESSION_CLOSE` / `SESSION_RESIZE` 按 `target` 路由，`target` 缺省取唯一在线节点
- [x] 1.6 目标节点不在线 → `ERROR{code:node_offline}`，不回落到别的节点
- [x] 1.7 全局 `seq` 分配 `index`，随 `SESSION_CREATED` 回给发起方
- [x] 1.8 合并视图 `SESSIONS{nodes:[{node,name,online,sessions}]}`，在任一节点列表变化与 ctl 新连上时下发
- [x] 1.9 healthz 增加 `nodes:{id:{online,sessions}}`，保留 `channels` / `viewers`
- [x] 1.10 清理死代码：`pair_timeout` 与 `RPty_PAIR_TIMEOUT`

## 2. 宿主进程

- [x] 2.1 `--node <id>` 参数，默认取 `socket.gethostname()`
- [x] 2.2 连上 `/agent?node=<id>` 后发 `HELLO{node_id,name,platform}`
- [x] 2.3 `SESSION_LIST` 每项带 `node_id`
- [x] 2.4 删除 `Agent.seq`，`index` 改用 relay 回传值；relay 未回时暂用本地占位并在 `SESSION_CREATED` 后修正

## 3. 客户端主进程

- [x] 3.1 `RemoteSession.node`，`create()` 增加 `target` 参数
- [x] 3.2 `SESSION_*` 信令带上 `target`
- [x] 3.3 处理 `NODES` / `SESSIONS`，维护 `nodes` 状态，通过 IPC 推给渲染层
- [x] 3.4 `syncFromList` 适配合并视图，跨节点 adopt
- [x] 3.5 本机会话识别：`node === 本机 node_id` 时标记 `local: true`（供 UI 判断可用性）
- [x] 3.6 `node_offline` 错误上报到对应 Tab

## 4. 客户端渲染层

- [x] 4.1 「+ 新建终端」：单节点直接建，多节点弹目标选择
- [x] 4.2 目标选择项：本机 / 各远端节点，显示节点名与在线状态
- [x] 4.3 本机节点不在线时「本机」置灰，附启动命令提示
- [x] 4.4 Tab 标记维持：`owned=false` → 「共享」徽标；**不加机器名**
- [x] 4.5 创建失败（node_offline / agent_offline）在 Tab 上显示错误态

## 5. 验证

- [ ] 5.1 单机回归：只有 mini 一个节点时，行为与 Stage 1 完全一致（不弹窗、编号连续）
- [x] 5.2 双节点在线：`NODES` 正确，两个节点同时可用
- [ ] 5.3 本机共享：A 在 mini 上建 Tab → B 端出现带「共享」的同一会话，双向输入同步
- [x] 5.4 对方控制：A 建在 pc 上 → `hostname` 回 `pc` 的主机名
- [x] 5.5 编号不撞：mini 与 pc 各建一个，编号全局唯一
- [ ] 5.6 节点掉线：杀掉 pc 宿主 → 对应 Tab 错误态，不静默
- [ ] 5.7 本机宿主未启动：客户端启动后「本机」项置灰
- [x] 5.8 healthz 多节点字段正确

## 6. 归档

- [ ] 6.1 更新 `docs/25-runbook.md`（双节点启动顺序、node_id 冲突排查）
- [ ] 6.2 `docs/27-multi-node.md` 状态改为已实施
- [ ] 6.3 打标签 `stage-2`

## 7. 实施记录（2026-11-27）

已跑通的：

- 双节点同时在线（Mac mini + 台式机 `192.168.2.2`）
- A 端在台式机上开终端 → `hostname` 回 `zhaojian`、`uname -s` 回 `Linux`
- B 端在 Mac mini 上开终端 → `hostname` 回 `zhoajiandeMac-mini.local`、`uname -s` 回 `Darwin`
- 两端镜像同一会话，编号全局唯一

实施中修掉的问题：

1. 老版本宿主进程的 data_url 不带 node → 数据通道不知道该找谁要快照，画面全空。
   改为 relay 用 `token → node` 反查，再退到「唯一在线节点」。
2. `SESSION_CREATED` 后主进程没更新自己的 `session.state`（只通知了渲染层），
   导致节点掉线时判不到「会话真的断了」。
3. relay 重启后 `seq` 归零，新会话从 1 开始和旧会话撞号。
   改为分配前从各节点的 `SESSION_LIST` 里捞回最大编号；客户端 resync 也延后 900ms，
   等各节点先上报。
4. 宿主进程可能仍按自己的旧计数上报 index。relay 广播列表时强制覆盖为权威值。

5. 客户端重连时会把自建的会话再补发一遍 `SESSION_CREATE`，relay 当时照着又发了一次新号，
   于是同一个终端在 A 窗口是「终端 10」、在 B 窗口是「终端 20」。
   现在 relay 只在第一次见到某个 session_id 时发号，之后一律沿用。
   客户端还会缓存首次拿到的号，所以修完得把两端都重启一次才会对齐。

待办：Mac mini 上的宿主进程还是老代码（未带 `--node`），当前显示为 `default` 节点。
重启后才会显示正确名称，重启会断开该进程下所有 PTY。
