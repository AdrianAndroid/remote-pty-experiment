# 20 · 服务端方案（怎么跑、跑在哪、跑稳）

`11` 讲信令逻辑，`13` 讲轻量化取舍。这篇讲**工程落地**：用什么技术栈、怎么部署、怎么不出事。

---

## 1. 结论

| 项 | 选择 |
| --- | --- |
| 语言 | **Python 3.11 + asyncio** |
| 库 | `websockets`（≥12，asyncio 版） |
| 进程数 | **1**（强制） |
| TLS | **Caddy 反代**，Python 只监听 `127.0.0.1:8765` |
| 存储 | 内存字典，**零持久化** |
| 部署 | systemd + `Restart=always` |
| 监控 | 一个 `/healthz` 返回 JSON |

整套约 170 行，单文件 `relay.py`，无第三方框架、无数据库、无配置文件（三个环境变量够了）。

---

## 2. 服务端不做什么

先划边界，这决定了它为什么能这么小：

- ❌ 不解析 PTY 数据（密文，也解不开）
- ❌ 不存会话、不存文件、不存历史
- ❌ 不做用户系统、不做注册登录
- ❌ 不做前端的"在线列表 UI"（那是客户端渲染的事）
- ❌ 不做证书签发（Caddy 做）
- ❌ 不做多机房、不做负载均衡

**它只做三件事：登记谁在线、转发 DIAL 信令、把两条连接焊成一根管子。**

---

## 3. 五个方案对比

| 方案 | 工作量 | 优点 | 致命问题 |
| --- | --- | --- | --- |
| **Python + asyncio** ✅ | 1 天 | 与 peer 同语言，逻辑可直接复用；协程天然适配"多长连接 + 转发" | 单核性能上限约 5k 并发（我们只用 2） |
| Go + gorilla | 2 天 | 单二进制、性能强 | 引入第二门语言，两端 peer 是 Python，协作成本高 |
| Node + ws | 1 天 | 生态好 | 回调/Promise 混用，与 peer 代码风格割裂 |
| Cloudflare Durable Objects | 0.5 天 | 天生"一房间一实例"，免运维、免证书 | 国内访问不稳，公司与家里都可能连不上 |
| nginx `stream` 四层转发 | 0.1 天 | 极简 | 按连接转发，无法做 DIAL 信令与在线表 |

选 Python。**理由不是性能，是"一套心智模型"**：relay 和 peer 用同一门语言、同一个协程模型、同一套日志格式，调试时脑子不用切换。

---

## 4. 必须单进程（这是硬约束，不是偏好）

在线表在 `self.nodes` 这个 Python 字典里。如果起 2 个 worker：

```
   peer A ──▶ worker1    nodes={A}
   peer B ──▶ worker2    nodes={B}
                          ↑ B 查在线表看不到 A
```

DIAL 直接失效。所以：

- **不能**用 `gunicorn -w 4`
- **不能**用 `uvicorn --workers 4`
- **只能** `python3 relay.py`

单进程能扛多少？一次转发就是一次 `await ws.send(msg)`，PTY 流量平均不到 50 KB/s。**4 核机器单进程跑几十对连接毫无压力**，而设计上只有 1 对。

> 如果哪天真要扩：加 Redis pub/sub 做跨进程在线表 + 跨进程消息路由。**现在加是纯负债。**

---

## 5. 四个内存结构

```python
self.nodes:   dict[str, Node]     # node_id -> 连接 + 元信息
self.pending: dict[str, Pending]  # pair_id -> 两端信息 + 创建时间
self.bridges: dict[str, Bridge]   # pair_id -> 已桥接的两条 ws
self.limits:  dict[str, list]     # ip / node_id -> 时间戳列表（滑动窗口）
```

`Node` 只有五个字段：

```python
@dataclass
class Node:
    node_id: str        # 16 hex，由 pubkey 派生
    name: str           # 显示名，如 office-mini
    pubkey: bytes       # 32 字节 X25519 公钥
    ws: WebSocketServerProtocol
    ip: str
```

`Pending` / `Bridge` 各三个字段。全部加起来不到 40 行定义。

**没有的东西**：消息队列、会话表、离线消息、审计日志表。重启即清空，这是设计而非缺陷——两端会自动重连重建。

---

## 6. 两个入口

```
wss://relay/ctl          常驻控制连接（JSON 帧）
wss://relay/d/<pair_id>  按需数据连接（二进制帧，直接透传）
```

### 6.1 控制连接握手

```
peer                           relay
 │  WS connect /ctl?token=xxx    │
 │──────────────────────────────▶│  ① 校验 token（不通过 → 1008）
 │  {"t":"REGISTER",             │
 │   "node_id":"a3f2c1d8",       │  ② 校验 sha256(pubkey)[:8] == node_id
 │   "name":"office-mini",       │     （不匹配 → 1008，防抢名）
 │   "pubkey":"<b64>"}           │  ③ 同名在线 → 顶掉旧的（4001）
 │◀──────────────────────────────│  ④ {"t":"REG_OK","peers":[...]}
 │                               │
 │  {"t":"DIAL","to":"5e9b0a71"} │
 │──────────────────────────────▶│  ⑤ 目标离线 → DIAL_ERR{offline}
 │                               │     目标忙   → DIAL_ERR{busy}
 │◀──────────────────────────────│  ⑥ 转发 {"t":"INCOMING","from":...}
 │        （目标端确认）          │
 │◀──────────────────────────────│  ⑦ {"t":"DIAL_OK","pair_id":"p_x1"}
```

