# tests

relay 状态机的集成测。不起服务、不占端口：假 ws 直接驱动
`Relay.handle_agent / handle_ctl / handle_data`，所以随便跑。

## 怎么跑

```sh
python3.12 -m unittest discover -s tests          # 全量
python3.12 -m unittest tests.test_relay -v        # 单文件带用例名
python3.12 -m unittest tests.test_relay.TestRelay.test_session_create_owner -v
```

依赖 `websockets`（仓库 `server/requirements.txt` 里锁的 12.0 即可）。
用例里的 `FakeWS` 只依赖 `websockets.exceptions.ConnectionClosed`，
不需要真的连上任何东西。

注意：`process_request`（`/healthz`）的参数签名在 websockets 15 变了，
本机若用 anaconda 的 python3.14 跑会缺依赖；用 `python3.12` 最省事。

## 覆盖了什么

一个用例钉住一条行为，出问题时看用例名就知道哪条协议被改了：

- 鉴权失败、token 不对直接关
- agent 上线/下线广播 `NODES`、`CLIENTS`
- `SESSION_LIST` 全局发号（relay 是唯一发号处，重启后不撞号）
- `SESSION_CREATE` 归属：谁的桌面归谁，在别人桌面里建的归对方
- `SESSION_RESIZE` 仲裁：只有创建端生效，镜像端只锁不抢，荒唐尺寸丢弃
- 广播：`SESSION_LIST` / `CLIENTS` 到所有控制端连接
- 数据面：1:N 多播、按键回灌 agent、快照先于排队增量
- 无快照时的兜底放行（2.5s 后直接开放增量）
- `SESSION_CLOSE` 摘缓存 + 广播 `SESSION_CLOSED`
- 配对：双向可见、断开即解配
- 断开不连坐：一个客户端走了不影响别人
- 同一个 client id 的两条连接合并成一个实体
- `HOST_EXIT` 清宿主标签
- 状态落盘与恢复（owner / index / claimant / seq）
- 无主会话被 primary 认领
- agent 重连顶替（旧连接 4002）

## 约定

- 每个用例自己设 `RPTY_STATE_FILE` 到临时目录，互不影响，也不碰线上 `/data`。
- 加新行为时先加一个用例，再改 `server/relay.py`——这仓库此前零测试，
  靠人肉点界面验证的那段历史不必重演。
