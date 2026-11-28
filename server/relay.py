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

状态模型（一份事实，四个实体）：

    Client {id, conns[], name, host, room}   —— 一个客户端进程 = 在线列表的一行
    Node   {id, ws, name, platform, last_list} —— 一台被控机上的宿主进程
    Session{id, token, node, owner, room, index} —— 一个 PTY：跑在哪、属于谁、几号
    Room   {id, members[2], state, sessions}  —— 一次一对一通话，房间外不可见

「谁在线」= clients 里那条有没有 conns；「谁在通话中」= Client.room 非空。
会话有两个可见域：私有（owner = 某个客户端）和房间（room = 某次通话）。
**服务端按可见域逐个挑人发**，不是"广播给所有人、客户端自己过滤" —— 后者是自觉，不是边界。

房间是强耦合的：一方断线先进入 30 秒宽限（断网重连能续），超时或任一方离开就关房，
房间里的 PTY 一起销毁，两人都回到列表。
归属、编号、认领记录、房间落盘在 RPTY_STATE_FILE，重启后不换主人、不重号、不泄密。

环境变量：
    RPty_TOKEN      必填，agent 与 ctl 共用的共享密钥
    RPty_HOST       默认 127.0.0.1
    RPty_PORT       默认 8765
    RPty_STATE_FILE 默认 /data/relay-state.json
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed

# ---- websockets 12.x / 15.x 差异，全部收在这十几行里 ---------------------
# 15 起默认换成新的 asyncio 实现：handler 收到的是 ServerConnection，
# 路径在 ws.request.path 上，process_request 的第一个参数也从 path 变成了连接对象。
# 12.x 还是老实现（ws.path、process_request(path, headers)）。两套都认，
# 这样镜像里装哪个版本都能起，升级只是部署时机问题。
try:  # 15+
    from websockets.asyncio.server import serve as ws_serve
    from websockets.http11 import Response as HTTPResponse

    NEW_WS_API = True
except ImportError:  # 12.x
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
# 单个 viewer 在等快照期间最多替它攒多少字节。超了就断开它 ——
# 重连会走 SESSION_SNAPSHOT 重新取屏，比让整台 relay 被一个卡死的客户端拖死划算。
VIEWER_QUEUE_BYTES = 8 * 1024 * 1024
# 房间一方断线后的宽限期：断网重连能续上，超过就关房并销毁终端。
# 不做宽限的话，Wi-Fi 抖一下就把 vim 里没保存的东西一起带走。
ROOM_GRACE_SECONDS = 30.0
# 邀请的有效期：过期的邀请不该还能被同意 —— 那等于可以替十分钟前的自己决定。
# 通话密码：默认值故意写死在两边（客户端缺省、服务端只用来算"是不是还在用默认密码"）。
# 服务端只存 PBKDF2 哈希，不存明文、不落盘。轮数取 120k：一次握手几毫秒，暴力试也没那么便宜。
DEFAULT_PASSWORD = "admin123"
PASSWORD_MIN = 6
PASSWORD_ROUNDS = 120_000


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
    # 所在房间 id。空 = 不在房间里（待匹配状态）。排他：一个人同时只能在一个房间。
    room: str = ""
    # 通话密码的 PBKDF2 哈希（salt = client id）。空 = 这个客户端还没上报密码，
    # 谁也匹配不进来。明文只在客户端自己的 userData 里，relay 不碰。
    pw_hash: str = ""
    # 还在用默认密码 admin123：UI 要显性提示，不然等于告诉别人"试 admin123 就能进"。
    pw_default: bool = False

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
    # 只在**私有域**里有意义：room 非空时，可见性完全由房间决定，owner 不参与。
    owner: str = ""
    # 可见域二：房间 id。非空 = 这条终端属于房间，只有房间成员看得见。
    room: str = ""
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
    # 队列已攒的字节数。只按条数限流是不够的：一条 8MB 的帧重复 512 次，
    # 就是 4GB —— 这台 relay 所在机器只有 1.6GiB 且没有 swap，会直接被 OOM 杀掉。
    queue_bytes: int = 0


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


