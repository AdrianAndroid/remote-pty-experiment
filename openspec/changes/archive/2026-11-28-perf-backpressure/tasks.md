# tasks

- [x] `Viewer.queue_bytes` + `VIEWER_QUEUE_BYTES = 8MB`，条数与字节双限
- [x] `_drop_viewer(channel, viewer, 4009, "slow")`：只踢单个观看者
- [x] `deliver_snapshot` 收尾把 `queue_bytes` 归零
- [x] `broadcast_ctls` 节点级广播单次序列化 + `_send_text`
- [x] 客户端 `queueOut` / `flushOut`（64KB 或 setImmediate）替换逐帧 IPC
- [x] 客户端 `bufferedBytes` 增量计数替换每帧 reduce
- [x] `markUnready` / reset 清理 `outPending` / `bufferedBytes`
- [x] 回归测试：慢 viewer 超 8MB 被 4009 断开且不残留
- [x] 压测复对比基线，真机两窗口验收
