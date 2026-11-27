# 25 · 运行手册（已上线）

> 本文描述**已经跑起来的那套东西**，不是规划。日期：2026-11-27。

## 一、现在的实际形态

```
MacBook Pro（随身）               阿里云 8.152.204.58             家里 Mac mini
┌──────────────────┐            ┌─────────────────────┐        ┌──────────────────┐
│ rpty.app         │  wss 443   │ openresty (1Panel)  │  wss   │ rpty_agent.py    │
│ Electron + xterm │ ─────────▶ │   ↓ 反代             │ ◀───── │ launchd 常驻      │
│ 左侧标签列 + 终端 │   /ctl     │ rpty-relay:8765     │  /agent│   ↓              │
│                  │   /d/<t>   │   /d/<token> 字节配对 │  /d/.. │ pty.fork() → zsh │
└──────────────────┘            └─────────────────────┘        └──────────────────┘
```

- 客户端**不落本地 PTY**，纯 WebSocket；所有 shell 都跑在 Mac mini 上。
- relay 只做字节配对，不解析终端流，不存会话状态。会话 token 由客户端生成。
- 两端都是**主动出站**，Mac mini 不监听任何端口。

## 二、域名与证书

- 域名：`rpty.zhaojian.xin` → `8.152.204.58`（阿里云 A 记录）
- 证书：Let's Encrypt，`/etc/letsencrypt/live/rpty.zhaojian.xin/`，2027-02-25 到期
- 续期：`certbot renew` 自动跑，deploy hook `/etc/letsencrypt/renewal-hooks/deploy/rpty.sh` 会把证书拷到 openresty 的 `conf/ssl/rpty/` 并 reload
- 签发走 HTTP-01：80 端口那个 nginx 容器把 `/.well-known/acme-challenge/` 转发到 `172.17.0.1:40080`（openresty 上的 acme server）

## 三、relay（云主机）

```bash
cd /opt/1panel/apps/rpty
docker compose ps                 # 应看到 rpty-relay  Up
docker compose logs -f --tail 50  # 排障
docker compose restart            # 重启
```

- 容器名 `rpty-relay`，`network_mode: host`，监听 `127.0.0.1:8765`
- `restart: always`，服务器重启自动回来
- 健康检查：`curl https://rpty.zhaojian.xin/healthz`
  返回 `{"ok":true,"agent":true,"ctl":false,"sessions_opened":N,...}`
- token 在 `/opt/1panel/apps/rpty/.env` 的 `RPty_TOKEN`，两端必须一致

反代配置：`/opt/1panel/www/conf.d/rpty.zhaojian.xin.conf`（443 反代 + WebSocket upgrade + `proxy_read_timeout 3600s`）。

## 四、agent（Mac mini）

已装成 launchd 服务，开机自启、挂了自动拉起：

```bash
launchctl list | grep rpty                       # 看是否在跑
launchctl kickstart -k gui/$(id -u)/xin.zhaojian.rpty-agent   # 重启
launchctl unload ~/Library/LaunchAgents/xin.zhaojian.rpty-agent.plist   # 停
tail -f ~/rpty/agent.log ~/rpty/agent.err.log    # 日志
```

- 代码：`~/rpty`（仓库 clone）
- Python：`~/rpty-venv-test/bin/python`（3.12 + websockets 17）
- plist：`~/Library/LaunchAgents/xin.zhaojian.rpty-agent.plist`（chmod 600，里面带 token）

**已知坑**：launchd 拉起的进程会经 `urllib.getproxies()` 读到 macOS 系统代理（本机 127.0.0.1:7897），websockets 于是尝试走 SOCKS 并报 `requires python-socks`。代码里已用 `proxy=None` 显式绕开，别删。

## 五、客户端（MacBook Pro）

```bash
open /Applications/rpty.app
```

- 配置：`~/Library/Application Support/rpty-desktop/rpty-config.json`（chmod 600）
  内容 `{"url":"wss://rpty.zhaojian.xin","token":"..."}`，首次可在连接页填
- 打包版与开发版共用这个目录（主进程里 `app.setPath('userData', ...)` 固定过）
- 开发态启动：`cd apps/desktop && ./node_modules/.bin/electron .`
- 重新打包：`cd apps/desktop && pnpm pack:mac`，产物 `release/mac-arm64/rpty.app`

快捷键：`⌘T` 新建、`⌘W` 关标签、`⌘1..9` 切标签、`⌘B` 收侧栏。`⌘C` 有选区复制、无选区发 `^C`。

## 六、升级流程

1. MacBook Pro 改代码 → `git push`
2. Mac mini：`cd ~/rpty && git pull && launchctl kickstart -k gui/$(id -u)/xin.zhaojian.rpty-agent`
3. 服务器（改了 relay 时）：把新的 `server/*` 同步到 `/opt/1panel/apps/rpty/`，`docker compose up -d --build`
4. 客户端：`pnpm pack:mac`，把 `release/mac-arm64/rpty.app` 覆盖到 `/Applications/`

## 七、排障对照表

| 现象 | 先看什么 |
| --- | --- |
| 客户端显示"被控端离线" | `curl .../healthz` 里 `agent` 是否为 true；Mac mini 上 `launchctl list \| grep rpty` |
| agent 日志刷 `requires python-socks` | 系统代理被读到，确认 `proxy=None` 还在 |
| 日志里 `ERROR duplicate` | 有旧 agent 进程没死，`pgrep -fl rpty_agent.py` 后 `kill -9` |
| 终端白屏 / 尺寸乱 | 侧栏切到别的标签再切回来触发一次 fit |
| TLS 握手 `unrecognized name` | SNI 没匹配到 server_name，检查 `conf.d` 里的域名拼写 |
| 证书过期告警 | `certbot renew --dry-run`，看 deploy hook 有没有执行 |

## 八、安全边界

- 谁拿到 token 谁就能在这台 Mac mini 上开一个登录 shell，等价于本机密码。
- token 只存在三处：服务器 `.env`、Mac mini 的 plist、MacBook Pro 的 userData，全部 chmod 600。
- relay 只做字节中继，不落盘、不记录内容。
- 后续可选加固：PSK 握手、只有白名单 IP 能连 `/ctl`、会话级一次一密。
