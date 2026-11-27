# 13 · Relay 轻量化

回答一个问题：**服务端能不能只做 WS 流量中转，数据全留在宿主方？**

结论：**能，而且比 `docs/11-relay-design.md` 里的设计还能再轻一档。** 下面给三档方案，从"有信令"到"纯房间配对"。

---

## 1. 先看数据到底在哪

| 数据 | 位置 | relay 是否可见 |
| --- | --- | --- |
| 终端屏幕内容 | 宿主内存（session） | ✗（密文） |
| 最近 64 KB 输出（ring buffer） | 宿主内存 | ✗ |
| PTY fd / 子进程 | 宿主内核 | ✗ |
| 文件内容 | 宿主机磁盘 | ✗ |
| ACL 白名单 | 每个 peer 本机 | ✗ |
| 私钥 | 每个 peer 本机 | ✗ |
| session 元数据（目录、历史） | 宿主 | ✗ |
| **谁在线** | relay 内存 | ✓ |
| **哪两个 socket 配对** | relay 内存 | ✓ |
| 字节计数 | relay 内存 | ✓ |

**只有最后三项在服务端，而且都是"管道层的记账"，不是业务数据。** 重启 relay 这三项全丢，两端自动重连重建——丢的代价是零。

---

## 2. 三档轻量

```
   档位 A ── 在线表 + DIAL 信令          ≈ 250 行
            能看到谁在线，能主动选目标
            有 registry / pending / timeout / 撞车处理

   档位 B ── 房间模型（rendezvous string） ≈ 90 行
            取消注册、取消信令、取消在线感知
            两端各自算出同一个房间名，relay 只按房间配对

   档位 C ── 托管中继（不自建）           0 行
            用 Cloudflare Durable Objects / Ably 之类
            代价：依赖第三方、公司网络可能不通、信任边界外移
```

**推荐档位 B。** 它把 relay 削到极限，同时保留完整的安全模型。

---

## 3. 档位 B：房间模型

### 3.1 核心思路

两端不需要"告诉 relay 我是谁"，只需要"进入同一个房间"：

```
   room = SHA256( min(node_id_A, node_id_B) + ":" + max(node_id_A, node_id_B) )

   office-mini ──▶ wss://relay/r/<room> ──┐
                                           ├── relay 发现房间里有 2 个 → 直接 pipe
   home-mbp   ──▶ wss://relay/r/<room> ──┘
```

relay 不知道 node_id、不知道谁连谁、不知道要开什么通道。它只知道"这个字符串对应的房间里现在有几个人"。

### 3.2 与档位 A 的差别

| 能力 | 档位 A | 档位 B |
| --- | --- | --- |
| 主动选目标节点 | ✓ `DIAL(target)` | ✗ 只能连"我和你的房间" |
| 感知对端是否在线 | ✓ `DIAL_ERR{offline}` | ✗ 连上后静默等待 |
| 注册 / 在线表 | 需要 | **不需要** |
| 信令帧 | 5 种 | **0 种** |
| 超时处理 | 需要 | **不需要** |
| 撞车处理 | 需要 tie-break | **不需要**（谁先进房间谁等） |
| 代码量 | 250 行 | **90 行** |

对个人使用来说，牺牲的两项几乎无感：你本来就知道要连哪台机器；对端不在线时，"静默等待、一上线立刻桥接"其实比"报错 offline 让你重试"体验更好。

### 3.3 完整实现

```python
# relay/relay.py —— 档位 B，约 90 行
import asyncio, os, time
from contextlib import suppress
import websockets

MAX_ROOM = 2
MAX_CONN = 20
rooms: dict[str, list] = {}          # room_key -> [ws, ws]
bytecount = {"up": 0, "down": 0}     # 仅统计，不落盘

async def pump(src, dst, direction):
    try:
        async for msg in src:
            bytecount[direction] += len(msg)
            await dst.send(msg)
    except Exception:
        pass
    finally:
        with suppress(Exception):
            await dst.close()

async def handle(ws):
    if sum(len(v) for v in rooms.values()) >= MAX_CONN:
        await ws.close(1013, "server_full")
        return

    path = getattr(getattr(ws, "request", None), "path", "") or ""
    room = path.rsplit("/", 1)[-1]
    if len(room) != 64 or not all(c in "0123456789abcdef" for c in room):
        await ws.close(1008, "bad_room")
        return

    peers = rooms.setdefault(room, [])
    if len(peers) >= MAX_ROOM:
        await ws.close(1013, "room_full")
        return

    peers.append(ws)
    try:
        # 房间未满：静候对端（这就是"等待上线"的实现）
        while len(peers) < 2:
            await asyncio.sleep(0.2)
            if ws.state.name != "OPEN":
                return
        other = peers[0] if peers[1] is ws else peers[1]
        await asyncio.gather(
            pump(ws, other, "up"),
            pump(other, ws, "down"),
            return_exceptions=True,
        )
    finally:
        with suppress(ValueError):
            peers.remove(ws)
        if not peers:
            rooms.pop(room, None)

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

就这么多。**没有 registry，没有 pending，没有 DIAL，没有 JSON 解析，没有帧格式认知。**

### 3.4 安全模型的变化（必须知道）

档位 A 里 ACL 在信令层就能拒绝（`DIAL_ERR{denied}`），档位 B 没有信令层，所以：

```
   ① relay 只在"房间满 2 人"时桥接 —— 这是唯一的结构性限制
   ② 桥接后立刻做端到端握手，交换并验证 node_id
   ③ 若对方 node_id 不在本机 ACL → 立即断开
   ④ 若握手失败（不是合法 peer）→ 立即断开
