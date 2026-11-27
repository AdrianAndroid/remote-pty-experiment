# pty-relay Specification

## Purpose

定义 remote-pty-experiment 的核心能力：通过 WebSocket 中继把远端 Mac 上的真实 PTY 暴露给家端终端，且两端均不监听任何端口、不依赖 SSH 与外部隧道程序。

## Requirements

### Requirement: 双向字节通道

系统 SHALL 在 `agent` 与 `terminal` 两个客户端之间建立全双工字节通道，中继不得对终端数据做任何文本解码或重编码。

#### Scenario: 键盘输入送达远端 PTY
- **WHEN** terminal 端用户按下字符键
- **THEN** 该字符的原始字节经 `data` 帧送达 agent 端，并写入 PTY master fd

#### Scenario: 多字节字符不被切裂
- **WHEN** 远端 PTY 输出一个跨越两次读取边界的中文字符
- **THEN** 家端渲染出的字符与远端一致，不出现乱码或替换符

#### Scenario: 大输出不丢字节
- **WHEN** 远端执行 `cat` 输出 10 MB 文本
- **THEN** 家端收到的总字节数与远端一致，帧按不超过 64 KB 原始字节切分

### Requirement: 真实 PTY 分配

agent 端 SHALL 为每个会话分配一个操作系统级 PTY，并在其上运行登录 shell。

#### Scenario: 交互式编辑器可用
- **WHEN** 用户在远端执行 `vim somefile`
- **THEN** 全屏编辑界面正常渲染，方向键移动、`i` 插入、`:` 命令、`:wq` 退出均正常工作

#### Scenario: 密码输入不回显
- **WHEN** 用户执行 `sudo -v` 并输入密码
- **THEN** 家端屏幕不显示输入的字符

#### Scenario: 会话内状态保持
- **WHEN** 用户先执行 `cd ~/project`，再执行 `pwd`
- **THEN** 输出为 `~/project`（同一 shell 会话内）

### Requirement: 终端尺寸同步

系统 SHALL 在 terminal 端终端尺寸变化时通知 agent 端调整 PTY 窗口大小。

#### Scenario: 拖拽窗口后远端重排
- **WHEN** 家端浏览器窗口被拉宽，终端列数由 120 变为 152
- **THEN** agent 端 PTY 尺寸更新为 152 列，`vim` 与 `htop` 界面按新尺寸重排，不出现错行与截断

#### Scenario: 尺寸变化限流
- **WHEN** 用户连续快速拖拽窗口 1 秒内触发 20 次尺寸变化
- **THEN** 实际下发的 `resize` 帧不超过 13 个（80 ms 最小间隔）

#### Scenario: 初始终端尺寸生效
- **WHEN** terminal 端首次连接时报告 `cols=132, rows=40`
- **THEN** PTY 以该尺寸初始化，而不是停留在默认值

### Requirement: 身份鉴权与角色配对

relay SHALL 要求每个连接在建立后 5 秒内完成 `auth` 鉴权，并仅允许一个 `agent` 与一个 `terminal` 配对。

#### Scenario: 缺少鉴权帧被拒绝
- **WHEN** 客户端连接后 5 秒内未发送 `auth` 帧
- **THEN** relay 以 close code 1008 关闭该连接

#### Scenario: token 错误被拒绝
- **WHEN** 客户端发送的 token 与其 role 对应的密钥不匹配
- **THEN** relay 返回 `auth_err`（reason 为 `bad_token`）并关闭连接，且不建立任何转发关系

#### Scenario: 角色 token 不可混用
- **WHEN** 客户端以 `role=agent` 提交 `TERM_TOKEN`
- **THEN** 鉴权失败

#### Scenario: 同角色重复连接
- **WHEN** 已存在一个在线 `agent`，第二个 `agent` 携合法 token 接入
- **THEN** 旧连接以 close code 4001 被顶替，新连接接管配对

### Requirement: 断线自动恢复

agent 与 terminal 两端 SHALL 在连接异常断开后自动重连，无需人工干预。

#### Scenario: 网络中断后恢复
- **WHEN** 公司 Mac 断网 5 分钟后恢复
- **THEN** agent 在退避周期内自动重连成功，家端无需重新登录

#### Scenario: 重连采用指数退避
- **WHEN** 连续多次连接失败
- **THEN** 重试间隔依次为 5s、10s、30s、60s，且不超过 60s

