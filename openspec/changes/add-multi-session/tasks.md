# 任务：多终端并行（左侧标签列）

## 1. 主进程：会话管理

- [ ] `src/main/ring-buffer.ts`
  - [ ] 定长环形缓冲，默认 256 KB，可配置
  - [ ] `append(chunk)` / `read()` / `reset()`
  - [ ] 溢出时丢头部并记录被丢弃字节数
- [ ] `src/main/pty-broker.ts`
  - [ ] `create({ cols, rows, shell })` → `{ leafId, pid }`
  - [ ] `write(leafId, data)` / `resize(leafId, cols, rows)` / `dispose(leafId)`
  - [ ] `onData` 写入对应 ring buffer 并推给渲染进程
  - [ ] `onExit` 只把该会话标 `exited`，不影响其它
  - [ ] `list()` 返回快照
- [ ] `src/main/ipc/handlers.ts` 所有通道加 `leafId` 维度
- [ ] 会话数上限 20，超出时 `create` 返回错误码 `too_many_sessions`

## 2. 渲染进程：两栏布局

- [ ] `screens/workspace.tsx`
  - [ ] 左侧 200px 固定列 + 右侧弹性区域
  - [ ] 左侧可折叠（`Cmd+B`），折叠后终端占满
- [ ] `components/session-list.tsx`
  - [ ] 设备分组头（只有一个设备时隐藏）
  - [ ] 每项：标题、状态点、后台有新输出的 `●`
  - [ ] 底部 `+ 新建 ⌘T`
  - [ ] 双击改名
  - [ ] 右键菜单：重命名 / 关闭 / 复制标题
- [ ] `components/terminal-host.tsx`
  - [ ] 每个会话一个 xterm 实例，**常驻不卸载**
  - [ ] 非活动会话 `display: none`
  - [ ] WebGL addon 只在可见时 attach，隐藏时 detach
  - [ ] 隐藏时暂停光标闪烁
  - [ ] 切回时：移除 `display:none` → 等一帧 → `fit()` → attach WebGL → 恢复闪烁
  - [ ] 窗口 resize 时只 fit 当前可见终端，其余标记为 dirty，切回时再 fit

## 3. 快捷键

- [ ] `Cmd+T` 新建（焦点跳到新终端）
- [ ] `Cmd+W` 关闭当前，最后一个时变空状态
- [ ] `Cmd+1…9` 切换，`Cmd+Shift+[` / `]` 前后切换
- [ ] `Cmd+Shift+W` 等价的"关闭当前"（避免与窗口关闭混淆时用）
- [ ] 全部注册进菜单栏，保证即使快捷键被抢也有入口

## 4. 边界处理

- [ ] PTY 退出：标签显示 `已退出`，点击可"重新启动"或"移除"
- [ ] 关闭有前台进程的会话（`vim`/`htop`）：弹确认框，默认焦点在取消
- [ ] 后台输出超限：插入 `[已省略 N KB]` 提示行
- [ ] 关窗口：默认保活（不 dispose），随应用退出才清理

## 5. 接协议（P2）

- [ ] `shared/wire.ts` 增加 `SESSION_*` 三条信令的编解码
- [ ] `main/relay-client.ts` 改为每会话一条 `/d/<token>`
- [ ] 断线重连：逐条重连 → 请求 `SESSION_LIST` → 按 `sessionId` 对上 `leafId` → 重放各自 ring buffer
- [ ] 重连后标签顺序与标题保持不变

## 6. 自测

- [ ] 同时开 3 个：`vim` / `htop` / `zsh`，输入互不串格
- [ ] 一个跑 `yes > /dev/null` 或 `cat 大文件`，另一个回显不受影响
- [ ] 关掉中间那个，前后两个顺序不变
- [ ] 切到后台再切回，`vim` 光标位置与内容完整
- [ ] 断网 10 秒，重连后三个终端的输出都补全
- [ ] 开满 20 个，第 21 个提示上限
- [ ] 内存：20 个 × 5000 行 ≈ 20 MB，活动监视器核对

## 7. 收尾

- [ ] `pnpm typecheck` 通过
- [ ] 更新 `docs/19` 若实现与线框有出入
- [ ] 提交：`feat(desktop): 多终端并行与左侧标签列`
- [ ] 归档：实现完成后把 `SESSION_*` 信令写入 `openspec/specs/pty-relay/spec.md`
