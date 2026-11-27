# 变更：实现 rpty v1（relay + peer + shell PTY）

## Why

设计已收敛（见 `docs/00-summary.md`），环境已实测通过（见 `docs/22-environment-verified.md`），
但仓库里一行代码都没有。本变更产出**第一个能用的版本**：家里连着公司，能跑 `vim`。

## What Changes

| 新增 | 内容 |
| --- | --- |
| `relay/relay.py` | 在线表、DIAL 信令、字节桥接、healthz，约 200 行 |
| `protocol/frames.py` | 帧编解码，纯逻辑，不 import 网络库 |
| `peer/peer.py` | 建连、配对、通道管理、PTY broker |
| `peer/pty.py` | `forkpty` + `loop.add_reader` + `TIOCSWINSZ` |
| `web/index.html` | xterm.js 终端页（单文件） |
| `scripts/smoke_test.py` | 本机双 peer 跑通全流程，不依赖云主机 |
| 部署文件 | `Dockerfile` / `docker-compose.yml` / `Caddyfile` / `supervisord.conf` |

**明确不在本变更内**：E2E 加密、PSK 密码、方向权限、`file` / `forward` 通道、菜单栏壳。这些进 v1.5 / v2。

## Impact

- **协议**：单条 ws。配对前 JSON 信令，配对后二进制帧直通（取代 `docs/15` 的 control/data 双连接）。
- **安全**：v1 只有 wss 单层，**明文窗口期**。仅限自用，不做公开部署，v1.5 补 E2E 后帧头不变。
- **部署**：`docs/21` 的单容器方案。
- **兼容**：不影响现有文档，仅新增代码目录。
