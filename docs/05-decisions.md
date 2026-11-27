# 05 · 技术选型决策记录（ADR）

每条记录：背景 → 选项 → 决策 → 后果。新增决策请追加编号，不要改写历史结论。

---

## ADR-001 · 传输层用 WebSocket 而不是 SSH / frp

**背景**：公司 Mac 上 `frpc` 一启动即被终端安全软件 kill，证明拦截发生在进程/二进制特征层。

**选项**
- A. `ssh -R` 反向隧道：零开发，但需要公司端 sshd，且 `-R` 是 EDR 重点检测行为
- B. frp / chisel / nps：已实测被 kill
- C. 自研 WebSocket 中继

**决策**：C。

**理由**：WSS 是标准 443 网页流量；两端零监听；进程是 `python3` 而非特征化二进制。

**后果**：需要自己实现鉴权、配对、重连、resize、心跳；代码量约 600 行。

---

## ADR-002 · 数据帧用 base64 JSON，不用二进制帧

**选项**
- A. WebSocket binary frame + 1 字节头
- B. JSON 文本帧 + base64 payload

**决策**：B。

**理由**：
1. 全链路单一 JSON 解析路径，debug 时可直接 `wscat` 肉眼读帧。
2. 浏览器端 `xterm.write()` 接受 `Uint8Array`，base64 解码成本可忽略。
3. 体积膨胀 33%，但终端流量本身极小（打字与 ANSI 刷新），实测不构成瓶颈。

**后果**：单帧载荷上限 64 KB 原始字节；超长输出需要 agent 侧切分。

---

## ADR-003 · Agent 端用 Python，不用 Go / Rust / Swift

**背景**：两台 Mac 芯片不同（Intel Mac mini + Apple Silicon MacBook Pro）。

**选项**
- A. Go 单二进制（需 `GOOS=darwin GOARCH=amd64/arm64` 各编一份）
- B. Python 脚本 + `websockets`
- C. Swift（需 Xcode 各架构编译）

**决策**：B。

**理由**：纯 Python 无架构相关产物，一份脚本两机通吃；迭代快；`pty` / `termios` 标准库直接可用。

**后果**：目标机需要 Python 3.9+ 与 `websockets` 包。若公司机禁止装 pip 包，则退化为「vendored 单文件」（把 `websockets` 源码内联，仍然通过启动）。这是已知风险点，见 `06-risks.md` R-03。

---

## ADR-004 · PTY 用 `os.forkpty()`，不用 `ptyprocess`

**背景**：`ptyprocess` 上手快，但对作业控制（`ctrl+z` / `fg` / `bg`）支持弱。

**决策**：v1 先用 `ptyprocess` 快速打通链路；v2 换成 `os.forkpty()` 原生实现。

**理由**：分阶段降低一次性调试成本；两条路对上层协议无差异，替换只影响 agent 内部。

**后果**：v1 文档需明确「`ctrl+z` 可能异常」。

---

## ADR-005 · Terminal 端优先做网页版

**选项**
- A. xterm.js 网页终端
- B. 本地 raw 模式 CLI 客户端（`termios` + `SIGWINCH`）

**决策**：v1 用 A，v2 补 B。

**理由**：xterm.js 的 VT 序列兼容性最完整，resize 事件原生可用，不需要处理本地 `termios` 保存/恢复与 `SIGWINCH` 捕获。代价是浏览器组合键劫持，用 `attachCustomKeyEventHandler` 解决。

---

## ADR-006 · Relay 单例配对，不做多会话（v1）

**决策**：全局一个 `agent` + 一个 `terminal`，同 role 新连接顶掉旧连接。

**理由**：个人使用场景，多会话收益低、状态管理复杂度高。

**后果**：需要多会话时用 `tmux` 在远端解决，比在协议层做多路复用便宜得多。

---

## ADR-007 · 断线重连采用指数退避

**参数**：`5s → 10s → 30s → 60s`（上限 60 s），成功后重置。

**理由**：避免公司网络抖动时 agent 高频重连形成可识别的周期性流量特征。

---

## ADR-008 · 认证用双 token + 未来上 mTLS

**v1**：`AGENT_TOKEN` / `TERM_TOKEN` 两组独立随机串，从环境变量读，不硬编码。
**v2**：客户端证书（mTLS），nginx 层做校验，防 token 泄漏。

**理由**：token 方案零成本可上线；泄露风险通过「两端 token 不同 + relay 侧限流」缓解。

---

## ADR-009 · 不引入任何外部隧道二进制（硬约束）

**决策**：任何需要下载运行的隧道/组网程序（frp / chisel / nps / tailscale / zerotier / ttyd / gotty / ngrok）**一律不采用**，即使短期看起来更省事。

**理由**：`frpc` 已被实测 kill，同类产品特征库覆盖度高，试错成本高且会产生安全告警记录。

**后果**：所有能力必须自研或复用系统自带组件。
