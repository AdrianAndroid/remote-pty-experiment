# 部署

生产是一台阿里云 ECS（2 vCPU / 1.6 GiB，无 swap），跑法：

```
/opt/1panel/apps/rpty/
├── docker-compose.yml   # 本目录这几份
├── Dockerfile
├── requirements.txt
├── relay.py             # 从 server/relay.py scp 过来，**挂载进容器**，不烤进镜像
├── .env                 # RPty_TOKEN=...（不进仓库）
└── data/                # relay-state.json
```

## 为什么 relay.py 是挂载的

镜像里也 COPY 了一份，但 compose 用 `./relay.py:/app/relay.py:ro` 把它遮住。
这样发版只是 `scp relay.py` + `docker restart`，不必重建镜像：
这台机器只有 1.6 GiB，重建一次要几分钟，还会把正在通话的人一起踢下线。

## 发版

```bash
scp server/relay.py $RELAY_HOST:/opt/1panel/apps/rpty/relay.py
ssh $RELAY_HOST 'cd /opt/1panel/apps/rpty && cp -p relay.py.prev relay.py.prev 2>/dev/null; docker restart rpty-relay'
curl -s https://relay.example.com/healthz
```

回滚：`mv relay.py.prev relay.py && docker restart rpty-relay`。

## 上限

- `MAX_CLIENTS = 10`：同时最多 10 个客户端身份，第 11 个收 `server_full` 并按 4010 断开。
- `VIEWER_QUEUE_BYTES = 8MB`：单个观众在等快照期间攒够 8MB 就按 4009 断开，重连走快照。
