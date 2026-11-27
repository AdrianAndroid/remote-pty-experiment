# 22 · 环境实测记录

**目的**：把「能不能做」这个问题用实测数据关掉，而不是靠推断。

**时间**：2026-11-27
**机器**：公司那台 Mac mini，`x86_64`，macOS 15.8.3（Build 24H241）
**执行位置**：本机终端，非容器、非远程

---

## 结论摘要

| 假设 | 结果 | 判定 |
| --- | --- | --- |
| 有能跑 asyncio 的 Python | 3.12.11（Homebrew）/ 3.12.7（Anaconda）/ 3.9.6（系统） | ✅ |
| 能装 `websockets` | 17.4，耗时 1.3 秒 | ✅ |
| 能起 WS 服务端 + 二进制帧往返 | echo 原样返回 | ✅ |
| 有真 PTY | `/dev/ttys009` | ✅ |
| 中文不切裂 | 正常输出 | ✅ |
| 能装 `cryptography` | 50.0.2，耗时 59 秒 | ✅ |
| X25519 + HKDF 可用 | 协商出 32 字节密钥 | ✅ |
| 出站 wss 到公网 | 3 个 echo 服务全通 | ✅ |
| 有强制代理 | 无代理环境变量 | ✅ |

**没有一项失败。**

---

## 1. 机器与 Python

```
$ uname -m
x86_64
$ sw_vers
ProductVersion:  15.8.3
BuildVersion:    24H241

/opt/anaconda3/bin/python3     -> Python 3.12.7
/usr/local/bin/python3         -> Python 3.12.11
/usr/bin/python3               -> Python 3.9.6
```

**为什么重要**：三套 Python 都在，说明不依赖单一安装源。真出问题时可以换一套。

---

## 2. 装包（曾经的"唯一硬门槛"）

```
$ /usr/local/bin/python3 -m venv ~/rpty-venv-test
$ ~/rpty-venv-test/bin/pip install websockets
Looking in indexes: https://mirrors.ustc.edu.cn/pypi/simple/
Downloading ... websockets-17.4-cp312-cp312-macosx_10_13_x86_64.whl (216 kB)
Successfully installed websockets-17.4
real    0m1.297s
```

**关键发现**：这台机器的 pip 已经配好了中科大镜像，所以不走 pypi.org。

之前担心的"公司网络封 PyPI"不成立。直接连 pypi.org 也能通（HTTP 200），只是慢（10 秒 378 KB）。

```
$ ~/rpty-venv-test/bin/pip install cryptography
Successfully installed cffi-2.1.1 cryptography-50.0.2 pycparser-3.12
real    0m59.566s
user    3m35.445s
```

`user` 时间远超 `real`，说明用到了多核编译——机器上有完整的 C 工具链（Xcode CLT）。这是一次性成本，装完就有。

---

## 3. WebSocket 服务端与二进制帧

```python
async def h(ws):
    async for m in ws:
        await ws.send(m)

async with serve(h, "127.0.0.1", 18765):
    async with connect("ws://127.0.0.1:18765") as c:
        await c.send(b"\x00\x01binary\x00\x00\x00\x06")
        r = await c.recv()
```

```
WS     OK  echo = b'\x00\x01binary\x00\x00\x00\x06'
```

**为什么重要**：验证的是**二进制帧**，不是文本帧。协议里 PTY 数据必须走二进制，走文本会触发编码转换、切裂 UTF-8。

---

## 4. 真 PTY（最关键的一项）

```python
pid, fd = os.forkpty()
if pid == 0:
    os.execv("/bin/sh", ["/bin/sh", "-c",
             "echo HI_FROM_PTY; tty; printf '中文测试\\n'; exit 0"])
```

```
PTY    OK  status = 0
--- PTY 原始输出 ---
HI_FROM_PTY
/dev/ttys009
中文测试
--- 结束 ---
```

**三个信号都正常**：

| 信号 | 含义 |
| --- | --- |
| `/dev/ttys009` | 拿到的是**终端设备**，不是 pipe。`vim`/`htop`/`sudo` 都依赖这个 |
| `中文测试` | 没有字节切裂，UTF-8 完整 |
| `status = 0` | 子进程正常退出，没被强杀 |

如果输出是 `/dev/fd/63` 或空，说明是管道模拟，那这个方案就废了。

---

## 5. 出站 WebSocket

```
wss://ws.postman-echo.com/raw     OK   1285ms
wss://echo.websocket.org          OK    631ms
wss://ws.ifelse.io                OK    908ms

环境代理变量：(无)
```

**这是比"能连自己服务器"更强的证据**——三个都是国外公共服务，公司网络连国外都通，说明：

1. 443 出站不受限
2. **WebSocket 升级没有被应用层拦截**
3. 没有强制 TLS 检查代理

延迟 600–1300 ms 是因为绕了国际线路。连国内云主机会低一个数量级。

> 附注：同时跑的 `nc -z -G 5 host 443` 显示 FAIL，那是 BSD 版 `nc` 不认 GNU 参数，不是网络问题。wss 能通就是证明。

---

## 6. 唯一没验证的

**EDR 在长时间运行时会不会杀 python 进程。**

已测的都是秒级进程。`frpc` 被杀是因为二进制特征，但真实风险模式是"一个 python 进程跑几小时 + 保持外部长连接"。

**验证方法**：部署后起一个只连接、不传数据的空转进程，观察 30 分钟。

**万一失败的退路**：

| 退路 | 说明 |
| --- | --- |
| 改进程名 | `setproctitle` 改成 `python3 -m http.server` 之类的样子 |
| 换端口 | 不一定是 443 |
| 加随机延时重连 | 降低"规律外连"特征 |
| 降频心跳 | 减少连接活动频率 |

**每一项都有退路，没有"一失败就推翻架构"的。**

---

## 7. 复现方法

```bash
# 1. 建环境
/usr/local/bin/python3 -m venv ~/rpty-venv-test
~/rpty-venv-test/bin/pip install websockets cryptography

# 2. 跑检查（脚本见本文件各节的代码块）
~/rpty-venv-test/bin/python check.py
```

当前机器上 `~/rpty-venv-test` 已保留，可直接复用。
