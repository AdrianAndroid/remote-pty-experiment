# 29 · 终端排版归档（PTY 尺寸唯一权威）

> 归档时间：2026-11-28
> 提交：`500e723`
> 变更：`openspec/changes/archive/2026-11-28-fix-terminal-sizing/`
> 状态：**已修复、已实测。两个端画面逐行一致，全屏 TUI 贴底不留白。**

---

## 1. 一句话

**xterm 的行列必须等于 PTY 的行列。** 之前它们不相等，于是"看着一样、内容不一样"、"claude 底部不充满"、"被控端文字重叠"同时出现。

---

## 2. 三处根因

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | 渲染层 `fit()` | 隐藏标签 / 未布局窗口上量出 0 尺寸，fit 给出 `10x5` 并写进 PTY，该会话从此两端黑屏、输入也不通 |
| 2 | relay | `SESSION_RESIZE` 只转给宿主，不广播给其它控制端；`last_list` 缓存也不更新 |
| 3 | 渲染层 | 镜像端先按自己窗口 `fit()`，再 `resize(lock)`。两次 reflow，且 fit 的行列与 PTY 不同 → 绝对光标定位全错位 |

---

## 3. 现在的规则

**尺寸只由创建端决定，镜像端严格跟随。**

- 创建端：窗口多大，PTY 就多大（fit → `SESSION_RESIZE`）。
- 镜像端：不 fit，直接 `term.resize(PTY 行列)`；容器装不下时对整层 `transform: scale()` 等比缩小。
- 缩放不改 xterm 内部字符度量，所以行列仍然正确，只是字变小、画面完整。
- 尺寸链路：`SESSION_RESIZE` → relay 更新缓存 + 广播 `SESSION_RESIZED` → 客户端 `onResized` → 渲染层 `sizeLock`。
- 三处守卫：容器 <40px 不 fit；客户端拒收 `cols<20 || rows<5`；relay 丢弃异常值并记 warning。
- 创建端为权威：列表里的尺寸与本地不一致时主动重发修正宿主。
- `ResizeObserver` / `window.resize` 走 `requestAnimationFrame` 防抖，避免拖窗口时按中间尺寸算出的缩放比例卡死。

---

## 4. 实测

| # | 项 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 1 | A `xterm-screen` | 952×760（自身 fit） | 960×760 |
| 2 | B `xterm-screen` | 928×900（锁在陈旧的 113×53，溢出容器 134px） | 960×760 |
| 3 | PTY 行列 | 120×38 / 116×45 混用，另有一个 10×5 | 两端统一 120×38 |
| 4 | 全屏 TUI 测试 | 两端错行、底部留白 | 两端 `ROWS=38 COLS=120`，末行贴底，逐行一致 |
| 5 | 容器压到 620px | 溢出裁切 | `scale(0.6333)`，内容完整 |

全屏测试脚本：`/tmp/altscreen.py`（进 alternate screen 画满所有行，末行打 `ROWS=x COLS=y <<LAST-LINE`）。

---

## 5. 边界与取舍

- **镜像端窗口更大**：按 PTY 尺寸绘制，右下留白；不放大字号，否则与宿主不同步。
- **镜像端窗口更小**：等比缩小，字变小但完整。缩放状态下鼠标坐标由 xterm 依 DOM rect 换算，点击定位仍正确。
- **异常尺寸**：宁可丢弃一次 resize，也不让 PTY 被压成不可用的尺寸（丢弃会打 warning，不改状态）。

---

## 6. 相关文件

- `apps/desktop/src/renderer/src/components/terminal-pane.tsx`（`pane__wrap`、锁尺寸、缩放、rAF 防抖）
- `apps/desktop/src/renderer/src/styles.css`（`.pane__wrap`）
- `apps/desktop/src/main/relay-client.ts`（`resize()` 守卫、`SESSION_RESIZED` 处理、列表尺寸刷新与自愈）
- `apps/desktop/src/shared/ipc.ts` / `preload/index.ts` / `main/index.ts` / `App.tsx`（`session:resized` 链路）
- `server/relay.py`（`_apply_resize_to_lists`、`SESSION_RESIZED` 广播、异常尺寸丢弃）
- `openspec/specs/pty-relay/spec.md`（新增「终端尺寸唯一权威」需求）
