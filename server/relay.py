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

环境变量：
    RPty_TOKEN    必填，agent 与 ctl 共用的共享密钥
    RPty_HOST     默认 127.0.0.1
    RPty_PORT     默认 8765
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
from typing import Any, Dict, Optional, Set
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol

LOG = logging.getLogger("relay")

# 终端输出可能一次来很大（比如 cat 一个二进制文件），但不能无限。
MAX_MESSAGE = 8 * 1024 * 1024
# viewer 还没拿到快照时最多替它排队多少条增量，超了就丢（宁可少画一段也不能撑爆内存）。
VIEWER_QUEUE_MAX = 512


class Viewer:
    """一条控制端数据通道。"""

    __slots__ = ("cid", "ws", "ready", "queue")

    def __init__(self, cid: str, ws: WebSocketServerProtocol) -> None:
        self.cid = cid
        self.ws = ws
        # 还没拿到快照前，增量先排队，保证「历史在前、增量在后」的顺序。
        self.ready = False
        self.queue: list[bytes] = []


class Channel:
    """一个 data_token 对应的多播通道。"""

    __slots__ = ("agent", "viewers", "owner", "node")

    def __init__(self) -> None:
        self.agent: Optional[WebSocketServerProtocol] = None
        self.viewers: Dict[str, Viewer] = {}
        # 谁创建的会话谁定尺寸，避免多端互相抢 PTY 的 cols/rows。
        self.owner: Optional[WebSocketServerProtocol] = None
        # 这条通道的 PTY 属于哪个节点，补快照时才知道该找谁要。
        self.node: Optional[str] = None


class Node:
    """一台被控机上的宿主进程。"""

    __slots__ = ("node_id", "ws", "name", "platform", "last_list")

    def __init__(self, node_id: str) -> None:
        self.node_id = node_id
        self.ws: Optional[WebSocketServerProtocol] = None
        self.name = node_id
        self.platform = ""
        # 最近一次这个节点报上来的会话列表，新控制端一连上就能拿到。
        self.last_list: Optional[Dict[str, Any]] = None

    def summary(self) -> Dict[str, Any]:
        sessions = (self.last_list or {}).get("sessions") or []
        return {
            "node": self.node_id,
            "name": self.name,
            "platform": self.platform,
            "online": self.ws is not None,
            "sessions": len(sessions),
        }


