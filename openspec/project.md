# Project Context

## Purpose

在异地两台 Mac 之间建立一条**不依赖 SSH、不依赖隧道二进制、两端零监听端口**的交互式终端通道，用于在家访问公司 Mac 的 CLI。

核心动机：公司 Mac 上 `frpc` 一启动即被终端安全软件终止，传统的端口转发与隧道方案全部被封。因此把通道退化为标准 WSS 网页流量，把程序退化为纯 Python 脚本，用开发量换取隐蔽性与可控性。

## Tech Stack

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 传输 | WebSocket over TLS（`wss://`，443） | 与普通网页流量无异 |
| Relay（云主机） | Python 3.9+ / `websockets` / asyncio | 单进程，只监听 `127.0.0.1:8765`，由 nginx 暴露 |
| Agent（公司 Mac） | Python 3.9+ / `websockets` / `pty` | `forkpty` 拉起登录 shell |
| Terminal（家 Mac） | xterm.js 5.x（网页）/ Python（本地 CLI） | 二选一 |
| 部署 | nginx + systemd（云）/ launchd（Mac） | |

不使用：SSH 转发、frp、chisel、nps、tailscale、zerotier、ttyd、gotty、ngrok 等任何外部隧道/组网二进制。

## Project Conventions

### 代码风格
- Python 一律 `asyncio` + 类型标注，单文件可独立运行，不做包化（降低公司机部署成本）。
- 不使用需要编译的依赖；纯 Python，保证 Intel 与 Apple Silicon 通用。
- 前端单文件 `web/index.html`，依赖走 CDN，不引入构建工具。

### 协议约定
- WebSocket 一律文本帧 + JSON；二进制数据用 base64 承载。
- 全链路**禁止**对终端字节做 `decode`/`encode` 往返（会切裂多字节 UTF-8）。
- 首帧必须 `auth`，5 秒超时关闭。

### 安全约定
- token 从环境变量读取，绝不硬编码进仓库。
- relay 只监听回环地址。
- 日志默认不记录 `data` 帧内容。
- agent 启动需 `AUTHORIZED=1`，作为合规确认位。

### 目录结构约定
```
relay/     云主机中继
agent/     公司 Mac 端
client/    家 Mac 本地 CLI 客户端
web/       浏览器终端
scripts/   部署与自检脚本
docs/      方案文档
openspec/  需求规格与变更
```

## Domain Context

- 两台 Mac 芯片不同（Intel / Apple Silicon），因此避免任何架构相关的编译产物。
- 公司网络对出站 443 放行，对隧道路由与异常长连接有审计。
- 家端通过云主机访问，非同一内网。
- 用户已有 Terraform/部署习惯：云主机侧组件优先 systemd，不引入 Docker（减少一层排障成本）。

## Important Constraints

1. **零监听端口**：两端不得开启任何监听端口。
2. **零陌生二进制**：不得引入外部下载的隧道/组网程序。
3. **必须真实 PTY**：不能退化为"执行命令回传输出"，否则 `vim`/`htop` 不可用。
4. **合规前置**：真实部署前须确认公司 IT 政策。

## External Dependencies

- 云主机：公网 IP、可用 443、nginx、systemd、Python 3.9+
- 域名与 TLS 证书（可用现有证书或 Let's Encrypt）
- 公司 Mac：Python 3.9+、`websockets` 包（若无法安装，走 vendored 单文件退化路径）
- 家 Mac：现代浏览器（支持 WebSocket）
