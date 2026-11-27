# 10 · 对称 Peer 设计（双向）

> 状态：**提案**，取代 `docs/02-architecture.md` §2 角色定义与 `docs/03-protocol.md` 中的固定角色模型。
> 与 `docs/08-bold-design.md`（加密 + mux + broker）叠加生效，不冲突。

---

## 0. 一句话

**没有 agent，没有 client，只有 peer。**

任何一端都能"请对面开一个 shell 给我"，也都能"接受对面的请求"。同一条连接上，两个方向可以同时存在会话。

---

## 1. 为什么这件事天然可行

关键洞察：**两端都是出站长连接，墙内墙外不影响对称性。**

```
   家 Mac ──出站──▶ 云 relay ◀──出站── 公司 Mac
```

既然两端都只是"连到 exchange 的客户端"，那它们在协议层就**没有任何理由不对称**。之前区分 `agent` / `terminal` 是顺着 SSH 的思路来的（SSH 天生有 client/server），但我们的传输模型里根本没这个约束。

去掉了这个假设，架构反而更简单：**一份代码，两端通用。**

---

## 2. 角色如何表达

### 2.1 从"连接的身份"变成"通道的属性"

```
旧：  连接 = agent 或 terminal          （身份，连接期固定）
新：  channel = 谁发起 + 什么类型        （属性，每个通道独立）
```

一个 `OPEN` 帧就是一次"请求"：

```
A ──OPEN{ channel:0x0001, kind:"shell", params:{shell:"/bin/zsh"} }──▶ B
B ──OPEN_OK{ channel:0x0001 }────────────────────────────────────▶ A
B 在自己的机器上 spawn PTY，把输出灌进 ch 0x0001
```

对 B 来说，这就是"有人连进来要一个 shell"。对 A 来说，这就是"我要连别人的 shell"。**同一个动作，两端的视角不同，代码同一份。**

### 2.2 channel id 用方向位区分

```
  bit 15     bit 14..0
  ┌────┬───────────────┐
  │ 0  │   channel id  │   ← A 发起（A 是这条 channel 的控制方）
  ├────┼───────────────┤
  │ 1  │   channel id  │   ← B 发起（B 是控制方）
  └────┴───────────────┘
```

这样同一个连接上，两个方向的 channel 永远不会撞 id，不需要协商。

### 2.3 一条连接上的完整画面

```
   home-mbp ═══════════════════════════════════════════════ office-mini
            │ ch  0x0001   shell(main)      A 控制 B 的 shell │
            │ ch  0x0002   file             A 读 B 的文件     │
            │ ch  0x0003   forward(5432)    A 访问 B 的端口   │
            │ ch  0x8001   shell(home)      B 控制 A 的 shell │
            │ ch  0x8002   forward(8888)    B 访问 A 的端口   │
            └──────────────────────────────────────────────────┘
```

**这才是"双向"的本质**：不是两套程序互相扮演角色，而是**一条连接上两个方向的多路会话同时存在**。

真实用例：
- 家里连公司写代码（ch 0x0001）
- 同时公司机上的脚本反向把构建产物推到家里 NAS（ch 0x8002）
- 公司机上一个长任务需要看家里那份数据集（ch 0x8001 file）

---

## 3. 发现与建连：relay 变成交换机

### 3.1 旧模型

```
relay 记事本：agent=? / terminal=?  → 两个都到齐 → 桥接
```

问题：固定了两个槽位，无法表达"我要连谁"。

### 3.2 新模型：注册 + DAL

```
   ① 每个 peer 上线，向 relay 注册
      REGISTER { node_id, name, pubkey, proto_version }

   ② A 想连 B
      A ──DIAL{ target: node_id_B }──▶ relay
      relay 查在线表 ──▶ B 在线？
                         ├─ 否 → 回 DIAL_ERR{ reason:"offline" }
                         └─ 是 → 通知 B：INCOMING{ from:node_id_A, name }
                                  B 检查 ACL
                                    ├─ 拒 → DIAL_ERR{ reason:"denied" }
                                    └─ 允 → relay 桥接两条 ws

   ③ 桥接后 relay 变成纯字节管道（并且只看到密文）
```

relay 的职责缩小到三件：**在线表、转发 DIAL 信令、桥接字节**。它不知道谁要 shell、谁要文件。

### 3.3 拓扑

