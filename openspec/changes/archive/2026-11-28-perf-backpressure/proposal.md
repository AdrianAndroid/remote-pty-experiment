# 性能治理：内存上限、每字节开销、显示路径合批

## 为什么
relay 跑在阿里云 2 vCPU / 1.6 GiB / **无 swap** 的机器上。压测（`/tmp/rpty-bench/bench.py`）
显示吞吐和延迟都不是瓶颈：下行 1KB 小帧 ≈12.7 MB/s、64KB 大块 173 MB/s、
按键 23.7k 次/s、回环 p50 0.43ms。真正会杀死这台机器的是**内存**和**每字节的固定开销**。

## 改了什么

### 1. viewer 队列按字节限流（server/relay.py）
- `Viewer.queue_bytes` 记录该观看者「等快照期间」已攒的字节。
- 新增 `VIEWER_QUEUE_BYTES = 8MB`；原来的 `VIEWER_QUEUE_MAX = 512` 只按条数。
  一条 8MB 的帧重复 512 次就是 4GB，足以 OOM。
- 超过任一上限：`_drop_viewer(..., 4009, "slow")` 断开这一个 viewer，
  通道与同通道的其他 viewer 不受影响；重连走 `SESSION_SNAPSHOT` 重新取屏。

### 2. 无差别广播只序列化一次
`broadcast_ctls` 里 `CLIENTS` / `NODES` / `NODE_ONLINE` 这类不含 `sessions` 列表、
也没有 `session_id` 的节点级广播，改为 `json.dumps` 一次、逐连接 `_send_text` 复用。
原来 20 个客户端就 dump 20 次。

### 3. 客户端显示路径合批（apps/desktop/src/main/relay-client.ts）
- 终端输出不再「每块一次 IPC → 每块一次 xterm.write」，改为按 leafId 累积，
  一个事件循环内最多推一次，攒到 64KB 立即推（`queueOut`/`flushOut`）。
- `buffered` 的字节裁剪从「每块 reduce 整条队列」（积压期 O(n²)）改成独立计数
  `bufferedBytes`，增量维护。
- `markReady` / `markUnready` / 全局 reset 三处都同步清理这两个 Map。

## 验证
- `pytest tests/ -q` — 46 passed（新增 `test_slow_viewer_is_dropped_not_buffered_forever`：
  9MB 灌给不回快照的 viewer，断言 4009 且 `relay.viewers` 清空）。
- `flake8 --max-line-length=110 server/ tests/ agent/` 零告警；`py_compile` 通过。
- `pnpm -C apps/desktop typecheck|build|test` 通过。
- 复测（同机 loopback）：下行 1KB ×2000 → 153ms / 12.7 MB/s；64KB ×128 → 46ms / 173 MB/s；
  按键 2000 → 84ms / 23.7k 次/s；回环 p50 0.43ms p95 1.29ms；列表广播 2.09 ms/次。
  全部不慢于改造前基线（151–183ms / 118–150 MB/s / 17.6–23k / 2.49–2.76ms）。
- 真机两窗口 demo：进房 → `yes rpty | head -20000` 两万行洪峰画面完整、无黑屏 →
  离开（Toast「你已离开通话」）→ 再进房仍有内容。

## 边界
- 慢客户端策略选「断开重连取快照」，不选「丢积压保连接」：丢积压会让画面
  静默残缺，而终端画面残缺比断线更难排查。
- 数据面（`/d/...`）本身仍未鉴权，P2 才补；此处只做资源保护。
