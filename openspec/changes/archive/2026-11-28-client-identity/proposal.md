# 变更：客户端给自己起一个持久名字

## Why

前三轮已经把"设备（agent）"和"标签（session）"的身份稳住了，但**客户端**还只是一个随机 uuid：

- 配对断开时，另一端只能看到"另一端已断开连接"，不知道是哪个客户端断的 —— 两台以上同时在线时毫无指向性；
- 自己的设备列表页面也说不出"我是谁"，排查"哪个窗口连的是哪个"只能靠猜；
- uuid 是 `client-id` 里的，人能读的零信息。

用户要求：每个客户端启动时给自己起一个唯一名字，**不卸载重装就不变**。

## What Changes

1. 主进程新增 `loadClientName()`：首次运行生成 `<主机名短名>-<4 位 hex>`，写进 `<userData>/client-name`；之后每次读回同一个。
2. 名字随 ctl 握手带给 relay：`/ctl?token=…&client=<uuid>&name=<name>&primary=1`。
3. relay 记住每个 ctl 的名字（`ctl_name`），广播 `PAIR_CLOSED` 时带 `by_name`；`/healthz` 新增 `clients: [{client, name}]` 便于排查。
4. 客户端显示：
   - 设备列表顶栏「已连接中继 · 我 · zhaojiandeMac-mini-1620」；
   - 配对断开页「「zhaojiandeMac-mini-f366」已断开连接」，副文案同样点名。
5. `RelayStatus.clientName` 一路透传到渲染进程，`setStatus` 的增量事件也带（否则重连后名字消失）。

## 边界

- 名字不是身份：`client-id`（uuid）仍是归属判定的唯一依据，改名字不影响"哪个标签是我开的"。
- 同机多开（不同 userData）各有一份 `client-name`，名字互不相同，hex 段天然区分。
- 删掉数据目录 = 换新客户端，名字重生成（等同重装）。
- 老 relay 不认 `name`：握手参数被忽略，界面退回"另一端已断开连接"，不影响连接。

## 验收

- 两个客户端同时在线，`/healthz` 的 `clients` 分别给出各自名字；
- 重启其中一个客户端，名字不变；换一个 userData 启动，名字不同；
- B 点「退出中继」后，A 的断开页点名 B；
- `pnpm typecheck` 通过，relay 重新部署后 `/healthz` 带 `clients`。
