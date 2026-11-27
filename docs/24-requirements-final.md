# 24 · 需求定稿

> 状态：需求已定稿，技术选型已收敛，代码未开始。
> 本文是唯一口径，与其它文档冲突时以本文为准。
> 决策过程见 `00-summary.md`，环境实测见 `22`，发布通道见 `23`。

---

## 1. 一句话

在两台 NAT 后的 Mac 之间，不依赖 SSH、不依赖反向代理，通过一个公网 WSS 中继，让一端能操作另一端**真实的 PTY**，支持多终端并行，手感接近本地终端。

---

## 2. 痛点与目标

**痛点**：公司机的 sshd 装不上，`frpc` 一启动就被终止，`ssh -R` 要求一端有公网 IP。现有所有远程终端方案都假设"某端可被入站连接"。

**目标**：把"可被连接"这件事从机器上剥离，交给一个双方都只是**出站**访问的云中继。中继只做配对和转发字节，不理解业务。

**副产品**：两端跑完全相同的程序，没有客户端/服务端的角色之分。

---

## 3. 六条硬约束

| # | 约束 | 来源 | 违反后果 |
| --- | --- | --- | --- |
| 1 | 不用 SSH 作为产品通道 | 立项前提 | 方案不成立 |
| 2 | 不用 frp / frps / 任何端口映射 | 用户明确 | frpc 在公司机被杀 |
| 3 | 不用 Tailscale / ZeroTier 等覆盖网络 | 早期否决 | 公司机装不上 |
| 4 | 两端都不开放入站端口 | 架构原则 | 违反公司安全策略 |
| 5 | 发布与运维不依赖 SSH 入站 | 本轮新增 | 原则漏口 |
| 6 | 任何新增功能必须带界面上可直接点到的入口 | 用户既有规则 | 功能等于没做 |

---

## 4. 拓扑

```
┌──────────── 家里 Mac mini（被连端 / 宿主）────────────┐
│  Electron 窗口（可关，关了 shell 也不死）              │
│        ↕ IPC / contextBridge                          │
│  Main 进程 ── node-pty ── zsh -l                      │
│        │  sessions: Map<id, PtySession + ring buffer>  │
│        ↕ WSS 出站（443）                               │
└───────────────────────┬───────────────────────────────┘
                        │
              ┌─────────▼──────────┐
              │ 8.152.204.58        │
              │ 1Panel-openresty    │  TLS 终结 / SNI 分流
              │        ↓ 127.0.0.1:8765
              │ relay (Docker/host) │  只配对、只转发字节
              └─────────▲──────────┘
                        │
┌───────────────────────┴───────────────────────────────┐
│ 公司 MacBook Pro（发起端 / 控制端）                    │
│  xterm.js ← IPC ← Main ← WSS                          │
└───────────────────────────────────────────────────────┘
```

两端程序完全一致。谁先发起谁就是控制端。

---

## 5. 客户端

### 5.1 技术栈

| 项 | 版本 | 备注 |
| --- | --- | --- |
| Electron | 45.5.0 | orca 用 43.7.8，取当前稳定 |
| electron-vite | 6.0.0 | main / preload / renderer 三段式 |
| Vite | 8.4.0 | |
| React | 19.3.1 | |
| TypeScript | 5.9.3 | |
| @xterm/xterm | 6.0.0 | |
| addon-fit / webgl / unicode11 / web-links | 0.11.0 / 0.19.0 / 0.9.0 / 0.12.0 | 四个够用 |
| node-pty | 1.1.0 | 需 `electron-rebuild` |
| pnpm / Node | 11.24.0 / 22.23.2 | |
| Electron 镜像 | `electron_mirror=https://npmmirror.com/mirrors/electron/` | 国内网络必需 |

### 5.2 进程职责

- **main**：持有 PTY、持有 WSS、持有 ring buffer。窗口只是视图。
- **preload**：只暴露 `RptyBridge`（create / write / resize / dispose / onData / onExit / onError）。`contextIsolation: true`、`nodeIntegration: false`。
- **renderer**：xterm 渲染 + UI，不碰 Node。

关窗口不杀 shell；退出应用才结束全部会话。

### 5.3 多会话模型

