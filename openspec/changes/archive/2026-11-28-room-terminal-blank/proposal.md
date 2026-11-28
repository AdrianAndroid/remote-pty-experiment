# 房间终端空白 / 误报「你已离开通话」

## 现象

两个客户端用通话密码建好房间后，其中一端侧栏还在房间里、标签也在，主区却是一块全黑的终端，
没有任何命令行；底部还挂着一条「你已离开通话」提示。再进出一次房间，黑屏照旧复现。

## 根因（两处，缺一不可）

1. **服务端：借来的终端散场时把数据通道整个摘掉。**
   `_close_room` 对 `borrowed` 会话调用 `_close_data_channel(token, "room_closed")`，该函数
   `self.channels.pop(token)` 会把通道连同 `channel.node` 一起丢掉，但 agent 那条数据 ws 还活着
   （`_drop_channel_if_idle` 见 `channel.agent` 非空就不收）。下次进房，viewer 经 `_ensure_channel`
   造出一条 `node=""` 的新通道 → relay 发不出 `VIEWER_JOINED` → agent 不补快照 →
   `viewer.ready` 直接吃增量；shell 空闲没有增量 ⇒ 永远空白。同时 agent 的旧循环把字节写进已被
   pop 的旧通道对象，输出被静默丢弃。

2. **客户端：画面卸掉后没撤销「已就绪」。**
   `leafId` 就是 `sessionId`，`readyLeaves` 里记着这块画面已就绪，但 xterm 卸载时没人清。
   重新进房还是同一个 leafId，于是在新 xterm 挂上之前到达的快照被当成实时数据直接
   `onData` 推给渲染层 —— 那时没有任何终端接着，字节进黑洞。

## 改动

- `server/relay.py`
  - 新增 `_detach_viewers(token, reason)`：只关 viewer（4008）、清空 `channel.viewers`、
    必要时 `_drop_channel_if_idle`，**保留通道与 `channel.node`**。
  - `_close_room` 的 `borrowed` 分支改调 `_detach_viewers`：借来的 PTY 不杀、通道不摘。
  - agent 侧字节循环每条按 `self.channels.get(token) or channel` 现取通道，通道被重建也不会写进旧对象。
  - viewer 加入时若 `channel.node` 为空，用 `session.node` 兜底并回写，避免发不出 `VIEWER_JOINED`。
- 客户端
  - 新增 IPC `session:unready` + `RelayClient.markUnready(leafId)`（清 `readyLeaves`、
    `pendingReady`，并把缓冲重置为空数组），`TerminalPane` 卸载时调用。
  - `App.tsx`：`onStatus` 收到房间时顺手 `setError('')`，上一间房留下的提示不跟着进新房间。
- 测试：新增 `test_borrowed_channel_survives_room_close`（关房后通道在、node 在、PTY 在；
  重开房新 viewer 能重新拿到 `VIEWER_JOINED` 与快照）。

## 验证

- `pytest` 45 passed；`flake8 --max-line-length=110 server/ tests/` 通过；
  `pnpm -C apps/desktop typecheck` / `build` 通过。
- 真机两窗口（demo relay 18765）：A 输 `admin123` 进房 → 两端都看到同一块终端；
  A 离开 → 双方回列表、提示分人称；A 再进房 ×2 → 两端终端都正常显示，
  列表页那条「你已离开通话」不再带进新房间。

## 已知边界

- 数据面鉴权仍只按「当时是否在房间」判定；房间散了旧 token 不会被回收（P2 的已知边界）。
- 本次只修「谁来看都黑」的生命周期问题，不改变借用终端的归属语义。
