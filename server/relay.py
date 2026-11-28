#!/usr/bin/env python3
"""
rpty relay —— 云中继。

三个端点：

    /agent        被控端（PTY 宿主）长连接，JSON 信令，?node=<id> 区分节点
    /ctl          控制端长连接，JSON 信令
    /d/<token>    某个会话的数据通道，纯二进制

一台 relay 可以同时挂多个宿主节点（各自一个 node_id），控制端创建终端时用
target 指定开在哪台。不同节点互不顶替，只有同一个 node_id 重连才算替换。

数据通道是 **1:N 多播**：一个 PTY 只有一条 agent 侧连接（role=agent），
可以有任意多条控制端连接（role=ctl）。agent 的输出广播给所有 viewer，
任何 viewer 的按键都汇进同一条连接写回 PTY —— 这就是「多个客户端看同一
块终端、谁敲都同步」的模式（Orca Mobile 那种镜像）。

新 viewer 连上时，relay 给 agent 发 VIEWER_JOINED，agent 回一份环形缓冲
快照，relay 定向只发给这个新 viewer，然后才开始给它推增量。中间到得太
早的增量先排队，不会和历史混序。

relay 不解析终端字节流、不生成会话 id；token 由控制端生成。

状态模型（一份事实，三个实体）：

    Client {id, conns[], name, host, pair}   —— 一个客户端进程 = 在线列表的一行
    Node   {id, ws, name, platform, last_list} —— 一台被控机上的宿主进程
    Session{id, token, node, owner, index, ...} —— 一个 PTY：跑在哪、属于谁、几号

    外加两张纯索引：by_ws（连接 → 客户端）、viewers（cid → viewer，供快照定向）。

「谁在线」= clients 里那条有没有 conns；「谁连着谁」= Client.host / Client.pair。
归属、编号、认领记录落盘在 RPTY_STATE_FILE，重启后不换主人、不重号。

环境变量：
    RPty_TOKEN      必填，agent 与 ctl 共用的共享密钥
    RPty_HOST       默认 127.0.0.1
    RPty_PORT       默认 8765
    RPty_STATE_FILE 默认 /data/relay-state.json
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed

# ---- websockets 12.x / 15.x 差异，全部收在这十几行里 ---------------------
# 15 起默认换成新的 asyncio 实现：handler 收到的是 ServerConnection，
# 路径在 ws.request.path 上，process_request 的第一个参数也从 path 变成了连接对象。
# 12.x 还是老实现（ws.path、process_request(path, headers)）。两套都认，
# 这样镜像里装哪个版本都能起，升级只是部署时机问题。
try:  # 15+
    from websockets.asyncio.server import ServerConnection as WSConn
    from websockets.asyncio.server import serve as ws_serve
    from websockets.http11 import Response as HTTPResponse

    NEW_WS_API = True
except ImportError:  # 12.x
    from websockets.server import WebSocketServerProtocol as WSConn  # type: ignore[assignment]
    from websockets.server import serve as ws_serve  # type: ignore[assignment]

    HTTPResponse = None  # type: ignore[assignment]
    NEW_WS_API = False


def ws_path(ws: Any) -> str:
    """取请求路径：老实现挂在 ws.path，新实现挂在 ws.request.path。"""
    path = getattr(ws, "path", None)
    if path:
        return str(path)
    request = getattr(ws, "request", None)
    return str(getattr(request, "path", "") or "")

LOG = logging.getLogger("relay")

# 终端输出可能一次来很大（比如 cat 一个二进制文件），但不能无限。
MAX_MESSAGE = 8 * 1024 * 1024
# viewer 还没拿到快照时最多替它排队多少条增量，超了就丢（宁可少画一段也不能撑爆内存）。
VIEWER_QUEUE_MAX = 512


# ---------------------------------------------------------------- 状态模型


@dataclass
class Node:
    """一台被控机上的宿主进程。"""

    id: str
    ws: Optional[Any] = None
    name: str = ""
    platform: str = ""
    # 最近一次这个节点报上来的会话列表，新控制端一连上就能拿到。
    last_list: Optional[Dict[str, Any]] = None

    def summary(self) -> Dict[str, Any]:
        sessions = (self.last_list or {}).get("sessions") or []
        return {
            "node": self.id,
            "name": self.name or self.id,
            "platform": self.platform,
            "online": self.ws is not None,
            "sessions": len(sessions),
        }


@dataclass
class Client:
    """一个客户端进程 —— 在线列表的一行。

    conns 是集合：同一个 client id 开两个窗口时，它们是同一个客户端的两条连接。
    任一条断开只摘掉自己，最后一条断开才把这个人从在线表移除。
    """

    id: str
    conns: set = field(default_factory=set)
    name: str = ""
    # 它认领的宿主 node id（本机 agent）；没认领就是空。
    host: str = ""
    # 「我进了谁」：{"to": 目标 client id, "node": 目标宿主}，没配对就是 None。
    pair: Optional[Dict[str, str]] = None

    @property
    def online(self) -> bool:
        return bool(self.conns)


@dataclass
class Session:
    """一个 PTY 会话：跑在哪台宿主、属于哪个客户端的桌面、编号几号。"""

    id: str
    token: str = ""
    node: str = ""
    # 谁的桌面（client id）。空 = 无主，会被认领给 default_claimant。
    owner: str = ""
    index: int = 0
    cols: int = 0
    rows: int = 0
    # 归属是"认领"来的（不是真的由某个客户端创建）。换主人时只迁移这些。
    claimed: bool = False


@dataclass
class Viewer:
    """一条控制端数据通道。"""

    cid: str
    ws: Any
    token: str
    # 还没拿到快照前，增量先排队，保证「历史在前、增量在后」的顺序。
    ready: bool = False
    queue: List[bytes] = field(default_factory=list)


@dataclass
class Channel:
    """一个 data_token 对应的多播通道。"""

    token: str
    agent: Optional[Any] = None
    # 这条通道的 PTY 属于哪个节点，补快照时才知道该找谁要。
    node: str = ""
    # 谁创建的会话谁定尺寸，避免多端互相抢 PTY 的 cols/rows。
    creator: Optional[Any] = None
    viewers: Dict[str, Viewer] = field(default_factory=dict)


class Relay:
    def __init__(self, token: str) -> None:
        self.token = token

        # ---- 三张主表
        # node_id -> Node，多台机器可以同时在线。
        self.nodes: Dict[str, Node] = {}
        # client id -> Client，在线列表就是这个；匿名连接归在 key="" 的桶里。
        self.clients: Dict[str, Client] = {}
        # session_id -> Session，同时承担路由 / 归属 / 发号。
        self.sessions: Dict[str, Session] = {}

        # ---- 两张索引
        # 连接 -> 客户端，握手时建，断开时删。
        self.by_ws: Dict[Any, Client] = {}
        # data_token -> 多播通道。
        self.channels: Dict[str, Channel] = {}
        # cid -> viewer，用于把 agent 的快照定向投给某一个 viewer。
        self.viewers: Dict[str, Viewer] = {}
        self._cid_seq = 0

        # 全局会话编号：多节点各自从 1 数会撞号，由 relay 统一分配。
        self.seq = 0

        # 无主会话（归属机制上线前建的、或 relay 重启把表弄丢的）统一认给第一个
        # 带 client 参数连上的控制端。这样「共享」标签永远只出现在非主人那一端，
        # 不会出现两个窗口都标共享的情况。
        self.default_claimant: str = ""
        self.claimant_primary = False

        # 归属与编号落盘，relay 重启不再把这些状态清零。
        self.state_file = os.environ.get("RPTY_STATE_FILE", "/data/relay-state.json")
        self._load_state()

        self.started_at = time.time()
        self.stats = {
            "sessions_opened": 0,
            "bytes_from_ctl": 0,
            "bytes_from_agent": 0,
        }

    # ---------------------------------------------------------------- 工具

    async def send_json(self, ws: Optional[Any], payload: Dict[str, Any]) -> None:
        if ws is None:
            return
        try:
            await ws.send(json.dumps(payload, ensure_ascii=False))
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001 - 对端已死不该影响另一方
            LOG.debug("send_json 失败", exc_info=True)

    def check_token(self, path: str) -> bool:
        query = parse_qs(urlparse(path).query)
        supplied = (query.get("token") or [""])[0]
        # 长度不等的比较会泄漏长度，用固定时间比较。
        return len(supplied) == len(self.token) and _const_eq(supplied, self.token)

    def ctl_conns(self) -> List[Any]:
        """此刻在线的所有控制端连接（广播用快照，避免 await 期间被改）。"""
        return [ws for client in self.clients.values() for ws in list(client.conns)]

    def _ensure_client(self, ws: Any, client_id: str, name: str = "", host: str = "") -> Client:
        client = self.clients.get(client_id)
        if client is None:
            client = Client(id=client_id)
            self.clients[client_id] = client
        client.conns.add(ws)
        self.by_ws[ws] = client
        if name and not client.name:
            client.name = name
        if host:
            client.host = host
        return client

    def _ensure_session(self, sid: str) -> Session:
        session = self.sessions.get(sid)
        if session is None:
            session = Session(id=sid)
            self.sessions[sid] = session
        return session

    def _ensure_channel(self, token: str) -> Channel:
        channel = self.channels.get(token)
        if channel is None:
            channel = Channel(token=token)
            self.channels[token] = channel
        return channel

    # ---------------------------------------------------------------- HTTP

    async def process_request(self, *args: Any) -> Any:
        """给 /healthz 一个真正的 HTTP 响应，不动 WebSocket 路径。

        两种签名都认：
          12.x  process_request(path: str, headers) -> (status, headers, body)
          15.x  process_request(connection, request) -> Response（走 connection.respond 那一套）
        """
        first = args[0] if args else ""
        if isinstance(first, str):
            connection = None
            path = first
        else:
            connection = first
            request = args[1] if len(args) > 1 else getattr(connection, "request", None)
            path = ws_path(connection) or str(getattr(request, "path", "") or "")

        if urlparse(path).path != "/healthz":
            return None

        nodes = {nid: n.summary() for nid, n in self.nodes.items()}
        payload = json.dumps(
            {
                "ok": True,
                "uptime": int(time.time() - self.started_at),
                "agent": any(n.ws is not None for n in self.nodes.values()),
                "ctl": bool(self.by_ws),
                "ctls": len(self.by_ws),
                "nodes": nodes,
                "clients": self.clients_summary(),
                "channels": len(self.channels),
                "viewers": sum(len(c.viewers) for c in self.channels.values()),
                **self.stats,
            },
            ensure_ascii=False,
        ).encode()

        if NEW_WS_API and HTTPResponse is not None:
            return HTTPResponse(
                200,
                "OK",
                Headers({"Content-Type": "application/json"}),
                payload,
            )
        return (200, [("Content-Type", "application/json")], payload)

    # ---------------------------------------------------------------- 入口

    async def handle(self, ws: Any) -> None:
        path = ws_path(ws)
        route = urlparse(path).path

        if not self.check_token(path):
            LOG.warning("鉴权失败 route=%s remote=%s", route, ws.remote_address)
            await ws.close(code=4001, reason="unauthorized")
            return

        if route == "/agent":
            query = parse_qs(urlparse(path).query)
            node_id = ((query.get("node") or [""])[0] or "default").strip()
            await self.handle_agent(ws, node_id)
        elif route == "/ctl":
            await self.handle_ctl(ws)
        elif route.startswith("/d/"):
            token = route[len("/d/"):]
            if not token:
                await ws.close(code=4004, reason="missing token")
                return
            query = parse_qs(urlparse(path).query)
            role = (query.get("role") or ["ctl"])[0]
            node_id = (query.get("node") or [""])[0]
            await self.handle_data(ws, token, role, node_id)
        else:
            await ws.close(code=4004, reason="unknown route")

    # ------------------------------------------------------------ 状态落盘

    def _load_state(self) -> None:
        """启动时把上次的归属、编号、认领者读回来。

        没有这个，relay 每重启一次，所有终端就"换一次主人"：编号从头数、
        归属全清空，用户看到的就是两个窗口都标共享。
        """
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return
        except Exception as exc:  # 文件坏了不该拦住 relay 启动
            LOG.warning("状态文件读取失败：%s", exc)
            return

        owners = data.get("owners") or {}
        if isinstance(owners, dict):
            for sid, owner in owners.items():
                if sid and owner:
                    self._ensure_session(str(sid)).owner = str(owner)

        index = data.get("index") or {}
        if isinstance(index, dict):
            for sid, idx in index.items():
                try:
                    value = int(idx)
                except (TypeError, ValueError):
                    continue
                if sid and value > 0:
                    self._ensure_session(str(sid)).index = value

        claimant = data.get("claimant") or ""
        if isinstance(claimant, str) and claimant:
            self.default_claimant = claimant
        self.claimant_primary = bool(data.get("claimant_primary"))

        claimed = data.get("claimed") or []
        if isinstance(claimed, list):
            for sid in claimed:
                if sid:
                    self._ensure_session(str(sid)).claimed = True

        self.seq = max((s.index for s in self.sessions.values()), default=0)
        LOG.info(
            "恢复状态：会话 %d 条（有主 %d），认领者 %s",
            len(self.sessions),
            sum(1 for s in self.sessions.values() if s.owner),
            self.default_claimant[:8] or "-",
        )

    def _save_state(self) -> None:
        """整份写回。会话数量在几十的量级，直接覆盖比增量维护省事。

        文件格式与旧版保持一致（owners / index / claimant / claimant_primary / claimed），
        线上 /data/relay-state.json 不需要迁移。
        """
        tmp = f"{self.state_file}.tmp"
        try:
            os.makedirs(os.path.dirname(self.state_file) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "owners": {s.id: s.owner for s in self.sessions.values() if s.owner},
                        "index": {s.id: s.index for s in self.sessions.values() if s.index > 0},
                        "claimant": self.default_claimant,
                        "claimant_primary": self.claimant_primary,
                        "claimed": sorted(s.id for s in self.sessions.values() if s.claimed),
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp, self.state_file)
        except Exception as exc:
            LOG.warning("状态保存失败：%s", exc)

    def _promote_claimant(self, client_id: str) -> None:
        """把「无主会话」的主人换成主窗口，并把它之前认领来的归属一起搬过去。

        只搬自己认领来的（claimed），真正由别人创建的会话不动 ——
        否则你在副本窗口里新建的终端会莫名其妙变成主窗口的。
        """
        old = self.default_claimant
        if old == client_id:
            self._save_state()
            return
        self.default_claimant = client_id
        moved = 0
        for session in self.sessions.values():
            if session.claimed and (not old or session.owner == old):
                session.owner = client_id
                moved += 1
        self._save_state()
        LOG.info("主窗口认领：%s -> %s，迁移 %d 个会话", old[:8] or "-", client_id[:8], moved)

    # ---------------------------------------------------------------- 信令

    async def broadcast_ctls(self, payload: Dict[str, Any]) -> None:
        """把 agent 的消息广播给所有在线控制端。

        各客户端只认自己 bySessionId 里的 session_id，别人的会话消息会被忽略，
        所以广播是安全的；不用为每个会话追踪它属于哪个 ctl。
        """
        if isinstance(payload.get("sessions"), list):
            payload = self.decorate_sessions(payload)
        for ws in self.ctl_conns():
            await self.send_json(ws, payload)

    def decorate_sessions(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """广播前给每一行补上 owner：客户端靠它分清哪个终端是自己开的。

        没有 owner 的会话（归属机制上线前建的、或 relay 重启把表弄丢）在这里
        一次性认给默认认领者并落盘。不这么做的话，两端都说"不是我的"，
        同一个终端会同时挂两个「共享」标 —— 标签就失去了唯一性。
        """
        rows = []
        claimed = False
        for item in payload.get("sessions") or []:
            if isinstance(item, dict):
                sid = str(item.get("session_id") or "")
                session = self.sessions.get(sid) if sid else None
                owner = session.owner if session is not None else ""
                if not owner and sid and self.default_claimant:
                    session = self._ensure_session(sid)
                    session.owner = self.default_claimant
                    session.claimed = True
                    owner = session.owner
                    claimed = True
                    LOG.info("无主会话认领 sid=%s -> %s", sid[:8], owner[:8])
                rows.append({**item, "owner": owner})
            else:
                rows.append(item)
        if claimed:
            self._save_state()
        return {**payload, "sessions": rows}

    async def broadcast_nodes(self) -> None:
        """节点上下线、改名、会话数变化时，把所有节点的概览推给控制端。"""
        await self.broadcast_ctls(
            {"type": "NODES", "nodes": [n.summary() for n in self.nodes.values()]}
        )
        # 客户端列表里的「N 个终端」是算出来的，跟着一起刷新
        await self.broadcast_clients()

    def clients_summary(self) -> List[Dict[str, Any]]:
        """在线客户端列表 —— 用户看到的就是这个，不是节点。

        表里一行就是一个客户端；同一个 client id 的两条连接已经在 Client.conns 里合并。
        匿名连接（不带 client 参数）归在 key="" 的桶里，不进列表。
        """
        out: List[Dict[str, Any]] = []
        for client in self.clients.values():
            if not client.id:
                continue
            node = self.nodes.get(client.host) if client.host else None
            # 卡片上写的是「这个客户端自己的终端数」，不是整台机器上有多少：
            # 一张桌面一套终端，数别人的会让两个客户端都显示同一个大数字。
            alive = (
                {
                    str(row.get("session_id") or "")
                    for row in ((node.last_list or {}).get("sessions") or [])
                    if isinstance(row, dict)
                }
                if node
                else set()
            )
            out.append(
                {
                    "client": client.id,
                    "name": client.name,
                    "host": client.host,
                    "online": True,
                    "host_name": node.name if node else "",
                    "host_online": bool(node and node.ws is not None),
                    "sessions": sum(
                        1
                        for sid, session in self.sessions.items()
                        if session.owner == client.id and sid in alive
                    ),
                }
            )
        return out

    def pairs_summary(self) -> List[Dict[str, Any]]:
        """当前配对表（进 -> 被进）。目标客户端已经下线的配对自动作废，不再广播。"""
        out: List[Dict[str, Any]] = []
        for client in list(self.clients.values()):
            pair = client.pair
            if not pair:
                continue
            to = pair.get("to", "")
            target = self.clients.get(to) if to else None
            if target is None or not target.online:
                client.pair = None
                continue
            out.append(
                {
                    "from": client.id,
                    "from_name": client.name,
                    "to": to,
                    "to_name": target.name,
                    "node": pair.get("node", ""),
                }
            )
        return out

    async def broadcast_clients(self) -> None:
        await self.broadcast_ctls(
            {
                "type": "CLIENTS",
                "clients": self.clients_summary(),
                "pairs": self.pairs_summary(),
            }
        )

    def _apply_resize_to_lists(self, sid: str, cols: int, rows: int) -> None:
        """创建端改了窗口：把新尺寸写回缓存列表。

        不然新连上的客户端会拿旧行列去锁 xterm，换行位置和宿主对不上，
        窗口大小不一样时画面还会溢出容器。
        """
        for node in self.nodes.values():
            cached = node.last_list
            if not isinstance(cached, dict):
                continue
            sessions = cached.get("sessions")
            if not isinstance(sessions, list):
                continue
            changed = False
            next_sessions = []
            for item in sessions:
                if str((item or {}).get("session_id") or "") == sid:
                    item = {**item, "cols": cols, "rows": rows}
                    changed = True
                next_sessions.append(item)
            if changed:
                node.last_list = {**cached, "sessions": next_sessions}

    def _drop_from_lists(self, sid: str) -> None:
        """把某个会话从各节点的缓存列表里摘掉。

        不摘的话，后连上的客户端会从缓存里 adopt 一个已经被关掉的会话，
        拿到一块永远没有回显的黑屏。
        """
        for node in self.nodes.values():
            cached = node.last_list
            if not isinstance(cached, dict):
                continue
            sessions = cached.get("sessions")
            if not isinstance(sessions, list):
                continue
            node.last_list = {
                **cached,
                "sessions": [
                    item
                    for item in sessions
                    if str((item or {}).get("session_id") or "") != sid
                ],
            }

    async def handle_agent(self, ws: Any, node_id: str) -> None:
        node = self.nodes.get(node_id)
        if node is None:
            node = Node(id=node_id, name=node_id)
            self.nodes[node_id] = node

        previous = node.ws
        node.ws = ws
        if previous is not None and previous is not ws:
            LOG.info("节点 %s 重连，顶掉旧连接", node_id)
            await previous.close(code=4002, reason="replaced")

        LOG.info("节点 %s 上线 %s", node_id, ws.remote_address)
        await self.broadcast_ctls(
            {"type": "NODE_ONLINE", "node": node_id, "at": int(time.time())}
        )
        await self.broadcast_nodes()

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    LOG.warning("agent 发来非 JSON，丢弃")
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get("type")

                if kind == "SESSION_SNAPSHOT":
                    # 快照只补给它要补的那个新 viewer，不能广播，
                    # 否则已经开着画面的端会被历史重画一遍。
                    await self.deliver_snapshot(msg)
                    continue

                if kind == "HOST_EXIT":
                    # 宿主正常退出前主动告别：这台机器上的终端全没了。
                    # 直接让所有控制端清掉，别让他们守着一屏灰标签等超时。
                    LOG.info("节点 %s 主动退出（HOST_EXIT）", node_id)
                    node.last_list = {
                        "type": "SESSION_LIST",
                        "node": node_id,
                        "name": node.name,
                        "sessions": [],
                    }
                    await self.broadcast_ctls(
                        {"type": "NODE_GONE", "node": node_id, "reason": "host_exit"}
                    )
                    await self.broadcast_nodes()
                    continue

                if kind == "HELLO":
                    node.name = str(msg.get("name") or node_id)
                    node.platform = str(msg.get("platform") or "")
                    LOG.info("节点 %s 自报名称 %s / %s", node_id, node.name, node.platform)
                    await self.broadcast_nodes()
                    continue

                # 顺手记住 session 的归属，resize / close 没带 target 时靠它路由。
                if kind == "SESSION_CREATED":
                    sid = str(msg.get("session_id") or "")
                    token = str(msg.get("data_token") or "")
                    if sid and token:
                        session = self._ensure_session(sid)
                        session.token = token
                        session.node = node_id
                elif kind == "SESSION_LIST":
                    dirty = False
                    for item in msg.get("sessions") or []:
                        if not isinstance(item, dict):
                            continue
                        sid = str(item.get("session_id") or "")
                        token = str(item.get("data_token") or "")
                        if not sid:
                            continue
                        session = self._ensure_session(sid)
                        if token:
                            session.token = token
                            session.node = node_id
                        # 编号只认 relay 这一份。每个会话第一次出现时定号，之后不再变；
                        # 宿主自报的编号只在 relay 从没见过它时作为初值（relay 重启后的老会话），
                        # 没有再补一个，免得客户端拿到 0 只能自己数，两端数出不同的号。
                        if not session.index:
                            idx = item.get("index")
                            if isinstance(idx, int) and idx > 0:
                                session.index = idx
                                if idx > self.seq:
                                    self.seq = idx
                            else:
                                session.index = self.next_index()
                            dirty = True
                        item["index"] = session.index
                        LOG.debug("列表定号 sid=%s index=%s", sid[:8], session.index)
                    # 新定下来的编号要落盘，否则 relay 重启后又从 1 数起。
                    if dirty:
                        self._save_state()
                    node.last_list = {
                        **msg,
                        "node": node_id,
                        "name": node.name,
                        "src": "agent",
                    }
                    # 列表变化往往意味着会话数变了，节点概览跟着更新。
                    await self.broadcast_ctls(node.last_list)
                    await self.broadcast_nodes()
                    continue

                await self.broadcast_ctls({**msg, "node": node_id, "src": "agent"})
        except ConnectionClosed:
            pass
        finally:
            if node.ws is ws:
                node.ws = None
                LOG.info("节点 %s 下线", node_id)
                await self.broadcast_ctls({"type": "NODE_OFFLINE", "node": node_id})
                await self.broadcast_nodes()

    async def handle_ctl(self, ws: Any) -> None:
        query = parse_qs(urlparse(ws_path(ws)).query)
        client_id = ((query.get("client") or [""])[0] or "").strip()
        client_name = ((query.get("name") or [""])[0] or "").strip()
        host_hint = ((query.get("host") or [""])[0] or "").strip()
        client = self._ensure_client(ws, client_id, client_name, host_hint)

        # 谁是「无主会话」的主人：优先主窗口（默认数据目录，primary=1）。
        # 副本窗口即使先连上，也只是临时拿着，主窗口一连上就整体移交，
        # 这样不会因为启动顺序不同而让同一台终端换主人。
        primary = ((query.get("primary") or [""])[0] or "") == "1"
        if client_id:
            if primary and (not self.default_claimant or not self.claimant_primary):
                self.claimant_primary = True
                self._promote_claimant(client_id)
            elif not self.default_claimant:
                self.default_claimant = client_id
                self._save_state()
                LOG.info("默认认领者设为 %s（副本窗口）", client_id[:8])

        LOG.info(
            "ctl 上线 %s（当前 %d 条连接，client=%s）",
            ws.remote_address,
            len(self.by_ws),
            client_id[:8] or "-",
        )
        await self.broadcast_clients()

        await self.send_json(
            ws,
            {
                "type": "HELLO",
                "agent_online": any(n.ws is not None for n in self.nodes.values()),
                "nodes": [n.summary() for n in self.nodes.values()],
                "clients": self.clients_summary(),
                "pairs": self.pairs_summary(),
                "server_time": int(time.time()),
                "version": "1.3.0",
            },
        )
        # 先把各节点缓存的会话列表直接甩给新控制端 —— 它要在几百毫秒内知道
        # 每台机器上已经有谁在开终端，才不会急着自己新建一个。
        for node in self.nodes.values():
            if node.last_list is not None:
                await self.send_json(ws, self.decorate_sessions(node.last_list))
        # 再让每个节点补发一次权威列表（缓存可能过期：刚关/刚建）。
        for node in self.nodes.values():
            if node.ws is not None:
                await self.send_json(node.ws, {"type": "CTL_ONLINE"})

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    LOG.warning("ctl 发来非 JSON，丢弃")
                    continue
                if not isinstance(msg, dict):
                    continue

                await self._handle_ctl_signal(ws, client, msg)
        except ConnectionClosed:
            pass
        finally:
            await self._detach_client(ws)

    async def _handle_ctl_signal(self, ws: Any, client: Client, msg: Dict[str, Any]) -> None:
        msg_type = msg.get("type")

        if msg_type == "CTL_HOST":
            # 客户端认领了自己的宿主（本机 agent）。列表按客户端展示，
            # 这条归属决定了「进入这个客户端」到底连到哪台机器的终端。
            host = str(msg.get("host") or "").strip()
            if client.host != host:
                client.host = host
                LOG.info("客户端 %s 认领宿主 %s", (client.id or "-")[:8], host or "-")
                await self.broadcast_clients()
            return

        if msg_type in ("CTL_PAIR", "CTL_UNPAIR"):
            # 配对 = 「我进了哪个客户端」。不是节点订阅：一个宿主上可能挂着
            # 好几个客户端，谁进的谁、要说得清，才能两边都显示出来。
            changed = False
            if msg_type == "CTL_UNPAIR":
                if client.pair is not None:
                    client.pair = None
                    changed = True
            else:
                target = str(msg.get("client") or "")
                node = str(msg.get("node") or "")
                if client.id and node and target:
                    client.pair = {"to": target, "node": node}
                    changed = True
                    LOG.info(
                        "客户端 %s 进入客户端 %s（宿主 %s）",
                        client.name or client.id[:8],
                        str(msg.get("to_name") or target)[:12],
                        node,
                    )
                elif client.pair is not None:
                    client.pair = None
                    changed = True
            if changed:
                await self.broadcast_clients()
            return

        if msg_type == "CTL_LEAVE":
            # 客户端主动断开：**不连坐别人**。每个客户端是独立个体，
            # 它走了只是从在线列表里消失，别人照常连着。
            # 名字和宿主先留着 —— 等 ws 真断掉，finally 里连人带记录一起移除，
            # 期间列表不会闪出一条「没有名字、宿主未上线」的僵尸卡。
            LOG.info(
                "客户端 %s 主动断开（%s）",
                str(msg.get("by") or "-")[:8],
                client.name or "-",
            )
            return

        if msg_type not in ("SESSION_CREATE", "SESSION_CLOSE", "SESSION_RESIZE", "PING"):
            # 其它类型直接回显错误，避免静默吞掉。
            await self.send_json(
                ws,
                {"type": "ERROR", "code": "bad_type", "message": f"未知信令 {msg_type}"},
            )
            return

        if msg_type == "PING":
            await self.send_json(ws, {"type": "PONG", "at": int(time.time())})
            return

        node = self.resolve_node(msg)
        if node is None or node.ws is None:
            await self.send_json(
                ws,
                {
                    "type": "ERROR",
                    "code": "node_offline" if msg.get("target") else "no_target",
                    "message": (
                        f"节点 {msg.get('target')} 不在线"
                        if msg.get("target")
                        else "有多个节点在线，需要指定 target"
                    ),
                    "node": msg.get("target"),
                    "ref": msg.get("request_id"),
                },
            )
            return

        sid = str(msg.get("session_id") or "")
        token = str(msg.get("data_token") or "")

        if msg_type == "SESSION_CREATE":
            # 谁建谁定尺寸。attach 来的端只镜像，不改 PTY 大小。
            if token:
                channel = self._ensure_channel(token)
                channel.creator = ws
                channel.node = node.id
            # 编号由 relay 全局分配：多节点各自从 1 数必然撞号。
            # 但只在第一次见到这个会话时发号 —— 客户端重连会把自己建的会话
            # 补发一遍 SESSION_CREATE，重新发号会让同一个终端在两台机器上
            # 显示成两个不同的编号。
            session = self._ensure_session(sid) if sid else None
            if session is not None and session.index:
                msg["index"] = session.index
            else:
                msg["index"] = self.next_index()
                if session is not None:
                    session.index = msg["index"]
            if session is not None:
                session.node = node.id
                if token:
                    session.token = token
                # 我正在别人客户端里开终端：这个 PTY 属于那张桌面，
                # 否则它会挂在我名下、对方那边看不见。
                owner = client.id
                pair = client.pair or {}
                if pair.get("to"):
                    owner = pair["to"]
                if owner and not session.owner:
                    session.owner = owner
            self.stats["sessions_opened"] += 1
            # 新建的会话带上了归属与编号，立刻落盘。
            self._save_state()
        else:
            session = self.sessions.get(sid)
            channel = self.channels.get(session.token) if session and session.token else None
            if (
                msg_type == "SESSION_RESIZE"
                and channel is not None
                and channel.creator is not None
                and channel.creator is not ws
            ):
                # 镜像端不改 PTY 尺寸，否则两端会互相拉扯、画面来回跳。
                LOG.debug("忽略非 owner 的 resize sid=%s", sid[:8])
                return

            if msg_type == "SESSION_RESIZE":
                # 尺寸只由创建端决定。转给宿主的同时广播给其它控制端，
                # 让镜像端立刻换锁，不用等下一份 SESSION_LIST。
                try:
                    new_cols = int(msg.get("cols") or 0)
                    new_rows = int(msg.get("rows") or 0)
                except (TypeError, ValueError):
                    new_cols = new_rows = 0
                if new_cols < 20 or new_rows < 5:
                    # 客户端还没布局时量出的荒唐尺寸，别把 PTY 压坏。
                    LOG.warning("丢弃异常 resize %sx%s sid=%s", new_cols, new_rows, sid[:8])
                    return
                if session is not None:
                    session.cols = new_cols
                    session.rows = new_rows
                self._apply_resize_to_lists(sid, new_cols, new_rows)
                await self.broadcast_ctls(
                    {
                        "type": "SESSION_RESIZED",
                        "session_id": sid,
                        "node": node.id,
                        "cols": new_cols,
                        "rows": new_rows,
                    }
                )

            if msg_type == "SESSION_CLOSE":
                if sid:
                    # 有人主动点了 ×：从缓存里摘掉，并告诉所有控制端"这是关掉的，
                    # 不是断了" —— 他们要把标签留成灰色，而不是继续当活着。
                    self._drop_from_lists(sid)
                    await self.broadcast_ctls(
                        {
                            "type": "SESSION_CLOSED",
                            "session_id": sid,
                            "node": node.id,
                            "reason": "ctl",
                        }
                    )
                    await self.broadcast_nodes()

        await self.send_json(node.ws, {**msg, "src": "ctl"})

    async def _detach_client(self, ws: Any) -> None:
        """一条控制端连接走了：摘掉这条连接；最后一条走了才把这个人从表里删掉。"""
        client = self.by_ws.pop(ws, None)
        if client is None:
            return
        client.conns.discard(ws)
        if client.online:
            await self.broadcast_clients()
            return

        gone = client.id
        self.clients.pop(client.id, None)
        # 它进的别人、别人进它的配对，一起解除
        if gone:
            for other in self.clients.values():
                if other.pair and other.pair.get("to") == gone:
                    other.pair = None

        LOG.info("ctl 下线 %s（剩 %d 条连接）", ws.remote_address, len(self.by_ws))
        # 在线列表就是"此刻连着 wss 的客户端"，走了立刻从列表里消失
        await self.broadcast_clients()
        if not self.by_ws:
            for node in self.nodes.values():
                if node.ws is not None:
                    await self.send_json(node.ws, {"type": "CTL_OFFLINE"})

    def next_index(self) -> int:
        """分配下一个全局编号。

        relay 重启后 seq 归零，但各节点上还活着旧会话。先把已知的最大编号捞回来，
        否则新会话会从 1 开始和旧会话撞号。
        """
        known = [self.seq, *(s.index for s in self.sessions.values())]
        for node in self.nodes.values():
            for item in (node.last_list or {}).get("sessions") or []:
                idx = item.get("index")
                if isinstance(idx, int):
                    known.append(idx)
        self.seq = max(known) + 1
        return self.seq

    def resolve_node(self, msg: Dict[str, Any]) -> Optional[Node]:
        """决定这条信令该发给哪个节点。

        优先 target；否则按 session_id 反查（resize/close 常不带 target）；
        再否则：只有一个节点在线就用它 —— 兼容单机时代的老客户端。
        """
        target = str(msg.get("target") or "")
        if target:
            return self.nodes.get(target)

        sid = str(msg.get("session_id") or "")
        if sid:
            session = self.sessions.get(sid)
            if session is not None and session.node:
                return self.nodes.get(session.node)

        online = [n for n in self.nodes.values() if n.ws is not None]
        return online[0] if len(online) == 1 else None

    # ---------------------------------------------------------------- 数据

    def _next_cid(self) -> str:
        self._cid_seq += 1
        return f"v{self._cid_seq}"

    def _drop_channel_if_idle(self, token: str) -> None:
        channel = self.channels.get(token)
        if channel is None:
            return
        if channel.agent is None and not channel.viewers:
            self.channels.pop(token, None)

    async def handle_data(
        self, ws: Any, token: str, role: str, node_id: str = ""
    ) -> None:
        """一个 data_token 下的多播通道。

        role=agent：唯一一条，PTY 宿主。它发来的字节广播给所有 viewer。
        role=ctl  ：任意多条，都是 viewer。谁发的字节都转给 agent。
        """
        channel = self._ensure_channel(token)

        if role == "agent":
            previous = channel.agent
            channel.agent = ws
            # 老版本 agent 的 data_url 不带 node，用通道上记的节点兜底。
            if not node_id:
                node_id = channel.node
                if not node_id:
                    online = [n for n in self.nodes.values() if n.ws is not None]
                    if len(online) == 1:
                        node_id = online[0].id
            if node_id:
                channel.node = node_id
            if previous is not None and previous is not ws:
                LOG.info("数据通道 %s 的 agent 重连，顶掉旧连接", token[:8])
                try:
                    await previous.close(code=4002, reason="replaced")
                except Exception:  # noqa: BLE001
                    pass
            LOG.info("数据通道 %s agent 侧已连（viewer %d 个）", token[:8], len(channel.viewers))
            try:
                async for chunk in ws:
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8")
                    self.stats["bytes_from_agent"] += len(chunk)
                    for viewer in list(channel.viewers.values()):
                        if viewer.ready:
                            await self._send_bytes(viewer.ws, chunk)
                        elif len(viewer.queue) < VIEWER_QUEUE_MAX:
                            # 还没拿到快照，先攒着，别和历史串序。
                            viewer.queue.append(chunk)
            except ConnectionClosed:
                pass
            finally:
                if channel.agent is ws:
                    channel.agent = None
                    LOG.info("数据通道 %s agent 侧断开", token[:8])
                self._drop_channel_if_idle(token)
            return

        # ---- viewer
        cid = self._next_cid()
        viewer = Viewer(cid=cid, ws=ws, token=token)
        channel.viewers[cid] = viewer
        self.viewers[cid] = viewer
        LOG.info("数据通道 %s viewer %s 加入（共 %d）", token[:8], cid, len(channel.viewers))

        owner_node = self.nodes.get(channel.node or "")
        if owner_node is not None and owner_node.ws is not None:
            # 请 agent 回一份环形缓冲，只补这个新来的。
            # 注意：必须走信令连接 /agent —— 数据通道里的一切字节都会被当成
            # 键盘输入写进 PTY，信令发到那里就会把 JSON 打到终端上。
            await self.send_json(
                owner_node.ws, {"type": "VIEWER_JOINED", "data_token": token, "cid": cid}
            )
            # 兜底：agent 那边卡住（信令断、会话没了）也不能让 viewer 一直等，
            # 否则它收到的增量会无限期排队，看起来就是「连上了但没画面」。
            asyncio.get_running_loop().call_later(2.5, self._force_ready, cid)
        else:
            # 没有历史可补，直接开始收（等它重连后自动续上）。
            viewer.ready = True

        try:
            async for chunk in ws:
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                self.stats["bytes_from_ctl"] += len(chunk)
                agent_ws = channel.agent
                if agent_ws is not None:
                    try:
                        await agent_ws.send(chunk)
                    except Exception:  # noqa: BLE001
                        LOG.debug("转发按键到 agent 失败", exc_info=True)
        except ConnectionClosed:
            pass
        finally:
            channel.viewers.pop(cid, None)
            self.viewers.pop(cid, None)
            LOG.info("数据通道 %s viewer %s 离开（剩 %d）", token[:8], cid, len(channel.viewers))
            self._drop_channel_if_idle(token)

    async def _send_bytes(self, ws: Any, chunk: bytes) -> None:
        try:
            await ws.send(chunk)
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            LOG.debug("推送字节失败", exc_info=True)

    def _force_ready(self, cid: str) -> None:
        viewer = self.viewers.get(cid)
        if viewer is None:
            return
        if viewer.ready:
            return
        LOG.warning("viewer %s 等快照超时，直接放开增量", cid)
        # 复用 deliver_snapshot 的收尾逻辑：先把排队的增量按序放出去，再置 ready。
        asyncio.get_running_loop().create_task(self.deliver_snapshot({"cid": cid}))

    async def deliver_snapshot(self, msg: Dict[str, Any]) -> None:
        """agent 的快照按 cid 定向投递，并把它排队中的增量放行。"""
        cid = str(msg.get("cid") or "")
        viewer = self.viewers.get(cid)
        if viewer is None:
            return
        data_b64 = msg.get("data")
        if data_b64:
            try:
                await self._send_bytes(viewer.ws, base64.b64decode(data_b64))
            except Exception:  # noqa: BLE001
                LOG.warning("快照解码失败 cid=%s", cid, exc_info=True)

        # 历史先到，随后放开排队中的增量，画面就和实时接上了。
        viewer.ready = True
        queued = viewer.queue
        viewer.queue = []
        for chunk in queued:
            await self._send_bytes(viewer.ws, chunk)
        LOG.debug("快照已投递 cid=%s（补 %d 条增量）", cid, len(queued))


def _const_eq(a: str, b: str) -> bool:
    """固定时间字符串比较，避免通过响应时间猜 token。"""
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a.encode(), b.encode()):
        diff |= x ^ y
    return diff == 0


async def main() -> None:
    token = os.environ.get("RPty_TOKEN", "").strip()
    if not token:
        sys.exit("启动失败：环境变量 RPty_TOKEN 未设置")

    host = os.environ.get("RPty_HOST", "127.0.0.1")
    port = int(os.environ.get("RPty_PORT", "8765"))

    logging.basicConfig(
        level=os.environ.get("RPty_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    relay = Relay(token)

    async with ws_serve(
        relay.handle,
        host,
        port,
        max_size=MAX_MESSAGE,
        ping_interval=20,
        ping_timeout=20,
        process_request=relay.process_request,
    ):
        LOG.info("relay 监听 ws://%s:%d", host, port)
        stop = asyncio.get_running_loop().create_future()

        def _graceful() -> None:
            if not stop.done():
                stop.set_result(None)

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                asyncio.get_running_loop().add_signal_handler(sig, _graceful)
            except NotImplementedError:
                pass

        await stop
        LOG.info("收到退出信号，正在关闭")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