#### Scenario: 宿主重启后自启
- **WHEN** 公司 Mac 重启完成
- **THEN** agent 由 launchd 自动拉起并恢复在线，无需用户登录后手动执行

### Requirement: 长连接保活

系统 SHALL 同时使用协议层 ping/pong 与应用层心跳，避免中间设备因空闲断开连接。

#### Scenario: 空闲连接不被切断
- **WHEN** 终端连续 30 分钟无任何输入输出
- **THEN** 连接仍然存活，下一次按键能正常送达

#### Scenario: 半开连接被发现
- **WHEN** 中间设备静默丢弃连接，导致对端无响应
- **THEN** 90 秒内被检测到并触发重连

### Requirement: 零监听端口

agent 与 terminal 两端 SHALL NOT 监听任何网络端口，仅主动发起出站连接。

#### Scenario: 公司端无新增监听
- **WHEN** agent 正常运行
- **THEN** `lsof -i -P | grep LISTEN` 中不出现由本方案引入的新监听端口

### Requirement: 合规确认位

agent SHALL 在未设置 `AUTHORIZED=1` 时拒绝启动。

#### Scenario: 缺少授权位
- **WHEN** 运行 `python3 agent_mac.py` 而未设置 `AUTHORIZED=1`
- **THEN** 进程打印合规提示并退出（非零退出码），不发起任何网络连接

### Requirement: 浏览器组合键不被劫持

网页终端 SHALL 拦截浏览器会抢占的组合键并转发给远端。

#### Scenario: vim 中 ctrl+w 分屏
- **WHEN** 用户在网页终端内运行 `vim` 并按 `ctrl+w` 再按 `s`
- **THEN** vim 执行分屏，浏览器标签页不被关闭

### Requirement: 会话关闭语义（kill 与 detach 二分）

系统 SHALL 按「关闭发起端对该会话的身份」区分关闭效果：创建端关闭等于终止 PTY，所有端都不得保留该标签；镜像端关闭只等于本端撤掉画面，PTY 继续运行。

标签 SHALL 被视为 PTY 的视图 —— PTY 存在则出现，PTY 消失则移除，不保留置灰占位。

#### Scenario: 创建端关闭
- **WHEN** 会话创建者在自己的标签上点关闭
- **THEN** 宿主终止该 PTY，所有客户端都移除对应标签；当时在线的立即移除，离线者重连后不再出现

#### Scenario: 镜像端关闭
- **WHEN** 非创建者在共享标签上点关闭
- **THEN** 仅该客户端移除标签，PTY 与其它客户端不受影响，relay 中该会话仍然存在

#### Scenario: 镜像端重连
- **WHEN** 镜像端关闭标签后断开并重新连接，且宿主上该 PTY 仍存在
- **THEN** 标签重新出现并恢复镜像，不需要任何手动操作

#### Scenario: 宿主侧 PTY 已不存在
- **WHEN** 会话在宿主侧消失（被创建端关闭、shell 退出、宿主进程退出、节点离线超时）
- **THEN** 客户端移除对应标签，不保留灰标签

#### Scenario: 撤掉的标签不被列表装回
- **WHEN** 镜像端已关闭某标签，之后收到该节点的会话列表广播
- **THEN** 该标签不会自动重新出现，直到下一次连接重建

### Requirement: 终端尺寸唯一权威

一个 PTY 的 cols/rows SHALL 只由创建端（owned）决定；镜像端不得改变 PTY 尺寸，渲染尺寸 SHALL 严格等于 PTY 尺寸。

系统 SHALL 拒绝把明显不合理的尺寸（`cols < 20` 或 `rows < 5`）写进 PTY。

#### Scenario: 创建端调整窗口
- **WHEN** 创建端改变窗口大小
- **THEN** PTY 跟着变成对应的行列，其它控制端收到 `SESSION_RESIZED` 并立即按新尺寸重排

#### Scenario: 镜像端窗口更小
- **WHEN** 镜像端容器装不下 PTY 的行列
- **THEN** 画面整体等比缩小以完整可见，xterm 的行列保持不变（不裁剪、不改字号度量）

#### Scenario: 镜像端窗口更大
- **WHEN** 镜像端容器大于 PTY 的行列
- **THEN** 画面按 PTY 尺寸绘制，多余空间留白，不改字号

