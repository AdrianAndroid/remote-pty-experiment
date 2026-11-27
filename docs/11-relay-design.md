# 11 · Relay 服务端设计

云主机上那个组件的完整设计。对应 `docs/10-symmetric-peer.md` 的对称模型。

---

## 0. 一句话

**relay 是一个带在线表的 WebSocket 交换机。**

除了"谁在线"和"哪两条连接配对"，它什么都不记、什么都不懂、什么都不存。

---

## 1. 它不做什么（比做什么更重要）

| 不做 | 原因 |
| --- | --- |
| 不解析 payload | 桥接后连帧头都不看，纯 `bytes` 搬运 |
| 不校验 ACL | ACL 是端到端的事，relay 不该知道谁能连谁 |
| 不管会话 | 会话在 peer 的 broker 里，relay 不知道什么叫 shell |
| 不管心跳 | WS 层 ping 由库维持，应用层 PING 帧透传给对端 |
| 不落盘 | 无数据库、无状态文件。重启即清空，peer 自己重连 |
| 不记内容 | 日志只有 node_id / 时间 / 字节数 |
| 不做应用层重试 | 重连是 peer 的责任 |

这张表是设计约束，不是谦虚。**每往 relay 里加一条业务逻辑，故障面就扩大一圈。**

---

## 2. 内部结构

```
   ┌─────────────────────────────────────────────────────────────────
   │  relay.py  (单进程 · asyncio · 只监听 127.0.0.1:8765)
   ├─────────────────────────────────────────────────────────────────
   │
   │   registry  ── 在线表
   │     node_id → PeerConn{ ws, name, ip, bridge, connected_at }
   │     重复 node_id 进来：顶掉旧连接（新连接优先）
   │
   │   pending   ── 待应答的建连请求
   │     dial_id → (caller, target_node_id, future, deadline)
   │     30 s 无应答 → 回 DIAL_ERR{timeout}
   │
   │   bridges   ── 进行中的桥接
   │     bridge_id → Bridge{a, b, bytes_ab, bytes_ba, created_at}
   │
   │   limits    ── 限流计数器（内存滑动窗口）
   │     每 IP 连接数 / DIAL 频率 / 单节点 bridge 数
   │
   └─────────────────────────────────────────────────────────────────
```

四个字典，一个进程，零持久化。全部状态在重启后归零——**这是特性，不是缺陷**：peer 会自动重连并重新 DIAL。

---

## 3. 连接生命周期

```
                        ┌──────────────────────────────────────┐
                        │                                      │
   ACCEPT ──▶ WAIT_REG(5s) ──▶ ONLINE ──▶ BRIDGED ──▶ DRAIN    │
                 │                │           │           │    │
             超时 │           DIAL │      断开 │      正常 │    │
                 ▼                ▼           ▼           ▼    │
              CLOSE(1008)     回到ONLINE   回到ONLINE  CLOSE    │
                                                                 │
   任何阶段 ws 错误 ──▶ 清理 ──▶ 通知 bridge 对端 ──▶ CLOSE ─────┘
```

四个状态：

| 状态 | 含义 | 允许的帧 |
| --- | --- | --- |
| `WAIT_REG` | 已连接，未注册 | 只有 `REGISTER` |
| `ONLINE` | 已在在线表 | `DIAL` / `INCOMING` 的应答 / `PING` |
| `BRIDGED` | 已配对，进入搬运模式 | **任何字节**（不再解析） |
| `DRAIN` | 对端已断，等本端关闭 | 只读 |

关键：**`ONLINE → BRIDGED` 是一个单向的状态跃迁，一旦进入就不再回到"解析帧"的逻辑。**

---

## 4. 建连时序

```
    A                      relay                    B
    │                      │                      │
    ├───── REGISTER ──────▶│                      │
    │◀───── REG_OK ────────┤                      │
    │                      │◀──── REGISTER ───────┤
    │                      ├────── REG_OK ───────▶│
    │                      │                      │
    ├────── DIAL(B) ──────▶│                      │
    │                      ├──── INCOMING(A) ────▶│
    │                      │                      │  查 ACL → 通过
    │                      │◀──── DIAL_ACK ───────┤
    │◀───── DIAL_OK ───────┤                      │
    │                      ├────── DIAL_OK ──────▶│
    │                      │                      │
    │                      │  ← 此刻起 relay 只搬字节，不解析
```

