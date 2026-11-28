# 客户端多开：把「一个客户端」显式化成一个 profile

## 为什么

现在的身份边界是一条**隐式约定**：`app.setPath('userData', RPTY_USERDATA || appData/rpty-desktop)`
（`main/index.ts:20`），客户端 id / 名字 / 我开的终端记录全落在这个目录里。于是：

| 用户动作 | 实际发生 | 问题 |
| --- | --- | --- |
| 双击图标两次 | 两个进程、**同一个 `client_id`**，relay 里合并成一行（`conns` 两条） | 两个进程同时读写 `client-id`、`owned-sessions.json`，后写覆盖先写 →「哪些终端是我开的」会丢，「共享」标签来回跳 |
| `RPTY_USERDATA=~/x ./start-client.sh` | 两行、两套桌面 | 能用，但这不是产品能力，是开发后门：不发 `primary=1`、名字是 `<主机短名>-4hex` 两台机器长得一样、每次都记路径 |
| 打包一份改名 | 两行 | 要维护两份安装包 |

而且没有单实例锁，`window-all-closed` 才退出，用户很容易开着好几个自己不知道的实例。

结论：**「客户端」这个名字下面混着两个概念**——身份（谁、哪套桌面）与窗口（显示同一批终端的界面）。
不拆开，多开就永远是靠环境变量凑合。

## 变成什么样

把「一个客户端」= 一个 **profile**（配置档）：

```
~/Library/Application Support/rpty-desktop/      ← 根目录，不动
├── rpty-config.json                             ← 默认 profile 自己的配置（保持兼容）
└── profiles/
    ├── default/  → 实际上就是根目录本身（老用户零迁移）
    └── client-2/
        ├── client-id        ← 各自生成，relay 里就是独立一行
        ├── client-name      ← <主机短名>-client-2
        └── owned-sessions.json
```

规则：

1. **默认 profile** 仍用根目录，老用户装的、连的、开的终端全都不用动。
2. **新建 profile** 落 `profiles/<名字>/`，创建时把当前 profile 的 `rpty-config.json` 复制过去
   —— 新客户端不用重新填 relay 地址和 token，之后各自独立（想连不同 relay 也行）。
3. 姓名：非默认 profile 的 `client-name` 改成 `<主机短名>-<profile 名>`，设备列表里一眼能分开；
   默认 profile 保持老的 `<主机短名>-4hex`。
4. `primary=1` 的判据从「有没有设 `RPTY_USERDATA`」改成「**是不是默认 profile**」，
   否则新建的每个 profile 都被当副本，无主会话认领会乱。
5. **单实例锁按 profile 维度**（Electron 的锁本来就按 userData 目录算）：同一 profile 再启动，
   不新开进程，把已有窗口提到前面；不同 profile 互不影响。
6. 菜单：「rpty」菜单里「重新连接 relay」下面加一条 `新建客户端…`（`Cmd+Shift+N`），
   不起眼但找得到。点击后自动起名字（`client-2`、`client-3`…）、播一个新进程（`detached`）、
   弹一条确认告诉你它在列表里叫什么。
7. 生命周期：新进程与父进程无关（`detached: true` + `unref()`），父进程退出不影响它；
   关窗即下线沿用 `close-semantics`，不做特殊处理。

## 为什么不是「一个进程多个身份」

relay 侧其实支持（`clients` 表按 `client_id` 分），但客户端要把 IPC 通道、窗口、`owned-sessions.json`
全部改成按 client 分桶，改动量是「多起一个进程」的好几倍，收益一模一样。
一个进程一条 `/ctl` 连接这条不变量也更省心 —— 尤其是数据面要收成 1:1 之后，
同进程两个身份会各自开数据连接，反而要额外处理「同一 PTY 两条 viewer 连接」。

## 与 `data-plane-one-to-one` 的关系

