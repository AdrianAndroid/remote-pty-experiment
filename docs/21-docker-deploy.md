# 21 · Docker 部署

短答：**用，但要用 compose 管两件事（caddy + relay），不是把 relay 单独塞进容器再让宿主机反代。**

---

## 1. 收益 vs 成本

| 维度 | 裸机 systemd | Docker compose |
| --- | --- | --- |
| 部署步骤 | 装 python、pip install、写 unit | `docker compose up -d` |
| 环境一致性 | 依赖系统 python 版本 | 锁死 3.12 |
| 版本回滚 | `git checkout` + restart | 换镜像 tag，秒切 |
| 证书管理 | 自己装 certbot 或 Caddy | Caddy 官方镜像，卷持久化 |
| 443 端口占用 | 与服务器其他站点冲突时难办 | 容器独占，互不干扰 |
| 多一层网络 | 无 | 有（compose 内部网络，不影响） |
| 排查路径 | `journalctl -u rpty` | `docker logs rpty-relay-1` |
| 磁盘风险 | 日志走 journald 自动轮转 | **必须手动配 `max-size`，否则撑爆磁盘** |
| 内存开销 | ~30 MB | ~180 MB（含 caddy） |

**结论**：对 170 行、零状态、单依赖的服务，Docker 的核心价值不是"隔离"，是**部署可重复 + 回滚便宜 + 443 端口不跟别的东西抢**。

这三条对你成立（服务器上大概率还有别的东西、迭代期要频繁改），所以用。

---

## 2. 为什么是 compose 管两件

```
❌ 宿主机 nginx  →  容器 relay
   复杂度拆两处：nginx 配置在宿主机、relay 在容器，两套日志两套重启策略

✅ compose 里 caddy + relay
   Caddyfile 和 Dockerfile 都在 repo 里，改了一起重启，回滚一起回滚
```

Caddy 也进容器还有个副作用好处：**证书在 Docker volume 里，不污染宿主机**，删了重建不重签。

---

## 3. 文件结构

```
remote-pty-experiment/
├── relay.py              # 服务端主程序（约 170 行）
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
└── .env.example
```

全部在 repo 根，`docker compose up -d` 一条命令起。

---

## 4. Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir websockets==12.0

COPY relay.py .

RUN useradd -r -s /bin/false rpty
USER rpty

EXPOSE 8765

# 端口存活即健康（无状态服务，不需要更复杂）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import socket;socket.create_connection(('127.0.0.1',8765),2)" || exit 1

CMD ["python", "-u", "relay.py"]
```

要点：

- `-u` 让 stdout 不缓冲，`docker logs` 才有实时输出
- 非 root 运行
- 不装 gcc、不装编译依赖（`websockets` 是纯 Python 包）
- 镜像约 **130 MB**

---

## 5. docker-compose.yml

```yaml
services:
  relay:
    build: .
    container_name: rpty-relay
    restart: unless-stopped
    environment:
      RPTY_TOKEN: ${RPTY_TOKEN:?set RPTY_TOKEN in .env}
      RPTY_MAX_NODES: ${RPTY_MAX_NODES:-20}
      RPTY_PORT: 8765
    expose:
      - "8765"                    # 只在 compose 网络内暴露，不映射到宿主机
    networks: [rpty]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    stop_grace_period: 5s

  caddy:
    image: caddy:2-alpine
    container_name: rpty-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"             # HTTP/3，可选
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data          # ★ 证书在这，必须持久化
      - caddy_config:/config
    environment:
      RPTY_DOMAIN: ${RPTY_DOMAIN:?set RPTY_DOMAIN in .env}
    depends_on:
      - relay
    networks: [rpty]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  rpty:

volumes:
  caddy_data:
  caddy_config:
```

---

## 6. Caddyfile

```caddyfile
{$RPTY_DOMAIN} {
    reverse_proxy /ctl* relay:8765
    reverse_proxy /d/*  relay:8765

    # 给个纯文本状态页，方便手机浏览器确认服务活着
    handle /healthz {
        respond "ok" 200
    }

    log {
        output stdout
        format json
    }
}
```

- `relay:8765` 是 compose 服务名，内部 DNS 自动解析
- WebSocket 升级 Caddy 全自动，不需要 `Upgrade` 头配置
- 证书自动申请续期，无需 certbot

---

## 7. .env

```bash
RPTY_TOKEN=改成你自己的一长串随机值
RPTY_DOMAIN=relay.example.com
RPTY_MAX_NODES=20
```

生成 token：

```bash
openssl rand -hex 32
```

`.env` 已在 `.gitignore` 里。**这个文件是唯一不能进 git 的东西。**

---

## 8. 三个必须注意的坑

### 坑 1：容器内监听地址

`relay.py` 里如果写死 `127.0.0.1`，Caddy 容器访问不到。

```python
HOST = os.getenv("RPTY_HOST", "0.0.0.0")   # 容器里必须是 0.0.0.0
```

因为 `expose` 只在 compose 网络内可见，宿主机和外网都碰不到 8765，安全上没问题。

### 坑 2：Caddy 证书卷

```yaml
volumes:
  - caddy_data:/data      # 少了这行，每次重启都重新申请证书
```

Let's Encrypt 有速率限制（同一域名每周 5 次重复签发）。**反复重建容器不持久化 `/data`，几天内就会把自己锁死。**

这是 Docker 部署 Caddy 最经典的翻车点。

### 坑 3：日志无限增长

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Docker 默认 `json-file` **不轮转**。一个长连接服务跑几个月，日志能把磁盘写满、然后把容器和宿主机一起搞挂。

两个服务都要配，别只配一个。

---

## 9. 常用命令

```bash
# 首次启动
docker compose up -d --build

# 看日志（实时）
docker compose logs -f relay

# 改完 relay.py 后
docker compose up -d --build relay

# 看健康状态
docker compose ps

# 进容器看网络
docker compose exec relay sh

# 完全清理（证书卷也删，慎用）
docker compose down -v
```

---

## 10. 自建机在 NAT 后面怎么办

如果云主机其实是家里/机房的 Ubuntu 机器，没有公网 IP：

| 情况 | 方案 |
| --- | --- |
| 有公网 IP | 直接 compose，443 对外 |
| 有公网 IP 但 80/443 被封 | Caddy 改 DNS-01 验证，不走 HTTP 挑战 |
| NAT 后面 | 需要端口映射，或用 `cloudflared` 隧道（但这是外部二进制，公司机能跑、服务器能跑，问题不大） |

**第 3 种要注意**：`cloudflared` 部署在**服务器侧**，不在公司机器侧，所以不受公司 EDR 影响。这条路是通的。

---

## 11. 什么时候不该用 Docker

| 情况 | 建议 |
| --- | --- |
| 服务器只有这一个服务、只你一个人维护 | 裸机 systemd 更省心，少一层排查 |
| 服务器内存 < 512 MB | 省下 180 MB 给别的东西 |
| 团队没人熟 Docker | 别为了"规范"引入不熟的东西 |

你这三条都不成立，所以用。

---

## 12. 与宿主机裸装的等价性

Docker 版和 systemd 版跑的是**同一个 `relay.py`**，行为完全一致。切换成本是一次 `scp` + 一条命令。

**所以不要现在纠结。先按 Docker 起，跑不通再退回裸机——两者不冲突，因为代码没变。**