```

代价：未授权连接会**消耗一次握手**才被踢掉（几百字节、几毫秒）。收益：relay 完全不知道身份。

另外：房间名由两个 node_id 算出，而 node_id 是公钥哈希——**知道双方公钥的第三方能算出房间名并抢占一个位置**。防护靠第 ③ 步的 ACL 校验，以及端到端握手的签名。要更严的话，房间名改用配对时交换的 `pair_secret`（只在两台机器之间共享），relay 就更无从推算。

---

## 4. relay 无法消除的最小状态

即使削到 90 行，有三件事**在原理上**无法外置：

| 状态 | 为什么不能省 |
| --- | --- |
| 哪两个 socket 配对 | 桥接的必要条件，不记就不知道该往哪发 |
| 连接是否存活 | 断了要清理，否则内存泄漏 |
| 房间占用计数 | 防止第三个连接挤进来 |

除非引入第三方信令（档位 C），否则这三项必须留在 relay 内存里。

**所以"只做 WS 中转"的准确表述是：**

> 零业务数据、零会话状态、零身份数据库；
> 只保留"配对关系"这一项，且它在内存里、重启即可丢弃。

---

## 5. 运维成本

| 项 | 档位 B |
| --- | --- |
| 文件 | 1 个 `.py`，无配置 |
| 依赖 | `websockets` 一个包 |
| 密钥 | **不需要任何密钥** |
| 数据库 | 无 |
| 内存 | < 30 MB（10 个 bridge） |
| CPU | 几乎为零（只 memcpy） |
| 机器 | 1 核 512 MB 足够，能跑在树莓派 / NAS 上（有公网即可） |
| 重启 | 全部桥断开，两端在退避周期内自动恢复 |

systemd 八行：

```ini
[Unit]
Description=remote-pty relay
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/rpty/relay.py
Restart=always
RestartSec=2
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

TLS 交给 nginx 或 Caddy。Caddy 只要两行：

```
relay.example.com {
    reverse_proxy /r/* 127.0.0.1:8765
}
```

> nginx 反代 WS 必须带 `Upgrade` / `Connection` 头，Caddy 自动处理——这也是"轻"的一部分。

---

## 6. 档位 C：完全不自建

如果连 90 行都不想维护：

| 方案 | 可行性 | 问题 |
| --- | --- | --- |
| Cloudflare Durable Objects | 技术上完美（一个 DO 就是一个房间） | 需 CF 账号；公司网络访问 CF 可能异常；免费额度够个人用 |
| Ably / Pusher | 有 WS 通道 | 是消息服务，不是字节管道，要包一层；按量计费 |
| 公共 WebSocket 中继 | 不推荐 | 不知道对方拿你的流量做什么 |

诚实建议：**档位 B 的 90 行已经是"轻"的极限区间了**，再往下换来的复杂度（第三方账号、计费、可用性依赖）大于省下的代码。

---

## 7. 建议

```
   起步：档位 B（房间模型）
         90 行，零配置，零密钥，内存态，重启无害

   如果以后需要"看谁在线 / 主动选节点"：
         加回档位 A 的 REGISTER + DIAL（+160 行）
         这是功能升级，不是架构改变——桥上跑的东西完全一样
```

关键判断：**档位 A → B 只是把"信令"换成了"约定"，桥接层和上面所有东西（加密、mux、session、ACL）一行都不用改。**

所以先做 B，以后要 A 时再加，不存在返工。

---

## 8. 一句话总结

> 服务端只是**一根带房间的门**：知道谁进了哪个屋、屋里够两个人就把两头接上。
> 它不知道你们是谁、在说什么、说了什么。
> 屋子里的家具（session、文件、历史）全在你自己的机器上。