**第 ② 步是关键**：`node_id = SHA256(pubkey)[:8]`，relay 自己算一遍对比。

这意味着**想占用 `office-mini` 这个名字，必须持有对应的私钥**——而私钥只在你机器上。relay 不存任何白名单，却实现了名字不可抢。

### 6.2 数据连接

```
peer A ──▶ /d/p_x1 ─┐
                    ├─▶ 两边到齐 → 双向 pump（纯字节，不解析）
peer B ──▶ /d/p_x1 ─┘
```

```python
async def pump(src, dst):
    async for msg in src:
        await dst.send(msg)      # 一个字节都不看
```

**就这四行。** 加密在上层做完，relay 转发的全是密文，它连"这是终端输入还是文件块"都分不出来。

到齐超时 10 秒，未到齐则清理 `pending`。

---

## 7. 代码骨架

```python
import asyncio, hashlib, json, os, secrets, time
from dataclasses import dataclass, field
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

TOKEN     = os.environ["RPTY_TOKEN"]
MAX_NODES = int(os.getenv("RPTY_MAX_NODES", "20"))

@dataclass
class Node:
    node_id: str; name: str; pubkey: bytes; ws: object; ip: str

class Relay:
    def __init__(self):
        self.nodes:   dict[str, Node] = {}
        self.pending: dict[str, dict] = {}
        self.bridges: dict[str, dict] = {}
        self.dial_ts: dict[str, list] = {}

    # ---------- 控制连接 ----------
    async def ctl(self, ws):
        ip = ws.remote_address[0]
        if ws.request.path.split("?")[-1].replace("token=", "") != TOKEN:
            return await ws.close(1008, "auth")
        node = None
        try:
            raw = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if raw["t"] != "REGISTER":
                return await ws.close(1008, "expect register")
            pub = raw["pubkey"]
            real_id = hashlib.sha256(base64.b64decode(pub)).hexdigest()[:16]
            if real_id != raw["node_id"]:
                return await ws.close(1008, "id/pubkey mismatch")
            if len(self.nodes) >= MAX_NODES and raw["node_id"] not in self.nodes:
                return await ws.close(1013, "server_full")
            old = self.nodes.get(raw["node_id"])
            if old:                                  # 同名顶替
                await old.ws.close(4001, "superseded")
            node = Node(raw["node_id"], raw["name"], pub, ws, ip)
            self.nodes[node.node_id] = node
            await ws.send(json.dumps({"t": "REG_OK"}))

            async for msg in ws:
                await self.on_ctl_msg(node, json.loads(msg))
        except (ConnectionClosed, asyncio.TimeoutError):
            pass
        finally:
            if node and self.nodes.get(node.node_id) is node:
                del self.nodes[node.node_id]

    async def on_ctl_msg(self, node, m):
        t = m["t"]
        if t == "LIST":
            out = [{"id": n.node_id, "name": n.name}
                   for n in self.nodes.values() if n.node_id != node.node_id]
            await node.ws.send(json.dumps({"t": "ONLINE", "peers": out}))

        elif t == "DIAL":
            if not self._rate_ok(node.node_id):
                return await node.ws.send(json.dumps({"t":"DIAL_ERR","why":"rate"}))
            peer = self.nodes.get(m["to"])
            if not peer:
                return await node.ws.send(json.dumps({"t":"DIAL_ERR","why":"offline"}))
            pid = "p_" + secrets.token_hex(4)
            self.pending[pid] = {"a": node.node_id, "b": peer.node_id,
                                 "ts": time.time(), "accepted": False}
            await peer.ws.send(json.dumps({
                "t":"INCOMING","pair_id":pid,
                "from":{"id":node.node_id,"name":node.name}}))

        elif t == "ACK":
            p = self.pending.get(m["pair_id"])
            if not p: return
            p["accepted"] = True
            for nid in (p["a"], p["b"]):
                await self.nodes[nid].ws.send(json.dumps(
                    {"t":"DIAL_OK","pair_id":m["pair_id"]}))

        elif t == "REJ":
            p = self.pending.pop(m["pair_id"], None)
            if p:
                await self.nodes[p["a"]].ws.send(json.dumps(
                    {"t":"DIAL_ERR","why":m.get("why","rejected")}))

    # ---------- 数据连接 ----------
    async def data(self, ws, pair_id):
        p = self.pending.get(pair_id)
        if not p or not p["accepted"]:
            return await ws.close(1008, "no such pair")
        p.setdefault("socks", []).append(ws)
        if len(p["socks"]) < 2:
            await asyncio.sleep(0)        # 等对端
            return
        a, b = p["socks"]
        self.pending.pop(pair_id, None)
        try:
            await asyncio.gather(pump(a, b), pump(b, a))
        finally:
            for s in (a, b):
                await s.close()

    def _rate_ok(self, nid):
        now = time.time()
        ts = [t for t in self.dial_ts.get(nid, []) if now - t < 60]
        if len(ts) >= 10: return False
        self.dial_ts[nid] = ts + [now]
        return True

async def pump(src, dst):
    try:
        async for msg in src:
            await dst.send(msg)
    except ConnectionClosed:
        pass

async def main():
    r = Relay()
    async def handler(ws):
        path = ws.request.path
        if path.startswith("/d/"):
            await r.data(ws, path[3:].split("?")[0])
        else:
            await r.ctl(ws)
    async with serve(handler, "127.0.0.1", 8765, ping_interval=20, ping_timeout=10):
        await asyncio.Future()

asyncio.run(main())
```