@dataclass
class Room:
    """一次一对一通话：两个客户端，共享同一批终端，房间外不可见。

    生命周期就是"两条连接同时都在"的那段时间：

        INVITE → ACCEPT → open ──一方断线──→ half（30 秒宽限）
                            └──重连──────────→ open
                            └──超时 / 任一方离开 / 关窗──→ 关闭（终端一起销毁）

    排他：一个客户端同时只能在一个房间里，所以 members 最多两个。
    """

    id: str
    members: List[str] = field(default_factory=list)
    # open：两人都连着；half：一方断线，正在等它重连。
    state: str = "open"
    # 房间里的 session_id，关房时按这份名单让宿主销毁 PTY。
    sessions: set = field(default_factory=set)
    # 从两人各自的私有桌面「借」进来的 session_id：本来就在跑，散场时还回去，
    # PTY 不杀。房间里现开的那些不在这张名单上，关房就跟着房间一起销毁。
    borrowed: set = field(default_factory=set)
    created_at: float = 0.0


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

        # ---- 房间：一对一的私密会话
        # room_id -> Room。房间里的终端只有 members 看得见。
        self.rooms: Dict[str, Room] = {}
        # 待对方同意的邀请：被邀请的 client id -> {"from": 谁, "at": 什么时候}
        # 邀请那套已经删掉：配对靠密码，不再需要"待处理的邀请"这张表。
        # 宽限期计时器：room_id -> 定时任务，重连时要能取消。
        self._room_timers: Dict[str, Any] = {}
        self._room_seq = 0

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
            client_id = (query.get("client") or [""])[0]
            await self.handle_data(ws, token, role, node_id, client_id)
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

        # 房间也要活过重启：否则 relay 一重启，房间里的终端全变成"无主"，
        # 谁都能看见 —— 那就是隐私漏洞，不是可用性问题。
        rooms = data.get("rooms") or {}
        if isinstance(rooms, dict):
            for room_id, raw in rooms.items():
                if not isinstance(raw, dict):
                    continue
                members = [str(x) for x in (raw.get("members") or []) if x]
                if len(members) != 2:
                    continue
                room = Room(
                    id=str(room_id),
                    members=members,
                    state=str(raw.get("state") or "half"),
                    created_at=float(raw.get("created_at") or 0),
                )
                self.rooms[room.id] = room
                for sid in raw.get("sessions") or []:
                    session = self._ensure_session(str(sid))
                    session.room = room.id
                    room.sessions.add(str(sid))
                for sid in raw.get("borrowed") or []:
                    room.borrowed.add(str(sid))

        for sid, room_id in (data.get("session_room") or {}).items():
            if sid and room_id and str(room_id) in self.rooms:
                self._ensure_session(str(sid)).room = str(room_id)

        self._room_seq = max(
            (
                int(room.id[1:])
                for room in self.rooms.values()
                if room.id[:1] == "r" and room.id[1:].isdigit()
            ),
            default=0,
        )

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
                        # 房间与会话的可见域一起落盘：重启后房间里的终端仍然是私密的，
                        # 不能退化成"无主"被谁都能看见。
                        "rooms": {
                            room.id: {
                                "members": list(room.members),
                                "state": room.state,
                                "created_at": room.created_at,
                                "sessions": sorted(room.sessions),
                                "borrowed": sorted(room.borrowed),
                            }
                            for room in self.rooms.values()
                        },
                        "session_room": {
                            s.id: s.room for s in self.sessions.values() if s.room
                        },
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

    # ------------------------------------------------------------ 可见性

    async def _push_session_lists(
        self, client_id: str, ws: Optional[Any] = None
    ) -> None:
        """把这个客户端能看的会话列表推一遍（逐行过滤，绝不整份转手）。

        HELLO 时推一次让客户端认路；房间刚开 / 重连回房间时再推一次 ——
        不然宽限期内别人在房间里开的终端，回来的这一端要等到下次变更才看得见。
        """
        for node in self.nodes.values():
            if node.last_list is None:
                continue
            decorated = self.decorate_sessions(node.last_list)
            rows = [
                row
                for row in (decorated.get("sessions") or [])
                if self._row_visible(client_id, row)
            ]
            payload = {**decorated, "sessions": rows}
            if ws is not None:
                await self.send_json(ws, payload)
            else:
                await self._send_to_client(client_id, payload)

    def _session_visible(self, client_id: str, session: Session) -> bool:
        """一条终端对某个客户端是否可见 —— 「小黑屋」的唯一判据。

        两个可见域，只有这两种：

        房间域（session.room 非空）：只有房间成员看得见。房间外的人连列表都收不到，
            数据面也用同一条判断（P2 在 /d 上再拦一道）。
        私有域（session.room 为空）：只有主人看得见；无主的归默认认领者。

        注意：这里判断的是"服务端发不发"，不是"界面显不显示"。界面过滤是客户端自觉，
        不能当隐私边界用。
        """
        if session.room:
            room = self.rooms.get(session.room)
            return bool(room) and client_id in room.members
        if session.owner:
            return session.owner == client_id
        # 无主：归默认认领者。没有认领者时（单客户端刚起的场景）才放开。
        return client_id == self.default_claimant or not self.default_claimant

    def _row_visible(self, client_id: str, row: Dict[str, Any]) -> bool:
        """列表里的一行（SESSION_LIST 的 item）是否该发给这个客户端。"""
        sid = str((row or {}).get("session_id") or "")
        session = self.sessions.get(sid) if sid else None
        if session is not None:
            return self._session_visible(client_id, session)
        # 没有会话记录的（老状态、宿主刚重启还没对齐）：只认行上的 owner。
        # 判不出来就不发 —— 宁可少显示一条，不可多泄露一条。
        return str((row or {}).get("owner") or "") == client_id

    # ------------------------------------------------------------ 房间

    def _client_room(self, client_id: str) -> Optional[Room]:
        client = self.clients.get(client_id)
        if client is None or not client.room:
            return None
        return self.rooms.get(client.room)

    async def _send_to_client(self, client_id: str, payload: Dict[str, Any]) -> None:
        client = self.clients.get(client_id)
        if client is None:
            return
        for ws in list(client.conns):
            await self.send_json(ws, payload)

    def _new_room_id(self) -> str:
        self._room_seq += 1
        return f"r{self._room_seq:04d}"

    def _peer_of(self, room: Room, client_id: str) -> str:
        for cid in room.members:
            if cid != client_id:
                return cid
        return ""

    async def _open_room(self, a: str, b: str) -> Room:
        """双向同意后建房间：两人各收一份 ROOM_OPEN，带对方的客户端卡片。"""
        room = Room(id=self._new_room_id(), members=[a, b], created_at=time.time())
        self.rooms[room.id] = room
        for cid in (a, b):
            client = self.clients.get(cid)
            if client is not None:
                client.room = room.id
        # 两人已有的私有终端跟着进房间：点「邀请」要的就是「两边合到一处」，
        # 不是进一个空房间再让对面现开一个。借来的散场时还给原主人，进程不杀。
        for cid in (a, b):
            for session in list(self.sessions.values()):
                if session.room or session.owner != cid:
                    continue
                session.room = room.id
                room.sessions.add(session.id)
                room.borrowed.add(session.id)

        self._save_state()

        for cid in (a, b):
            peer_id = self._peer_of(room, cid)
            peer = self.clients.get(peer_id)
            await self._send_to_client(
                cid,
                {
                    "type": "ROOM_OPEN",
                    "room": room.id,
                    "members": room.members,
                    "peer": {
                        "client": peer_id,
                        "name": peer.name if peer else "",
                        "host": peer.host if peer else "",
                    },
                },
            )
        for cid in (a, b):
            await self._push_session_lists(cid)
        LOG.info("房间 %s 打开：%s <-> %s", room.id, a[:8], b[:8])
        await self.broadcast_clients()
        return room

    async def _close_room(self, room_id: str, reason: str, by: str = "") -> None:
        """关房：通知双方、销毁房间内终端、两人一起回列表。"""
        room = self.rooms.pop(room_id, None)
        if room is None:
            return
        timer = self._room_timers.pop(room_id, None)
        if timer is not None:
            timer.cancel()

        # 房间里的终端跟着房间一起销毁：房间关了就没有合法观看者，
        # 留一个没人能连的 PTY 只是占资源、扩泄漏面。
        for sid in list(room.sessions):
            # 借来的：散场后回到原主人的私有桌面。owner 一直没动，清掉 room 就归位了。
            # 数据面照样收尾 —— 房间外的观看者不能因为房间关了继续挂在别人终端上。
            if sid in room.borrowed:
                borrowed = self.sessions.get(sid)
                if borrowed is not None:
                    borrowed.room = ""
                    if borrowed.token:
                        # 借来的终端不随房间销毁：PTY 还活着，数据通道也必须留着。
                        # 连通道一起 pop 的话，下次进房的新 viewer 会挂在一个不知道
                        # node 的新通道上，relay 也就不会向 agent 要快照 ——
                        # 用户看到的会是一块永远空白的终端（shell 空闲时连增量都没有）。
                        # 这里只把房间里的 viewer 请出去，agent 连接与 channel.node 保留。
                        await self._detach_viewers(borrowed.token, "room_closed")
                continue

            session = self.sessions.pop(sid, None)
            node = self.nodes.get(session.node) if session is not None and session.node else None
            if node is not None and node.ws is not None:
                await self.send_json(
                    node.ws, {"type": "SESSION_CLOSE", "session_id": sid, "target": node.id}
                )
            # 数据面也要一起收尾：不关 viewer 的话，那条连接会挂在一个已经没人管的
            # 通道上，画面停在最后一帧，用户以为终端还在。
            if session is not None and session.token:
                await self._close_data_channel(session.token, "session_closed")
            self._drop_from_lists(sid)
        room.sessions.clear()

        for cid in room.members:
            client = self.clients.get(cid)
            if client is not None and client.room == room_id:
                client.room = ""
            # by = 谁主动离开的（超时是空）。发起离开的那一端要显示「你已离开通话」，
            # 而不是第三人称的「通话已结束」。
            await self._send_to_client(
                cid, {"type": "ROOM_CLOSED", "room": room_id, "reason": reason, "by": by}
            )
            # 还回去的终端要重新回到主人的列表里：不推这一下，他回桌面会看到它们消失。
            await self._push_session_lists(cid)
        LOG.info("房间 %s 关闭（%s）", room_id, reason)
        self._save_state()
        await self.broadcast_clients()

    def _schedule_room_grace(self, room_id: str, grace: Optional[float] = None) -> None:
        """一方断线后开始计时。期间重连就取消，超时才关房。"""
        if room_id in self._room_timers:
            return
        # 默认值在调用时取，不在定义时绑定 —— 否则测试改 ROOM_GRACE_SECONDS 不生效。
        delay = ROOM_GRACE_SECONDS if grace is None else grace

        async def _expire() -> None:
            try:
                await asyncio.sleep(delay)
                room = self.rooms.get(room_id)
                if room is None or room.state != "half":
                    return
                await self._close_room(room_id, "peer_timeout")
            finally:
                self._room_timers.pop(room_id, None)

        self._room_timers[room_id] = asyncio.create_task(_expire())

    async def _resume_room(self, client: Client) -> None:
        """重连回一个还活着的房间：取消宽限计时，通知对方"他回来了"。

        房间是按 client id 记住成员的，而 client 对象在最后一条连接断开时会被删掉，
        所以重连必须靠 room.members 反查回来 —— 这也正是"断网重连不掉线"的实现位置。
        """
        if not client.id:
            return
        for room in self.rooms.values():
            if client.id not in room.members:
                continue
            client.room = room.id
            timer = self._room_timers.pop(room.id, None)
            if timer is not None:
                timer.cancel()
            peer_id = self._peer_of(room, client.id)
            peer = self.clients.get(peer_id)
            if room.state == "half":
                room.state = "open"
                await self._send_to_client(
                    peer_id, {"type": "ROOM_PEER_BACK", "room": room.id}
                )
                LOG.info("房间 %s 成员 %s 重连，宽限取消", room.id, client.id[:8])
            # 回来的这一端也要知道自己还在房间里，否则界面会停在列表上，
            # 而房间其实已经把它算成成员了 —— 那种错位最难查。
            await self._send_to_client(
                client.id,
                {
                    "type": "ROOM_OPEN",
                    "room": room.id,
                    "members": room.members,
                    "peer": {
                        "client": peer_id,
                        "name": peer.name if peer else "",
                        "host": peer.host if peer else "",
                    },
                    "resumed": True,
                },
            )
            await self._push_session_lists(client.id)
            await self.broadcast_clients()
            return

    async def _handle_ctl_password(self, ws: Any, client: Client, msg: Dict[str, Any]) -> None:
        """客户端上报自己的通话密码。只存哈希，明文不出本机。

        密码是"别人进来要过的门"，不是本机登录：所以改密码不需要旧密码，
        能操作这个客户端就等于能改它。
        """
        raw = str(msg.get("password") or "")
        if len(raw) < PASSWORD_MIN:
            await self._error(ws, "password_short", f"密码至少 {PASSWORD_MIN} 位")
            return
        client.pw_hash = self._pw_hash(client.id, raw)
        client.pw_default = raw == DEFAULT_PASSWORD
        await self.send_json(ws, {"type": "PASSWORD_SET", "default": client.pw_default})
        # 列表上的「默认密码」标记要跟着变
        await self.broadcast_clients()

    async def _handle_room_join(self, ws: Any, client: Client, msg: Dict[str, Any]) -> None:
        """密码对了就建房 —— 中间不再有"对方同意"这一步。

        对方不需要在场操作，但**必须在线**：房间是两条活连接之间的耦合，
        给一个已经下线的人建房没有意义。
        """
        target = str(msg.get("to") or "").strip()
        raw = str(msg.get("password") or "")
        if not client.id:
            await self._error(ws, "need_client", "连接需要客户端身份")
            return
        if not target:
            await self._error(ws, "no_target", "没说要连谁")
            return
        if target == client.id:
            await self._error(ws, "self", "不能连自己")
            return
        if self._client_room(client.id) is not None:
            await self._error(ws, "busy", "你已经在通话中，先离开再说")
            return
        peer = self.clients.get(target)
        if peer is None or not peer.online:
            await self._error(ws, "offline", "对方不在线")
            return
        if peer.room:
            # 不告诉发起者"对方跟谁在一起"，只说忙。
            await self._error(ws, "peer_busy", "对方正在私密会话中")
            return
        if not peer.pw_hash:
            await self._error(ws, "no_password", "对方还没上报密码（对方客户端版本太旧）")
            return
        if not secrets.compare_digest(self._pw_hash(target, raw), peer.pw_hash):
            LOG.info("密码不匹配：%s -> %s", client.id[:8], target[:8])
            await self._error(ws, "bad_password", "密码不对")
            return
        await self._open_room(client.id, target)

    @staticmethod
    def _pw_hash(client_id: str, password: str) -> str:
        """PBKDF2-SHA256，salt 用 client id（固定，不需要另存）。"""
        return hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), client_id.encode("utf-8"), PASSWORD_ROUNDS
        ).hex()

    async def _error(self, ws: Any, code: str, message: str) -> None:
        await self.send_json(ws, {"type": "ERROR", "code": code, "message": message})

    # ---------------------------------------------------------------- 信令

    async def broadcast_ctls(self, payload: Dict[str, Any]) -> None:
        """把 agent 的消息分发给控制端 —— **按可见域逐个挑人**。

        以前这里是"所有人一份"：会话列表无差别广播，靠客户端按 owner 自己过滤显示。
        那是客户端自觉，不是隐私边界。房间模型要求服务端根本不发：
        房间外的连接不该收到房间内任何会话的 id、快照、字节。

        三种情形：

        - 带 `sessions` 列表的（SESSION_LIST）：每人一份，只留他能看的行；
        - 带 `session_id` 的（CREATED / CLOSED / 快照类）：看不见的人直接跳过；
        - 其它（NODE_ONLINE / NODES / CLIENTS 这些节点级状态）：广播，在线状态是公共信息。
        """
        if isinstance(payload.get("sessions"), list):
            payload = self.decorate_sessions(payload)

        rows = payload.get("sessions") if isinstance(payload.get("sessions"), list) else None
        sid = str(payload.get("session_id") or "")

        if rows is None and not sid:
            # 没有会话内容要按人裁剪（CLIENTS / NODES / NODE_ONLINE 这类）：
            # 序列化一次复用，别为每个客户端各 dump 一遍 —— 20 个客户端就是 20 次。
            text = json.dumps(payload, ensure_ascii=False)
            for ws in list(self.by_ws):
                await self._send_text(ws, text)
            return

        for ws, client in list(self.by_ws.items()):
            if rows is not None:
                visible = [row for row in rows if self._row_visible(client.id, row)]
                await self.send_json(ws, {**payload, "sessions": visible})
                continue
            if sid:
                session = self.sessions.get(sid)
                if session is not None and not self._session_visible(client.id, session):
                    continue
            await self.send_json(ws, payload)

    def decorate_sessions(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """广播前给每一行补上 owner：客户端靠它分清哪个终端是自己开的。

        没有 owner 的会话（归属机制上线前建的、或 relay 重启把表弄丢）在这里
        一次性认给默认认领者并落盘。不这么做的话，两端都说"不是我的"，
        同一个终端会同时挂两个「共享」标 —— 标签就失去了唯一性。

        **房间里的会话不参与认领**：它们的可见性由 room 决定，owner 必须是空。
        漏了这一句，房间里的终端会被"认领"成默认认领者的私有终端，
        也就把小黑屋的东西写到了某张桌面上。
        """
        rows = []
        claimed = False
        for item in payload.get("sessions") or []:
            if isinstance(item, dict):
                sid = str(item.get("session_id") or "")
                session = self.sessions.get(sid) if sid else None
                if session is not None and session.room:
                    rows.append({**item, "owner": ""})
                    continue
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

        `busy` 是"这个人在通话中"，**不含对方是谁**：小黑屋不该在墙上挂牌子。
        第三方只需要知道点不动，不需要知道谁跟谁在聊。
        """
        out: List[Dict[str, Any]] = []
        for client in self.clients.values():
            if not client.id:
                continue
            node = self.nodes.get(client.host) if client.host else None
            # 卡片上写的是「这个客户端自己的终端数」，不是整台机器上有多少：
            # 一张桌面一套终端，数别人的会让两个客户端都显示同一个大数字。
            # 房间里的终端不算进任何人的卡片 —— 它们属于房间，不属于某张桌面。
            alive = (
                {
                    str(row.get("session_id") or "")
                    for row in ((node.last_list or {}).get("sessions") or [])
                    if isinstance(row, dict)
                }
                if node
                else set()
            )
            room = self.rooms.get(client.room) if client.room else None
            out.append(
                {
                    "client": client.id,
                    "name": client.name,
                    "host": client.host,
                    "online": True,
                    "host_name": node.name if node else "",
                    "host_online": bool(node and node.ws is not None),
                    "busy": room is not None,
                    # 在通话中但一方掉线、正在等重连：列表上要写成「通话中 · 重连中」，
                    # 否则第三方会站在那儿白等一个已经不在的人。
                    "reconnecting": bool(room is not None and room.state == "half"),
                    # 有没有上报密码（没有就是老客户端，点也进不去）；
                    # 以及是否还在用默认弱口令 —— 这两条只描述"能不能进"和"该不该提醒"，
                    # 不泄露密码本身。
                    "password": bool(client.pw_hash),
                    "password_default": bool(client.pw_default),
                    "sessions": sum(
                        1
                        for sid, session in self.sessions.items()
                        if session.owner == client.id and not session.room and sid in alive
                    ),
                }
            )
        return out

    def pairs_summary(self) -> List[Dict[str, Any]]:
        """历史接口，返回空表。

        以前这里把"谁进了谁"广播给所有人 —— 等于把小黑屋的门牌挂出来。
        配对关系现在只通过 `ROOM_OPEN` 定向告诉房间内的两个人，
        对外一律不可见。保留这个函数只为不破坏旧客户端对 `pairs` 字段的解析。
        """
        return []

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
                "version": "1.4.0",
            },
        )
        # 先把各节点缓存的会话列表直接甩给新控制端 —— 它要在几百毫秒内知道
        # 每台机器上已经有谁在开终端，才不会急着自己新建一个。
        #
        # 注意这里必须逐行过滤：这是 client 刚连上、还没进任何房间的时刻，
        # 直接把 node.last_list 原样发出去，等于把别人房间里的终端编号告诉他。
        await self._push_session_lists(client.id, ws)
        # 再让每个节点补发一次权威列表（缓存可能过期：刚关/刚建）。
        for node in self.nodes.values():
            if node.ws is not None:
                await self.send_json(node.ws, {"type": "CTL_ONLINE"})

        # 重连回来的可能正处在一个"等它回来"的房间里 —— 在 HELLO 之后把房间接上，
        # 顺序不能反：客户端要先认识自己是谁、有哪些客户端，再收到"你还在房间里"。
        await self._resume_room(client)

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

        if msg_type == "CTL_PASSWORD":
            await self._handle_ctl_password(ws, client, msg)
            return

        if msg_type == "ROOM_JOIN":
            await self._handle_room_join(ws, client, msg)
            return

        if msg_type == "ROOM_LEAVE":
            room = self._client_room(client.id)
            if room is None:
                await self._error(ws, "no_room", "你不在通话中")
                return
            await self._close_room(room.id, "left", by=client.id)
            return

        if msg_type in ("CTL_PAIR", "CTL_UNPAIR"):
            # 老的单向配对已下线：A 点一下就把自己塞进 B 的桌面，正是"小黑屋"要防的事。
            # 保留解析只为给老客户端一句能看懂的话，不再产生任何房间。
            await self._error(
                ws,
                "pair_removed",
                "配对已改成密码匹配（ROOM_JOIN + password），请升级客户端",
            )
            return

        if msg_type in ("ROOM_INVITE", "ROOM_ACCEPT", "ROOM_DECLINE"):
            # 邀请/同意那一步已经删了：现在点进去输密码直接建房。
            await self._error(
                ws,
                "invite_removed",
                "配对已改成密码匹配（点设备后输密码），请升级客户端",
            )
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
                # 两个可见域：在房间里开的终端属于房间（双方平等可见），
                # 没在房间里的挂在创建者名下（私有域）。
                # 以前这里是"我在别人桌面里开，就归对方"，那是单向配对时代的产物：
                # 归属权是关系，不是所有权，房间模型下由 ROOM 字段表达。
                if client.room:
                    session.room = client.room
                    session.owner = ""
                    room = self.rooms.get(client.room)
                    if room is not None:
                        room.sessions.add(sid)
                elif client.id and not session.owner:
                    session.owner = client.id
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
                    session = self.sessions.get(sid)
                    if session is not None and session.room:
                        room = self.rooms.get(session.room)
                        if room is not None:
                            room.sessions.discard(sid)
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
        """一条控制端连接走了：摘掉这条连接；最后一条走了才把这个人从表里删掉。

        在房间里的人走了，不是"我自己下线"这么简单：房间是强耦合的，一方走另一方也完蛋。
        这里只进入 **宽限期**（默认 30 秒）——断网重连接得上就当无事发生，超时才关房。
        这么设计是因为 PTY 会随房间一起销毁，立刻关等于 Wi-Fi 抖一下丢一次工作。
        """
        client = self.by_ws.pop(ws, None)
        if client is None:
            return
        client.conns.discard(ws)
        if client.online:
            await self.broadcast_clients()
            return

        gone = client.id
        room = self._client_room(gone) if gone else None
        self.clients.pop(client.id, None)
        LOG.info("ctl 下线 %s（剩 %d 条连接）", ws.remote_address, len(self.by_ws))
        # 在线列表就是"此刻连着 wss 的客户端"，走了立刻从列表里消失
        await self.broadcast_clients()

        if room is not None:
            room.state = "half"
            peer_id = self._peer_of(room, gone)
            await self._send_to_client(
                peer_id,
                {
                    "type": "ROOM_PEER_GONE",
                    "room": room.id,
                    "grace": ROOM_GRACE_SECONDS,
                },
            )
            self._schedule_room_grace(room.id)
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

    def _session_by_token(self, token: str) -> Optional[Session]:
        """按 data_token 反查会话。会话数在几十的量级，线性扫足够。"""
        for session in self.sessions.values():
            if session.token == token:
                return session
        return None

    async def handle_data(
        self, ws: Any, token: str, role: str, node_id: str = "", client_id: str = ""
    ) -> None:
        """一个 data_token 下的多播通道。

        role=agent：唯一一条，PTY 宿主。它发来的字节广播给所有 viewer。
        role=ctl  ：观看者。**必须带 client 身份**，且这条会话对它是可见的；
                    否则 4003 —— 拿着 token 直连也进不来，这是小黑屋在数据面的那道门。
        """
        session = self._session_by_token(token)
        if role == "ctl":
            allowed = bool(session) and bool(client_id) and self._session_visible(
                client_id, session
            )
            if not allowed:
                LOG.warning(
                    "数据面拒绝：token=%s client=%s（会话 %s）",
                    token[:8],
                    client_id[:8] or "-",
                    "不存在" if session is None else "不可见",
                )
                await ws.close(code=4003, reason="forbidden")
                return

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
                    # 通道可能被重建过（房间关了又开）：每条都按 token 现取，
                    # 否则字节会写进一个已经没人管的旧对象，所有人都收不到。
                    live = self.channels.get(token) or channel
                    for viewer in list(live.viewers.values()):
                        if viewer.ready:
                            await self._send_bytes(viewer.ws, chunk)
                        elif (
                            len(viewer.queue) < VIEWER_QUEUE_MAX
                            and viewer.queue_bytes + len(chunk) <= VIEWER_QUEUE_BYTES
                        ):
                            # 还没拿到快照，先攒着，别和历史串序。
                            viewer.queue.append(chunk)
                            viewer.queue_bytes += len(chunk)
                        else:
                            # 一直不收的人不该占用这台机器的内存：断开，让它重连走快照。
                            LOG.info(
                                "viewer %s 积压 %d 字节，断开（通道 %s）",
                                viewer.cid,
                                viewer.queue_bytes,
                                token[:8],
                            )
                            await self._drop_viewer(live, viewer, 4009, "slow")
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

        # 通道上没记 node（历史状态、或 viewer 比 agent 先到）时，用会话自己记的 node 兜底，
        # 不然后面就发不出 VIEWER_JOINED，新 viewer 永远等不到快照。
        if not channel.node and session is not None and session.node:
            channel.node = session.node
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

    async def _drop_viewer(
        self, channel: "Channel", viewer: "Viewer", code: int, reason: str
    ) -> None:
        """踢掉单个观看者：通道和别的观看者不受影响。"""
        channel.viewers.pop(viewer.cid, None)
        self.viewers.pop(viewer.cid, None)
        try:
            await viewer.ws.close(code=code, reason=reason)
        except Exception:  # noqa: BLE001 - 对端可能已经断了
            pass

    async def _detach_viewers(self, token: str, reason: str) -> None:
        """只关观看者，保留通道本身（agent 连接 + node 归属）。

        用于「借来的终端」散场：PTY 还在、通道还得能被人重新挂上来。
        """
        channel = self.channels.get(token)
        if channel is None:
            return
        for viewer in list(channel.viewers.values()):
            self.viewers.pop(viewer.cid, None)
            try:
                await viewer.ws.close(code=4008, reason=reason)
            except Exception:  # noqa: BLE001 - 对端可能已经断了
                pass
        channel.viewers.clear()
        self._drop_channel_if_idle(token)

    async def _close_data_channel(self, token: str, reason: str) -> None:
        """关掉一条数据通道上的所有 viewer 并摘掉通道。

        会话被销毁时必须走这里：否则 viewer 连接还挂着，画面冻在最后一帧，
        用户完全看不出后台已经没了。
        """
        channel = self.channels.pop(token, None)
        if channel is None:
            return
        for viewer in list(channel.viewers.values()):
            self.viewers.pop(viewer.cid, None)
            try:
                await viewer.ws.close(code=4008, reason=reason)
            except Exception:  # noqa: BLE001 - 对端可能已经断了
                pass
        channel.viewers.clear()

    async def _send_text(self, ws: Any, text: str) -> None:
        """已经是 JSON 字符串了，直接发，不再序列化。"""
        try:
            await ws.send(text)
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            LOG.debug("send_text 失败", exc_info=True)

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
        viewer.queue_bytes = 0
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
