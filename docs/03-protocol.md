# 03 · WebSocket 帧协议

URI：`wss://<domain>/ws`
传输：文本帧，内容为 UTF-8 JSON。二进制数据统一 base64 承载。

---

## 1. 设计要点

1. **控制帧与数据帧分离**：`data` 只装终端字节，`resize` / `clipboard` / `heartbeat` 各自独立，互不解析对方的载荷。
2. **字节无损**：PTY 输出可能在 UTF-8 多字节字符中间被切断，因此 `data.payload` 一律 base64，绝不在传输层做 `decode/encode`。
3. **首帧强制鉴权**：连接建立后第一帧必须是 `auth`，超时 5 秒未收到则服务端关闭连接（code 1008）。
4. **role 决定路由**：relay 不解析 `data`，只按来源 role 把帧推给对端。

---

## 2. 帧类型总表

| type | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `auth` | C → S | role, token, version, meta | 首帧鉴权 |
| `auth_ok` | S → C | role, peer_online | 鉴权通过 |
| `auth_err` | S → C | reason | 鉴权失败，随后关闭 |
| `data` | A ↔ T | payload(base64) | PTY 原始字节流，双向透传 |
| `resize` | T → A | cols, rows | 终端尺寸同步 |
| `heartbeat` | 双向 | ts | 应用层心跳（协议层 ping 之外的兜底） |
| `clipboard` | A ↔ T | direction, text | 剪贴板互通（v2，可选） |
| `exit` | A → T | code | 远端 shell 退出 |
| `notice` | S → 双向 | level, text | 服务端提示（对端离线等） |

> `A` = agent（公司 Mac），`T` = terminal（家 Mac），`S` = relay（云主机）。

---

## 3. 帧定义

### 3.1 auth

```json
{
  "type": "auth",
  "role": "agent",
  "token": "<TOKEN>",
  "version": 1,
  "meta": {
    "hostname": "company-mac-mini",
    "shell": "/bin/zsh",
    "term": "xterm-256color"
  }
}
```

```json
{
  "type": "auth",
  "role": "terminal",
  "token": "<TOKEN>",
  "version": 1,
  "meta": { "cols": 120, "rows": 32, "term": "xterm-256color" }
}
```

校验规则：

- `role` ∈ {`agent`, `terminal`}
- `token` 必须与对应角色的密钥一致（两个角色两个密钥，互不通用）
- `version` 不等于 1 → `auth_err: unsupported_version`

### 3.2 auth_ok

```json
{ "type": "auth_ok", "role": "agent", "peer_online": false, "server_time": 1732700000 }
```

`peer_online` 告知当前对端是否已在线上。Agent 若收到 `peer_online: true`，应立即触发一次 `resize`（用默认 120×32）以初始化 PTY 尺寸。

### 3.3 auth_err

```json
{ "type": "auth_err", "reason": "bad_token" }
```

`reason` 取值：`bad_token` / `bad_role` / `unsupported_version` / `agent_busy` / `duplicate_role`。

发送后服务端以 code `1008` 关闭连接。

### 3.4 data

```json
{ "type": "data", "seq": 1024, "payload": "G1sySjsxSOS9oOWlve+8jOS4lueVjA==" }
```

- `payload`：base64 编码的原始字节，UTF-8 安全。
- `seq`：单调递增序号，仅用于日志排查与丢帧检测，**不参与重传**。
- 单帧上限：**64 KB 原始字节**（base64 后约 87 KB）。超出则 agent 端切分。
- 不允许空 payload。

### 3.5 resize

```json
{ "type": "resize", "cols": 152, "rows": 43 }
```

- 方向：`terminal → agent`（单向）
- agent 收到后调用 `pty.setwinsize(rows, cols)`，内核自动向 `zsh` 发 `SIGWINCH`
- 限流：**最小间隔 80 ms**，快速拖动窗口时只发最后一次（前端 debounce）
- 合法范围：`cols ∈ [20, 500]`、`rows ∈ [5, 200]`，越界则 clamp 不做报错

### 3.6 heartbeat

```json
{ "type": "heartbeat", "ts": 1732700012 }
```

双层保活：