两端都收到 `DIAL_OK`，这是必要的：被叫方需要知道"桥已经通了，可以开始握手"，否则它不知道什么时候该把 socket 从"信令模式"切到"搬运模式"。

---

## 5. 桥接后的数据路径

```
    A                 registry          pump               B
    │                 │                 │                 │
    │                 │                 │◀─── bytes ──────┤   B 的输出
    │                 │◀──── fwd ───────┤                 │
    │◀──── 转发 ──────┤                 │                 │
    ├───── 输入 ─────▶│                 │                 │   A 的输入
    │                 ├───── fwd ──────▶│                 │
    │                 │                 ├───── 转发 ─────▶│
```

实现就是两个协程：

```python
async def pump(src, dst):
    try:
        async for msg in src:
            await dst.send(msg)
    finally:
        with suppress(Exception):
            await dst.close()

await asyncio.gather(
    pump(a.ws, b.ws),
    pump(b.ws, a.ws),
    return_exceptions=True,
)
```

没有缓冲、没有重排、没有确认。TCP 保证有序，WS 保证消息边界，这就够了。

---

## 6. 三个必须处理的边界情况

### 6.1 双向同时 DIAL（撞车）

A 和 B 同时按下"连接对方"：

```
   A ──DIAL(B)──▶ relay ──INCOMING(A)──▶ B
   B ──DIAL(A)──▶ relay ──INCOMING(B)──▶ A     ← 两条请求交叉
```

不处理会出现两条 bridge，互相打架。

**tie-break 规则：`node_id` 字典序小的一方胜出。**

```
   若 node_id_A < node_id_B  →  接受 A 的 DIAL，B 的 DIAL 回 DIAL_ERR{race}
   被拒方收到 race →  静默等待 3 s →  检查是否已 BRIDGED
                                    ├─ 是 → 正常使用
                                    └─ 否 → 重试
```

规则简单、无状态、两端算出的结果一致，不需要额外协商。

### 6.2 桥接中断后谁重连

**由 bridge 的发起方（DIAL 的那一方）负责重连。**

- 发起方：断线 → 指数退避重连 → 重新 DIAL
- 被叫方：断线 → 重连 → 注册 → 静候对方 INCOMING

如果两边都主动重连，就会退化成 6.1 的撞车；虽然 tie-break 能兜住，但会多一轮无效信令。

### 6.3 对端进程被杀（无 FIN）

TCP 半开连接：`recv` 不返回，`pump` 卡住。

靠 WS 层 ping 解决：`websockets.serve(ping_interval=20, ping_timeout=10)`。20 s 没 pong 就抛异常，`pump` 退出，进入 DRAIN。

不要自己写应用层超时判断——库已经做了，重复实现只会互相打架。

---

## 7. 反枚举与限流

relay 不做鉴权，但它必须防止自己成为**探测工具**。

### 7.1 不泄露节点是否存在

```
   DIAL_ERR 的原因只有三种：offline / timeout / race
   ✗ 绝不返回 not_found
```

"不存在"和"离线"都返回 `offline`。否则攻击者可以枚举 node_id 空间，摸清你有哪些机器在线。

### 7.2 限流表

| 维度 | 阈值 | 超限动作 |
| --- | --- | --- |
| 单 IP 并发连接 | 3 | 拒绝新连接 |
| 全局并发连接 | 20 | 拒绝新连接 |
| 单 IP REGISTER | 5 / 分钟 | 拒绝 |
| 单 node DIAL | 10 / 分钟 | `DIAL_ERR{rate_limited}` |
| 单 node 并发 bridge | 3 | 拒绝新 DIAL |
| 单 bridge 速率 | 无上限（可选 10 MB/s） | 观测，不断流 |

滑动窗口用 `collections.deque` + 时间戳，几十行搞定，不引第三方库。

