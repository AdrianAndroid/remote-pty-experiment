# Tasks: make-peers-symmetric

依赖 `add-pty-ws-relay` 的 P0 协议骨架。本变更在其之上把角色模型改为对称。

## 1. 身份与密钥

- [ ] 1.1 `peer/identity.py`：生成 / 加载 X25519 静态密钥对（`~/.rpty/identity`，权限 600）
- [ ] 1.2 `node_id = SHA256(pubkey)[:8].hex()`，同时提供 32 位短指纹供人工核对
- [ ] 1.3 握手签名：对 `(eph_pub, timestamp, nonce)` 签名，防重放
- [ ] 1.4 `rpty whoami`：打印 name / node_id / 指纹

## 2. ACL

- [ ] 2.1 `peer/acl.py`：`~/.rpty/acl.toml`，结构为 `[peers.<node_id>] name / perms`
- [ ] 2.2 权限位：`shell` / `file` / `forward` / `exec`，默认**空集**
- [ ] 2.3 未在白名单的 DIAL → 直接 `DIAL_ERR{denied}`，不进入握手
- [ ] 2.4 每次 `OPEN` 单独判权，`forward` 额外校验端口白名单
- [ ] 2.5 `rpty allow <node_id> --name X --perm shell,file`
- [ ] 2.6 `rpty revoke <node_id>` / `rpty peers`
- [ ] 2.7 文件热加载（ACL 改完不用重启）

## 3. Rendezvous

- [ ] 3.1 `relay/registry.py`：在线表 `{node_id → conn}`，含 name / proto_version
- [ ] 3.2 `REGISTER` 帧处理，重复 node_id 顶掉旧连接
- [ ] 3.3 `DIAL{target}` 处理：查表 → 转发 `INCOMING{from}` → 等被叫方应答
- [ ] 3.4 桥接：两条 ws 建立后进入纯字节转发模式（只认帧头，不解析 payload）
- [ ] 3.5 一个 relay 支持**多条并发 bridge**
- [ ] 3.6 断开清理：任一方向断开 → 通知另一端 → 清在线表与 bridge
- [ ] 3.7 超时：`DIAL` 30 s 无应答 → `DIAL_ERR{timeout}`

## 4. 协议改造

- [ ] 4.1 channel id 方向位：发起方决定高位，`0x0000-0x7FFF` / `0x8000-0xFFFF`
- [ ] 4.2 `OPEN{channel, kind, params}` → `OPEN_OK{channel}` / `OPEN_ERR{channel, reason}`
- [ ] 4.3 `kind=shell`：宿主 spawn PTY，params 含 `shell` / `cols` / `rows`
- [ ] 4.4 `kind=file`：宿主提供 `list` / `stat` / `get` / `put` 子操作
- [ ] 4.5 `kind=forward`：宿主发起 TCP 连接，params 含 `host` / `port`
- [ ] 4.6 `REVOKE{channel}`：任一端主动撤销，宿主侧清理资源
- [ ] 4.7 删除 `auth.role` 字段，改用 `node_id` + 签名

## 5. Peer 主程序

- [ ] 5.1 `peer/main.py`：一份入口，同时承担宿主与控制方
- [ ] 5.2 `peer/broker.py`：本地会话表（我是宿主的那些）
- [ ] 5.3 `peer/remote.py`：远程会话表（我是控制方的那些）
- [ ] 5.4 同一进程内两个表并存，互不干扰
- [ ] 5.5 `rpty dial <node_id>` / `rpty sessions` / `rpty attach <session>`
- [ ] 5.6 断线重连后自动恢复本地会话（ring buffer 承接），远程会话显示"已断开，重连中"
- [ ] 5.7 删除 `agent/` 与 `client/` 的独立入口

## 6. 网页终端

- [ ] 6.1 支持选择目标节点（下拉：在线 peers）
- [ ] 6.2 由网页发起 `OPEN kind=shell`，而非被动接受
- [ ] 6.3 多 channel 标签页（一个浏览器页面同时看两台机器的 shell）
- [ ] 6.4 断开单 channel 不影响其他 channel

## 7. 安全可见性（不可分期，必须同批交付）

- [ ] 7.1 新 channel 建立时弹本机通知：`{peer} 请求 {kind}`
- [ ] 7.2 菜单栏状态灯显示在线会话数与对端名称
- [ ] 7.3 一键断开全部会话（panic button），断后 60 s 内拒绝新的 DIAL
- [ ] 7.4 日志：每个 channel 的建立 / 关闭时间、对端 node_id、kind（不含内容）
- [ ] 7.5 首次被连时强制人工确认，确认后可"记住此 node"

## 8. 测试

- [ ] 8.1 参数化矩阵：`{A→B, B→A, 并发}` × `{shell, file, forward}`
- [ ] 8.2 channel id 不冲突测试（双向同时开 100 个通道）
- [ ] 8.3 ACL 拒绝路径：未授权 node 的 DIAL、越权 kind
- [ ] 8.4 三节点：A⇄B、A⇄C、B⇄C 同时在线不串线
- [ ] 8.5 桥接中断：一端掉线，另一端收到明确关闭事件而非静默

## 9. 文档与收尾

- [ ] 9.1 `docs/02-architecture.md` §2 标注被 `docs/10-symmetric-peer.md` 取代
- [ ] 9.2 `docs/03-protocol.md` auth 与配对章节同步
- [ ] 9.3 `README.md` 索引加入 08 / 09 / 10
- [ ] 9.4 合入 `openspec/specs/`，归档本 change
- [ ] 9.5 提交并推送
