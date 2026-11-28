# 装一个包就完整：客户端自带宿主

## 为什么

现在 ctl（窗口）和 agent（宿主）是两个进程、两次安装：deb / .app 只带 ctl，
机器装完在别人列表里是「宿主未上线」，卡片灰着点不动。自己用都要补装 python agent，
发给朋友更不可能成立 —— 他们不会去装 python3 + websockets + 写 systemd unit。

目标：**装一个安装包 → 控制端和宿主都在**，装上就能被连、也能连别人。

## 改了什么（设计）

### 1. 宿主用 Node 重写，作为 app 的子进程

`agent/rpty_agent.py`（746 行）的职责：连 relay 当 agent、开 PTY、转发读写/尺寸/关闭、
在 `~/.rpty/agents/` 写注册文件供 ctl 认领。这些在 Node 里都能做，且随 app 一起打包签名，
不需要目标机装任何解释器。

- 新包：`apps/desktop/src/agent/`（main 侧），用 `node-pty` 开 PTY；
- 协议与 `server/relay.py` 对齐，逐条对齐 python 版的 HELLO / OPEN / DATA / RESIZE / CLOSE / EXIT；
- 仍写 `~/.rpty/agents/<node>.json` + `.sock`，ctl 的 `askLocalAgent()` 逻辑不变，
  多开时老的优先（`started_at` 升序）这条语义照搬。

### 2. 生命周期由主进程管

- app ready → fork sidecar（独立子进程，别绑在 renderer 上）；
- 窗口全关 → 一起退出（保持现有「关窗即下线」语义）；
- sidecar 崩溃 → 指数退避重启，连续 N 次失败后状态里显示原因，不再死循环；
- 设置里加开关「这台机器提供终端」，关掉就不起 sidecar，只当纯控制端。

### 3. 打包

- macOS：`x64` 与 `arm64` 分开出包（node-pty 是原生模块，universal 要先按两架构 rebuild 再 lipo，
  先不做，省得把简单事搞复杂），文件名带架构；
- Linux：deb 里不含 python 依赖，`depends` 里去掉 python 相关项；
- Windows：本期不做，ConPTY 走 node-pty 理论可行，单独排期。

### 4. 分发给朋友

macOS 没有 Developer ID 证书 + 公证时，朋友首次打开会被 Gatekeeper 拦。
本期做法：文档写清「右键 → 打开」或 `xattr -dr com.apple.quarantine /Applications/rpty.app`；
若拿到 Developer ID，再加 `notarize` 配置，本期不改流程。

## 验证

- 新机器只装一个包：`healthz` 里出现该机器的 node，别人列表里卡片可点、能开终端；
- 只开窗口不启用宿主：卡片显示「宿主未上线」，与今天一致；
- 同一机器开两个窗口只起一个 sidecar（注册文件唯一）；
- sidecar 被杀后自动回来，房间内终端断开有 EXIT 状态而不是假死；
- macOS 关闭窗口后 relay 上该客户端与 node 一起消失，不留僵尸；
- Linux deb 在干净容器里 `dpkg -i` 后不装任何额外包即可上线。

## 边界

- 不做「一个进程多身份」：sidecar 仍是独立进程、独立连接，只是随包分发、由 app 托管。
- 不做跨机迁移会话：PTY 仍在本机，进程死了终端就没了（与今天一致）。
