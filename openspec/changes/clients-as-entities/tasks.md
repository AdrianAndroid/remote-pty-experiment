# 任务

- [x] agent：`~/.rpty/agents/` 注册目录 + unix socket `whoami` 应答（`start_local` / `stop_local`）
- [x] 客户端：`askLocalAgent()` 扫注册文件问宿主，握手带 `host=`
- [x] relay：`ctl_host` / `CTL_HOST` / `clients_summary()` / `CLIENTS` 广播 / `/healthz.clients`
- [x] relay：ctl 断开立刻广播列表（走了就从列表消失），`CTL_LEAVE` 不再清名字（避免闪僵尸卡）
- [x] relay：`CTL_LEAVE` 不再广播 `PAIR_CLOSED`（断开不连坐）
- [x] 渲染层：列表改成「在线客户端」，自己标「我」+ 禁用 + 排第一
- [x] 渲染层：`activeClientId` 记住进的是哪个客户端（同机多客户端 host 相同，不能按 host 反查）
- [x] 文案：设备 → 客户端；退出中继 → 断开中继；连接页不再说"重新连接"
- [x] relay：配对表 `CTL_PAIR` / `CTL_UNPAIR` / `CLIENTS.pairs` / 任一端下线即解除
- [x] 渲染层：被进方卡片「「X」正在查看」、进方侧栏「已配对」
- [x] 工作区底部按钮改为「离开」（⌘⇧D 在客户端里=离开，在列表上=断中继）
- [x] 对方断开时自动退回列表并提示
- [x] 配对成功后两端都自动进终端列表（进自己宿主不算配对）
- [ ] 同一宿主上「进别人的客户端」看到的是同一批终端 —— 语义待讨论
