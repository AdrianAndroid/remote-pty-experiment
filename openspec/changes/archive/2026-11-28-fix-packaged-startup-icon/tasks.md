# 任务

- [x] 1.1 `app.dock.setIcon` 只在非打包环境执行，并加 `existsSync` + try/catch 兜底
- [x] 1.2 重新 build + electron-builder 打包，覆盖安装到 `/Applications/rpty.app`
- [x] 1.3 启动验证：窗口出现、无 unhandled rejection、连上 `wss://rpty.zhaojian.xin` 且出现在在线客户端列表