```
Workspace
└── Device（v1 只有一个）
    └── Session[]
        ├── id           本地 leaf id（UUID，稳定，重排不变）
        ├── sessionId    远端会话 id
        ├── title        跟随 OSC 0/2 标题，可手改
        ├── state        connecting | active | background | disconnected | exited
        ├── cols/rows
        └── ringBuffer   默认 256 KB
```

**互不干扰的六条口径**：

| # | 维度 | 要求 |
| --- | --- | --- |
| 1 | 进程 | 每个会话各自 `pty.spawn`，独立 PID、cwd、env |
| 2 | 尺寸 | `resize` 只作用于自己 |
| 3 | 输入 | 按键只路由给当前选中会话 |
| 4 | 缓冲 | 每个会话独立 ring buffer，不共享 scrollback |
| 5 | 失效 | 某个 PTY 退出只标记自己 |
| 6 | 后台 | 后台会话输出照常接收，不节流 |

上限 20 个会话。20 × 5000 行 scrollback ≈ 20 MB。

### 5.4 终端手感参数（照抄 orca，不自创）

```ts
allowProposedApi: true
cursorBlink: true
cursorStyle: 'block'
fontSize: 14
fontWeight: '300'
fontWeightBold: '500'
scrollback: 5000            // 可调 1000–50000
scrollSensitivity: 1.15
fastScrollSensitivity: 5
macOptionIsMeta: false
macOptionClickForcesSelection: true
drawBoldTextInBrightColors: true
allowTransparency: false
scrollbar: { width: 7 }
vtExtensions: { kittyKeyboard: true }
fontFamily: SF Mono → Menlo → Monaco → Cascadia Mono → Consolas
          → DejaVu Sans Mono → Symbols Nerd Font Mono → monospace
```

**四个决定"顺不顺手"的实现点**：

1. 先 `open()` 再加载 WebGL，顺序反了会白屏
2. fit 需要延迟重试——容器尺寸变化后立即 fit 会算错 cell
3. 半截 ANSI 序列要跨帧缓存（一次 write 切在 `\x1b[38;5` 中间）
4. `attachCustomKeyEventHandler` 返回 `false` 才冒泡；kitty 编码器会吃掉 Cmd+C

**渲染策略**：所有会话的 xterm 实例常驻，非活动会话用 `display:none` 隐藏，不卸载 DOM。WebGL addon 只在可见时 attach，隐藏时 detach 并暂停光标闪烁。切回时先移出 `display:none`、等一帧、再 fit、再 attach WebGL。

不使用 `@xterm/headless` + `serialize`（那是给移动端和远端镜像用的）。

### 5.5 键盘与输入法

- `Ctrl+C`：有选区走剪贴板，无选区发 `\x03`
- `Cmd+V` 走原生粘贴，内容做 bracketed paste 包装
- 中文输入法：`isComposing` 期间不转发按键；处理好 `compositionend` 与 Enter `keyup` 的顺序；macOS 切输入法首键不能被吞

---

## 6. 服务端

| 项 | 选择 | 依据 |
| --- | --- | --- |
| 语言 | 系统 Python 3.10.12 | 已在，零安装 |
| WS 库 | `websockets==12.0` | 支持 ≥3.8 |
| 监听 | `127.0.0.1:8765` | openresty 为 host 网络，回环直通 |
| 部署 | Docker，`network_mode: host`，`mem_limit: 256m` | 统一到 1Panel |
| 反代 | 1Panel-openresty 443 + 独立 vhost | 443 已被占用 |
| 存储 | 无 | 在线表在内存字典 |
| 进程数 | **必须单进程** | 多 worker 会让在线表分裂 |

资源预算：RSS 35–45 MB、CPU 空转 <1%、峰值 +20 MB、磁盘占用可忽略。

`docs/21` 里的 Caddy 与双进程方案作废——证书已有、443 已通，Caddy 纯属多余。

---

## 7. 协议

### 7.1 双连接

| 通道 | 路径 | 内容 |
| --- | --- | --- |
| 控制 | `/ctl` | JSON 文本，信令，全应用一条 |
| 数据 | `/d/<session_token>` | 二进制帧，每个终端一条 |

`session_token` 由被连端生成并经 ctl 返回，relay 只按 token 把两条连接配对成字节管道，**不解析帧体**。