#### Scenario: 尚未布局时不写尺寸
- **WHEN** 标签页不可见或窗口还没完成布局，量到的容器尺寸接近 0
- **THEN** 不发起尺寸变更，PTY 尺寸保持不变

#### Scenario: 行列与 PTY 不一致
- **WHEN** 客户端的行列和 PTY 不一致
- **THEN** 全屏 TUI（如 claude、vim）仍然逐行对齐，不出现文字重叠或内容串行

### Requirement: 连接可主动断开并可恢复（配对断开）

控制端 SHALL 提供断开与 relay 的连接的入口，且断开后 SHALL 能重建连接而不必重新输入地址与 token。

一条链路上的控制端 SHALL 视为一组：任一端主动断开，其它端 SHALL 一起断开，且都 SHALL NOT 自动重连。

断开 SHALL NOT 影响被控端上的 PTY 进程。

#### Scenario: 侧栏断开
- **WHEN** 用户点击侧栏底部的「断开连接」（或按 ⌘⇧D）
- **THEN** 客户端向 relay 发送主动离开，关闭 ctl 与全部数据通道，不自动重连，界面回到连接页并显示「已断开」

#### Scenario: 一端断开带走其它端
- **WHEN** 任一端主动断开
- **THEN** 其它控制端收到 `PAIR_CLOSED`，立即断开并回到连接页，提示「另一端已断开连接」，且不自动重连

#### Scenario: 掉线不等于主动断开
- **WHEN** 客户端的网络异常中断（没有发出主动离开）
- **THEN** relay 不做配对断开，其它控制端继续正常镜像

#### Scenario: 断开不影响 PTY
- **WHEN** 断开连接
- **THEN** 宿主机上的 shell 进程 pid 不变、输出继续产生，重连后画面原样接上

#### Scenario: 重新连接
- **WHEN** 用户在「已断开」页面点击「重新连接」
- **THEN** 用已保存的地址与 token 重连成功，宿主上仍在运行的会话以镜像方式回到标签列，标签不重复

#### Scenario: 重连后归属不变
- **WHEN** 创建端断开后再重连
- **THEN** 它创建的会话仍然没有「共享」标记，归属按 `client-id` 认领回来

#### Scenario: 断开期间会话变化
- **WHEN** 断开期间宿主上新增或被 kill 掉会话
- **THEN** 重连后的列表反映宿主当前状态（新增的出现，被 kill 的不出现）

### Requirement: 先连中继再选设备（两层连接）

客户端到中继的连接（WSS）与「与某台机器的终端会话」SHALL 是两层：

- 连上 WSS 之后 SHALL 进入**设备列表**，只显示节点名字、在线状态与现有终端数，不为任何会话建立数据通道。
- 点选某台设备之后 SHALL 才为该节点的会话建立数据通道并进入工作区，其它节点一条 viewer 都不占。
- 离开设备 SHALL 只撤掉该节点全部会话的画面与数据通道，PTY 不 kill，回到设备列表；WSS 保持连接。
- 断开 WSS SHALL 只发生在用户点「退出中继」、退出应用、或重连连续失败且用户放弃时。

#### Scenario: 连上中继不占任何通道
- **WHEN** 客户端连上 WSS
- **THEN** 显示设备列表，relay 的 `viewers` 为 0

#### Scenario: 进入设备
- **WHEN** 用户在列表里点一台在线的设备
- **THEN** 只为该节点的会话开数据通道，`viewers` 等于该节点会话数，工作区显示这些标签

#### Scenario: 离开设备
- **WHEN** 用户点侧栏「← 设备」（或按 ⌘⇧E）
- **THEN** `viewers` 归 0、回到设备列表，PTY pid 不变；再进入时标签原样恢复且不重复

#### Scenario: 设备离线不可进入
- **WHEN** 某节点离线
- **THEN** 它的卡片置灰不可点，标注「离线」

#### Scenario: 进入后再点退出中继
- **WHEN** 用户在工作区点「退出中继」（⌘⇧D）
- **THEN** 按配对断开语义断开 WSS，另一端一并回到连接页，设备上的 PTY 继续运行

### Requirement: 节点身份的持久化

agent SHALL 在启动时解决自己的节点身份并落盘，使**重启、重连、重新配对后名字不变**：