（骨架，`base64` 导入等细节略。真实实现约 170 行。）

---

## 8. 部署

### 8.1 Caddy 反代（自动证书）

```caddyfile
relay.example.com {
    reverse_proxy /ctl* 127.0.0.1:8765
    reverse_proxy /d/*  127.0.0.1:8765
    handle /healthz {
        respond `{"ok":true}` 200
    }
}
```

Caddy 自动申请并续期 Let's Encrypt 证书，WebSocket 自动升级，无需额外配置。

**为什么不用 nginx**：nginx 也能干，但要自己跑 certbot、自己写 `proxy_set_header Upgrade`、自己配 `proxy_read_timeout`（默认 60s 会掐断长连接）。Caddy 这些全是默认正确值。

### 8.2 systemd

```ini
[Unit]
Description=rpty relay
After=network.target

[Service]
Environment=RPTY_TOKEN=xxxxxxxx
ExecStart=/usr/bin/python3 /opt/rpty/relay.py
Restart=always
RestartSec=3
User=rpty

[Install]
WantedBy=multi-user.target
```

`Restart=always` 就够了——进程挂了 3 秒拉起，两端 peer 指数退避重连，用户体感是"闪了一下"。

**为什么不需要优雅重启**：没有会话状态要保。所有 PTY 在宿主机器上活着，relay 重启只断桥，宿主收到断开后保留 PTY 等重连，ring buffer 还在。

### 8.3 三个环境变量

```bash
RPTY_TOKEN=...        # 共享 token，两端 peer 都要配
RPTY_MAX_NODES=20     # 全局连接上限
RPTY_PORT=8765
```

不用配置文件。**配置越少，公司机器上部署越不容易出错。**

---

## 9. 运维

| 事件 | 影响 | 处理 |
| --- | --- | --- |
| relay 重启 | 所有桥断，PTY 不死 | 两端自动重连，10 秒内恢复 |
| 云主机宕机 | 同上 | 同上，用户看到"重连中" |
| 单 peer 网络抖动 | 该节点掉线 | 30 秒心跳判死，清理在线表 |
| 同名重复登录 | 顶替 | 旧的收 4001，UI 提示"该账号在别处登录" |
| 有人扫 `/ctl` | 无 token 被 1008 | 记录来源 IP，10 次/分封禁 |
| 内存泄漏 | — | 四个字典都有清理路径，`pending` 带 10s 超时 |

健康检查：

```bash
curl https://relay/healthz
{"ok":true,"nodes":2,"bridges":1,"uptime":86400}
```

`nodes` 长期只增不减 = 有泄漏，这是唯一的要盯的指标。

---

## 10. 安全边界（relay 能做到 / 做不到）

| 威胁 | relay 能防 | 靠谁 |
| --- | --- | --- |
| 未授权连 relay | ✅ token | — |
| 抢别人的 node_id | ✅ pubkey 绑定校验 | — |
| 枚举在线节点 | ✅ 只回自己 DIAL 的结果 | — |
| 读取终端内容 | ✅ 全链路密文 | E2E 层 |
| 中间人替换 pubkey | ❌ | TOFU 指纹核对 |
| 恶意 peer 高频 DIAL | ✅ 10 次/分 | — |
| 拿到服务器后的横向 | ❌ | 服务器本身最小化：无业务数据可拿 |

**最坏情况**：云主机被完全攻陷。攻击者能做的只有——看到谁在线、掐断连接。**看不到一个字节的终端内容**。这是这个设计最重要的性质。

---

## 11. 什么时候必须改架构

| 触发条件 | 需要做什么 |
| --- | --- |
| 连接数 > 5000 | 换 Go，或按 node 分片 + Redis |
| 要多机房就近接入 | Redis pub/sub 同步在线表 |
| 要给多人共享（团队） | 加用户系统 + 权限表，此时才需要数据库 |
| 要做 WebRTC 打洞 | relay 降级为信令服务器（更轻） |

**四条现在都不满足，所以现在不动。**