为什么不是单连接：多个终端并行时，一个会话的大块输出会把心跳和按键回显堵在队列后面（10 MB 输出 ≈ 0.6 s）。双连接天然隔离。

### 7.2 控制信令

```
REGISTER   { node_id, pubkey, caps }
REG_LIST   → [ { node_id, online, alias } ]
DIAL       { target }
INCOMING   { from, need_confirm }
ACK / REJ  { reason? }
SESSION_CREATE { cols, rows, shell? } → { session_id, token, title }
SESSION_LIST   → [ { session_id, title, cols, rows, created_at } ]
SESSION_CLOSE  { session_id }
PING / PONG
```

### 7.3 数据帧

固定长度二进制头 + payload，含 `opcode`（Input / Output / Resize / Error / Close）、`session_id`、`seq`。字节布局在 `openspec/specs` 固定，实现与 spec 必须一致。

---

## 8. 安全模型

| 层 | 机制 | 作用范围 | 版本 |
| --- | --- | --- | --- |
| 1 | TLS（真证书） | 客户端 ↔ relay | v1 |
| 2 | 服务端准入 token | 谁能连上 relay | v1 |
| 3 | `node_id = SHA256(pubkey)[:8]` | 身份识别、防冒名 | v1 |
| 4 | ACL 白名单 | 谁能连谁 | v1 |
| 5 | 方向判定（单向建链） | A 可连 B ≠ B 可连 A | v1 |
| 6 | PSK / E2E | relay 看不到明文 | v1.5 |

**v1 的已知妥协**：只有 TLS 到 relay，relay 进程能看到明文流量。E2E 留到 v1.5。v1 只在自己可控的网络里使用。

---

## 9. 界面

### 9.1 布局

**左侧竖向标签列 + 右侧单终端**，没有顶部标签栏，v1 不分屏。

```
┌──────────────────────────────────────────────────────────┐
│  ● ● ●   remote-pty · 已连接 MacBook Pro      ⌘K  ⌘?  ⚙  │
├──────────────┬───────────────────────────────────────────┤
│  会话        │                                           │
│              │  ~/code $ git status                      │
│ ● MacBook    │  On branch main                            │
│   Pro        │  Changes not staged for commit:            │
│   ● 在线      │    modified: src/main/pty-session.ts      │
│              │                                           │
│  ▸ zsh ~/code│  ~/code $ npm run build                   │
│  ▸ vim       │  ✓ built in 1.42s                         │
│  ▸ htop    ● │                                           │
│              │  ~/code $ _                               │
│  ─────────   │                                           │
│  + 新建 ⌘T   │                                           │
│              │                                           │
│  其他设备     │                                           │
│  ○ iMac 离线  │                                           │
├──────────────┴───────────────────────────────────────────┤
│ ● 7.8ms   UTF-8   zsh  80×24          12:04:31  ⌘/  [?]  │
└──────────────────────────────────────────────────────────┘
```

左侧列表按设备分组，只有一个设备时不显示分组头。`●` 表示后台有新输出，`○` 表示已断开。

### 9.2 屏与入口

| 屏 | 内容 | 入口 |
| --- | --- | --- |
| 首页 | 本机标识 + 二维码，共享我这台 / 连接其他机器 | 启动默认 |
| 连接 | 输入对端标识，历史列表 | 首页按钮 |
| 配对确认 | 模态框，显示完整指纹，默认焦点在"拒绝" | 收到 INCOMING |
| 工作区 | 左侧标签列 + 右侧终端 + 状态栏 | 连上之后 |
| 空状态 | 没有终端时显示"新建终端" | 关掉最后一个终端 |
| 设置 | 外观 / 终端 / 连接 / 安全 四组 | ⌘, |
| 诊断 | RTT、会话表、日志 | ⌘⇧L |
| 快捷键 | 浮层 | ⌘/ |

**每个功能至少两个入口**（快捷键 + 可见按钮），符合约束 6。

### 9.3 快捷键

| 动作 | 快捷键 |
| --- | --- |
| 新建终端 | ⌘T |
| 关闭终端 | ⌘W（关到最后一个变空状态，不退窗口） |
| 切换终端 | ⌘1 … ⌘9 / ⌘⇧[ ⌘⇧] |
| 重命名 | 双击标签 |
| 查找 / 清屏 | ⌘F / ⌘K |
| 复制 / 粘贴 | ⌘C / ⌘V |
| 字号 | ⌘+ / ⌘− |
| 设置 / 诊断 / 快捷键 | ⌘, / ⌘⇧L / ⌘/ |