- `--node` / `--name` 显式给出时优先；
- 否则读状态文件（默认 `~/.rpty/agent.json`，可用 `RPTY_STATE` 覆盖）；
- 都没有时生成 `<主机名短名>-<4 位 hex>` 并写回状态文件。

节点 id 用于路由与客户端按节点保存的标签记录，显示名用于界面；两者可独立指定。

#### Scenario: 同机多开不撞名
- **WHEN** 同一台机器用不同的 `RPTY_STATE` 起两个 agent
- **THEN** 两个节点 id 唯一，同时在线，客户端列表都能看到

#### Scenario: 重启名字不变
- **WHEN** agent 重启
- **THEN** 读回状态文件里的同一个 node id，relay 与客户端仍认为是同一台设备

#### Scenario: 显示名重复时客户端可区分
- **WHEN** 多台设备的显示名相同
- **THEN** 设备卡片补上 id 的 `-<hex4>` 尾段以便区分

### Requirement: 客户端身份的持久化

每个客户端 SHALL 在首次运行时生成 `<主机名短名>-<4 位 hex>` 并写入 `<userData>/client-name`，
此后每次启动读回同一个名字 —— **不删除数据目录就不变**。

名字随 ctl 握手传给 relay（`name` 参数），relay 在配对断开广播里带上 `by_name`，
并在 `/healthz` 的 `clients` 里列出，供对端提示与排查使用。

客户端身份（`client-id`）与客户端名字（`client-name`）分工：前者判定会话归属，后者给人看。

#### Scenario: 名字跨重启稳定
- **WHEN** 客户端重启
- **THEN** 读回同一个 `client-name`，界面「我 · <name>」不变

#### Scenario: 同机两个客户端不同名
- **WHEN** 用不同 userData 启动两个客户端
- **THEN** 各有一份 `client-name`，`/healthz` 的 `clients` 能分别看到

#### Scenario: 配对断开点名
- **WHEN** 一端点「退出中继」
- **THEN** 另一端断开页显示「「<by_name>」已断开连接」；relay 不认识名字时退回「另一端已断开连接」

### Requirement: 在线客户端列表

屏幕上列出的本实体 SHALL 是**客户端**，不是设备/节点。relay 用内存中的 ctl 连接维护这份列表，
客户端断开 wss 就立刻从列表里消失 —— 在线列表即"此刻连着中继的客户端"。

一个 client id 开多个窗口时按 client id 合并成一行。自己那条标「我」、不可进入，并固定排第一。

#### Scenario: 连上才在列表里
- **WHEN** 客户端连上 wss
- **THEN** 其它客户端的列表里出现它，并带上它认领的宿主名与会话数

#### Scenario: 断开即消失
- **WHEN** 客户端点「断开中继」或进程退出
- **THEN** relay 立刻广播新列表，它从别人的列表里消失，不回退成"离线"灰卡

#### Scenario: 自己不给自己发进入入口
- **WHEN** 列表里有一条是自己的 client id
- **THEN** 那一行显示「我」，无「进入」，点击无反应

### Requirement: 宿主由本地 agent 认领

客户端 SHALL NOT 用主机名推断宿主。agent 在 `~/.rpty/agents/<node>.sock` 开 unix socket 应答
`{"op":"whoami"}`，并在同目录写 `<node>.json` 注册文件；客户端连中继前扫该目录问出宿主 node id，
握手时用 `host=` 上报，relay 记入 `ctl_host` 并在 `CLIENTS` / `/healthz` 里带出 `host`、`host_name`、
`host_online`、`sessions`。

#### Scenario: agent 未运行时
- **WHEN** 本机没有 agent 注册文件
- **THEN** 客户端照常连中继，只是列表里 `host` 为空、显示「宿主未上线」，不进别人的可选列表

#### Scenario: 同机多客户端
- **WHEN** 同一台机器开两个客户端
- **THEN** 两条 ctl 各自一行、各自名字，`host` 同为那台机器唯一的 node id

### Requirement: 断开不连坐

每个客户端是独立个体：`CTL_LEAVE` SHALL 只影响自己，不广播 `PAIR_CLOSED`，不改变别人的画面。

#### Scenario: 他人断开
- **WHEN** 另一个客户端断开中继
- **THEN** 我正在看的终端不受影响，列表里只是少了它那一行
