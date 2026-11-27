# remote-pty-experiment

在异地两台 Mac 之间，通过 WebSocket 中继实现交互式终端访问的实验仓库。

不用 SSH、不用 frp、不用 chisel，两端都只向云主机主动发起 `wss://` 出站连接，云主机只做**字节透传中继**。

> 一句话：把 SSH 的 `本地 tty ↔ 加密通道 ↔ 远端 pty` 模型，换成 `浏览器/本地终端 ↔ WSS ↔ 云中继 ↔ WSS ↔ 远端 pty`。

---

## 为什么做这个

公司 Mac 上跑 `frpc` 会被终端安全软件直接 kill，`frp` 这条路已经验证不可用。约束是：

| 约束 | 说明 |
| --- | --- |
| 不能跑隧道类二进制 | `frpc` / `chisel` / `tunnels` 一类特征明显，启动即被杀 |
| 两端都是 Mac | Intel Mac mini + Apple Silicon MacBook Pro，需要跨芯片通用 |
| 两端都能访问云主机 | 都有出站能力，这是方案成立的基础 |
| 目标是交互式 CLI | 不是批量跑命令，要能用 `vim`、`htop`、`top` |

结论：把"通道"退化成正常的 HTTPS/WSS 网页流量，把"程序"退化成脚本或自编译产物，把"端口暴露"彻底取消（两端都不监听端口）。

---

## 架构

```
 ┌──────────────────┐         ┌────────────────────────┐         ┌──────────────────┐
 │   家 Mac (终端端)  │         │        云主机            │         │   公司 Mac (Agent) │
 │                  │         │                        │         │                  │
 │  xterm.js 网页    │  wss    │   nginx :443  (TLS)    │  wss    │  agent_mac.py    │
 │  或 本地 raw 客户端│ ──────▶ │        ↓               │ ◀────── │        ↓         │
 │                  │  443    │  relay.py :8765        │  443    │  PTY (zsh/bash)  │
 │  键盘/显示        │ ◀────── │   ┌─ 按 role 配对 ─┐   │ ──────▶ │   vim/htop/...   │
 └──────────────────┘         │   └─ 字节透传 ─────┘   │         └──────────────────┘
                              └────────────────────────┘
```

- **Agent 端（公司 Mac）**：出站连 `wss`，本地 `forkpty` 拉起登录 shell，PTY 输出 → ws，ws 输入 → PTY。
- **Relay（云主机）**：一个 `agent` 连接 + 一个 `terminal` 连接，按 role 配对，只转发不解析数据帧内容。
- **Terminal 端（家 Mac）**：xterm.js 网页终端，或本地 raw 终端客户端。
- **没有监听端口**：公司 Mac 不开放 22，不开放任何本地端口；只做出站。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/01-background.md](docs/01-background.md) | 问题背景、方案演进全过程（frp → ssh 反向隧道 → webhook → WebSocket） |
| [docs/02-architecture.md](docs/02-architecture.md) | 架构、数据流、进程模型、部署形态 |
| [docs/03-protocol.md](docs/03-protocol.md) | WebSocket 帧协议定义（auth / data / resize / clipboard / heartbeat） |
| [docs/04-capability-matrix.md](docs/04-capability-matrix.md) | 哪些 CLI 能正常用、哪些有坑、验收标准 |
| [docs/05-decisions.md](docs/05-decisions.md) | 技术选型决策记录（ADR） |
| [docs/06-risks.md](docs/06-risks.md) | 风险、合规边界、故障排查 |
| [docs/07-roadmap.md](docs/07-roadmap.md) | 里程碑与迭代计划 |
| [openspec/](openspec/) | 需求规格与变更（本项目所有功能变更必须先立 OpenSpec change） |

---

## 快速开始（待实现）

```bash
# 云主机
pip install websockets
python3 relay.py --port 8765

# 公司 Mac（Agent）
pip install websockets
python3 agent_mac.py --url wss://your.domain/ws --token <AGENT_TOKEN>

# 家 Mac（Terminal）
python3 term_mac.py --url wss://your.domain/ws --token <TERM_TOKEN>
# 或浏览器打开 web/index.html
```

> 代码目录尚未创建，当前仓库处于**方案定型阶段**，先落文档、协议与 OpenSpec 变更，再进入编码。

---

## 目录规划（目标形态）

```
remote-pty-experiment/
├── README.md
├── docs/                     # 方案文档
├── openspec/                 # 需求规格与变更
├── relay/                    # 云主机中继服务
│   └── relay.py
├── agent/                    # 公司 Mac 端
│   ├── agent_mac.py
│   └── com.remotepty.agent.plist   # launchd 常驻
├── client/                   # 家 Mac 本地终端客户端
│   └── term_mac.py
├── web/                      # 浏览器终端
│   └── index.html
└── scripts/                  # 部署与自检脚本
```

---

## 状态

- [x] 方案调研与可行性验证（frp 已证实不可用）
- [x] 架构与协议定稿
- [ ] OpenSpec 变更 `add-pty-ws-relay` 实施
- [ ] 最小可运行链路（行模式打通）
- [ ] PTY + resize 完整交互
- [ ] 浏览器终端
- [ ] launchd 常驻 + 自动重连

---

## 合规提示

本仓库实现的是**远程控制公司办公设备**的能力。在真实部署前，需确认所在公司 IT 政策是否允许此类远程访问；文档中以 `AUTHORIZED=1` 环境变量作为显式确认开关（详见 [docs/06-risks.md](docs/06-risks.md)）。