```
                        ┌──────────────────────┐
      home-mbp ──wss───▶│                      │
      Apple Silicon     │       relay          │
                        │   ┌──────────────┐   │
      office-mini ─wss─▶│   │ online table │   │
      Intel             │   │  bridge      │   │
                        │   └──────────────┘   │
      home-nas ───wss───▶│                      │
                        └──────────────────────┘

      任意两两可连：home-mbp ⇄ office-mini
                   home-mbp ⇄ home-nas
                   office-mini ⇄ home-nas
      同一条链路上可以同时存在多条 bridge
```

三节点以上时，relay 的价值才真正体现：它是**交换机**，不是"某个特定角色的中转站"。

---

## 4. 安全模型（对称后最大的新问题）

### 4.1 问题变了

之前的安全问题是"别人能不能连上 relay"。现在的问题是：

> **任何一个能连上 relay 的 node，都能 DIAL 我。怎么防止陌生节点连进来开 shell？**

两个 token 的方案在这里彻底失效——没有"角色"，token 就没有归属。

### 4.2 三层防御

```
   第 1 层 · 身份       每个 node 一对 X25519 静态密钥
                        node_id = SHA256(pubkey)[:8] 的 hex
                        连接时必须证明持有私钥（握手签名）

   第 2 层 · ACL        本机维护 allowlist：
                        ┌─────────────────────────────────────┐
                        │ node_id      名称          权限       │
                        │ a3f2c1d8     office-mini   shell,file │
                        │ 5e9b0a71     home-nas      file       │
                        │ *            (默认拒绝)    -          │
                        └─────────────────────────────────────┘
                        未在白名单 → DIAL 直接被拒，连握手都不做

   第 3 层 · 通道授权    每条 channel 单独判权：
                        kind=shell   → 需要 perm.shell
                        kind=file    → 需要 perm.file（可限制目录）
                        kind=forward → 需要 perm.forward（默认关）
```

### 4.3 首次配对（out-of-band）

第一次连某台机器，必须有个带外通道确认身份，否则会被中间人冒充：

```
   公司机首次启动：
     ┌──────────────────────────────┐
     │  node_id   a3f2c1d8          │
     │  name      office-mini       │
     │                              │
     │   ███ ▄▄▄ ███ ▄██ ██▄       │  ← 终端里打出的短指纹
     │   ▄██ ███ ▄▄▄ ██▄ ▄██       │
     └──────────────────────────────┘

   在家机上：
     $ rpty allow a3f2c1d8 --name office-mini --perm shell,file
```

比"复制粘贴 token"多了一步，但换来的是：**token 泄漏不再等于 shell 泄漏**，因为攻击者还需要私钥。

### 4.4 本机可见性（对称的必然后果）

对称之后，你的机器随时可能成为"被控制方"。所以必须：

- 菜单栏常驻状态灯：`office-mini 已连接 · 2 个会话`
- 每次**新 channel** 弹一条通知：`office-mini 请求 shell`（可配"信任后不再问"）
- 一键断开所有会话（panic button）
- 日志记录每个 channel 的建立/关闭时间与对端

**没有这一层，对称设计就是个后门。** 这是本方案里唯一不能省的部分。

---

## 5. 协议变更（相对 v1）

| 项 | v1（角色固定） | v2（对称 peer） |
| --- | --- | --- |
| auth 帧 | `role: agent/terminal` | `node_id + 签名挑战` |
| 配对 | relay 按角色槽位 | `REGISTER` + `DIAL` 信令 |
| channel id | 全局递增 | **高 1 位表方向** |
| OPEN | 不存在（连接即通道） | `OPEN{kind, params}` → `OPEN_OK` |
| 权限 | 两个 token | ACL 白名单 + 每通道 perms |
| 心跳 | 单向 | 双向对称 |
| 断线 | 两端各自重连 | 两端各自重连，channel 状态由 ring buffer 承接 |

新增帧：

| type | 名称 | 用途 |
| --- | --- | --- |
| `0x10` | REGISTER | 向 relay 注册身份 |
| `0x11` | DIAL | 请求连接某 node |
| `0x12` | INCOMING | relay 通知被连接方 |
| `0x13` | DIAL_OK / DIAL_ERR | 建连结果 |
| `0x14` | OPEN | 开通道（双向都可发） |
| `0x15` | OPEN_OK / OPEN_ERR | 通道建立结果 |
| `0x16` | REVOKE | 主动撤销某个 channel |

> 实施时这些会合并进统一帧类型表，不复用 v1 的编号。

---

## 6. 代码结构的影响

### 6.1 好消息：代码量反而少了

