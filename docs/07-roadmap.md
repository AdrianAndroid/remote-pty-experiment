# 07 · 里程碑与迭代计划

原则：**每一阶段结束都必须是一个能自己验证的可用状态**，不做"一次写完再调试"。

---

## M0 · 方案定型（当前阶段）

产出：文档 + 协议 + OpenSpec 变更。

- [x] 背景与方案演进记录 → `docs/01-background.md`
- [x] 架构与部署形态 → `docs/02-architecture.md`
- [x] WebSocket 帧协议定稿 → `docs/03-protocol.md`
- [x] 能力边界与验收清单 → `docs/04-capability-matrix.md`
- [x] 技术选型决策 → `docs/05-decisions.md`
- [x] 风险与合规 → `docs/06-risks.md`
- [ ] OpenSpec 变更 `add-pty-ws-relay` 提案定稿
- [ ] 仓库初始化 git + 首次提交

**验证**：文档能回答「为什么不用 SSH」「resize 怎么做」「什么时候该放弃」三个问题。

---

## M1 · 最小链路打通（行模式，无 PTY 交互）

目标：证明**两端 → 云主机 → 双向字节流**这条路能走通，先不管终端体验。

范围：
- `relay/relay.py`：鉴权、配对、`data` 帧转发（约 120 行）
- `agent/agent_mac.py`：连 wss，收到 `data` 就 `subprocess.run` 执行，输出回传（**此阶段先不用 PTY**）
- `client/term_mac.py`：本地读 stdin → 发帧；收帧 → 打印

验证：
```bash
# 家端输入
echo "hello from home"   → 公司端执行 echo，回显到本终端
```

**已知局限**：`cd` 不保持、无颜色、无交互程序。这是**故意**的，只为验证通道。

---

## M2 · 换 PTY，做完整交互

范围：
- agent 端改 `ptyprocess`（或直接 `os.forkpty`）拉起 `/bin/zsh -l`
- 注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`LANG=en_US.UTF-8`
- 实现 `data` 帧 base64 编解码，全链路零文本转换
- 实现 `resize` 帧 → `setwinsize()`

验证：`vim`、`htop`、`sudo` 密码输入、Tab 补全全部正常。

---

## M3 · 网页终端（正式可用形态）

范围：
- `web/index.html`：xterm.js 5.x + fitAddon
- `attachCustomKeyEventHandler` 拦截 `ctrl+w` / `ctrl+t` / `ctrl+n`
- 断线重连 UI（顶部横幅「重连中…」）
- 连接状态、显示当前对端主机名

验证：`docs/04-capability-matrix.md` §4 验收清单前 8 项全过。

---

## M4 · 常驻与稳定性

范围：
- `agent/com.remotepty.agent.plist`：launchd 开机自启 + 崩溃重启
- 指数退避重连（5→10→30→60 s）
- 应用层心跳（30 s）+ 协议层 ping（20 s）
- 日志轮转（`~/Library/Logs/remotepty-agent.log`，按 10 MB 切）
- 云主机 `systemd` unit

验证：拔网线 10 分钟再插回，无需人工干预自动恢复；重启电脑后自动上线。

---

## M5 · 体验补齐

- [ ] `tmux` 会话保持（agent 端 spawn `tmux new -A -s main`）
- [ ] 剪贴板互通（`clipboard` 帧 + `pbpaste` / OSC 52）
- [ ] 本地 raw 终端客户端（`term_mac.py` 完整版，含 `termios` 与 `SIGWINCH`）
- [ ] 作业控制（`ctrl+z` / `fg` / `bg`），前提是已切 `forkpty`
- [ ] 连接白名单 / IP 限制
- [ ] 一键启停脚本（`scripts/agent-ctl.sh`）

---

## 里程碑依赖

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5
                │
                └── 也可并行：M2 完成后即可先做本地客户端，网页端稍后
```

M1 到 M2 是**最大的一次认知跳跃**（从"执行命令"变成"持有 tty"），建议 M1 验证完立刻做 M2，不要在中途加功能。

---

## 待讨论的开放问题

标记为需要在下一次讨论中定夺的点：

1. **agent 是否常驻**：常驻方便但增加暴露时长与告警概率；按需启动（如定时任务唤醒）更隐蔽但体验差。倾向：工作日白天常驻，其余时间停。
2. **relay 放哪台机器**：现有云主机是否已有 443 占用；域名与证书是否复用。
3. **是否需要多终端同时连**（比如家里两台设备）：决定是否 v1 就做 `session_id`。
4. **日志级别**：默认 INFO 是否够排查，是否需要可开关的帧级 DEBUG（可能记录敏感内容，默认必须关）。
5. **失败降级方案**：wss 长期不通时的 Plan B 是回到不依赖通道的本地工作流，还是申请公司 VPN。

---

## 时间预期（粗略）

| 阶段 | 工作量 |
| --- | --- |
| M1 | 半天 |
| M2 | 1 天（PTY 与 resize 调试为主） |
| M3 | 1 天（前端与键位） |
| M4 | 半天 |
| M5 | 按需，可持续迭代 |

真正的时间成本不在编码，在**公司网络环境下的反复验证**。
