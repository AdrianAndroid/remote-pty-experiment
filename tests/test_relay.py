"""
relay 状态机的集成测 —— 用假 ws 直接驱动 handle_agent / handle_ctl / handle_data。

不起服务、不占端口：`Relay.handle(ws)` 拿到什么 ws 就用什么 ws，所以给一个
鸭子类型的假连接（有 path / send / close / 异步迭代）就能跑完整条链路。

跑法：
    cd ~/rpty && python3.12 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import relay  # noqa: E402

TOKEN = "tok-123"


_STOP = object()  # 塞进队列表示连接关闭


class FakeWS:
    """够用的假 WebSocket：只为 relay 用到的四个能力。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self.remote_address = ("127.0.0.1", 5000)
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list = []
        self.closed: tuple | None = None

    # ---- relay 用到的东西

    async def send(self, payload) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)
        self.inbox.put_nowait(_STOP)

    def __aiter__(self) -> "FakeWS":
        return self

    async def __anext__(self):
        item = await self.inbox.get()
        if item is _STOP:
            raise StopAsyncIteration
        return item

    # ---- 测试侧

    def feed(self, payload) -> None:
        self.inbox.put_nowait(payload)

    def end(self) -> None:
        self.inbox.put_nowait(_STOP)

    def events(self) -> list:
        out = []
        for item in self.sent:
            if isinstance(item, str):
                try:
                    out.append(json.loads(item))
                except ValueError:
                    continue
        return out

    def of_type(self, kind: str) -> list:
        return [e for e in self.events() if e.get("type") == kind]

    def last(self, kind: str):
        found = self.of_type(kind)
        return found[-1] if found else None

    def binary(self) -> list:
        return [item for item in self.sent if isinstance(item, bytes)]


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RPTY_STATE_FILE"] = os.path.join(self.tmp.name, "relay-state.json")
        self.relay = relay.Relay(TOKEN)
        self.wss: list[FakeWS] = []
        self.tasks: list[asyncio.Task] = []

    async def asyncTearDown(self) -> None:
        for ws in self.wss:
            ws.end()
        await asyncio.sleep(0.02)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tmp.cleanup()

    # ---------------------------------------------------------------- 工具

    def spawn(self, path: str) -> FakeWS:
        ws = FakeWS(path)
        self.wss.append(ws)
        self.tasks.append(asyncio.create_task(self.relay.handle(ws)))
        return ws

    async def settle(self, times: int = 4) -> None:
        for _ in range(times):
            await asyncio.sleep(0.005)

    async def feed(self, ws: FakeWS, payload) -> None:
        if isinstance(payload, (str, bytes)):
            ws.feed(payload)
        else:
            ws.feed(json.dumps(payload))
        await self.settle()

    async def agent(self, node: str = "n1", name: str = "mini") -> FakeWS:
        ws = self.spawn(f"/agent?node={node}&token={TOKEN}")
        await self.settle()
        await self.feed(ws, {"type": "HELLO", "node_id": node, "name": name, "platform": "darwin"})
        return ws

    async def client(self, cid: str, name: str = "", host: str = "", primary: bool = False) -> FakeWS:
        query = f"?client={cid}&token={TOKEN}"
        if name:
            query += f"&name={name}"
        if host:
            query += f"&host={host}"
        if primary:
            query += "&primary=1"
        ws = self.spawn("/ctl" + query)
        await self.settle()
        return ws

    async def create(self, ctl: FakeWS, sid: str = "s1", token: str = "t1", target: str = "n1") -> None:
        await self.feed(
            ctl,
            {
                "type": "SESSION_CREATE",
                "session_id": sid,
                "data_token": token,
                "cols": 100,
                "rows": 30,
                "target": target,
            },
        )

    async def open_agent_data(self, token: str = "t1", node: str = "n1") -> FakeWS:
        ws = self.spawn(f"/d/{token}?role=agent&node={node}&token={TOKEN}")
        await self.settle()
        return ws

    async def open_viewer(self, token: str = "t1") -> FakeWS:
        ws = self.spawn(f"/d/{token}?role=ctl&token={TOKEN}")
        await self.settle()
        return ws

    async def answer_snapshots(self, agent_ws: FakeWS, data: bytes = b"") -> None:
        """把 relay 发的 VIEWER_JOINED 逐条回应成 SESSION_SNAPSHOT。"""
        for event in agent_ws.of_type("VIEWER_JOINED"):
            await self.feed(
                agent_ws,
                {
                    "type": "SESSION_SNAPSHOT",
                    "cid": event["cid"],
                    "data_token": event["data_token"],
                    "data": base64.b64encode(data).decode() if data else "",
                },
            )

    # ---------------------------------------------------------------- 鉴权与握手

    async def test_bad_token_closed(self) -> None:
        ws = self.spawn("/ctl?client=c1&token=wrong")
        await self.settle()
        self.assertEqual(ws.closed[0], 4001)
        self.assertEqual(ws.events(), [])

    async def test_client_hello_carries_nodes(self) -> None:
        await self.agent("n1", "mini")
        ctl = await self.client("c1", "mini-aaaa", "n1")
        hello = ctl.last("HELLO")
        self.assertIsNotNone(hello)
        self.assertTrue(hello["agent_online"])
        self.assertEqual(hello["nodes"][0]["node"], "n1")
        self.assertEqual(hello["nodes"][0]["name"], "mini")
        # 上线时广播过一次 CLIENTS，自己那条要能认出来
        clients = ctl.last("CLIENTS")["clients"]
        self.assertEqual([c["client"] for c in clients], ["c1"])
        self.assertEqual(clients[0]["host"], "n1")

    # ---------------------------------------------------------------- 编号与归属

    async def test_session_list_assigns_global_index(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.feed(
            agent,
            {
                "type": "SESSION_LIST",
                "sessions": [
                    {"session_id": "s1", "data_token": "t1", "cols": 80, "rows": 24, "index": 5},
                    {"session_id": "s2", "data_token": "t2", "cols": 80, "rows": 24},
                ],
            },
        )
        rows = ctl.last("SESSION_LIST")["sessions"]
        by_sid = {row["session_id"]: row for row in rows}
        self.assertEqual(by_sid["s1"]["index"], 5)
        self.assertEqual(by_sid["s2"]["index"], 6)
        self.assertEqual(self.relay.seq, 6)

    async def test_session_create_sets_owner_and_forwards(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.create(ctl, sid="s1", token="t1")
        forwarded = agent.last("SESSION_CREATE")
        self.assertIsNotNone(forwarded)
        self.assertEqual(forwarded["index"], 1)
        self.assertEqual(forwarded["src"], "ctl")
        self.assertEqual(self.relay.sessions["s1"].owner, "c1")
        self.assertEqual(self.relay.sessions["s1"].node, "n1")

    async def test_create_inside_other_client_belongs_to_it(self) -> None:
        await self.agent("n1")
        mine = await self.client("c1", host="n1")
        await self.client("c2", host="n1")
        await self.feed(mine, {"type": "CTL_PAIR", "client": "c2", "node": "n1", "to_name": "c2"})
        await self.create(mine, sid="s9", token="t9")
        self.assertEqual(self.relay.sessions["s9"].owner, "c2")

    # ---------------------------------------------------------------- 尺寸仲裁

    async def test_resize_only_from_creator(self) -> None:
        agent = await self.agent("n1")
        creator = await self.client("c1", host="n1")
        mirror = await self.client("c2", host="n1")
        await self.create(creator, sid="s1", token="t1")
        agent.sent.clear()

        # 镜像端改尺寸：丢掉，不发宿主也不广播
        await self.feed(mirror, {"type": "SESSION_RESIZE", "session_id": "s1", "cols": 90, "rows": 20})
        self.assertEqual(agent.of_type("SESSION_RESIZE"), [])
        self.assertEqual(self.relay.sessions["s1"].cols, 0)

        # 创建端改尺寸：转发 + 广播
        await self.feed(creator, {"type": "SESSION_RESIZE", "session_id": "s1", "cols": 120, "rows": 32})
        self.assertEqual(agent.last("SESSION_RESIZE")["cols"], 120)
        self.assertEqual(mirror.last("SESSION_RESIZED")["rows"], 32)
        self.assertEqual(self.relay.sessions["s1"].cols, 120)

        # 荒唐尺寸（布局还没量出来）：丢掉
        agent.sent.clear()
        await self.feed(creator, {"type": "SESSION_RESIZE", "session_id": "s1", "cols": 10, "rows": 3})
        self.assertEqual(agent.of_type("SESSION_RESIZE"), [])

    # ---------------------------------------------------------------- 广播

    async def test_session_list_broadcast_to_every_client(self) -> None:
        agent = await self.agent("n1")
        a = await self.client("c1", host="n1")
        b = await self.client("c2", host="n1")
        await self.feed(
            agent,
            {"type": "SESSION_LIST", "sessions": [{"session_id": "s1", "data_token": "t1"}]},
        )
        self.assertEqual(a.last("SESSION_LIST")["sessions"][0]["session_id"], "s1")
        self.assertEqual(b.last("SESSION_LIST")["sessions"][0]["session_id"], "s1")

    # ---------------------------------------------------------------- 数据面

    async def test_data_multicast_and_keys_go_to_pty(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.create(ctl, sid="s1", token="t1")
        agent_data = await self.open_agent_data("t1")
        v1 = await self.open_viewer("t1")
        v2 = await self.open_viewer("t1")
        await self.answer_snapshots(agent)

        await self.feed(agent_data, b"OUTPUT")
        self.assertEqual(v1.binary(), [b"OUTPUT"])
        self.assertEqual(v2.binary(), [b"OUTPUT"])

        v1.feed(b"KEY")
        await self.settle()
        self.assertEqual(agent_data.binary(), [b"KEY"])

    async def test_snapshot_arrives_before_queued_increment(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.create(ctl, sid="s1", token="t1")
        agent_data = await self.open_agent_data("t1")
        viewer = await self.open_viewer("t1")

        # 快照还没回来时先到的增量必须排队，不能抢在历史前面
        await self.feed(agent_data, b"LIVE")
        self.assertEqual(viewer.binary(), [])

        await self.answer_snapshots(agent, b"HISTORY")
        self.assertEqual(viewer.binary(), [b"HISTORY", b"LIVE"])

    async def test_viewer_without_snapshot_still_gets_bytes(self) -> None:
        """agent 卡住不回快照时，2.5s 兜底放行（这里直接调 _force_ready 验证收尾）。"""
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.create(ctl, sid="s1", token="t1")
        agent_data = await self.open_agent_data("t1")
        viewer = await self.open_viewer("t1")
        cid = agent.last("VIEWER_JOINED")["cid"]

        await self.feed(agent_data, b"QUEUED")
        self.relay._force_ready(cid)
        await self.settle()
        self.assertEqual(viewer.binary(), [b"QUEUED"])

    # ---------------------------------------------------------------- 关闭

    async def test_session_close_drops_from_cache(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.feed(
            agent,
            {"type": "SESSION_LIST", "sessions": [{"session_id": "s1", "data_token": "t1"}]},
        )
        await self.feed(ctl, {"type": "SESSION_CLOSE", "session_id": "s1"})
        self.assertIsNotNone(ctl.last("SESSION_CLOSED"))
        self.assertEqual(self.relay.nodes["n1"].last_list["sessions"], [])
        self.assertIsNotNone(agent.last("SESSION_CLOSE"))

    # ---------------------------------------------------------------- 客户端个体性

    async def test_pairing_visible_both_sides_and_dropped_on_disconnect(self) -> None:
        await self.agent("n1")
        a = await self.client("c1", "mini-aaaa", "n1")
        b = await self.client("c2", "mbp-bbbb", "n1")
        await self.feed(a, {"type": "CTL_PAIR", "client": "c2", "node": "n1", "to_name": "mbp-bbbb"})
        pairs = b.last("CLIENTS")["pairs"]
        self.assertEqual(pairs, [{"from": "c1", "from_name": "mini-aaaa", "to": "c2", "to_name": "mbp-bbbb", "node": "n1"}])

        b.end()
        await self.settle()
        self.assertEqual(self.relay.pairs_summary(), [])
        self.assertIsNone(self.relay.clients["c1"].pair)

    async def test_one_client_leaving_does_not_touch_another(self) -> None:
        await self.agent("n1")
        a = await self.client("c1", host="n1")
        b = await self.client("c2", host="n1")
        a.end()
        await self.settle()
        remaining = [c["client"] for c in self.relay.clients_summary()]
        self.assertEqual(remaining, ["c2"])
        self.assertIsNotNone(b.last("CLIENTS"))

    async def test_second_connection_same_client_is_same_entity(self) -> None:
        """同一个 client id 的两条连接 = 一个客户端，不是两个。"""
        await self.agent("n1")
        first = await self.client("c1", "mini-aaaa", "n1")
        second = await self.client("c1", "mini-aaaa", "n1")
        self.assertEqual(len(self.relay.clients_summary()), 1)
        first.end()
        await self.settle()
        self.assertEqual(len(self.relay.clients_summary()), 1)
        second.end()
        await self.settle()
        self.assertEqual(self.relay.clients_summary(), [])

    async def test_host_exit_clears_labels(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1")
        await self.create(ctl, sid="s1", token="t1")
        await self.feed(agent, {"type": "HOST_EXIT", "node": "n1"})
        self.assertEqual(ctl.last("NODE_GONE")["node"], "n1")
        self.assertEqual(self.relay.nodes["n1"].last_list["sessions"], [])

    # ---------------------------------------------------------------- 落盘与恢复

    async def test_state_survives_restart(self) -> None:
        await self.agent("n1")
        ctl = await self.client("c1", host="n1", primary=True)
        await self.create(ctl, sid="s1", token="t1")

        reborn = relay.Relay(TOKEN)
        self.assertEqual(reborn.sessions["s1"].owner, "c1")
        self.assertEqual(reborn.sessions["s1"].index, 1)
        self.assertEqual(reborn.default_claimant, "c1")
        self.assertEqual(reborn.seq, 1)
        # 新会话不会和老会话撞号
        self.assertEqual(reborn.next_index(), 2)

    async def test_orphan_session_claimed_by_primary(self) -> None:
        agent = await self.agent("n1")
        ctl = await self.client("c1", host="n1", primary=True)
        # 归属机制上线前留下的会话：relay 表里没有它
        await self.feed(
            agent,
            {"type": "SESSION_LIST", "sessions": [{"session_id": "old", "data_token": "t0"}]},
        )
        self.assertEqual(self.relay.sessions["old"].owner, "c1")
        self.assertTrue(self.relay.sessions["old"].claimed)
        self.assertEqual(ctl.last("SESSION_LIST")["sessions"][0]["owner"], "c1")

    # ---------------------------------------------------------------- HTTP / 版本兼容

    async def test_healthz_old_signature(self) -> None:
        """websockets 12.x 的调用方式：process_request(path, headers)。"""
        result = await self.relay.process_request("/healthz", {})
        if relay.NEW_WS_API:
            # 15.x 里就算调用方传的是字符串，也要回 Response（serve 只认这个）
            self.assertEqual(result.status_code, 200)
            body = result.body
        else:
            status, headers, body = result
            self.assertEqual(status, 200)
            self.assertEqual(dict(headers)["Content-Type"], "application/json")
        self.assertTrue(json.loads(body)["ok"])

    async def test_healthz_new_signature(self) -> None:
        """websockets 15.x 的调用方式：process_request(connection, request)，路径在 connection.request.path。"""

        class Req:
            path = "/healthz"

        class Conn:
            request = Req()

        result = await self.relay.process_request(Conn(), Req())
        if relay.NEW_WS_API:
            # 新实现要的是 Response 对象，不是三元组
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["Content-Type"], "application/json")
            body = result.body
        else:
            status, _, body = result
            self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    async def test_process_request_leaves_ws_paths_alone(self) -> None:
        """只接管 /healthz，WebSocket 端点原样放行（返回 None）。"""
        self.assertIsNone(await self.relay.process_request("/ctl?token=x"))
        self.assertIsNone(await self.relay.process_request("/agent?node=n1"))

        class Req:
            path = "/d/tok?role=ctl"

        class Conn:
            request = Req()

        self.assertIsNone(await self.relay.process_request(Conn(), Req()))

    async def test_ws_path_reads_both_layouts(self) -> None:
        """老实现 ws.path、新实现 ws.request.path 都取得到。"""

        class Old:
            path = "/ctl?token=x"

        class New:
            class request:
                path = "/ctl?token=x"

        self.assertEqual(relay.ws_path(Old()), "/ctl?token=x")
        self.assertEqual(relay.ws_path(New()), "/ctl?token=x")

    async def test_handle_routes_using_request_path(self) -> None:
        """新实现下 handle() 也能靠 ws.request.path 找到 /ctl 路由。"""

        class NewWS(FakeWS):
            def __init__(self, path: str) -> None:
                super().__init__(path)
                del self.path  # 只留 request.path，模拟 15.x
                self.request = type("Req", (), {"path": path})()

        ctl = NewWS("/ctl?token=tok-123&client=c9&name=新实现")
        task = asyncio.create_task(self.relay.handle(ctl))
        await asyncio.sleep(0)
        await self.settle()
        self.assertIsNotNone(ctl.last("HELLO"))
        self.assertIn("c9", self.relay.clients)
        task.cancel()

    # ---------------------------------------------------------------- 节点重连

    async def test_agent_reconnect_replaces_old_socket(self) -> None:
        first = await self.agent("n1")
        second = await self.agent("n1")
        await self.settle()
        self.assertEqual(first.closed[0], 4002)
        self.assertIs(self.relay.nodes["n1"].ws, second)


if __name__ == "__main__":
    unittest.main()