不同 profile = 不同 `client_id` = 各自一条 viewer 连接，天然不冲突。
本次同时收紧「同一 profile 只允许一个窗口」，于是 1:1 变更里那条
「多窗口必须共享一条数据连接」的前置条件**不需要做**。两个变更互不依赖，可以先落这个。

## 不变的部分

- relay 协议、端点、`clients` 表结构、`/healthz` 字段，一个字不动。
- 默认 profile 的目录、配置文件、`client-id` / `client-name` 生成规则（未命名新 profile 前）不变。
- `RPTY_USERDATA` 继续认（开发用），映射成「名字叫 `custom` 的非默认 profile」，行为与现在一致（不发 `primary`）。

## 代价与风险

- 菜单里多一个入口就多一种「我到底开了几个」的困惑 —— 用窗口标题与列表名字兜住（名字里带 profile）。
- 复制配置意味着 token 会在多个 profile 目录各存一份，改 token 要改多次；v1 接受，后续可提到共享层。
- 新建的 profile 与默认 profile 是**两套桌面**：在 A 里开的终端，B 里看不到（这是设计意图，不是 bug）。
- 没有单元测试基建（`apps/desktop` 无 test runner），验证靠 `typecheck` + `build` + 真机启动冒烟；
  profile 解析这一层刻意写成不依赖 electron 的纯函数，将来补测只需要 `node --test`。

## 落地记录

### 结果

- 新增 `apps/desktop/src/main/profile.ts`（~150 行，不 import electron）：
  `resolveProfile` / `profileDir` / `listProfiles` / `nextProfileName` / `seedProfile` / `initProfile` / `getProfile`。
  优先级 `RPTY_PROFILE` > `RPTY_USERDATA` > 默认；名字不合法一律回默认
  （一个手滑的环境变量不该让人"找不到自己的终端"）。
- `main/index.ts`：`initProfile` → `app.setPath('userData', profile.dir)` → `mkdirSync` →
  `requestSingleInstanceLock()`；菜单 `rpty` 下新增「新建客户端…」（`⌘⇧N`）→ `createClient()`：
  起名 → 建目录并复制配置 → `spawn(process.execPath, …, { detached: true })` → 对话框告知。
  窗口标题默认 `rpty`、其余 profile 为 `rpty · <名字>`。
- `main/relay-client.ts`：`primary=1` 判据改成 `getProfile().isDefault`；
  `client-name` 生成规则改为 `<主机短名>-<profile 名>`（默认 profile 保持 4 位 hex 老规则）。
- `apps/desktop/test/profile.test.mjs` + `pnpm -C apps/desktop test`：把 `profile.ts` 单独编译成 ESM
  再跑断言，覆盖默认/具名/后门三条路径、非法名字回落、`client-N` 取最大号 +1、
  seed 复制配置且不覆盖已有配置。这是 desktop 侧第一个可跑的测试。
- `docs/34-client-identity.md` 补一节「profile：一台机器上开多个客户端」。

### 验证

- `pnpm -C apps/desktop typecheck`、`build` 均通过。
- `pnpm -C apps/desktop test` → `profile.test OK`（20 条断言）。
- 真机冒烟：`RPTY_PROFILE=smoke1` 起 → `profiles/smoke1/{client-id,client-name}` 生成，
  `client-name = zhaojiandeMac-mini-smoke1`；同 profile 再启动一次 → 退出码 0、不起第二个进程；
  `RPTY_PROFILE=smoke2` → 两个 Electron 主进程并存、各自 SingletonLock、名字分别是 smoke1/smoke2。
  冒烟目录已删。
- 未点菜单自动化验证 GUI 点击：菜单动作是 `nextProfileName → seedProfile → spawn`，
  与上面手工起第二实例同一串代码路径，只差那个 `dialog`。

### 已知取舍

- token 会随 `rpty-config.json` 在多个 profile 各存一份，换 token 要改多次；后续可提到共享层。
- profile 建好后没有删除/重命名入口，目前只能删目录（文档里写了名字不可变的原因）。
- `RPTY_USERDATA` 仍作为开发后门保留，名字固定叫 `custom`。