| 层 | 机制 | 参数 |
| --- | --- | --- |
| 协议层 | WebSocket ping/pong | 服务端每 20 s ping，10 s 无 pong 断开 |
| 应用层 | `heartbeat` 帧 | 两端每 30 s 发一次，90 s 未收到对端帧则主动重连 |

应用层心跳的作用是穿透那些会「吞掉 ping 帧但不转发」的中间代理。

### 3.7 clipboard（v2）

```json
{ "type": "clipboard", "direction": "to_remote", "text": "pbcopy 的内容" }
```

- `direction`: `to_remote`（家 → 公司 Mac 剪贴板）/ `to_local`（公司 → 家）
- agent 端 `to_remote` 落地为 `pbcopy`，`to_local` 由 `pbpaste` 轮询或 OSC 52 触发
- v1 不实现，仅保留类型占位

### 3.8 exit

```json
{ "type": "exit", "code": 0 }
```

远端 shell 退出后由 agent 发送，terminal 端应显示提示并停止接收输入。

### 3.9 notice

```json
{ "type": "notice", "level": "warn", "text": "agent 尚未上线，输入已缓存" }
```

`level` ∈ {`info`, `warn`, `error`}。

---

## 4. 连接状态机

### 4.1 Agent

```
IDLE
 └─ connect wss ──▶ CONNECTING
                      ├─ 超时/失败 ──▶ 退避(5s→10s→30s, 上限60s) ──▶ CONNECTING
                      └─ 成功 ──▶ AUTH_SENT
                                    ├─ auth_err ──▶ CLOSED → 退避重连
                                    └─ auth_ok ──▶ SPAWN_PTY
                                                    └─ RUNNING
                                                        ├─ ws 关闭 ──▶ 杀 PTY ──▶ 退避重连
                                                        └─ shell 退出 ──▶ 发 exit ──▶ 杀 PTY ──▶ 重连
```

### 4.2 Terminal

```
IDLE → connect → AUTH_SENT → auth_ok → RUNNING
                                  ↑          │
                                  └── 重连 ◀──┘（断线后指数退避，UI 显示"重连中"）
```

### 4.3 Relay

```
每个连接:
  CONNECTED ──(5s 内无 auth)──▶ CLOSE(1008)
      │
   auth 校验
      ├─ 失败 ──▶ auth_err ──▶ CLOSE(1008)
      └─ 成功 ──▶ 注册到 agent_ws / terminal_ws
                    ├─ 同名 role 已存在 ──▶ 踢掉旧连接（新连接优先）
                    └─ 循环转发 ──▶ 断开时清空引用 + 给对端发 notice
```

---

## 5. 转发规则（relay 核心逻辑）

```python
async for raw in ws:
    msg = json.loads(raw)          # 只为读 type / 鉴权，data 载荷原样转发
    t = msg["type"]

    if t == "data":
        target = terminal_ws if ws is agent_ws else agent_ws
        if target: await target.send(raw)     # 原样转发，不重编码
        continue

    if t == "resize":
        if agent_ws: await agent_ws.send(raw)

    if t == "heartbeat":
        # 不转发，relay 自己刷新对端存活计时
        ...
```

要点：
- `data` 帧**原样转发原始字符串**，不做 `json.loads` → `dumps` 往返，避免任何潜在编码改动。
- `resize` 只在 `terminal → agent` 方向有效，反向到达的丢弃。
- 对端不在线时：`data` 帧**丢弃并回 notice**（v1 不缓存；v2 可加 64 KB 环形缓冲）。

---

## 6. 环境变量与 PTY 初始化参数

agent 端 spawn shell 时必须注入：

```python
env = os.environ.copy()
env["TERM"] = "xterm-256color"
env["COLORTERM"] = "truecolor"
env["LANG"] = "en_US.UTF-8"
env["LC_ALL"] = "en_US.UTF-8"
```

漏掉 `TERM` → `vim` 报 `E558: Terminal entry not found`；漏掉 `COLORTERM` → 配色退化为 256 色。

初始尺寸：`120 × 32`，收到第一帧 `resize` 后覆盖。

---

## 7. 错误码约定

| WS close code | 含义 |
| --- | --- |
| 1000 | 正常关闭 |
| 1008 | 鉴权失败 / 策略拒绝 |
| 1011 | 服务端内部错误 |
| 4000 | token 过期（预留） |
| 4001 | 同名 role 被新连接顶替 |