### 9.4 视觉约定

| 用途 | 色值 |
| --- | --- |
| 窗口背景 / 侧边栏 / 标签栏 | `#1e1e1e` / `#252526` / `#2d2d2d` |
| 前景 / 次要文本 | `#cccccc` / `#8a8a8a` |
| 边框 | `#3c3c3c` |
| 强调 / 在线 / 重连 / 断开 | `#4ec9b0` / `#89d185` / `#cca700` / `#f14c4c` |

UI 13px，终端 14px `fontWeight 300`，间距 8pt 栅格。

交互原则：断线用横幅不用弹窗；破坏性操作才用模态框且默认焦点在取消侧；状态栏永远显示连接质量。

---

## 10. 生命周期与边界

| 情况 | 行为 |
| --- | --- |
| 网络断 | 所有会话保留，各自 ring buffer 继续累积 |
| 重连 | 逐条管道重连，重放各自 buffer，标签顺序不变 |
| 关标签 | 结束该 PTY；前台有 `vim`/`htop` 时二次确认 |
| 关最后一个标签 | 变空状态，窗口保留 |
| 关窗口 | 会话全部保留（后台保活默认开） |
| 退出应用 | 结束全部会话 |
| 后台输出超限 | 丢头部，插入一行 `[已省略 N KB]` |

---

## 11. 版本切片

| 版本 | 内容 |
| --- | --- |
| **P0** | 单窗口 + 本地 xterm + 本地 zsh，只验手感（半天） |
| **P1** | main 持有 PTY、多会话 broker、ring buffer、重连重放、本地 IPC |
| **P2** | 接 relay：双连接、信令、ACL、多终端异地打通 |
| **P3** | 打包 DMG、bundle id、签名、开机自启 |
| **v1.5** | E2E、PSK、方向权限、多设备并行、分屏 |
| **v2** | 文件传输、自举发布 |

---

## 12. 验收标准

1. 公司机（无 sshd、有出站策略）能连上家里 Mac mini 的 zsh，**全程无一行业务 SSH 命令**
2. 同时开 3 个终端，`vim` / `htop` / `tmux` 各一，互不干扰、无花屏
3. 在一个终端跑 `cat` 大文件，另一个终端的按键回显不受影响
4. 关掉家里那台的窗口，公司侧 shell 不退出、历史不丢
5. 拔网线 10 秒再插上，自动重连并补上断线期间的输出
6. 中文输入法下输入中文不乱码、首键不丢
7. relay RSS < 50 MB，连续跑 7 天不涨
8. `docker restart rpty-relay` 后客户端 5 秒内自动恢复

---

## 13. 决策记录

| # | 决策 | 结果 |
| --- | --- | --- |
| D1 | 域名 | `rpty.zhaojian.xin`，独立子域 |
| D2 | 连接模型 | 双连接 `/ctl` + `/d/<token>` |
| D3 | 分屏 | v1 不做，**左侧标签列 + 右侧单终端** |
| D4 | 仓库可见性 | 公开 |
| D5 | 加密 | v1 明文，E2E 进 v1.5 |
| D6 | 关最后一个标签 | 变空状态，窗口保留 |
| D7 | 后台保活 | 默认开 |
| D8 | swapfile | 补 2 G，`vm.swappiness=10` |
| D9 | 服务器 22 端口 | 收到白名单，不关闭 |
| D10 | 客户端 daemon 化 | v1 不做 |
| D11 | 会话上限 | 20 |
| D12 | 自动更新 | v1 不做 |

---

## 14. 作废的旧设计

| 文档 | 内容 | 处置 |
| --- | --- | --- |
| 01 / 02 / 03 | 固定 agent / terminal 角色 | 已废 |
| 13 / 14 | 极简房间模型 | 已废（15 已否定） |
| 21 | Caddy + 双进程 + 三方案对比 | 作废，改为 Docker host 网络 + openresty |
| 00 第 6 条 | 单条 ws | 已改为双连接 |
| openspec/specs/pty-relay/spec.md | agent/terminal 角色 + auth role | 待标 superseded |
