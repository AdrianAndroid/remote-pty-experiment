# Proposal: add-pty-ws-relay

## Why

需要一个在家访问公司 Mac CLI 的通道，但公司 Mac 上 `frpc` 一启动即被终端安全软件终止，SSH 反向转发也需要公司端开启监听端口且属 EDR 重点关注行为。

因此需要一条**不依赖 SSH、不引入外部隧道二进制、两端零监听**的方案：两端都只向云主机发起标准 `wss://` 出站连接，云主机按角色配对并透传字节，agent 端分配真实 PTY 运行登录 shell。

## What Changes

新增三个组件与一份协议，构成从零到可用的完整链路：

- **新增** `relay/relay.py`：WebSocket 中继服务，负责鉴权、单例配对、字节透传、对端在线状态通知。仅监听 `127.0.0.1:8765`。
- **新增** `agent/agent_mac.py`：公司 Mac 端，出站连接 relay，`forkpty` 拉起登录 shell，PTY 字节与 ws 帧互转，支持 `resize` 与自动重连。
- **新增** `client/term_mac.py`：家 Mac 本地 CLI 客户端（v2 形态），raw 模式接管 stdin/stdout。
- **新增** `web/index.html`：浏览器终端（v1 主形态），xterm.js 渲染 + 组合键拦截。
- **新增** 帧协议 v1：`auth` / `auth_ok` / `auth_err` / `data` / `resize` / `heartbeat` / `exit` / `notice` / `clipboard`(占位)。
- **新增** 部署产物：nginx `location /ws` 配置、systemd unit（云主机）、launchd plist（公司 Mac）。
- **新增** `scripts/agent-ctl.sh`：agent 启停与状态自检。

不新增任何外部依赖二进制；Python 侧仅依赖 `websockets`。

## Impact

### 受影响的规格
- `pty-relay`（新建）：双向字节通道、真实 PTY、尺寸同步、鉴权配对、断线恢复、保活、零监听、合规确认位、组合键处理。

### 受影响的代码
全部为新增，无存量代码。目录：`relay/`、`agent/`、`client/`、`web/`、`scripts/`。

### 运维影响
- 云主机需新增 nginx location 与 systemd unit，443 已有站点不受影响（同域名新路径）。
- 公司 Mac 新增 launchd 常驻项与一个日志文件。
- 新增两个密钥（`AGENT_TOKEN`、`TERM_TOKEN`）需要保管与轮换。

### 风险与缓解
- 公司网关对长连接审计 → 心跳 + 按需启停，不长期常驻。
- 公司机无法安装 `websockets` → 退化路径：vendored 单文件。
- 规格细节见 `docs/06-risks.md`。

### 不在本次范围内
- 多会话（`session_id`）与多终端并发
- 剪贴板互通（仅保留帧类型占位）
- 会话持久化（用远端 `tmux` 替代）
- mTLS（v1 用双 token）
