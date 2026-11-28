# 设计取舍

## 为什么重写而不是把 python 打进包

| 方案 | 代价 |
| --- | --- |
| PyInstaller 打 python agent | 每平台一个 10MB 左右二进制，签名要单独处理；协议不用改，但发布链路多一步 |
| 目标机自带 python3 + websockets | 朋友的机器不保证有；macOS 的 python3 依赖 Xcode CLT |
| Node 重写（选这个） | 一次性移植成本，换来零外部依赖、随 app 一起签、单包分发 |

协议层已经有 `tests/test_relay.py` 47 个用例作为契约，移植后可以用同一套测试对 relay 跑。

## node-pty 的坑

- 原生模块，必须 `electron-rebuild` 到 electron 45 对应的 ABI；打包要按架构分别构建；
- macOS 需要 `--build-from-source` 且 Xcode CLT 在位；
- deb 里要把 `.node` 打进 asar 外的 `app.asar.unpacked`（原生模块不能在 asar 里加载）。
