# 任务

- [x] 定位服务端通道生命周期问题（`_close_room` → `_close_data_channel` pop 掉 channel/node）
- [x] 新增 `_detach_viewers`，借来的终端散场只踢 viewer
- [x] agent 字节循环按 token 现取通道
- [x] viewer 加入时用 `session.node` 兜底 `channel.node`
- [x] 新增 `session:unready` + `markUnready`，`TerminalPane` 卸载时撤销就绪
- [x] 进房时清掉上一间房留下的错误提示
- [x] 回归测试 `test_borrowed_channel_survives_room_close`
- [x] pytest 45 / flake8 / typecheck / build 全绿
- [x] 真机双窗口复验（进房、离开、再进房 ×2）
