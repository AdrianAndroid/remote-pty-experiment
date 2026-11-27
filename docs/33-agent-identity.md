# 33 · agent 自己起名字，重启不变

## 问题

节点标识原来只有 `--node`，没给就取主机名短名。三个后果：

- 同机起第二个 agent 必须手动想名字，想不到就撞成同一个节点（后连的把前一个顶掉，relay 直接 `replaced`）；
- 主机名变了就是"另一台机器"，客户端按节点存的标签记录（`rpty.tabs.v1`）对不上，看着像标签丢了；
- 名字是否稳定取决于启动命令怎么敲，不是 agent 自己的事。

## 现在的规则

启动时按优先级解决身份，并落盘：

| 优先级 | 来源 |
| --- | --- |
| 1 | `--node` / `--name`（显式指定，手动部署照旧） |
| 2 | 状态文件 `~/.rpty/agent.json` 里的 `node` / `name` |
| 3 | 现场生成 `node = <主机名短名>-<4 位 hex>`，`name = 主机名` |

状态文件可用 `RPTY_STATE` 指到别处，同机多开各用一份互不干扰：

```json
{ "node": "zhaojiandeMac-mini-8b49", "name": "zhaojiandeMac-mini.local", "created_at": 1795801998 }
```

**节点 id** 给程序认（relay 路由、客户端标签记录都按它），**显示名**给人看。两者分开，重启、断线重连、重新配对都不变。

## 客户端的配合

显示名撞车时（同机多开），设备卡片自动补 `-<hex4>` 尾段：`zhaojiandeMac-mini [8b49]`。
名字唯一时不显示尾段，保持干净。

## 实测

| 步骤 | 结果 |
| --- | --- |
| 不带 `--node` 起 agent | 生成 `zhaojiandeMac-mini-8b49`，写进 `/tmp/rpty-a1.json` |
| 杀掉重启 | 还是 `zhaojiandeMac-mini-8b49` |
| 换一个 `RPTY_STATE` 再起一个 | `zhaojiandeMac-mini-be99`，两个节点同时在线 |
| 客户端列表 | 三张同名卡（主机 agent + 两个新 agent），后两张带 `8b49` / `be99` 徽标 |

## 兼容与边界

- 老 agent 部署（launchd 里写死 `--node`）完全不受影响。
- 已有部署如果没写 `--node`，升级后第一次启动会生成新 id；想保持原 id，就往 `~/.rpty/agent.json` 写进去（本次就是这么把 `default` 钉回来的）。
- 删掉状态文件 = 换新身份，等于换了一台新机器。
