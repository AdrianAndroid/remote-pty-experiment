# 任务

## 1. relay

- [x] `Client` 加 `pw_hash` / `pw_default`
- [x] `CTL_PASSWORD`：长度 ≥6，存 PBKDF2 哈希（salt = client id，120k 轮），回 `PASSWORD_SET {default}`
- [x] `ROOM_JOIN {to, password}`：自己已在房间 → `busy`；对方忙 → `peer_busy`；
      对方没设密码 → `no_password`；密码不对 → `bad_password`；都对 → 直接建房
- [x] 删 `ROOM_INVITE / ROOM_ACCEPT / ROOM_DECLINE`、`invites`、`ROOM_INVITE_TTL`
- [x] `clients_summary` 加 `password` / `password_default`
- [x] 老客户端发 `ROOM_INVITE` → `invite_removed`

## 2. 客户端主进程

- [x] `client-password` 文件（0600，缺省 `admin123`）—— `main/password.ts`
- [x] 连上 `/ctl` 就上报密码；`RelayClient.setPassword()` 改完再报
- [x] IPC 换成 `room:join` / `auth:set-password` / `auth:password-info`
- [x] 删邀请相关事件与字段（`InviteView` / `RelayInvited` / `invite` / `acceptInvite` / `declineInvite`）

## 3. 渲染层

- [x] 点设备卡 → 密码输入框（空、居中、自动聚焦、回车提交、错密码原地提示）
- [x] 设置里能改自己的密码；当前是默认密码时显性提示（按钮「我的密码 · 默认」+ 弹窗红字）
- [x] 删「通话邀请」弹窗
- [x] 房间/离开/回列表文案同步（「你已离开通话」/「X 离开了通话」）

## 4. 验证

- [x] 单测 44 passed（含错密码、默认密码标记、忙、没设密码、改密码立即生效、短密码、老信令）
- [x] `flake8 --max-line-length=110 server/ tests/` 通过；`pnpm typecheck / test / build` 通过
- [x] 协议 e2e（`/tmp/rpty-e2e/room_e2e_18790.py`，真 relay + 真 agent）：17 项 PASS
- [x] 真机：A 输 `admin123` 点 B → 双方同时进房间（B 未点任何东西）；错密码 → 弹窗内「密码不对」；
      A 改密码 `a-new-pass-9` 后 B 用旧密码被拒、用新密码进入；B 离开 → 两侧同时回列表，
      B 提示「你已离开通话」、A 提示「…demo-b 离开了通话」
- [x] 文档 12 / 15 / 34 同步，本变更归档

## 已知边界

- 密码通过 WSS 明文到 relay（TLS 保护链路），relay 端只存哈希；客户端本地明文存 0600 文件。
- 默认 `admin123` 是弱口令；无失败次数限制/锁定，和 token 一样是后续加固项。
- 老客户端与新 relay 不兼容：它不发 `CTL_PASSWORD`，别人连不进来（`no_password`）；
  relay 与客户端必须一起升级。
