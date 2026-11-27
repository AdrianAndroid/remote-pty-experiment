# Tasks: add-pty-ws-relay

按阶段推进，每个阶段结束都是可独立验证的状态。

## 1. 仓库与骨架

- [ ] 1.1 `.gitignore`（Python / macOS / 日志 / `.env`）
- [ ] 1.2 目录骨架：`relay/` `agent/` `client/` `web/` `scripts/`
- [ ] 1.3 `requirements.txt`（仅 `websockets`）
- [ ] 1.4 首次提交并推送到远端

## 2. Relay（云主机中继）

- [ ] 2.1 asyncio + `websockets.serve`，监听 `127.0.0.1:8765`
- [ ] 2.2 首帧 `auth` 校验：role / token / version，5 s 超时关闭（1008）
- [ ] 2.3 分角色注册，同角色新连接顶替旧连接（4001）并通知对端 `notice`
- [ ] 2.4 `data` 帧原样转发，不做 json 往返解析
- [ ] 2.5 `resize` 仅 `terminal → agent` 方向转发
- [ ] 2.6 `heartbeat` 处理：不转发，刷新对端存活计时；90 s 无帧判定半开
- [ ] 2.7 协议层 ping：每 20 s，10 s 无 pong 断开
- [ ] 2.8 日志：记录连接、鉴权结果、断开原因；**不记录 data 内容**
- [ ] 2.9 token 从环境变量读取，缺失则拒绝启动

## 3. Agent（公司 Mac）

- [ ] 3.1 `AUTHORIZED=1` 守卫，未设置则打印提示并非零退出
- [ ] 3.2 出站连接 + `auth` 握手 + `auth_ok` 处理
- [ ] 3.3 `forkpty` 拉起 `/bin/zsh -l`（可配置 shell）
- [ ] 3.4 注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`LANG`/`LC_ALL=en_US.UTF-8`
- [ ] 3.5 上行协程：`os.read(master_fd)` → base64 → `data` 帧；单帧 ≤ 64 KB 切分
- [ ] 3.6 下行协程：`data` 帧 → base64 decode → `os.write(master_fd)`
- [ ] 3.7 `resize` 处理：`ioctl(TIOCSWINSZ)` 设置 rows/cols
- [ ] 3.8 `seq` 递增计数；shell 退出时发送 `exit` 帧
- [ ] 3.9 断线重连：指数退避 5/10/30/60 s，重连后重建 PTY
- [ ] 3.10 应用层心跳：每 30 s 发 `heartbeat`

## 4. Terminal v1（网页）

- [ ] 4.1 `web/index.html`：xterm.js 5.x + fitAddon，CDN 引入
- [ ] 4.2 连接与 `auth` 握手，token 从 URL query 或输入框读取
- [ ] 4.3 `onData` → `data` 帧；收帧 → `term.write(Uint8Array)`
- [ ] 4.4 `fitAddon.onResize` → debounce 80 ms → `resize` 帧
- [ ] 4.5 `attachCustomKeyEventHandler` 拦截 `ctrl+w` / `ctrl+t` / `ctrl+n`
- [ ] 4.6 连接状态横幅：连接中 / 已连接 / 重连中 / 对端离线
- [ ] 4.7 指数退避重连，重连后自动发送当前尺寸

## 5. Terminal v2（本地 CLI，可与 4 并行）

- [ ] 5.1 `termios` 进入 raw 模式，退出时恢复原状态（含异常退出）
- [ ] 5.2 `SIGWINCH` 捕获 → 发送 `resize` 帧
- [ ] 5.3 stdin 逐字节读取 → `data` 帧；收帧 → stdout 写原始字节
- [ ] 5.4 `atexit` 与信号处理保证终端状态恢复

## 6. 部署

- [ ] 6.1 nginx `location /ws` 配置（Upgrade 头、`proxy_read_timeout 86400`、`proxy_buffering off`）
- [ ] 6.2 云主机 systemd unit：`remote-pty-relay.service`，`EnvironmentFile=.env`
- [ ] 6.3 公司 Mac launchd plist：`com.remotepty.agent.plist`，`RunAtLoad` + `KeepAlive`
- [ ] 6.4 日志轮转（10 MB 切分）
- [ ] 6.5 `scripts/agent-ctl.sh`：start / stop / status / logs

## 7. 验收

- [ ] 7.1 `ls -la` 彩色与对齐正常
- [ ] 7.2 `vim` 全流程（移动、插入、命令、保存退出）
- [ ] 7.3 `vim` 中 `ctrl+w` + `s` 分屏且不关标签页
- [ ] 7.4 `htop` 刷新正常，拖拽窗口后自适应
- [ ] 7.5 `sudo -v` 密码不回显
- [ ] 7.6 Tab 补全、上下键历史、`ctrl+r`
- [ ] 7.7 `ping -c 3 baidu.com` 中途 `ctrl+c` 可中断
- [ ] 7.8 中文输出无乱码
- [ ] 7.9 断网 5 分钟恢复后自动重连
- [ ] 7.10 公司端 `lsof -i -P | grep LISTEN` 无新增监听端口
- [ ] 7.11 未设 `AUTHORIZED=1` 时 agent 拒绝启动且无网络请求

## 8. 收尾

- [ ] 8.1 `docs/07-roadmap.md` 更新阶段状态
- [ ] 8.2 将本 change 合入 `openspec/specs/pty-relay/`
- [ ] 8.3 提交并推送
