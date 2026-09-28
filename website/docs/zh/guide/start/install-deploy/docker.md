---
description: 使用官方 Docker 镜像与 Docker Compose 部署 AIO Proxy 容器化服务。
---

# Docker 容器化部署

如果你希望在独立容器、远程服务器或 NAS 设备上运行 AIO Proxy，可以使用官方发布的 Docker 容器镜像。

## 快速运行 (Docker CLI)

```sh
docker run -d \
  --name aio-proxy \
  --restart unless-stopped \
  --pull always \
  -p 9317:9317 \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  -v ~/.aio-proxy:/root/.aio-proxy \
  ghcr.io/aio-proxy/aio-proxy:latest
```

## 推荐方式：Docker Compose

在服务器或项目目录中创建 `docker-compose.yml`：

```yaml title="docker-compose.yml"
services:
  aio-proxy:
    image: ghcr.io/aio-proxy/aio-proxy:latest
    container_name: aio-proxy
    # 每次部署或拉起时自动检查并拉取最新镜像
    pull_policy: always
    restart: unless-stopped
    ports:
      - '9317:9317'
    volumes:
      - ./aio-proxy-data:/data
    environment:
      AIO_PROXY_HOME: /data
    command: ['run', '--host', '0.0.0.0']
    # 限制单个日志文件最大 20MB，保留最多 3 个滚动轮转文件
    logging:
      driver: 'json-file'
      options:
        max-size: '20m'
        max-file: '3'
```

### 启动与维护

```sh
# 启动容器
docker compose up -d

# 查看容器运行日志
docker compose logs -f

# 更新镜像至最新版本并重启
docker compose pull && docker compose up -d

# 停止容器
docker compose down
```

## 容器网络与访问说明

- **默认监听**：容器内默认监听在 `9317` 端口，通过宿主机端口映射 `-p 9317:9317` 暴露。
- **Dashboard 访问**：启动后即可通过浏览器访问 `http://<宿主机IP>:9317/dashboard`。如果远程暴露，请务必在 `config.jsonc` 中配置 `server.password` 强化安全性。
- **配置热重载**：在宿主机修改了挂载的 `config.jsonc` 后，可通过 Docker 命令触发重载：
  ```sh
  docker exec aio-proxy aio-proxy reload
  ```
