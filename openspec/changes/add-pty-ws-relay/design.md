# Design: add-pty-ws-relay

技术决策的浓缩版。完整推理见 `docs/03-protocol.md` 与 `docs/05-decisions.md`。

## 架构决策

### D1 · 云主机做纯字节中继，不做任何逻辑

```
agent ──wss──▶ relay ──▶ terminal
terminal ──wss──▶ relay ──▶ agent
```

relay 只做四件事：鉴权、按 role 存引用、把 `data` 原样推给对端、发对端在线状态。

**为什么不在 relay 做会话管理**：relay 越"笨"，故障面越小、重启代价越低。所有终端语义（PTY、shell、会话）都在 agent 侧，relay 崩了重启即可，两端各自重连恢复。

**代价**：relay 是单点。用 systemd 自动拉起 + 两端自动重连覆盖，不做多副本（个人场景不需要）。

### D2 · data 帧一律 base64

因为 PTY `read()` 的边界**不等同于字符边界**。一个 3 字节的 UTF-8 中文，可能第 1 字节在上一次 read、后 2 字节在下一次 read。任何中间层的 `decode()` 都会抛错或产生替换符。

方案：`os.read()` 拿到 `bytes` → `base64.b64encode` → JSON 安全字符串 → 家端 `base64.b64decode` → `Uint8Array` → `term.write()`。

**全链路零文本转换**，这是"中文不乱码、`cat` 大文件不丢字节"的根本原因。

### D3 · 控制帧独立，不塞进 data 流

若把 `resize` 塞进终端字节流（比如约定 `\x1b[...` 私有序列），会与远端程序的转义序列冲突——远端可能恰好输出同样的字节。

因此协议层分两类帧：`data` 只走终端字节，`resize` / `clipboard` / `heartbeat` 走结构化 JSON。relay 按 `type` 分流，互不污染。

### D4 · Agent 用 forkpty 而非 ptyprocess（终态）

`ptyprocess` 的 `PtyProcess` 在 macOS 上对进程组与作业控制支持不完整，`ctrl+z` 容易把 shell 挂死。

终态实现：

```python
pid, master_fd = os.forkpty()
if pid == 0:
    os.execvpe(shell, [shell, "-l"], env)   # 子进程：登录 shell
# 父进程持有 master_fd，读写即终端 I/O
```

子进程拿到的是真正的 controlling tty，作业控制信号链完整。

M2 阶段允许先用 `ptyprocess` 快速验证，但合入前必须切到 `forkpty`（见 ADR-004）。

### D5 · 尺寸同步走 ioctl，不重启 PTY

```python
import fcntl, termios, struct
fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
```

内核看到窗口尺寸变化后，自动向前台进程组发 `SIGWINCH`。`vim` / `htop` 收到信号后重绘，整个过程不需要重启进程、不需要重连。

前端配合：`fitAddon` 的 resize 事件做 80 ms debounce，避免拖拽时产生几十个 `resize` 帧。

### D6 · 双 token，角色隔离

两个独立随机密钥，分别对应 `agent` 与 `terminal`：

- 泄漏 `TERM_TOKEN` → 只能作为终端连上，无法冒充公司端抢占配对
- 泄漏 `AGENT_TOKEN` → 风险较高（可冒充 agent），因此 agent token 不写进任何前端代码，只存在公司机环境变量里

v2 上 mTLS，把鉴权从应用层下移到 nginx。

### D7 · 心跳双层

| 层 | 参数 | 解决什么 |
| --- | --- | --- |
| WS ping/pong | 20 s / 10 s 超时 | 标准层存活检测，库自带 |
| 应用 heartbeat | 30 s 发 / 90 s 判死 | 穿透会吞 ping 但不转发数据的代理 |

只做 WS ping 不够：某些企业网关会终止 ping/pong 但保持数据连接，看起来连接活着，实际不通。应用层心跳解决这个"半开"状态。

### D8 · 断线重连保留 PTY 还是重建

v1：**重建**。断开即杀 PTY，重连后新 shell。

理由：保留 PTY 需要考虑孤儿进程、fd 泄漏、shell 状态不一致，复杂度高。

替代：agent 端 spawn `tmux new -A -s main`，把"会话保持"的职责交给 tmux，重连自动 attach 回原会话。用成熟工具解决，而不是自己造。

## 关键实现要点

### PTY 读写不能阻塞事件循环

`os.read(master_fd, n)` 在没有输出时会阻塞，直接放在协程里会卡死整个 loop。

```python
data = await loop.run_in_executor(None, os.read, master_fd, 65536)
```

或者用 `loop.add_reader(master_fd, callback)` + `asyncio.Queue`，性能更好（不需要线程池）。推荐后者。

### shell 退出要先发 exit 帧再断开

子进程 `waitpid` 返回后，先 `ws.send({"type":"exit","code":...})`，再关 ws。否则家端只会看到一次无来由的断开，误以为是网络问题触发重连。

### 组合键拦截必须在 xterm 层

```js
term.attachCustomKeyEventHandler((e) => {
  if (e.ctrlKey && ['w','t','n'].includes(e.key.toLowerCase())) {
    // 返回 false 表示不交给浏览器，xterm 会把键码写进 onData
    return true;   // true = 由 xterm 处理并转发
  }
  return true;
});
```

注意：`attachCustomKeyEventHandler` 的返回值语义是"是否允许 xterm 继续处理该事件"。返回 `false` 会让事件继续冒泡给浏览器，所以要**阻止浏览器行为**需要 `e.preventDefault()` + 返回 `true`。

### 合规守卫在最前

```python
if os.environ.get("AUTHORIZED") != "1":
    print("remote-pty-agent: 未设置 AUTHORIZED=1，表示尚未获得公司授权，拒绝启动。")
    sys.exit(2)
```

放在所有 import 与网络调用之前，保证未授权时**不产生任何网络流量**。
