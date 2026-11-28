# 统一 websockets 版本：锁的版本跑不动代码

## 为什么

`server/requirements.txt` 只有一行 `websockets==12.0`，而仓库里两个进程对它的要求是**互相矛盾**的：

| 代码 | 用到的 API | 需要版本 |
| --- | --- | --- |
| `agent/rpty_agent.py:192`、`:455` | `websockets.connect(..., proxy=None)` | `proxy` 参数 15.x 才有（14 及以前不认识，13 会直接 `TypeError`） |
| `server/relay.py:1148` | `websockets.serve(..., process_request=cb)`，`cb(path: str, headers)` | 12.x 正常；15.x 里 `process_request` 的第一个参数变成了连接对象，`urlparse(path)` 直接 `AttributeError: 'ServerConnection' object has no attribute 'decode'` |

也就是说：**照 `requirements.txt` 装的 12.0，agent 一启动就死在 `create_connection() got an unexpected keyword argument 'proxy'`；
按 15.x 装，relay 一访问 `/healthz` 就 500。** 线上现在能跑，是因为机器上手工装的是某个中间版本，
而 Docker 镜像（`python:3.10-slim` + `requirements.txt`）按文件装会得到一个跑不起来的环境 —— 一重建就炸。

这不是风格问题，是**依赖声明与代码不一致**，属于「换个干净机器就复现不了线上」的那类故障。

## 变成什么样

一句话：**一个版本，两个进程都能跑，且 `requirements.txt` 说的就是实际跑的。**

1. `server/requirements.txt` 钉到 **`websockets==15.0.1`**（本机已装、已实测的版本；15.x 也是目前带 `proxy` 参数的最新主线）。
2. `server/relay.py` 加一层薄兼容，让它 **12.x 与 15.x 都能起**：
   - serve 入口按版本选择：15+ 用 `websockets.asyncio.server.serve`（新实现，不再有 Deprecation 警告），
     12.x 回落到 `websockets.server.serve`（老实现）。
   - `process_request` 同时接受两种签名：`(path: str, headers)` 与 `(connection, request)`；
     新签名下用 `connection.respond(...)` 交回 HTTP 响应，老签名下仍返回 `(status, headers, body)`。
   - `handle()` 里取路径改成一个小函数 `_ws_path(ws)`：`ws.path`（老）或 `ws.request.path`（新）都认。
   - 这样「升不升级」变成**部署时机问题，不是能不能启动的问题**。
3. 测试补三条：`/healthz` 在两种 `process_request` 签名下都给出 200 + JSON；非 `/healthz` 路径不接管。

**不动**：`agent/rpty_agent.py` 一行都不改（它的写法在 15.x 下是对的）；协议、端点、`/healthz` 输出字段、
`Client/Node/Session` 状态模型、`RPTY_STATE_FILE` 格式全部不变。

## 为什么不选「降回 12.0」

那条路是删掉 agent 里的 `proxy=None`（两处），代价看起来更小，但：

- `proxy=None` 是**故意的**：本机开着 Clash，环境里带 `ALL_PROXY` 时，新版 websockets 默认会走代理连 relay，
  而 relay 就在家里/云上的直连地址，走代理会绕出去甚至失败。删掉它等于把「别用代理」这条约束丢掉。
- 12.0 已经是 2023 年的版本，legacy 实现在 15 之后进入维护倒计时，继续往下钉等于把债往后推。
- 兼容层只有二十来行，且两种签名都能用测试钉住，比"改 agent 行为"更容易验证。

## 代价

- relay 多一层版本兼容分支（约 25 行 + 一个 `_ws_path` 辅助函数），代价是「同一个行为有两套入口」，
  所以两种情况都必须在测试里跑一遍。
- `requirements.txt` 从 12.0 跳到 15.0.1，镜像重建时要重新拉依赖；`python:3.10-slim` 满足 15.x 的
  `>=3.9` 要求，Dockerfile 不用改。
- 本机两套环境都要留：`websockets 12.0`（验证兼容分支）与 `15.0.1`（验证新路径）。

## 落地记录

### 结果

- `server/requirements.txt`：`websockets==12.0` → **`websockets==15.0.1`**，附一行注释说明「agent 侧要 `proxy=` 参数，不能低于 14」。
- `server/relay.py` 顶部加了一段 20 行的版本适配层，其余逻辑一行没动：

  ```python
  try:      # 15+：新 asyncio 实现
      from websockets.asyncio.server import ServerConnection as WSConn, serve as ws_serve
      from websockets.http11 import Response as HTTPResponse
      NEW_WS_API = True
  except ImportError:   # 12.x：legacy 实现
      from websockets.server import WebSocketServerProtocol as WSConn, serve as ws_serve
      NEW_WS_API = False
  ```

  - `ws_path(ws)`：`ws.path` / `ws.request.path` 都认。
  - `process_request(*args)`：`isinstance(args[0], str)` 判新老签名；新签名回 `http11.Response`（带
    `Content-Type: application/json`），老签名回 `(200, headers, body)`。
  - `serve` 统一走 `ws_serve`，15+ 下不再打印 `websockets.server.serve is deprecated`。
  - 类型注解从 `WebSocketServerProtocol` 改成 `Any`（两个版本里的连接类型不同，写死哪个都会在另一个版本下报错）。
- `agent/rpty_agent.py` **零改动**。

### 验证

- 测试：`tests/test_relay.py` 从 18 个用例加到 **23 个**，新增 5 个专钉版本兼容
  （`/healthz` 老签名、`/healthz` 新签名、非 `/healthz` 不接管、`ws_path` 两种布局、
  `handle()` 靠 `request.path` 路由到 `/ctl`）。
  - `websockets 12.0`：23/23 通过
  - `websockets 15.0.1`：23/23 通过
- 端到端（15.0.1）：relay + agent + 客户端全用 15.0.1，`/healthz` 返回
  `HTTP/1.1 200` + `Content-Type: application/json`（`Server: Python/3.12 websockets/15.0.1`），
  随后 `SESSION_CREATE → 快照 118 字节 → 按键原样回显 → SESSION_CLOSE` 全通。
- 混搭端到端：relay 跑 12.0、agent 跑 15.0.1，`/healthz` 200、数据面回显正常 —— 老镜像不会被新 agent 打死，
  新镜像也不用等 agent 升级。
- 附带收益：15.0.1 下 `ws.close(code=4001/4002/4004, reason=...)`、`async for message in ws`、
  1:N 多播、快照定向全部照常，说明迁移到新 asyncio 实现没有改到任何协议行为。

### 仍未处理（另开变更）

- relay 目前仍走 legacy 的 handler 风格（一条连接一个协程），没用 15.x 新实现的多连接特性；
  等 16.x 真正删掉 legacy 时再决定是迁到 `ServerConnection` 全量写法，还是把 relay 拆成模块。
- 部署侧要重建镜像才会用上 15.0.1；`requirements.txt` 改完之前打出来的镜像仍装 12.0 —— 但那份 relay.py
  现在两种版本都能起，所以「先发代码、后重建」也不会造成窗口期故障。
