# 任务

## 1. 去掉「上线即进自己的桌面」

- [ ] 删 `App.tsx` 的 `ownEnteredRef` 声明
- [ ] 删 `ownHostNode` 驱动的自动 `enterDevice` effect（原 655-663）
- [ ] 删 `onOpenMine` 里对 `ownEnteredRef.current = true` 的赋值
- [ ] 确认 `pairs.to == 我` 那条自动进入**仍然保留**（对方显式配对的动作）

## 2. 去掉「空桌面自动建终端」

- [ ] 删 `autoCreatedRef` 声明与全部 8 处赋值
- [ ] 删 513-532 那个 `setTimeout(700)` 自动 `createSession`
- [ ] 确认空状态屏（`visibleSessions.length === 0`）正常显示

## 3. 验证

- [ ] `pnpm -C apps/desktop typecheck` 通过
- [ ] `pnpm -C apps/desktop build` 通过
- [ ] 真机：启动 → 停在设备列表（看到自己的客户端 + 配对关系）
- [ ] 真机：点「我这台电脑」→ 6 个旧标签照常恢复，选中项与顺序都在
- [ ] 真机：新建客户端 → 停在设备列表，**不**在宿主上多出终端
- [ ] 真机：进一个没有终端的桌面 → 显示空状态，等用户按 ⌘T

## 4. 文档

- [ ] `docs/34-client-identity.md:157` 那句"自动进自己的桌面"改成新行为
- [ ] `docs/12-concept-model.md` 不需要改（术语未变）
