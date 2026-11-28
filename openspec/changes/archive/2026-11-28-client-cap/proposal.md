# 服务端最多 10 个客户端

## 为什么
这台 relay 跑在 2 vCPU / 1.6 GiB 的机器上，没有硬性上限时一个人开一堆窗口、
或者陌生人扫到地址都不需要密码就能连信令面，最后是所有人一起变慢。
上限放在服务端才是真上限。

## 改了什么
- `server/relay.py` 新增 `MAX_CLIENTS = 10`。
- `handle_ctl` 在登记连接**之前**数一次「当前还在线的客户端身份」：
  `sum(1 for c in clients.values() if c.conns)`；到 10 就回
  `ERROR{code:"server_full"}` 并按关闭码 `4010` 断开。
- 同一个 `client_id` 重连不占新名额 —— 断线重连不该被自己顶掉。
- 客户端 `relay-client.ts`：`close` 里认 4010 → 记 `ctlFull`，
  `onCtlClosed` 直接返回、不再做指数退避重连（免得一直撞墙），状态写明
  「服务端已满（最多 10 个客户端）」。`connect()` 开始时清掉这个标记。

## 验证
- 新增 `test_client_cap_rejects_eleventh`：10 个客户端在场 → 第 11 个收
  `server_full` + 4010；同名 `c0` 重连不受影响。`pytest` 47 passed。
- `flake8` 零告警，`pnpm typecheck` 通过。

## 边界
- 只限制「客户端身份」，不限制单个客户端开几条连接（多窗口共用一份身份）。
- 名额按连接在线的客户端算；断线即释放，不做租期。
