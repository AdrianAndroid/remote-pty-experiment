# 变更：多终端并行（左侧标签列）

## Why

初版客户端只有单个终端，用户评价"交互模式太简单了"。真实使用场景需要同时跑多个：一个跑构建、一个编辑、一个看日志，互不干扰。

同时确定了一条 UI 形态：**左侧竖向标签列，右侧只显示当前选中的那一个终端**。没有顶部标签栏，v1 不分屏。

## What Changes

### 数据模型

```
Workspace
└── Device（v1 只有一个）
    └── Session[]
        ├── leafId      本地 UUID，稳定，重排/重连不变
        ├── sessionId   远端会话 id
        ├── title       跟随 OSC 0/2，可手改
        ├── state       connecting | active | background | disconnected | exited
        ├── cols/rows
        └── ringBuffer  默认 256 KB
```

### 主进程

| 新增 | 内容 |
| --- | --- |
| `src/main/pty-broker.ts` | 会话表 `Map<leafId, PtySession>`，create/dispose/list |
| `src/main/ring-buffer.ts` | 环形缓冲，超限丢头部并记 `[已省略 N KB]` |
| `src/main/ipc/handlers.ts` | 扩展为按 `leafId` 分发的通道 |

### 渲染进程

| 新增 | 内容 |
| --- | --- |
| `screens/workspace.tsx` | 左侧列表 + 右侧终端的两栏布局 |
| `components/session-list.tsx` | 竖向标签列，含设备分组头 |
| `components/terminal-host.tsx` | 多实例管理：隐藏用 `display:none`，WebGL 按可见性 attach/detach |

### 协议（P2 生效）

```
SESSION_CREATE { cols, rows, shell? } → { session_id, token, title }
SESSION_LIST   → [ { session_id, title, cols, rows, created_at } ]
SESSION_CLOSE  { session_id }
```

数据通道从 `/d/` 单条改为**每会话一条** `/d/<session_token>`。

## Impact

- **协议**：新增 3 条信令；`docs/15` 的双连接设计在会话维度上恢复
- **relay**：不需要改——它本来就只按 token 配对字节管道，N 条连接就是 N 次配对
- **UI**：`docs/19` 已按左侧标签列重画
- **资源**：20 个会话 × 5000 行 scrollback ≈ 20 MB

## 明确不做

分屏（v1.5）、多设备并行（v1.5）、标签拖拽排序（v1.5）、会话迁移到另一台（不做）。

## 验收

同时开 3 个终端（`vim` / `htop` / `zsh`），分别输入互不串；其中一个跑 `cat` 大文件时，另一个的按键回显不受影响。
