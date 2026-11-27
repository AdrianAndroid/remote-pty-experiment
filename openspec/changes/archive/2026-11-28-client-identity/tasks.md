# 任务

- [x] 1.1 主进程 `loadClientName()`：`<userData>/client-name`，格式 `<主机名短名>-<4hex>`
- [x] 1.2 ctl URL 追加 `&name=`；`RelayStatus.clientName`
- [x] 1.3 `PAIR_CLOSED` 读 `by_name`，`handlePeerClosed(by, byName)` 透传
- [x] 2.1 relay：`ctl_name` 记录、`PAIR_CLOSED` 带 `by_name`、`/healthz` 输出 `clients`
- [x] 2.2 relay 重新部署，`/healthz` 验证 `clients`
- [x] 3.1 设备列表顶栏「我 · <name>」（`.devices__me`）
- [x] 3.2 断开页点名对方（`peerName`）
- [x] 3.3 `setStatus` 增量事件也带 `clientName`（修重连后名字丢失）
- [x] 4.1 实测：两个客户端不同名 → 重启不变 → 配对断开点名