### 7.3 它仍然看得到什么

诚实地说，relay 虽然看不到内容，但看得到**元信息**：

- 你的 IP（这是 TLS 连接的事实，无法隐藏）
- 连接/断开时间
- 每个 bridge 的字节数与方向
- node_id（如果不做混淆的话）

如果要进一步降低暴露面，可以把 `node_id` 也做成"给 relay 的假名"——真实身份只在端到端握手里验证。这属于 v3，先记着。

---

## 8. 部署

```
   ┌───────────────────────────────────────────────────────────────
   │  云主机
   │
   │  nginx :443  ── TLS 终结 ──▶  relay 127.0.0.1:8765
   │    └─ location /ws  ─ Upgrade 转发
   │
   │  systemd: remote-pty-relay.service
   │    ├─ Restart=always
   │    ├─ RestartSec=2
   │    ├─ MemoryMax=256M
   │    └─ 无 EnvironmentFile（relay 不需要密钥）
   └───────────────────────────────────────────────────────────────
```

注意最后一行：**relay 不需要任何密钥配置**。它没有 token、没有私钥、没有证书（证书在 nginx 层）。这本身就是"盲中继"的一个证明。

nginx 关键三行：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

外加 `proxy_read_timeout 86400s` 和 `proxy_buffering off`（缓冲会让终端输出变卡）。

---

## 9. 代码骨架

约 250 行，全部逻辑：

```python
# relay/relay.py
import asyncio, json, time, os
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
import websockets

REG_TIMEOUT = 5.0
DIAL_TIMEOUT = 30.0
MAX_CONN = 20
MAX_PER_IP = 3
MAX_BRIDGE_PER_NODE = 3
RATE_DIAL = (10, 60)        # 10 次 / 60 秒

@dataclass
class PeerConn:
    ws: object
    node_id: str = ""
    name: str = ""
    ip: str = ""
    bridge: object = None
    dial_hist: deque = field(default_factory=deque)

online: dict[str, PeerConn] = {}
pending: dict[str, asyncio.Future] = {}
bridges: set = set()

def ok(dial: deque, n, window):
    now = time.time()
    while dial and now - dial[0] > window:
        dial.popleft()
    if len(dial) >= n:
        return False
    dial.append(now)
    return True

async def handle(ws):
    ip = ws.remote_address[0]
    if len(online) >= MAX_CONN:
        await ws.close(1013, "server_full"); return

    peer = PeerConn(ws=ws, ip=ip)
    try:
        # ── 阶段 1：等注册 ──────────────────────────────
        raw = await asyncio.wait_for(ws.recv(), REG_TIMEOUT)
        msg = json.loads(raw)
        if msg.get("type") != "REGISTER":
            await ws.close(1008, "need_register"); return

        node_id = msg["node_id"]
        if node_id in online:
            with suppress(Exception):
                await online[node_id].ws.close(4001, "replaced")
        peer.node_id, peer.name = node_id, msg.get("name", "")
        online[node_id] = peer
        await ws.send(json.dumps({"type": "REG_OK", "peers": len(online)}))

        # ── 阶段 2：信令循环 ────────────────────────────
        async for raw in ws:
            msg = json.loads(raw)
            t = msg.get("type")

            if t == "DIAL":
                target = msg.get("target")
                if not ok(peer.dial_hist, *RATE_DIAL):
                    await ws.send(json.dumps({"type": "DIAL_ERR",
                                              "reason": "rate_limited"}))
                    continue
                tp = online.get(target)
                # 反枚举：不存在与离线返回同一种错误
                if tp is None:
                    await ws.send(json.dumps({"type": "DIAL_ERR",
                                              "reason": "offline"}))
                    continue
                # 撞车 tie-break：node_id 小的一方胜
                if peer.bridge:
                    await ws.send(json.dumps({"type": "DIAL_ERR",
                                              "reason": "busy"}))
                    continue
                fut = asyncio.get_running_loop().create_future()
                pending[peer.node_id] = fut
                await tp.ws.send(json.dumps({
                    "type": "INCOMING", "from": peer.node_id,
                    "name": peer.name}))
                try:
                    await asyncio.wait_for(fut, DIAL_TIMEOUT)
                except asyncio.TimeoutError:
                    await ws.send(json.dumps({"type": "DIAL_ERR",
                                              "reason": "timeout"}))
                finally:
                    pending.pop(peer.node_id, None)

            elif t == "DIAL_ACK":
                fut = pending.get(msg.get("from"))
                if fut and not fut.done():
                    fut.set_result(True)

            elif t == "DIAL_REJ":
                fut = pending.get(msg.get("from"))
                if fut and not fut.done():
                    fut.set_exception(RuntimeError("denied"))

            elif t == "PING":
                await ws.send(json.dumps({"type": "PONG"}))

    except (asyncio.TimeoutError, websockets.ConnectionClosed,
            json.JSONDecodeError):
        pass
    finally:
        if peer.node_id and online.get(peer.node_id) is peer:
            del online[peer.node_id]
        with suppress(Exception):
            if peer.bridge:
                await teardown(peer.bridge, peer)
```

