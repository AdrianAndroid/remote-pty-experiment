# 23 · 发布与运维通道

本项目的前提是"不用 SSH"。这个"不用"有两个层面，必须分清，否则文档会自相矛盾。

| 层面 | 内容 | 本项目 |
| --- | --- | --- |
| 产品通道 | 一端怎么操作另一端的 shell | **完全不用 SSH**，走 WSS 中继 |
| 运维通道 | 代码怎么上服务器、出问题怎么救 | **不依赖 SSH 入站**，见下 |

---

## 1. 三个阶段的通道

| 阶段 | 通道 | 是否需要 SSH 入站 |
| --- | --- | --- |
| 一次性引导（建目录、装依赖、签证书） | 1Panel Web 面板（已开在 443），或一次 SSH 后收白名单 | 否 / 仅一次 |
| 日常发布 | 服务器**主动拉** GitHub Release + 签名校验 + 软链切换 | 否 |
| 救援 | 1Panel 面板 / 阿里云控制台 VNC（ECS 自带"远程连接"） | 否 |

原则：**整个系统里没有任何一方为对端开放入站端口**。客户端不出站之外的任何东西，服务器除了 443 也不给部署脚本开口子。这与 relay 的架构是同一条原则——两端都是出站，中继才是唯一入口。

---

## 2. 依赖清单（写死的边界）

rpty 的上游依赖只有两项：

1. 本机 `127.0.0.1:8765` 上的 relay 容器
2. 1Panel-openresty 提供的 443

**与 reelup、frps、supabase、1Panel 面板本身均无依赖**，任一停止均不影响 rpty。openresty 重启的失效表现为"连接断开 + 自动重连"，PTY 与 ring buffer 不受影响。

不共享：reelup 的容器、reelup 的证书、reelup 的 server_name、frps 的端口池（50000–59999）。

---

## 3. 部署形态

```
/opt/1panel/apps/rpty/
├── docker-compose.yml
├── Dockerfile
├── relay.py            ← 日常发布只覆盖这个文件
├── relay.py.prev       ← 回滚用
└── .env                ← 600，含 token
```

`docker-compose.yml`：

```yaml
services:
  relay:
    build: .
    image: rpty-relay:0.1.0
    container_name: rpty-relay
    network_mode: host          # 与 openresty 一致，127.0.0.1:8765 直接互访
    restart: always
    mem_limit: 256m
    volumes:
      - ./relay.py:/app/relay.py:ro
      - ./.env:/etc/rpty/relay.env:ro
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

`Dockerfile`：

```dockerfile
FROM python:3.10-slim
RUN pip install --no-cache-dir websockets==12.0
WORKDIR /app
CMD ["python", "-u", "/app/relay.py"]
```

**镜像只 build 一次**，之后改代码只覆盖挂载的 `relay.py`。这样发布的成本与裸机 systemd 相同（8 KB 文件），但保留了 1Panel 的统一管理入口。

---

## 4. 反代配置

在 1Panel 中为 `rpty.zhaojian.xin` 建站点，location 段必须显式写这几行（默认值会咬人）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout  3600s;   # 默认 60s 会掐断空闲终端
    proxy_send_timeout  3600s;
    proxy_buffering off;         # 不关会攒包，输出一顿一顿
}
```

TLS 由 1Panel 的 Let's Encrypt 自动签发与续期（certbot timer 每日 00:49）。证书按站点独立存放，与 reelup 互不影响。

---

## 5. 日常发布（零 SSH）

### 5.1 发布流程

```
本地改代码
  → git tag v0.1.1 && git push --tags
  → GitHub Actions 打包 relay.py + 生成 ed25519 签名
  → 服务器 systemd timer（每 5 分钟）检查 latest release
  → 下载 → 验签 → 建新目录 → 切软链 → docker restart
```

目录约定：

```
/opt/1panel/apps/rpty/releases/
├── 0.1.0/relay.py
├── 0.1.1/relay.py
└── current -> 0.1.1
```

### 5.2 手动发布（应急）

```bash
scp relay.py root@8.152.204.58:/opt/1panel/apps/rpty/relay.py.new
ssh root@8.152.204.58 'cd /opt/1panel/apps/rpty && mv relay.py relay.py.prev && mv relay.py.new relay.py && docker restart rpty-relay'
```

### 5.3 回滚

```bash
ssh root@8.152.204.58 'cd /opt/1panel/apps/rpty && mv relay.py.prev relay.py && docker restart rpty-relay'
```

3 秒完成。relay 无状态，回滚零代价——重启只断桥，PTY 在两端继续活着。

### 5.4 签名校验

服务器只存公钥（`/etc/rpty/release.pub`），发布包必须带 ed25519 签名。验签失败一律不切换，跑着的版本不受影响。这与项目里 `node_id = SHA256(pubkey)` 是同一套思路。

---

## 6. 输入输出与监控

| 项 | 做法 |
| --- | --- |
| 健康检查 | `GET /healthz` 返回 `{"ok":true,"sessions":N}` |
| 日志 | 容器 json-file，10 MB × 3 轮转；`docker logs rpty-relay -f` |
| 内存 | `mem_limit: 256m` 兜底（机器 1.6 GiB 无 swap） |
| 磁盘 | 镜像 130 MB + 代码 20 KB，机器剩 30 GB |
| 端口 | 只有 `127.0.0.1:8765`，公网不可见，安全组无需改动 |

---

## 7. 需要人做一次的事（不在此自动化）

1. 阿里云 DNS 加 `rpty` 的 A 记录 → `8.152.204.58`
2. 1Panel 建站点 `rpty.zhaojian.xin` + 签证书
3. 1Panel 编排贴 `docker-compose.yml` + 首次 build
4. 生成 token 写入 `.env`（600）
5. 补 2 G swapfile（见 `22`，会改生产机系统配置，单独确认）

---

## 8. 尚未验证

| 项 | 怎么验 |
| --- | --- |
| 公司网络能出站 wss 到 `rpty.zhaojian.xin` | 在公司那台上 `curl -v` 一次握手，或直接跑 P2 |
| 公司机对未签名 Electron 的拦截 | P3 打包后实跑，观察是否被 EDR 静默终止 |
| 长时间空转不杀进程 | 部署后空转 30 分钟观察 |

第 1 项是方案成立的根本，必须在 P2 之前完成；`docs/22` 的实测是在**家里**做的，公司侧尚未验证。
