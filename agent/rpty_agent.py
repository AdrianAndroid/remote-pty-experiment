#!/usr/bin/env python3
"""
rpty agent —— 跑在被控 Mac 上，开真实 PTY 并把字节流送到 relay。

它只做三件事：

    1. 维持一条到 relay /agent 的信令长连接，收 SESSION_* 指令
    2. 为每个会话 fork 一个真 PTY，起一条到 /d/<token> 的数据连接
    3. 把 PTY 输出灌进数据连接，把数据连接的字节写回 PTY

会话 token 由控制端生成，agent 原样使用，因此 agent 不需要任何全局状态。

用法：
    python3 rpty_agent.py --relay wss://rpty.zhaojian.xin --token <TOKEN>

环境变量也可以：RPty_RELAY / RPty_TOKEN
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import json
import logging
import os
import pty
import signal
import socket
import struct
import sys
import termios
import time
from typing import Any, Dict, Optional

import websockets
from websockets.exceptions import ConnectionClosed

LOG = logging.getLogger("agent")

# 每个会话保留多少历史，供重连时重放。
RING_BYTES = 256 * 1024
# PTY 读缓冲队列超过这个条数就暂停读 fd，做背压。
QUEUE_HIGH = 256
QUEUE_LOW = 64
READ_CHUNK = 64 * 1024


def clamp(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


class Session:
    """一个真实 PTY 会话。"""

    def __init__(
        self,
        sid: str,
        token: str,
        cols: int,
        rows: int,
        shell: str,
        on_finish=None,
    ) -> None:
        self.sid = sid
        self.token = token
        # 被控机上的全局序号，用来让所有客户端显示同一个「终端 N」
        self.index = 0
        self.cols = cols
        self.rows = rows
        self.shell = shell
        self.on_finish = on_finish

        self.loop = asyncio.get_running_loop()
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()
        self.buffer = bytearray()
        self.ws: Optional[Any] = None
        self.paused = False
        self.closed = False

        self.pid, self.fd = self._fork_pty()
        self._apply_size()
        self.loop.add_reader(self.fd, self._on_readable)
        LOG.info("会话 %s 建立 pid=%d %dx%d", sid[:8], self.pid, cols, rows)

    # ------------------------------------------------------------ PTY

    def _fork_pty(self):
        pid, fd = pty.fork()
        if pid == 0:
            # 子进程：只做 exec，绝不回到 asyncio。
            try:
                os.chdir(os.path.expanduser("~"))
                env = os.environ.copy()
                env.update(
                    {
                        "TERM": "xterm-256color",
                        "COLORTERM": "truecolor",
                        "TERM_PROGRAM": "rpty",
                    }
                )
                os.execvpe(self.shell, [self.shell, "-l"], env)
            except BaseException:
                os._exit(127)
        return pid, fd

    def _apply_size(self) -> None:
        try:
            fcntl.ioctl(
                self.fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", self.rows, self.cols, 0, 0),
            )
        except OSError:
            LOG.debug("设置窗口尺寸失败", exc_info=True)

    def resize(self, cols: int, rows: int) -> None:
        self.cols = clamp(cols, 2, 1000, self.cols)
        self.rows = clamp(rows, 2, 500, self.rows)
        self._apply_size()

    def write(self, data: bytes) -> None:
        if self.closed:
            return
        try:
            os.write(self.fd, data)
        except OSError:
            LOG.debug("写入 PTY 失败", exc_info=True)

    # ------------------------------------------------------------ 读方向

    def _on_readable(self) -> None:
        try:
            chunk = os.read(self.fd, READ_CHUNK)
        except OSError:
            chunk = b""

        if not chunk:
            self.loop.remove_reader(self.fd)
            self._finish("eof")
            return

        self.buffer.extend(chunk)
        if len(self.buffer) > RING_BYTES:
            del self.buffer[: len(self.buffer) - RING_BYTES]

        if self.queue.qsize() < QUEUE_HIGH * 2:
            self.queue.put_nowait(chunk)

        if self.queue.qsize() > QUEUE_HIGH and not self.paused:
            self.loop.remove_reader(self.fd)
            self.paused = True
            LOG.debug("会话 %s 背压：暂停读 PTY", self.sid[:8])

    async def drain_loop(self) -> None:
        while not self.closed:
            chunk = await self.queue.get()
            if self.ws is not None:
                try:
                    await self.ws.send(chunk)
                except ConnectionClosed:
                    pass
                except Exception:  # noqa: BLE001
                    LOG.debug("发送失败", exc_info=True)

            if self.paused and self.queue.qsize() < QUEUE_LOW and not self.closed:
                try:
                    self.loop.add_reader(self.fd, self._on_readable)
                except Exception:  # noqa: BLE001
                    pass
                self.paused = False

    # ------------------------------------------------------------ 数据通道

    async def run_data(self, url: str, notify) -> None:
        """维护 /d/<token> 的 agent 侧连接；断了就重连。

        历史不再从这里重放 —— 多播通道下会把老画面重复推给已经在看的端。
        新 viewer 要历史，走 VIEWER_JOINED -> SESSION_SNAPSHOT 那条定向路径。
        """
        drain = asyncio.create_task(self.drain_loop())
        try:
            while not self.closed:
                try:
                    async with websockets.connect(url, max_size=None, ping_interval=20, proxy=None) as ws:
                        self.ws = ws
                        LOG.info("会话 %s 数据通道已连", self.sid[:8])
                        async for message in ws:
                            if isinstance(message, str):
                                message = message.encode("utf-8")
                            self.write(message)
                except ConnectionClosed:
                    pass
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    LOG.warning("会话 %s 数据通道异常：%s", self.sid[:8], exc)
                finally:
                    self.ws = None

                if self.closed:
                    break
                await asyncio.sleep(1.0)
        finally:
            drain.cancel()

    # ------------------------------------------------------------ 收尾

    def _finish(self, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        LOG.info("会话 %s 结束（%s）", self.sid[:8], reason)
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass

        if self.on_finish is not None:
            try:
                self.on_finish(self.sid)
            except Exception:  # noqa: BLE001
                LOG.debug("on_finish 回调失败", exc_info=True)

    def close(self) -> None:
        self._finish("closed")


class Agent:
    def __init__(self, relay: str, token: str) -> None:
        self.relay = relay.rstrip("/")
        self.token = token
        self.sessions: Dict[str, Session] = {}
        self.hostname = socket.gethostname()
        self.tasks: Dict[str, asyncio.Task] = {}
        self.ws: Optional[Any] = None
        self.backoff = 1.0
        # 所有客户端共用一套编号：谁建的都按这个序号显示，两端标签才对得上。
        self.seq = 0

    @property
    def signal_url(self) -> str:
        return f"{self.relay}/agent?token={self.token}"

    def data_url(self, data_token: str) -> str:
        # role=agent 区分多播通道的两侧：别的客户端都以 role=ctl 挂进来当 viewer。
        return f"{self.relay}/d/{data_token}?role=agent&token={self.token}"

    # ------------------------------------------------------------ 主循环

    async def run(self) -> None:
        while True:
            try:
                await self.run_once()
                self.backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                LOG.warning("信令连接断开：%s", exc)

            delay = self.backoff
            self.backoff = min(self.backoff * 2, 30.0)
            LOG.info("%.1fs 后重连 relay", delay)
            await asyncio.sleep(delay)

    async def run_once(self) -> None:
        async with websockets.connect(self.signal_url, ping_interval=20, max_size=None, proxy=None) as ws:
            self.ws = ws
            self.backoff = 1.0
            LOG.info("已连上 relay %s", self.relay)

            # 告知当前已有会话，便于控制端重建标签。
            await self.send_session_list()

            async for raw in ws:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                await self.dispatch(message)

    async def send_session_list(self) -> None:
        if self.ws is None:
            return
        payload = {
            "type": "SESSION_LIST",
            "hostname": self.hostname,
            "platform": sys.platform,
            "sessions": [
                {
                    "session_id": s.sid,
                    "data_token": s.token,
                    "cols": s.cols,
                    "rows": s.rows,
                    "index": s.index,
                }
                for s in self.sessions.values()
                if not s.closed
            ],
        }
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except ConnectionClosed:
            pass

    async def dispatch(self, message: Dict[str, Any]) -> None:
        kind = message.get("type")
        LOG.debug("收到信令 %s", {k: v for k, v in message.items() if k != "src"})

        if kind == "SESSION_CREATE":
            await self.on_create(message)
        elif kind == "SESSION_CLOSE":
            sid = message.get("session_id") or ""
            self.on_close(sid)
        elif kind == "SESSION_RESIZE":
            sid = message.get("session_id") or ""
            session = self.sessions.get(sid)
            if session is not None:
                session.resize(message.get("cols"), message.get("rows"))
        elif kind == "VIEWER_JOINED":
            await self.on_viewer_joined(message)
        elif kind == "CTL_ONLINE":
            LOG.info("控制端已上线")
            # 控制端刚连上时收不到之前发的 SESSION_LIST，这里补一份，
            # 否则客户端拿不到 hostname，也没法判断哪些会话还活着。
            await self.send_session_list()
        elif kind == "PING":
            await self.reply({"type": "PONG", "at": int(time.time())})
        else:
            LOG.debug("未知信令 %s", kind)

    async def reply(self, payload: Dict[str, Any]) -> None:
        if self.ws is None:
            return
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except ConnectionClosed:
            pass

    async def on_viewer_joined(self, message: Dict[str, Any]) -> None:
        """有新客户端挂到这个会话：把环形缓冲当「当前屏幕」补给它。

        多播通道里没法只对某一个人说话，所以快照走信令、带 cid 让 relay 定向投。
        """
        data_token = str(message.get("data_token") or "")
        cid = str(message.get("cid") or "")
        if not cid:
            return

        target = None
        for session in self.sessions.values():
            if session.token == data_token and not session.closed:
                target = session
                break

        # 哪怕没有历史也必须回一条，否则 relay 那边这个 viewer 会一直等快照、增量全卡住。
        payload: Dict[str, Any] = {
            "type": "SESSION_SNAPSHOT",
            "cid": cid,
            "data_token": data_token,
            "data": "",
        }
        if target is not None:
            payload["session_id"] = target.sid
            payload["data"] = base64.b64encode(bytes(target.buffer)).decode("ascii")
            LOG.info(
                "给新 viewer %s 补快照 %d 字节（会话 %s）",
                cid,
                len(target.buffer),
                target.sid[:8],
            )
        else:
            LOG.warning("VIEWER_JOINED 找不到会话 token=%s", data_token[:8])
        await self.reply(payload)

    # ------------------------------------------------------------ 会话

    async def on_create(self, message: Dict[str, Any]) -> None:
        sid = str(message.get("session_id") or "")
        data_token = str(message.get("data_token") or "")
        if not sid or not data_token:
            await self.reply(
                {"type": "ERROR", "code": "bad_request", "message": "缺少 session_id 或 data_token"}
            )
            return

        if sid in self.sessions:
            existing = self.sessions[sid]
            if not existing.closed:
                # 幂等：控制端重连时会用同一个 session_id 再要一次。
                # 这里绝不能新建 PTY，只确认并保证数据通道还在。
                task = self.tasks.get(sid)
                if task is None or task.done():
                    self.tasks[sid] = asyncio.create_task(
                        existing.run_data(self.data_url(existing.token))
                    )
                LOG.info("会话 %s 已存在，按重连处理", sid[:8])
                await self.reply(
                    {
                        "type": "SESSION_CREATED",
                        "session_id": sid,
                        "data_token": existing.token,
                        "pid": existing.pid,
                        "title": "reconnect",
                    }
                )
                return
            # 已退出的旧会话，清掉重开。
            self.sessions.pop(sid, None)
            old_task = self.tasks.pop(sid, None)
            if old_task is not None:
                old_task.cancel()

        if len([s for s in self.sessions.values() if not s.closed]) >= 32:
            await self.reply({"type": "ERROR", "code": "too_many", "message": "会话数超过上限"})
            return

        shell = str(message.get("shell") or os.environ.get("SHELL") or "/bin/zsh")
        cols = clamp(message.get("cols"), 2, 1000, 80)
        rows = clamp(message.get("rows"), 2, 500, 24)

        try:
            session = Session(
                sid, data_token, cols, rows, shell, on_finish=self.drop_session
            )
        except Exception as exc:  # noqa: BLE001
            LOG.exception("创建 PTY 失败")
            await self.reply({"type": "ERROR", "code": "pty_failed", "message": str(exc)})
            return

        self.seq += 1
        session.index = self.seq
        self.sessions[sid] = session
        task = asyncio.create_task(session.run_data(self.data_url(data_token), self.reply))
        self.tasks[sid] = task

        await self.reply(
            {
                "type": "SESSION_CREATED",
                "session_id": sid,
                "data_token": data_token,
                "pid": session.pid,
                "title": os.path.basename(shell),
            }
        )
        # 让所有在线的控制端都发现这个新终端 —— 镜像模式下大家看同一批会话。
        await self.send_session_list()

    def drop_session(self, sid: str) -> None:
        """PTY 自己退出后清表，避免 sessions 里堆一堆死会话。"""
        self.sessions.pop(sid, None)
        task = self.tasks.pop(sid, None)
        if task is not None:
            task.cancel()
        self.notify_list_changed()

    def notify_list_changed(self) -> None:
        """会话增减后广播一次列表；这是同步回调，不能直接 await。"""
        try:
            asyncio.get_running_loop().create_task(self.send_session_list())
        except RuntimeError:
            pass

    def on_close(self, sid: str) -> None:
        session = self.sessions.pop(sid, None)
        if session is None:
            return
        session.close()
        task = self.tasks.pop(sid, None)
        if task is not None:
            task.cancel()
        self.notify_list_changed()


async def amain() -> None:
    parser = argparse.ArgumentParser(description="rpty agent")
    parser.add_argument("--relay", default=os.environ.get("RPty_RELAY", ""), help="wss://host")
    parser.add_argument("--token", default=os.environ.get("RPty_TOKEN", ""), help="共享密钥")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if not args.relay or not args.token:
        sys.exit("启动失败：需要 --relay 与 --token（或 RPty_RELAY / RPty_TOKEN）")

    agent = Agent(args.relay, args.token)

    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    def _shutdown() -> None:
        if not stop.done():
            stop.set_result(None)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            pass

    runner = asyncio.create_task(agent.run())
    await stop
    runner.cancel()
    for session in list(agent.sessions.values()):
        session.close()
    LOG.info("agent 退出")


if __name__ == "__main__":
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
