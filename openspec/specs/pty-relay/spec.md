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
