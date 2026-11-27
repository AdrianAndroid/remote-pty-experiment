# 21 · Docker 部署

## 1. 先回答：一个容器够不够

**够，而且推荐。**

上一条我给的 `caddy + relay` 两容器是"关注点分离"的标准做法，适用于有团队、有 CI、多服务编排的生产环境。对**一个 170 行、零状态、单人维护**的服务，它带来的是纯粹的额外成本：

| 两容器要多做的事 | 单容器 |
| --- | --- |
| 定义 compose 网络、服务发现 | 不需要 |
| 两份 logging 配置 | 一份 |
| 两份重启策略 | 一份 |
| `depends_on` 启动顺序 | supervisord 里 `priority` 一行 |
| 两处看日志 | `docker logs` 一处 |

所以：**一个容器，两个进程，supervisord 管。**

---

## 2. 三种方案

| 方案 | 进程数 | 镜像 | 证书 | 适合谁 |
| --- | --- | --- | --- | --- |
| **A · 单容器双进程** ✅ | 2（caddy + python） | ~180 MB | Caddy 自动续 | 本项目 |
| B · 单容器单进程 | 1（python 自己 TLS） | ~130 MB | 自己管 | 极致极简，能接受手动续期 |
| C · 两容器 | 2 | ~180 MB | Caddy 自动续 | 多服务编排、有团队 |

选 A。理由：**证书自动续期是这个项目里唯一"忘了会出人命"的运维项**——证书过期服务就挂，而且你可能几天后才发现。Caddy 的 10 行 supervisord 配置换掉这个风险，值。

---

## 3. 方案 A：单容器双进程

### 3.1 文件结构

```
remote-pty-experiment/
├── relay.py
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
├── supervisord.conf
└── .env.example
```

### 3.2 Dockerfile

```dockerfile
# 从 Caddy 官方镜像拿静态二进制（跨发行版可跑，版本最新）
FROM caddy:2-alpine AS caddybin

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        supervisor ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=caddybin /usr/bin/caddy /usr/bin/caddy

WORKDIR /app
RUN pip install --no-cache-dir websockets==12.0

COPY relay.py .
COPY Caddyfile /etc/caddy/Caddyfile
COPY supervisord.conf /etc/supervisor/conf.d/rpty.conf

RUN useradd -r -s /bin/false rpty || true

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import socket;socket.create_connection(('127.0.0.1',8765),2)" || exit 1

CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
```

要点：
- Caddy 从官方镜像 `COPY` 二进制，不用 apt 装（Debian 源里的版本旧且依赖多）
- supervisor 是 Debian 自带包，`apt` 一行装好
- 镜像约 180 MB

### 3.3 supervisord.conf

