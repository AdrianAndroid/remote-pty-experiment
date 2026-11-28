# 26 · Stage 1 归档（单宿主机 + 多客户端镜像）

> 归档时间：2026-11-27
> 提交区间：`3029f72` → `595f2bb`
> 标签：`stage-1`
> 状态：**阶段验收通过，可交付试用；跨机器与打包未做。**

---

## 1. 这一阶段到底做完了什么

一句话：**一台 Mac mini 当宿主，两个独立客户端同时连、看同一块终端、敲同一块键盘，全链路走公网。**

原来设想的「客户端 ↔ 云 relay ↔ 被控机」三段结构没变，变的是数据通道从 1:1 配对改成了 1:N 多播 —— 这才是"同步"而不是"各开一个"。

```
客户端 A ─┐
          ├─▶ wss://relay.example.com ─▶ agent(Mac mini) ─▶ 同一个 zsh
客户端 B ─┘        (relay 多播)              (PTY 宿主)
```

---

## 2. 实测验收

以下全部是真机、真公网、非模拟。

| # | 项 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 两端在同一通道 | `curl /healthz` | `channels:3, viewers:6, ctls:2`（3 会话 × 2 端） |
| 2 | 同一 shell 进程 | 两端 `echo $$` | 都是 `80327` |
| 3 | 输出多播 | A 敲 → B 看 | B 秒出，含提示符与滚动位置 |
| 4 | 输入多播 | B 敲 → A 看 | A 秒出 `I-AM-THE-OWNER 80327` |
| 5 | 走的是真公网 | `lsof -i :443` | 每个客户端 6 条 ESTABLISHED → `relay.example.com` |
| 6 | 标签归属 | 目视 | A 的「终端 3」无徽标；B 的三个全带「共享」 |
| 7 | 全局编号 | 两端对照 | A/B 的「终端 3」是同一会话 |
| 8 | 镜像端不串行 | 目视 | 锁尺寸后 B 与 A 逐字一致，无重叠错行 |
| 9 | 宿主标识 | 目视 + `hostname` | 左上角「宿主 zhaojiandeMac-mini」；终端内 `hostname` 同值 |
| 10 | 旧会话自动接管 | 重启客户端 | 挂回 agent 上存活的 PTY，画面恢复 |

第 10 项有个副作用，见 §4。

---

## 3. 关键设计决定（都是踩坑踩出来的）

**通道语义：`role=agent` 唯一，`role=ctl` 任意多。**
一个 PTY 只能有一个宿主，但可以有无限个观看者。resize 只有 owner 能做，否则两端会互相拉扯尺寸。

**快照定向，不重放。**
新 viewer 进来时 relay 发 `VIEWER_JOINED`，agent 回 `SESSION_SNAPSHOT` 只给这一个 viewer；在快照到达前的增量按序排队（上限 512 条），2.5 秒兜底强制放行。
早期是"重连就重放整段环形缓冲"，多播下每个新端都会刷一屏重复内容。

**信令必须走 `/agent`，不能走数据通道。**
踩过：`VIEWER_JOINED` 发到数据 ws，agent 把它当键盘输入写进 PTY，终端上直接出现一行 JSON。

**镜像端锁尺寸。**
镜像的 xterm 强制 `term.resize(pty.cols, pty.rows)`，不本地 `fit()`。
不锁的话本地按自己窗口宽度重排、PTY 按老宽度换行，画面就串行 —— 表现为字符重叠、命令拼成一团。

**编号由宿主分配。**
agent 维护全局 `seq`，`SESSION_LIST` 每项带 `index`。客户端不再自己数，否则两端同名不同物。

---

## 4. 已知限制（不影响当前使用，但要知道）

1. **重启客户端后「共享」会误显示。** agent 上的 PTY 还活着，"谁创建的"关系没有持久化，重连时被当成别人的会话。功能不受影响，只是标签语义不准。
2. **`/agent` 只有一个槽位。** 一台 relay 同一时刻只能挂一个 agent 进程。切机器必须停掉旧的，否则互相顶。
3. **镜像端窗口比 PTY 窄时右侧留白或横向滚动。** 锁尺寸的代价，没做缩放适配。
4. **`pair_timeout` 是死代码。** 1:1 配对逻辑删了，相关参数和 `RPty_PAIR_TIMEOUT` 环境变量没清理。
5. **`VIEWER_JOINED` 的 2.5s 兜底没单独构造用例。** 只在实际链路里被动覆盖过。

---

## 5. Stage 2 待办

按优先级：

- [ ] **真跨机器**：Mac mini 客户端 ↔ 局域网 Ubuntu 台式机（`$LAN_HOST`）当 agent。台式机侧已就绪，未实跑。
- [ ] **客户端打 x64 `.app`**：`pack:mac` 当前只配 arm64，本机是 Intel。
- [ ] **owner 交接**：让尺寸控制权能在客户端之间转移，顺带解决 §4 第 1 条。
- [ ] 清理 `pair_timeout` 死代码。
- [ ] 缩放适配（窗口窄于 PTY 时 `transform: scale()`，Orca 手机端做法）。

---

## 6. 复现方式

```bash
# 宿主（Mac mini）
launchctl kickstart -k gui/$(id -u)/com.example.rpty-agent
tail -f ~/rpty/agent.err.log        # 注意是 .err.log

# 客户端 A
cd ~/rpty/apps/desktop && ./node_modules/.bin/electron .

# 客户端 B（隔离 userData，否则会用同一个配置目录）
RPTY_USERDATA="$HOME/Library/Application Support/rpty-desktop-b" \
  ./node_modules/.bin/electron .

# 看链路状态
curl -s https://relay.example.com/healthz
```

细节与坑见 `25-runbook.md`。
