# tasks

- [ ] `apps/desktop/src/agent/`：Node 版 agent 骨架（relay 连接 + HELLO + 心跳）
- [ ] node-pty 开 PTY，OPEN/RESIZE/DATA/CLOSE/EXIT 与 python 版逐条对齐
- [ ] 写 `~/.rpty/agents/<node>.json` + `.sock`，保持 `askLocalAgent()` 兼容
- [ ] 主进程 fork sidecar；关窗一起退出；崩溃退避重启
- [ ] 设置页「这台机器提供终端」开关（默认开）
- [ ] `package.json`：mac 出 x64 / arm64 两包；deb 去掉 python 依赖
- [ ] 干净环境验证：只装一个包 → 卡片可点、能开终端
- [ ] 文档：分发给 friends 的 Gatekeeper 说明；`~/bin/macmini/docs/rpty/` 同步
