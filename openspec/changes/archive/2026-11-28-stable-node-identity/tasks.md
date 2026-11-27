# 任务

- [x] 1.1 agent 增加身份解析：`--node` > 状态文件 > 生成 `<host>-<hex4>`
- [x] 1.2 状态文件 `~/.rpty/agent.json`（`RPTY_STATE` 可覆盖），读不到就写
- [x] 1.3 HELLO / SESSION_LIST 的 `name` 用解析出来的名字
- [x] 1.4 新增 `--name`，显示名与节点 id 分开
- [x] 2.1 客户端：同名设备卡片自动补 id 尾段
- [x] 2.2 实测：起两个 agent → 两个唯一节点；重启其中一个 → 名字不变
