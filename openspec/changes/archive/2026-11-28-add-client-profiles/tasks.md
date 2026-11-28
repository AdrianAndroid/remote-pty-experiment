# 任务

## 1. profile 解析层（纯逻辑，不依赖 electron）

- [x] 新建 `apps/desktop/src/main/profile.ts`：
      `resolveProfile(root, env)` → `{ name, dir, isDefault }`；
      默认 profile 用根目录；`RPTY_PROFILE` 指定的用 `profiles/<name>`；
      `RPTY_USERDATA` 映射成 `custom`
- [x] `profileDir(root, name)` / `nextProfileName(root)`（扫 `profiles/` 取 `client-N` 最大 +1）
- [x] `seedProfile(root, name, fromDir)`：建目录、复制 `rpty-config.json`（没有就跳过）
- [x] 模块级 `initProfile()` / `getProfile()`，供主进程与 relay-client 共用

## 2. 主进程

- [x] `index.ts`：先 `initProfile`，再 `app.setPath('userData', profile.dir)`
- [x] 单实例锁：同一 profile 第二次启动 → `app.quit()`，`second-instance` 里把窗口提到前面（不新开窗口）
- [x] 窗口标题带上 profile 名（`rpty · client-2`），Mission Control / Dock 里能分开
- [x] 菜单：`rpty` → `新建客户端…`（`Cmd+Shift+N`）：自动命名 → `seedProfile` → `spawn(detached)` →
      `dialog` 告知新客户端在设备列表里的名字
- [x] 保留 `RPTY_USERDATA` 兼容路径

## 3. relay-client

- [x] `loadClientName()`：非默认 profile 用 `<主机短名>-<profile 名>`，默认 profile 保持老的 4 位 hex
- [x] `wsUrl()`：`primary=1` 判据改成 `getProfile().isDefault`
- [x] `client-id` / `owned-sessions.json` 跟着 userData 走，不改逻辑

## 4. 验证

- [x] `pnpm -C apps/desktop typecheck` 通过
- [x] `pnpm -C apps/desktop build` 通过
- [x] 默认 profile 解析正确（单测断言 `dir = 根目录`、`isDefault = true`、`primary` 会发）；真机没起默认 profile，避免在用户的在线列表里多出一条
- [x] 真机冒烟（等价路径）：`RPTY_PROFILE=smoke2` 起第二实例 → 独立进程、userData 在 `profiles/smoke2`、`client-name = <主机短名>-smoke2`；菜单项本身是同一串动作（`nextProfileName` → `seedProfile` → `spawn`），未点菜单，避免弹出 GUI 交互
- [x] 真机冒烟：同 profile 再启动一次 → 不起第二个进程，窗口被提到前面
- [x] 清理冒烟产生的 profile 目录

## 5. 文档与归档

- [x] `docs/34-client-identity.md` 补一节「profile：同机多客户端」
- [x] `openspec/specs/pty-relay/spec.md` 不需要改（relay 协议未变）
- [x] 归档到 `openspec/changes/archive/2026-11-28-add-client-profiles/`