class Relay:
    def __init__(self, token: str) -> None:
        self.token = token

        # node_id -> Node，多台机器可以同时在线。
        self.nodes: Dict[str, Node] = {}
        # 允许多个控制端同时在线（多个窗口 / 多台客户端看同一批会话）。
        self.ctls: Set[WebSocketServerProtocol] = set()

        # data_token -> 多播通道
        self.channels: Dict[str, Channel] = {}
        # cid -> (token, Viewer)，用于把 agent 的快照定向投给某一个 viewer
        self.viewers: Dict[str, tuple[str, Viewer]] = {}
        self._cid_seq = 0

        # session_id -> data_token，resize 仲裁用
        self.sid_token: Dict[str, str] = {}
        # session_id -> node_id，客户端没带 target 时也能把信令送回正确的节点
        self.sid_node: Dict[str, str] = {}
        # data_token -> node_id：数据通道建起来时若没带 node（老版本 agent），靠它兜底
        self.token_node: Dict[str, str] = {}
        # ctl 连接 -> 客户端自报的稳定 id，用来判断「这个会话是谁开的」
        self.ctl_client: Dict[Any, str] = {}
        # session_id -> 开它的客户端 id。重启 relay 会丢，客户端本地还存了一份。
        self.sid_owner: Dict[str, str] = {}
        # session_id -> relay 分配的编号。宿主进程可能还在自增自己的旧计数，
        # 广播列表时一律以这里为准，否则多节点下会出现两个「终端 9」。
        self.sid_index: Dict[str, int] = {}
        # 全局会话编号：多节点各自从 1 数会撞号，由 relay 统一分配。
        self.seq = 0

        # 无主会话（归属机制上线前建的、或 relay 重启把表弄丢的）统一认给第一个
        # 带 client 参数连上的控制端。这样「共享」标签永远只出现在非主人那一端，
        # 不会出现两个窗口都标共享的情况。
        self.default_claimant: str = ""
        self.claimant_primary = False
        # 哪些会话的归属是"认领"来的（不是真的由某个客户端创建）。换主人时只迁移这些，
        # 真正被别人创建的会话不能跟着跑。
        self.sid_claimed: Set[str] = set()
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

    async def send_json(self, ws: Optional[WebSocketServerProtocol], payload: Dict[str, Any]) -> None:
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

    # ---------------------------------------------------------------- HTTP

    async def process_request(self, path: str, request_headers) -> Any:
        """给 /healthz 一个真正的 HTTP 响应，不动 WebSocket 路径。"""
        if urlparse(path).path == "/healthz":
            nodes = {nid: n.summary() for nid, n in self.nodes.items()}
            body = json.dumps(
                {
                    "ok": True,
                    "uptime": int(time.time() - self.started_at),
                    "agent": any(n.ws is not None for n in self.nodes.values()),
                    "ctl": len(self.ctls) > 0,
                    "ctls": len(self.ctls),
                    "nodes": nodes,
                    "channels": len(self.channels),
                    "viewers": sum(len(c.viewers) for c in self.channels.values()),
                    **self.stats,
                },
                ensure_ascii=False,
            ).encode()
            return (200, [("Content-Type", "application/json")], body)
        return None

    # ---------------------------------------------------------------- 入口

    async def handle(self, ws: WebSocketServerProtocol) -> None:
        path = ws.path
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
            self.sid_owner.update({str(k): str(v) for k, v in owners.items() if k and v})
        index = data.get("index") or {}
        if isinstance(index, dict):
            for k, v in index.items():
                try:
                    self.sid_index[str(k)] = int(v)
                except (TypeError, ValueError):
                    continue
        claimant = data.get("claimant") or ""
        if isinstance(claimant, str) and claimant:
            self.default_claimant = claimant
        self.claimant_primary = bool(data.get("claimant_primary"))
        claimed = data.get("claimed") or []
        if isinstance(claimed, list):
            self.sid_claimed = {str(v) for v in claimed if v}
        self.seq = max(self.sid_index.values(), default=0)
        LOG.info(
            "恢复状态：归属 %d 条，编号 %d 条，认领者 %s",
            len(self.sid_owner),
            len(self.sid_index),
            self.default_claimant[:8] or "-",
        )

    def _save_state(self) -> None:
        """整份写回。会话数量在几十的量级，直接覆盖比增量维护省事。"""
        tmp = f"{self.state_file}.tmp"
        try:
            os.makedirs(os.path.dirname(self.state_file) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "owners": self.sid_owner,
                        "index": self.sid_index,
                        "claimant": self.default_claimant,
                        "claimant_primary": self.claimant_primary,
                        "claimed": sorted(self.sid_claimed),
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp, self.state_file)
        except Exception as exc:
            LOG.warning("状态保存失败：%s", exc)

    def _promote_claimant(self, client_id: str) -> None:
        """把「无主会话」的主人换成主窗口，并把它之前认领来的归属一起搬过去。

        只搬自己认领来的（sid_claimed），真正由别人创建的会话不动 ——
        否则你在副本窗口里新建的终端会莫名其妙变成主窗口的。
        """
        old = self.default_claimant
        if old == client_id:
            self._save_state()
            return
        self.default_claimant = client_id
        moved = 0
        for sid in list(self.sid_claimed):
            if self.sid_owner.get(sid) == old:
                self.sid_owner[sid] = client_id
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
        for ctl in list(self.ctls):
            await self.send_json(ctl, payload)

    def decorate_sessions(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """广播前给每一行补上 owner：客户端靠它分清哪个终端是自己开的。

        没有 owner 的会话（归属机制上线前建的、或 relay 重启把表弄丢的）在这里
        一次性认给默认认领者并落盘。不这么做的话，两端都说"不是我的"，
        同一个终端会同时挂两个「共享」标 —— 标签就失去了唯一性。
        """
        rows = []
        claimed = False
        for item in payload.get("sessions") or []:
            if isinstance(item, dict):
                sid = str(item.get("session_id") or "")
                owner = self.sid_owner.get(sid, "")
                if not owner and sid and self.default_claimant:
                    owner = self.default_claimant
                    self.sid_owner[sid] = owner
                    self.sid_claimed.add(sid)
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

    async def handle_agent(self, ws: WebSocketServerProtocol, node_id: str) -> None:
        node = self.nodes.get(node_id)
        if node is None:
            node = Node(node_id)
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

                # 顺手记住 session_id 的归属，resize / close 没带 target 时靠它路由。
                if kind == "SESSION_CREATED":
                    sid = str(msg.get("session_id") or "")
                    token = str(msg.get("data_token") or "")
                    if sid and token:
                        self.sid_token[sid] = token
                        self.sid_node[sid] = node_id
                        self.token_node[token] = node_id
                elif kind == "SESSION_LIST":
                    dirty = False
                    for item in msg.get("sessions") or []:
                        if isinstance(item, dict):
                            sid = str(item.get("session_id") or "")
                            token = str(item.get("data_token") or "")
                            if sid and token:
                                self.sid_token[sid] = token
                                self.sid_node[sid] = node_id
                                self.token_node[token] = node_id
                            # 编号只认 relay 这一份。每个会话第一次出现时定号，之后不再变；
                            # 宿主自报的编号只在 relay 从没见过它时作为初值（relay 重启后的老会话），
                            # 没有再补一个，免得客户端拿到 0 只能自己数，两端数出不同的号。
                            if sid:
                                known = self.sid_index.get(sid)
                                if known is None:
                                    idx = item.get("index")
                                    if isinstance(idx, int) and idx > 0:
                                        known = idx
                                        if idx > self.seq:
                                            self.seq = idx
                                    else:
                                        known = self.next_index()
                                    self.sid_index[sid] = known
                                    dirty = True
                                LOG.debug("列表定号 sid=%s index=%s", sid[:8], known)
                                item["index"] = known
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

    async def handle_ctl(self, ws: WebSocketServerProtocol) -> None:
        self.ctls.add(ws)
        query = parse_qs(urlparse(ws.path).query)
        client_id = ((query.get("client") or [""])[0] or "").strip()
        self.ctl_client[ws] = client_id
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
        LOG.info("ctl 上线 %s（当前 %d 个，client=%s）", ws.remote_address, len(self.ctls), client_id[:8] or "-")

        await self.send_json(
            ws,
            {
                "type": "HELLO",
                "agent_online": any(n.ws is not None for n in self.nodes.values()),
                "nodes": [n.summary() for n in self.nodes.values()],
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

                msg_type = msg.get("type")
                if msg_type in ("SESSION_CREATE", "SESSION_CLOSE", "SESSION_RESIZE", "PING"):
                    if msg_type == "PING":
                        await self.send_json(ws, {"type": "PONG", "at": int(time.time())})
                        continue

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
                        continue

                    if msg_type == "SESSION_CREATE":
                        # 谁建谁定尺寸。attach 来的端只镜像，不改 PTY 大小。
                        token = str(msg.get("data_token") or "")
                        if token:
                            self.channels.setdefault(token, Channel()).owner = ws
                        # 编号由 relay 全局分配：多节点各自从 1 数必然撞号。
                        # 但只在第一次见到这个会话时发号 —— 客户端重连会把自己建的会话
                        # 补发一遍 SESSION_CREATE，重新发号会让同一个终端在两台机器上
                        # 显示成两个不同的编号。
                        sid = str(msg.get("session_id") or "")
                        known = self.sid_index.get(sid) if sid else None
                        if known is not None:
                            msg["index"] = known
                        else:
                            msg["index"] = self.next_index()
                            if sid:
                                self.sid_index[sid] = msg["index"]
                        if sid:
                            LOG.debug("发号 sid=%s index=%s known=%s src=%s", sid[:8], msg["index"], known, msg_type)
                            self.sid_node[sid] = node.node_id
                            client_id = self.ctl_client.get(ws, "")
                            if client_id:
                                self.sid_owner.setdefault(sid, client_id)
                        if token:
                            self.channels.setdefault(token, Channel()).node = node.node_id
                        self.stats["sessions_opened"] += 1
                        # 新建的会话带上了归属与编号，立刻落盘。
                        self._save_state()
                    else:
                        sid = str(msg.get("session_id") or "")
                        token = self.sid_token.get(sid)
                        channel = self.channels.get(token) if token else None
                        if (
                            msg_type == "SESSION_RESIZE"
                            and channel is not None
                            and channel.owner is not None
                            and channel.owner is not ws
                        ):
                            # 镜像端不改 PTY 尺寸，否则两端会互相拉扯、画面来回跳。
                            LOG.debug("忽略非 owner 的 resize sid=%s", sid[:8])
                            continue

                    if msg_type == "SESSION_CLOSE":
                        closed_sid = str(msg.get("session_id") or "")
                        if closed_sid:
                            # 有人主动点了 ×：从缓存里摘掉，并告诉所有控制端"这是关掉的，
                            # 不是断了" —— 他们要把标签留成灰色，而不是继续当活着。
                            self._drop_from_lists(closed_sid)
                            await self.broadcast_ctls(
                                {
                                    "type": "SESSION_CLOSED",
                                    "session_id": closed_sid,
                                    "node": node.node_id,
                                    "reason": "ctl",
                                }
                            )
                            await self.broadcast_nodes()

                    await self.send_json(node.ws, {**msg, "src": "ctl"})
                else:
                    # 其它类型直接回显错误，避免静默吞掉。
                    await self.send_json(
                        ws,
                        {"type": "ERROR", "code": "bad_type", "message": f"未知信令 {msg_type}"},
                    )
        except ConnectionClosed:
            pass
        finally:
            self.ctls.discard(ws)
            self.ctl_client.pop(ws, None)
            LOG.info("ctl 下线 %s（剩 %d 个）", ws.remote_address, len(self.ctls))
            if not self.ctls:
                for node in self.nodes.values():
                    if node.ws is not None:
                        await self.send_json(node.ws, {"type": "CTL_OFFLINE"})

    def next_index(self) -> int:
        """分配下一个全局编号。

        relay 重启后 seq 归零，但各节点上还活着旧会话。先把已知的最大编号捞回来，
        否则新会话会从 1 开始和旧会话撞号。
        """
        known = [self.seq, *self.sid_index.values()]
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
            node_id = self.sid_node.get(sid)
            if node_id:
                return self.nodes.get(node_id)

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
        self, ws: WebSocketServerProtocol, token: str, role: str, node_id: str = ""
    ) -> None:
        """一个 data_token 下的多播通道。

        role=agent：唯一一条，PTY 宿主。它发来的字节广播给所有 viewer。
        role=ctl  ：任意多条，都是 viewer。谁发的字节都转给 agent。
        """
        channel = self.channels.setdefault(token, Channel())

        if role == "agent":
            previous = channel.agent
            channel.agent = ws
            # 老版本 agent 的 data_url 不带 node，用 token 反查兜底。
            if not node_id:
                node_id = self.token_node.get(token, "")
                if not node_id:
                    online = [n for n in self.nodes.values() if n.ws is not None]
                    if len(online) == 1:
                        node_id = online[0].node_id
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
        viewer = Viewer(cid, ws)
        channel.viewers[cid] = viewer
        self.viewers[cid] = (token, viewer)
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

    async def _send_bytes(self, ws: WebSocketServerProtocol, chunk: bytes) -> None:
        try:
            await ws.send(chunk)
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            LOG.debug("推送字节失败", exc_info=True)

    def _force_ready(self, cid: str) -> None:
        entry = self.viewers.get(cid)
        if entry is None:
            return
        _token, viewer = entry
        if viewer.ready:
            return
        LOG.warning("viewer %s 等快照超时，直接放开增量", cid)
        # 复用 deliver_snapshot 的收尾逻辑：先把排队的增量按序放出去，再置 ready。
        asyncio.get_running_loop().create_task(self.deliver_snapshot({"cid": cid}))

    async def deliver_snapshot(self, msg: Dict[str, Any]) -> None:
        """agent 的快照按 cid 定向投递，并把它排队中的增量放行。"""
        cid = str(msg.get("cid") or "")
        entry = self.viewers.get(cid)
        if entry is None:
            return
        _token, viewer = entry
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

    async with websockets.serve(
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
