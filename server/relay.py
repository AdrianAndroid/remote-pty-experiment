#!/usr/bin/env python3
"""
rpty relay —— 云中继。

三个端点：

    /agent        被控端（PTY 宿主）长连接，JSON 信令
    /ctl          控制端长连接，JSON 信令
    /d/<token>    某个会话的数据通道，纯二进制双向泵

relay 的设计目标是「什么都不懂」：不解析终端字节流，不生成会话 id，不
保存会话状态。配对两个端点所需的 token 由控制端生成并随 SESSION_CREATE
下发给 agent，两边各自来连 /d/<token>；先到的排队，后到的立刻开始双向
转发。因此 relay 挂了重启，只要两端重连，会话本身不受影响（PTY 活在
agent 那台机器上）。

环境变量：
    RPty_TOKEN    必填，agent 与 ctl 共用的共享密钥
    RPty_HOST     默认 127.0.0.1
    RPty_PORT     默认 8765
    RPty_PAIR_TIMEOUT  数据通道等待配对的秒数，默认 60
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol

LOG = logging.getLogger("relay")

# 终端输出可能一次来很大（比如 cat 一个二进制文件），但不能无限。
MAX_MESSAGE = 8 * 1024 * 1024


class Relay:
    def __init__(self, token: str, pair_timeout: float = 60.0) -> None:
        self.token = token
        self.pair_timeout = pair_timeout

        self.agent: Optional[WebSocketServerProtocol] = None
        self.ctl: Optional[WebSocketServerProtocol] = None

        # data_token -> 先到的那一端
        self.pending: Dict[str, WebSocketServerProtocol] = {}
        self.pending_since: Dict[str, float] = {}

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
            body = json.dumps(
                {
                    "ok": True,
                    "uptime": int(time.time() - self.started_at),
                    "agent": self.agent is not None,
                    "ctl": self.ctl is not None,
                    "pending_channels": len(self.pending),
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
            await self.handle_agent(ws)
        elif route == "/ctl":
            await self.handle_ctl(ws)
        elif route.startswith("/d/"):
            token = route[len("/d/"):]
            if not token:
                await ws.close(code=4004, reason="missing token")
                return
            await self.handle_data(ws, token)
        else:
            await ws.close(code=4004, reason="unknown route")

    # ---------------------------------------------------------------- 信令

    async def handle_agent(self, ws: WebSocketServerProtocol) -> None:
        previous = self.agent
        self.agent = ws
        if previous is not None and previous is not ws:
            LOG.info("agent 重连，顶掉旧连接")
            await previous.close(code=4002, reason="replaced")

        LOG.info("agent 上线 %s", ws.remote_address)
        await self.send_json(
            self.ctl, {"type": "AGENT_ONLINE", "at": int(time.time())}
        )

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    LOG.warning("agent 发来非 JSON，丢弃")
                    continue
                if not isinstance(msg, dict):
                    continue
                await self.send_json(self.ctl, {**msg, "src": "agent"})
        except ConnectionClosed:
            pass
        finally:
            if self.agent is ws:
                self.agent = None
                LOG.info("agent 下线")
                await self.send_json(self.ctl, {"type": "AGENT_OFFLINE"})

    async def handle_ctl(self, ws: WebSocketServerProtocol) -> None:
        previous = self.ctl
        self.ctl = ws
        if previous is not None and previous is not ws:
            LOG.info("ctl 重连，顶掉旧连接")
            await previous.close(code=4002, reason="replaced")

        LOG.info("ctl 上线 %s", ws.remote_address)
        await self.send_json(
            ws,
            {
                "type": "HELLO",
                "agent_online": self.agent is not None,
                "server_time": int(time.time()),
                "version": "1.0.0",
            },
        )
        if self.agent is not None:
            await self.send_json(self.agent, {"type": "CTL_ONLINE"})

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
                    if self.agent is None:
                        await self.send_json(
                            ws,
                            {
                                "type": "ERROR",
                                "code": "agent_offline",
                                "message": "被控端不在线",
                                "ref": msg.get("request_id"),
                            },
                        )
                        continue
                    await self.send_json(self.agent, {**msg, "src": "ctl"})
                else:
                    # 其它类型直接回显错误，避免静默吞掉。
                    await self.send_json(
                        ws,
                        {"type": "ERROR", "code": "bad_type", "message": f"未知信令 {msg_type}"},
                    )
        except ConnectionClosed:
            pass
        finally:
            if self.ctl is ws:
                self.ctl = None
                LOG.info("ctl 下线")
                await self.send_json(self.agent, {"type": "CTL_OFFLINE"})

    # ---------------------------------------------------------------- 数据

    async def handle_data(self, ws: WebSocketServerProtocol, token: str) -> None:
        waiter = self.pending.pop(token, None)
        self.pending_since.pop(token, None)

        if waiter is None:
            self.pending[token] = ws
            self.pending_since[token] = time.time()
            LOG.debug("数据通道 %s 先到，等待配对", token[:8])
            try:
                await asyncio.wait_for(ws.wait_closed(), timeout=self.pair_timeout)
            except asyncio.TimeoutError:
                LOG.warning("数据通道 %s 等待配对超时", token[:8])
                await ws.close(code=4008, reason="pair timeout")
            finally:
                if self.pending.get(token) is ws:
                    self.pending.pop(token, None)
                    self.pending_since.pop(token, None)
            return

        LOG.info("数据通道 %s 配对成功", token[:8])
        self.stats["sessions_opened"] += 1
        await self.pump(waiter, ws)

    async def pump(self, a: WebSocketServerProtocol, b: WebSocketServerProtocol) -> None:
        """双向字节泵。任何一端断开，把另一端也关掉。"""

        async def forward(src, dst, counter: str) -> None:
            try:
                async for chunk in src:
                    if isinstance(chunk, str):
                        # 控制端理论上只发二进制；万一发了文本，按 UTF-8 转。
                        chunk = chunk.encode("utf-8")
                    self.stats[counter] += len(chunk)
                    await dst.send(chunk)
            except ConnectionClosed:
                pass
            finally:
                try:
                    await dst.close()
                except Exception:  # noqa: BLE001
                    pass

        await asyncio.gather(
            forward(a, b, "bytes_from_ctl"),
            forward(b, a, "bytes_from_agent"),
            return_exceptions=True,
        )
        LOG.info("数据通道关闭")


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
    pair_timeout = float(os.environ.get("RPty_PAIR_TIMEOUT", "60"))

    logging.basicConfig(
        level=os.environ.get("RPty_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    relay = Relay(token, pair_timeout)

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
