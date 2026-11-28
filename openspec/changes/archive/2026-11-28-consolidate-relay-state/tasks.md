# 任务

## 1. 先钉行为（测试）

- [x] `tests/test_relay.py`：假 ws（`path` / `send` / `close` / 异步迭代）+ 临时状态文件
- [x] 覆盖：鉴权失败、agent 上线广播、`SESSION_LIST` 全局发号、`SESSION_CREATE` 归属、resize 仲裁、
      多 ctl 广播、数据面多播与按键回灌、快照定向 + 排队增量顺序、`SESSION_CLOSE` 摘缓存、
      配对与解配、断开不连坐、状态落盘与恢复、agent 重连顶替
- [x] `tests/README.md`：怎么跑（`python3.12 -m unittest discover -s tests`）

## 2. 状态收口

- [x] `Node` / `Client` / `Session` / `Viewer` / `Channel` 五个 dataclass（单文件内，不拆包）
- [x] `Relay` 容器从 13 + 4 收到 6 + 3：
      `nodes` / `clients` / `sessions` / `channels` / `viewers` / `by_ws` + `seq` / `default_claimant` / `claimant_primary`
- [x] `clients_summary()` / `pairs_summary()` 改为遍历 `Client` 对象，字段直读
- [x] `_save_state()` / `_load_state()` 改为读写 `Session` 记录，**文件格式不变**
- [x] 广播改为对 `Client.conns` 快照遍历（避免 await 期间被改）
- [x] `decorate_sessions()`、`_apply_resize_to_lists()`、`_drop_from_lists()` 保持语义
- [x] `handle_agent` / `handle_ctl` / `handle_data` 的协议与分支保持逐条对应
- [x] `/healthz` 字段不变（`ctls` = 连接数，`clients` = 客户端列表）

## 3. 验收

- [x] 全部测试通过（18 个用例，3.0s）
- [x] `python3 -m py_compile server/relay.py`
- [x] 本地起 relay + agent + 客户端跑一遍：开终端、快照、按键回灌、关标签，与重构前的 relay 同脚本 A/B 对比
- [x] 更新 `openspec/specs/pty-relay/spec.md`：新增「服务端状态单一事实来源」要求
- [x] 归档到 `openspec/changes/archive/2026-11-28-consolidate-relay-state/`
