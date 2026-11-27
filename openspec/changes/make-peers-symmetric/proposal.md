# Proposal: make-peers-symmetric

## Why

当前设计固定了两个角色：`agent`（公司 Mac，提供 PTY）与 `terminal`（家 Mac，消费 PTY）。这个划分是从 SSH 的 client/server 模型继承来的，但本方案的传输模型里两端都只是"向 relay 出站连接的客户端"，**在协议层没有任何理由不对称**。

保留固定角色带来三个实际问题：

1. 需要维护两份入口程序（`agent_mac.py` / `term_mac.py`），部署时容易装错；
2. 公司机无法主动访问家里资源（取文件、跑家里的模型、查环境），只能单向；
3. 扩展到三节点（家里 MacBook + Mac mini + 公司 Mac）时，N×N 的组合无法用固定角色表达。

因此把角色从"连接的身份"降级为"通道的属性"，让任意两端可以双向、并发地互相开通道。

## What Changes

### 协议
- **BREAKING** `auth` 帧：`role` 字段移除，改为 `node_id` + 私钥签名挑战
- **BREAKING** 配对模型：从"relay 按角色槽位配对"改为 `REGISTER` + `DIAL` 信令 + 在线表
- **BREAKING** channel id：高 1 位标记发起方方向，`0x0000-0x7FFF` / `0x8000-0xFFFF`
- **新增** `OPEN` / `OPEN_OK` / `OPEN_ERR` / `REVOKE` 帧：通道按需创建，双向都可发起
- **新增** `REGISTER` / `DIAL` / `INCOMING` / `DIAL_OK` / `DIAL_ERR` 帧
- **新增** `kind` 语义：`shell` / `file` / `forward` / `exec`

### 身份与权限
- **新增** 每节点 X25519 静态密钥对；`node_id = SHA256(pubkey)[:8].hex()`
- **新增** ACL 白名单：按 `node_id` 授予细粒度权限（`shell` / `file` / `forward`）
- **移除** 双 token 方案（`AGENT_TOKEN` / `TERM_TOKEN`）
- **新增** 首次配对走 out-of-band（终端显示指纹 + `rpty allow <node_id>`）

### 代码结构
- **合并** `agent/` + `client/` 为统一的 `peer/`，同一进程内同时维护"我是宿主"与"我是控制方"两张会话表
- **新增** `peer/broker.py`（本地会话）、`peer/remote.py`（远程会话）、`peer/acl.py`

### 运维
- **新增** 菜单栏能力：在线会话数状态灯、新 channel 通知、一键断开全部会话
- **新增** CLI 子命令：`rpty allow` / `rpty revoke` / `rpty peers` / `rpty sessions`

## Impact

### 受影响的规格
- `pty-relay`：所有涉及"角色"的 Requirement 需要重写为"对等节点"
- 新增 `peer-identity`：身份、密钥、指纹
- 新增 `peer-acl`：授权模型
- 新增 `channel-lifecycle`：通道建立、撤销、方向位

### 受影响的代码
- `protocol/`：帧类型表扩展、channel id 方向位、OPEN 状态机
- `relay/`：从"配对器"改为"在线表 + DIAL 信令 + 桥接"
- `agent/` + `client/`：合并为 `peer/`
- `web/`：需支持发起 OPEN（不只是被动连）

### 受影响的文档
- `docs/02-architecture.md` 角色定义（§2）被取代
- `docs/03-protocol.md` auth 与配对模型被取代
- 新增 `docs/10-symmetric-peer.md` 作为主设计

### 迁移影响
项目尚无生产部署，**无向后兼容负担**，可以一次性切换到对称模型，不需要版本过渡期。

### 风险
- **安全面扩大**：任意被 ACL 授权的节点可连入本机。必须在同一变更内交付 ACL + 通知 + 一键断开，不可分期。
- **测试矩阵翻倍**：方向 × 通道类型组合，必须参数化测试，否则易出现 channel id 冲突类 bug。
- **工作量 +1 天**（rendezvous 与 ACL）。

### 不在本次范围内
- 共享终端（多控制方同时 attach）
- 节点中继链（A → B → C 转发）
- 会话迁移（把运行中会话从一台机器搬到另一台）
- WebRTC 直连打洞