```ini
[supervisord]
nodaemon=true
pidfile=/tmp/supervisord.pid
logfile=/dev/stdout
logfile_maxbytes=0
loglevel=info

[program:relay]
command=python -u relay.py
directory=/app
priority=10
autorestart=true
startretries=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:caddy]
command=caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
priority=20
autorestart=true
startretries=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

- `nodaemon=true` 让 supervisord 留在前台，成为容器的 PID 1
- `priority` 决定启动顺序：relay 先起，caddy 后起
- `maxbytes=0` 表示不轮转，日志直接进 Docker 的 json-file 驱动（由容器的 `max-size` 管）
- `autorestart=true`：任一进程挂了 1 秒内拉起，不用重启容器

### 3.4 Caddyfile

同容器，所以后端地址是 `127.0.0.1`：

```caddyfile
{$RPTY_DOMAIN} {
    reverse_proxy /ctl* 127.0.0.1:8765
    reverse_proxy /d/*  127.0.0.1:8765

    handle /healthz {
        respond "ok" 200
    }

    log {
        output stdout
        format json
    }
}
```

### 3.5 docker-compose.yml

**只有一个 service**：

```yaml
services:
  rpty:
    build: .
    container_name: rpty
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      RPTY_TOKEN: ${RPTY_TOKEN:?set RPTY_TOKEN in .env}
      RPTY_DOMAIN: ${RPTY_DOMAIN:?set RPTY_DOMAIN in .env}
      RPTY_MAX_NODES: ${RPTY_MAX_NODES:-20}
      RPTY_HOST: 0.0.0.0
      RPTY_PORT: 8765
    volumes:
      - caddy_data:/data          # ★ 证书，必须持久化
      - caddy_config:/config
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    stop_grace_period: 5s

volumes:
  caddy_data:
  caddy_config:
```

### 3.6 .env

```bash
RPTY_TOKEN=改成 openssl rand -hex 32 的输出
RPTY_DOMAIN=relay.example.com
RPTY_MAX_NODES=20
```

---

## 4. 方案 B：单容器单进程（不要 Caddy）

如果你连 supervisor 都不想要，让 Python 自己终结 TLS。**一个容器，一个进程，没有 supervisor。**

### 4.1 Dockerfile

```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir websockets==12.0
COPY relay.py .
EXPOSE 443
CMD ["python", "-u", "relay.py"]
```

### 4.2 relay.py 里加 TLS

```python
import ssl, os

ctx = None
if os.getenv("RPTY_TLS_CERT"):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.environ["RPTY_TLS_CERT"],
                        os.environ["RPTY_TLS_KEY"])

async with serve(handler, "0.0.0.0", 443, ssl=ctx,
                 ping_interval=20, ping_timeout=10):
    await asyncio.Future()
```

### 4.3 运行

```bash
docker run -d --name rpty \
  -p 443:443 \
  -e RPTY_TOKEN=xxx \
  -e RPTY_TLS_CERT=/certs/fullchain.pem \
  -e RPTY_TLS_KEY=/certs/privkey.pem \
  -v /etc/letsencrypt/live/relay.example.com:/certs:ro \
  --restart unless-stopped \
  rpty:latest
```

### 4.4 代价（要接受才选）

| 问题 | 说明 |
| --- | --- |
| 证书续期 | 宿主机 cron 跑 `certbot renew`，续完要 `docker kill -s HUP` 或重启容器 |
| 首次签发 | certbot 的 HTTP-01 挑战要占 80 端口，会和容器冲突——得先停容器签发，或用 DNS-01 |
| 没有 80 跳转 | 只能走 `wss://`，没有 http→https 重定向（我们的场景本来也不访问 80） |
| 证书路径耦合 | 容器依赖宿主机的 let's encrypt 目录结构 |

**能跑，但把"证书"这个最容易忘的事交给了你自己。**

---

## 5. 方案 C：两容器

就是上一条给的版本。保留它作为参考——**如果哪天这个服务扩成 relay + web 前端 + 管理面板，那时候拆容器才有意义。**

现在拆的好处只有一个：日志更干净。代价是五处配置要同步维护。不值。

---

## 6. 三个必踩的坑（与方案无关）

### 坑 1：容器内必须监听 `0.0.0.0`

```python
HOST = os.getenv("RPTY_HOST", "0.0.0.0")
```

写死 `127.0.0.1` 的话，同容器的 Caddy 能连上（都在 loopback），但**方案 B 里直接用 `-p 443:443` 就会连不通**——Docker 的端口映射从外面打进来，目标是容器的 eth0，不是 loopback。

统一用 `0.0.0.0`，8765 没有 `ports` 映射，外网碰不到。

### 坑 2：Caddy 的 `/data` 必须持久化

```yaml
volumes:
  - caddy_data:/data
```

少了这行，每次重建容器都重新申请证书。Let's Encrypt 同一域名**每周限 5 次重复签发**，几天内就把自己锁死。

### 坑 3：Docker 日志默认不轮转

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
```

长连接服务跑几个月，`json-file` 能把磁盘写满，然后把容器和宿主机一起搞挂。

---

## 7. 常用命令

```bash
# 起
docker compose up -d --build

# 看两个进程的日志（混在一起，带 program 前缀）
docker compose logs -f

# 改完 relay.py
docker compose up -d --build

# 容器内看进程状态
docker compose exec rpty supervisorctl status

# 单独重启 caddy（比如换了证书）
docker compose exec rpty supervisorctl restart caddy

# 完全清理（连证书一起删，慎用）
docker compose down -v
```

`supervisorctl status` 会显示：

```
caddy    RUNNING   pid 12, uptime 3 days, 4:11:02
relay    RUNNING   pid 11, uptime 3 days, 4:11:03
```

---

## 8. 什么时候退回裸机

| 情况 | 建议 |
| --- | --- |
| 服务器只有这一个服务、只你一人维护 | 裸机 systemd 更省心，少一层 |
| 服务器内存 < 512 MB | 省下 180 MB |
| 443 端口已被别的服务占用 | 用裸机 + 现有反代，别抢端口 |

**三条都不成立，所以用 Docker。**

而且注意：Docker 版和 systemd 版跑的是**同一个 `relay.py`**，行为完全一致。切换成本是一次 `scp`，随时能换。
