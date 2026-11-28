# tasks

- [x] `MAX_CLIENTS = 10` + `handle_ctl` 登记前检查名额
- [x] 超限回 `server_full` 并 `close(4010)`
- [x] 同名重连不占名额
- [x] 客户端认 4010：不自动重连，状态可见
- [x] 测试 `test_client_cap_rejects_eleventh`
