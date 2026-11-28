# Project Context

## Purpose

在异地两台 Mac 之间建立一条**不依赖 SSH、不依赖反向代理、两端零监听端口**的交互式终端通道，用于在家操作远端 Mac 的真实 PTY。

核心动机：公司 Mac 上 `frpc` 一启动即被终端安全软件终止，传统的端口转发与隧道方案全部被封。因此把通道退化为标准 WSS 网页流量——两端只做出站连接，由公网中继完成配对，中继本身不承载任何业务语义。

## Tech Stack

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 传输 | WebSocket over TLS（`wss://`，443） | 与普通网页流量无异 |
| Relay（云主机） | Python 3.10.12 / `websockets==12.0` / asyncio | 单进程，监听 `127.0.0.1:8765`，由 1Panel-openresty 暴露 |
| 客户端（两端同一份） | Electron 45 / TypeScript 5.9 / React 19 / `@xterm/xterm` 6 / `node-pty` 1.1 | 主进程持有 PTY 与 WS，渲染进程只做显示 |
| 反代与证书 | 1Panel-openresty（`network_mode: host`）+ Let's Encrypt | 443 已被占用，复用现有 OpenResty |
| 部署 | Docker（`network_mode: host`，`mem_limit: 256m`）+ 源码 bind mount | 统一到 1Panel 的容器列表 |
| 包管理 | pnpm 11 / Node 22 | 仅客户端 |

不使用：SSH 转发、frp / frps、chisel、nps、tailscale、zerotier、ttyd、gotty、ngrok 等任何外部隧道/组网二进制，也不使用 Caddy。

## Project Conventions

### 代码风格
- Python 单文件 `server/relay.py`，`asyncio` + 类型标注，不做包化（降低部署与排障成本）。
- 不引入需要编译的 Python 依赖；纯 Python，保证 Intel 与 Apple Silicon 通用。
- TypeScript 严格模式，`contextIsolation: true`、`nodeIntegration: false`，渲染进程不直接接触 Node。
- 界面文案一律中文，代码标识符一律英文。

### 协议约定
- **控制信道** `/ctl`：JSON 文本帧，只承载信令（REGISTER / LIST / DIAL / INCOMING / ACK / REJ / PING）。
- **数据信道** `/d/<session_token>`：二进制帧，每个终端一条独立连接。
- 全链路**禁止**对终端字节做 `decode`/`encode` 往返（会切裂多字节 UTF-8）。
- relay **不解析**二进制帧体，只按 token 把两条连接配对成字节管道。
- 首帧必须完成身份声明，5 秒超时关闭。

### 安全约定
- token 从环境变量读取，绝不硬编码进仓库。
- relay 只监听回环地址 `127.0.0.1`。
- 日志默认不记录数据帧内容。
- 客户端首启需用户确认"允许被连接"，作为合规确认位。

### 目录结构约定
```
apps/desktop/   Electron 客户端（两端同一份）
server/         relay（Python 单文件 + Dockerfile + compose）
scripts/        发布与运维脚本
docs/           方案文档
openspec/       需求规格与变更
```

## Domain Context

- 两端 Mac 芯片可能不同（Intel / Apple Silicon），客户端产物须为 universal 或分别分发。
- 公司网络对出站 443 放行，对隧道路由与异常长连接有审计。
- 云主机为阿里云 ECS（Ubuntu 22.04 / 2 vCPU / 小内存），除 relay 外还跑着几个无关容器与一个前端服务，内存是唯一紧张资源。真值见 `ops/local.md`（不入库）。
- 443 已由 1Panel-openresty 持有，新服务须以独立 vhost 接入，不得占用 frps 的 50000–59999 端口池。

## Important Constraints

1. **零监听端口（两端）**：客户端不得开启任何监听端口，只能出站。
2. **零陌生二进制**：不得引入外部下载的隧道/组网程序。
3. **必须真实 PTY**：不能退化为"执行命令回传输出"，否则 `vim`/`htop` 不可用。
4. **禁止 frp**：不得以 frp / frps / 端口映射作为连通手段，含临时验证与调试。
5. **发布不依赖 SSH 入站**：日常发布走「服务器拉 GitHub Release + 签名校验 + 软链切换」，引导与救援走 1Panel 面板或阿里云控制台 VNC。
6. **合规前置**：真实部署前须确认公司 IT 政策。

## External Dependencies

- 云主机：公网 IP、443、1Panel-openresty、Docker、Python 3.10
- 域名 `relay.example.com` 及其 Let's Encrypt 证书（自动续期）
- 公司 Mac：能出站 443，能运行未签名/已签名 Electron 应用
- 家 Mac：同客户端

## Change Workflow

任何需求**先建 OpenSpec 变更**（`openspec/changes/<change-id>/`），再实施。变更至少包含 `proposal.md` 与 `tasks.md`，实现完成后归档到 `openspec/specs/`。