桥接部分单独一个函数，**它是唯一进入搬运模式的地方**：

```python
async def bridge(a: PeerConn, b: PeerConn):
    """两端都已 REGISTER，直接开始搬字节。"""
    a.bridge = b.bridge = (a, b)
    bridges.add((a, b))
    for p in (a, b):
        await p.ws.send(json.dumps({"type": "DIAL_OK"}))
    try:
        await asyncio.gather(pump(a.ws, b.ws), pump(b.ws, a.ws))
    finally:
        bridges.discard((a, b))
        a.bridge = b.bridge = None
        for p in (a, b):
            with suppress(Exception):
                await p.ws.close(1000, "bridge_closed")

async def pump(src, dst):
    try:
        async for msg in src:
            await dst.send(msg)
    except Exception:
        pass

async def main():
    port = int(os.environ.get("RELAY_PORT", 8765))
    async with websockets.serve(
        handle, "127.0.0.1", port,
        ping_interval=20, ping_timeout=10,
        max_size=1 << 20,
    ):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
```

注：上面的 `DIAL` 分支只演示了信令，实际实现里 `DIAL_ACK` 之后需要把两边从"信令循环"里摘出来交给 `bridge()` —— 常见做法是用一个 `Event` 打断 `async for`，或者把信令循环和搬运循环写成同一个状态机的两个分支。这是实现时最容易写错的地方，务必单独做集成测试。

---

## 10. 失败模式

| 现象 | 原因 | 排查 |
| --- | --- | --- |
| 两端都显示"离线" | REGISTER 失败 / nginx 未转发 Upgrade | `curl -i https://host/ws` 应返回 426 |
| DIAL 一直超时 | 被叫方没回 ACK（ACL 卡住或进程僵死） | 看被叫方日志的 INCOMING 记录 |
| 桥通了但没数据 | 两端加密握手失败 | 端到端日志，relay 看不出来（正常） |
| 每小时固定断一次 | 中间设备空闲超时 | 确认 ping_interval 生效 |
| 一个 node 连不上但其他正常 | 在线表里有僵尸条目 | `GET /stats` 看 bridge 数是否异常 |
| relay 内存缓慢上涨 | 桥接未清理（DRAIN 卡住） | 检查 `bridges` 集合是否只增不减 |

最后一条是最典型的 bug：`pump` 异常退出后忘记清 `bridges`，内存就会漏。测试必须覆盖"桥接中断后集合归零"。

---

## 11. 规模与成本

| 项 | 数值 |
| --- | --- |
| 代码量 | 约 250 行 |
| 单 bridge 内存 | ≈ 2 × WS buffer（各 64 KB）+ 协程栈 |
| 10 个 bridge | < 20 MB |
| CPU | 几乎为零（不解析、不加密） |
| 持久化 | 无 |
| 重启影响 | 所有桥断开，两端在退避周期内自动恢复 |

**relay 是整个系统里最没有技术含量的部分，这是设计目标，不是遗憾。** 它在架构里的角色相当于一根交换机——坏了大不了重启，反正两端会自己重连。
