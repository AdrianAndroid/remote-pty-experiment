# 02 · 架构

---

## 1. 拓扑

```
┌────────────────────────┐        ┌──────────────────────────────┐        ┌────────────────────────┐
│  家 Mac · Terminal 端    │        │      云主机 · Relay 端          │        │  公司 Mac · Agent 端     │
│                        │        │                              │        │                        │
│  ┌──────────────────┐  │        │  ┌────────────────────────┐  │        │  ┌──────────────────┐  │
│  │ web/index.html   │  │  wss   │  │ nginx :443  TLS 终结    │  │  wss   │  │ agent_mac.py     │  │
│  │ (xterm.js 5.x)   │──┼───────▶│  │        ↓ proxy_pass    │──┼───────▶│  │   ↓              │  │
│  └──────────────────┘  │  443   │  │ relay.py :8765 asyncio  │  │  443   │  │ forkpty("zsh -l") │  │
│          或            │        │  │   ┌──────────────────┐  │  │        │  │   ↓              │  │
│  ┌──────────────────┐  │        │  │   │ agent ⇄ terminal │  │  │        │  │  master fd ⇄ slave│  │
│  │ client/term_mac  │  │        │  │   │   字节透传路由     │  │  │        │  │     ↓            │  │
│  │ (raw 终端)        │◀─┼────────│  │   └──────────────────┘  │  │        │  │  /bin/zsh (tty)  │  │
│  └──────────────────┘  │        │  └────────────────────────┘  │        │  └──────────────────┘  │
└────────────────────────┘        └──────────────────────────────┘        └────────────────────────┘
        只出站                              公网入口                                只出站
```

三条不可违反的约束：

- 公司 Mac **不监听任何端口**（sshd 保持现状，但方案不依赖它）
- 家 Mac **不监听任何端口**
- 两端都只有**出站 TCP 443**

---

## 2. 角色定义

| 角色 | 运行位置 | 职责 | 连接方向 |
| --- | --- | --- | --- |
| `agent` | 公司 Mac | 持有 PTY，执行 shell，回传输出 | 出站连接 relay |
| `terminal` | 家 Mac | 采集键盘输入，渲染输出 | 出站连接 relay |
| `relay` | 云主机 | 鉴权、配对、字节转发、心跳 | 监听 8765（仅本机，由 nginx 暴露） |

配对规则：**全局单例**，一个 `agent` + 一个 `terminal`。多会话（`session_id`）放到 v2。

---

## 3. 数据流

### 3.1 键盘输入 → 远端执行

```
用户按 a
  → xterm.js onData("\x61")
  → ws.send({type:"data", data:"YQ=="})
  → relay 转发给 agent
  → agent base64 decode → os.write(pty_master_fd, b"a")
  → zsh 收到字符，回显到 PTY master
```

### 3.2 远端输出 → 家端渲染

```
vim 刷新屏幕
  → 写入 PTY master（含 ANSI 转义序列 \x1b[...）
  → agent os.read(pty_master_fd) 得到原始字节
  → ws.send({type:"data", data:"G1sySjs..."})
  → relay 转发给 terminal
  → xterm.js term.write(decoded) → 渲染出完整界面
```

> 关键：**中途不做任何文本解码/重编码**。PTY 输出可能在多字节 UTF-8 字符中间被切断，如果中途 `decode().encode()` 会破坏字节。因此 data 帧统一 base64 承载原始字节。

### 3.3 窗口尺寸同步

```
用户拖动浏览器窗口
  → xterm fitAddon 计算 cols/rows
  → ws.send({type:"resize", cols:152, rows:43})
  → relay 转发给 agent
  → agent pty.setwinsize(rows, cols)  → 内核发 SIGWINCH
  → vim / htop 收到 SIGWINCH，重新排版
  → 新屏幕内容通过 data 帧回传
```

---

## 4. 进程模型

### 4.1 Agent 端

```
agent_mac.py (单进程)
 ├─ asyncio event loop
 ├─ 协程 A: ws.recv() → os.write(master_fd)        # 下行
 ├─ 协程 B: os.read(master_fd) → ws.send()         # 上行（在 executor 中阻塞读）
 └─ 子进程: /bin/zsh -l   （forkpty 产生，挂在 slave fd 上）
```

重连策略：ws 断开 → 杀掉旧 PTY（可选保留）→ 5 秒后重连 → 新建 PTY。v1 不保留会话（重连即新 shell）。

### 4.2 Relay 端

```
relay.py (单进程, asyncio)
 ├─ websockets.serve(handler, 127.0.0.1, 8765)
 ├─ 全局: agent_ws, terminal_ws
 └─ 每个连接一个 handler 协程：鉴权 → 存引用 → 循环转发 → 清理引用
```

单实例内存态，无需数据库。重启 relay 会导致两端都断线，各自重连后自动恢复配对。

### 4.3 Terminal 端

两种形态，二选一：

| 形态 | 优点 | 缺点 |
| --- | --- | --- |
| `web/index.html`（xterm.js） | 渲染最稳、resize 天然、无需依赖环境 | 浏览器劫持部分组合键，需 `attachCustomKeyEventHandler` |
| `client/term_mac.py`（raw 终端） | iTerm 原生体验、本地快捷键可用 | 需手动 `termios` 进 raw 模式 + 捕获 `SIGWINCH` |

v1 以网页端为主，本地客户端为 v2。

---

## 5. 部署形态

### 5.1 云主机

```
/etc/nginx/conf.d/remote-pty.conf   →  443 TLS + Upgrade 转发
relay.py                             →  systemd 常驻, 只听 127.0.0.1:8765
.env                                 →  AGENT_TOKEN / TERM_TOKEN
```

nginx 关键配置：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

### 5.2 公司 Mac

```
~/Library/LaunchAgents/com.remotepty.agent.plist   →  launchd 开机自启
日志: ~/Library/Logs/remotepty-agent.log
```

### 5.3 家 Mac

浏览器打开 `https://your.domain/`，或本地运行 `python3 client/term_mac.py`。

---

## 6. 为什么不用隧道 / 不用 SSH

| 维度 | SSH `-R` | frp | 本方案 |
| --- | --- | --- | --- |
| 公司端是否监听端口 | 需要 22 | 否 | **否** |
| 是否需要下载二进制 | 否 | 是（已被 kill） | **否（纯 Python 脚本）** |
| 出站协议 | SSH | 自定义/WS | **标准 WSS** |
| 交互式 PTY | ✅ | ✅ | ✅ |
| 需要自己写代码 | 几乎不用 | 配置 | 需要 |

代价明确：**用开发量换隐蔽性与可控性**。
