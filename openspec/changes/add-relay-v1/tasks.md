# v1 任务清单

> 状态：**全部未开始**。按组顺序做，每组做完跑一次 `scripts/smoke_test.py`。
> 任何一组改动了协议，先改 `protocol/frames.py` 再动两端。

## 1. 协议层（先做，两端共用）

- [ ] 1.1 定义帧头：`[ver(1)][type(1)][channel(2)][length(4, BE)]`
- [ ] 1.2 实现 `encode(type, channel, payload) -> bytes`
- [ ] 1.3 实现 `decode(buf) -> (frame, rest)`，支持粘包/半包
- [ ] 1.4 定义 type 常量：`HELLO / OPEN / OPEN_OK / OPEN_ERR / DATA / RESIZE / CLOSE / PING`
- [ ] 1.5 channel 方向位：`0x0000-0x7FFF` 主发起方，`0x8000-0xFFFF` 对端
- [ ] 1.6 单元测试：往返编解、超长帧截断、半包拼接
- [ ] 1.7 硬约束：本文件**不得** import `websockets` / `asyncio` / `socket`

## 2. relay 核心

- [ ] 2.1 `Node` / `Pair` 数据结构（node_id、name、pubkey、ws、ip）
- [ ] 2.2 token 校验（query 或 `Authorization: Bearer`）
- [ ] 2.3 `REGISTER`：校验 `sha256(pubkey)[:8] == node_id`，不匹配关 1008
- [ ] 2.4 同名节点顶替（旧的收 4001）
- [ ] 2.5 `LIST` → `ONLINE`（只返回请求者关心的，不做全局广播）
- [ ] 2.6 `DIAL`：离线 → `DIAL_ERR{offline}`；忙 → `busy`；超限 → `rate`
- [ ] 2.7 转发 `INCOMING` 给目标端
- [ ] 2.8 `ACK` → 两边都收 `DIAL_OK{pair_id}`
- [ ] 2.9 `REJ` → 发起方收 `DIAL_ERR`
- [ ] 2.10 配对后切数据态：`pump(a, b)` 双向直通，**不解析 payload**
- [ ] 2.11 断开清理：从 `nodes` / `pairs` 移除，关掉对端
- [ ] 2.12 限流：单 IP 并发 3、全局 20、单 node DIAL 10 次/分
- [ ] 2.13 pending 超时 15 秒清理
- [ ] 2.14 `/healthz` 返回 `{ok, nodes, bridges, uptime}`
- [ ] 2.15 日志只记事件与字节数，**不记内容**

## 3. peer 骨架

- [ ] 3.1 配置加载：`~/.rpty/config.toml`（relay url、token、name）
- [ ] 3.2 身份：生成 X25519 密钥对存 `~/.rpty/identity`（600），`node_id = sha256(pub)[:8]`
- [ ] 3.3 连接 relay，指数退避重连（1s → 30s 封顶）
- [ ] 3.4 `REGISTER` + 保持心跳（30s 发，90s 判死）
- [ ] 3.5 发起 `DIAL`、处理 `INCOMING` / `ACK` / `DIAL_OK`
- [ ] 3.6 配对后切换数据态
- [ ] 3.7 通道管理：`OPEN` / `OPEN_OK` / `CLOSE` 生命周期

## 4. PTY（最容易出坑的一组）

- [ ] 4.1 `os.forkpty()` 拉起登录 shell
- [ ] 4.2 注入环境变量：`TERM=xterm-256color`、`COLORTERM=truecolor`、`LANG=en_US.UTF-8`
- [ ] 4.3 **不用阻塞 `os.read`**，改用 `loop.add_reader(fd, ...)` 读 master fd
- [ ] 4.4 输出 → `DATA` 帧，**全程 bytes，禁止 `decode()/encode()` 往返**
- [ ] 4.5 输入 → `os.write(master_fd, data)`
- [ ] 4.6 `RESIZE` → `fcntl.ioctl(master_fd, TIOCSWINSZ, pack("HHHH", rows, cols, 0, 0))`
- [ ] 4.7 子进程退出 → 发 `CLOSE`，回收 `waitpid`
- [ ] 4.8 验证 `ctrl+C` / `ctrl+Z` / `ctrl+D` 正常
- [ ] 4.9 验证 `vim` 打开、编辑、`:wq` 正常

## 5. 权限（v1 只做最简 ACL）

- [ ] 5.1 `~/.rpty/acl.toml`，默认**空集**
- [ ] 5.2 收到 `OPEN` 时查 ACL，未授权回 `OPEN_ERR{denied}`
- [ ] 5.3 拒绝必须发生在 `forkpty` **之前**
- [ ] 5.4 三种原因区分：`denied` / `need_psk` / `busy`

## 6. Web UI

- [ ] 6.1 本地 HTTP 服务 `127.0.0.1:7700`（只监听 loopback）
- [ ] 6.2 在线列表页（`●` 在线 / `◐` 已连接 / `○` 离线 / `⊘` 未授权）
- [ ] 6.3 xterm.js 5.3.0 + fitAddon 0.8.0（CDN）
- [ ] 6.4 `attachCustomKeyEventHandler` 拦截 `ctrl+w` / `ctrl+t` / `ctrl+n`
- [ ] 6.5 `fitAddon` resize → 80ms debounce → `RESIZE` 帧
- [ ] 6.6 断线重连提示

## 7. 部署

- [ ] 7.1 `Dockerfile`（单容器：python + caddy 二进制 + supervisor）
- [ ] 7.2 `supervisord.conf`（relay priority 10，caddy priority 20）
- [ ] 7.3 `Caddyfile`（`/ctl*` 与 `/d/*` 反代，同容器走 127.0.0.1）
- [ ] 7.4 `docker-compose.yml`（单 service，caddy_data 卷持久化）
- [ ] 7.5 `.env.example`
- [ ] 7.6 nginx / Caddy 反代配置示例（若 443 已被占用）

## 8. 验证（每一组做完就跑）

- [ ] 8.1 `scripts/smoke_test.py`：本机两个假 peer 跑完 REGISTER → LIST → DIAL → ACK → 桥接 → 双向收发
- [ ] 8.2 本机 loopback 端到端：peer A 起 shell，peer B 连上执行 `echo hi`
- [ ] 8.3 跨机端到端：家里 → 公司，跑 `ls` / `vim` / `htop`
- [ ] 8.4 断线重连：kill relay，两端 10 秒内恢复
- [ ] 8.5 窗口缩放：拖动终端大小，`htop` 不花屏
- [ ] 8.6 中文：`ls` 含中文文件名、`cat` 中文文件不乱码
- [ ] 8.7 **EDR 空转 30 分钟**：只连接不传数据，观察进程是否被杀

## 9. 收尾

- [ ] 9.1 README 更新为可运行状态
- [ ] 9.2 记录实测延迟与带宽
- [ ] 9.3 把 v1 的明文窗口期风险写进 README 顶部
