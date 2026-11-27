# 任务

- [x] 1.1 客户端新增 `activeNode`：未进入设备时不 adopt 任何会话
- [x] 1.2 `syncFromList` / `snapshotSessions` 只处理当前设备节点的会话
- [x] 1.3 新增 `setActiveNode(node|null)`：离开设备时 detach 该节点全部会话（不 kill）
- [x] 1.4 新增 IPC `node:activate` + preload `activateNode()`
- [x] 2.1 新增设备列表页（名字 / 在线 / 终端数 / 空态）
- [x] 2.2 进入设备后显示工作区；侧栏顶部加「← 设备」返回按钮
- [x] 2.3 「断开连接」改名「断开中继」，仍走配对断开
- [x] 3.1 实测：连上 WSS viewers=0，进设备 viewers=会话数
- [x] 3.2 实测：返回列表 viewers=0，PTY pid 不变，再进入标签不重复
