# 任务

## 1. relay 兼容两种 websockets

- [x] serve 导入按版本回落：`websockets.asyncio.server.serve`（15+）→ `websockets.server.serve`（12.x）
- [x] `process_request` 接受 `(path, headers)` 与 `(connection, request)` 两种签名，`/healthz` 都返回 200 + JSON
- [x] `ws_path(ws)`：`ws.path` 与 `ws.request.path` 都认，`handle()` / `handle_ctl()` 改用它
- [x] 15+ 走新实现，不再有 `websockets.server.serve is deprecated` 警告

## 2. 依赖声明

- [x] `server/requirements.txt` 钉 `websockets==15.0.1`（附一行说明为什么不能低于 14）
- [x] `server/Dockerfile` 是 `python:3.10-slim`，满足 15.x 的 `>=3.9`，无需改

## 3. 验证

- [x] `websockets 12.0` 环境跑全量测试：23 个用例通过
- [x] `websockets 15.0.1` 环境跑全量测试：23 个用例通过
- [x] 新增测试 5 个：`/healthz` 老签名、`/healthz` 新签名、非 `/healthz` 不接管、`ws_path` 两种布局、`handle()` 靠 `request.path` 路由
- [x] 15.0.1 端到端：relay + agent + 客户端 `HELLO → SESSION_CREATE → 快照 118B → 按键回显 → SESSION_CLOSE` 全通
- [x] 混搭端到端：relay 跑在 12.0、agent 跑在 15.0.1，同样全通（老镜像不会被新 agent 打死）
- [x] `python3 -m py_compile server/relay.py`

## 4. 归档

- [x] `openspec/specs/pty-relay/spec.md` 新增「依赖声明与运行时一致」要求
- [x] 归档到 `openspec/changes/archive/2026-11-28-unify-websockets-version/`