```
旧： agent/          +  client/          +  web/           （三份入口）
新： peer/                                     +  web/      （一份入口，两端同跑）

peer/
  ├─ main.py        启动、配置、ACL 加载
  ├─ node.py        身份、握手、DIAL
  ├─ broker.py      本地会话表（我是宿主的部分）
  ├─ session.py     PTY 生命周期、ring buffer
  └─ client.py      远程会话表（我是控制方的部分）
```

同一进程里同时持有两个表：

```
   Session Broker（我是宿主）
     ├ main      PTY + ring      ← office-mini 正连着我
     └ …

   Remote Sessions（我是控制方）
     └ home-mbp/main             ← 我正连着 office-mini
```

**一份程序，两个方向都能跑**，不需要"部署哪个版本"的纠结。

### 6.2 坏消息：测试矩阵变大

```
   方向      A→B        B→A        A→B 与 B→A 并发
   类型    shell      shell      shell + file
           file       file       shell + forward
           forward    forward    三通道同时
```

必须用参数化测试覆盖，否则会出现"单向能跑、双向就串包"的诡异 bug（典型的 channel id 冲突）。

---

## 7. 里程碑调整

在 `docs/08-bold-design.md` 的 P0–P8 上插入两处：

| 阶段 | 内容 | 工期 | 变化 |
| --- | --- | --- | --- |
| P0 | protocol：帧编解码 + **channel 方向位** + OPEN 语义 | 0.5d | 无变化（设计时就带上） |
| **P0.5** | **rendezvous：REGISTER / DIAL / 在线表 / ACL** | **1d** | **新增** |
| P1 | 内存 transport + 假 PTY + 会话状态机 | 0.5d | 无变化 |
| P2 | relay + peer + 网页，localhost 双向打通 | 1d | 验证 A→B 与 B→A 都通 |
| P3 | 真 PTY + resize | 0.5d | 无变化 |
| P4 | 部署，异地联调（三节点） | 1d | 加一台验证交换机能力 |
| P5 | E2E 加密 | 0.5d | 无变化 |
| P6 | Session Broker + 回放 | 1d | 双向都要测 |
| P7 | 流控 + file 通道 | 1d | 无变化 |
| P8 | 菜单栏（含新 channel 通知、panic button） | 1.5d | 工作量增加 |

总计约 **8 天**（原 7 天，+1 天给 rendezvous 与 ACL）。

---

## 8. 取舍

### 8.1 得到了什么

1. **部署简化**：一份代码，两端同跑，没有"装错版本"这类问题。
2. **应急能力**：公司机能反向连家里取文件、跑家里的模型。
3. **多节点**：家里 MacBook、Mac mini、公司 Mac 任意两两互通。
4. **共享终端**：两端同时 attach 一个 session，可做远程协助（tmate 式）。
5. **会话迁移**：公司开的 shell，回家接上继续。

### 8.2 付出了什么

| 代价 | 程度 | 说明 |
| --- | --- | --- |
| 协议复杂度 | 中 | 多 7 种帧，channel 带方向位 |
| 安全面 | **高** | 你的机器随时可能被连，必须有 ACL + 通知 + 一键断开 |
| 测试矩阵 | 中 | 方向 × 类型 组合爆炸，必须参数化 |
| relay 复杂度 | 低 | 从"配对"变成"在线表 + 桥接"，反而更简单 |
| 工期 | +1 天 | |

### 8.3 一个必须承认的风险

**双向 = 你的家机也变成可被访问的目标。** 如果公司那边（或任何被授予 ACL 的节点）被入侵，攻击者可以从公司机反向连到你家机。

缓解：
- 默认 ACL 是空（谁都不许连进来），必须显式添加
- 家机默认只授予 `file` 权限，不给 `shell`
- 公司机 → 家机的连接需要家机本机弹窗确认（首次），之后可"记住"

**如果这些防护不做，双向设计就是纯负债。** 这是我在这个提案里唯一的强烈保留意见。

---

## 9. 待定夺

1. **默认拒绝还是默认允许？** 我强烈建议默认拒绝（空 ACL），首次连接靠 `rpty allow <node_id>` 显式添加。
2. **家机是否授予 shell 权限？** 建议不给，只给 `file`，需要时临时开启。
3. **relay 是否要支持多 bridge？** 三节点场景必须支持，但实现上只是"在线表里有几个就允许几条 bridge"，成本很低。
4. **共享终端（两人同时 attach 同一 session）是否放进 v2？** 技术上不难（ring buffer 多播），但涉及"双人同时输入"的冲突语义，建议延后。
