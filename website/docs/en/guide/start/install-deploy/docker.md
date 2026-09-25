---
description: Deploy AIO Proxy using Docker or Docker Compose with persistent configuration, log limits, and container networking.
---

# Docker Deployment

For server deployments, CI/CD pipelines, or isolated environments, deploying AIO Proxy via container is fast and clean.

Official Image: `ghcr.io/aio-proxy/aio-proxy:latest`

---

## 1. Quick Start via Docker Run

```sh
docker run -d \
  --name aio-proxy \
  --restart unless-stopped \
  -p 9317:9317 \
  -v ~/.aio-proxy:/root/.aio-proxy \
  ghcr.io/aio-proxy/aio-proxy:latest \
  run --host 0.0.0.0
```

:::warning Binding to 0.0.0.0
Inside a Docker container, you must pass `--host 0.0.0.0` in the startup command so external traffic can map to port 9317. The config schema forbids setting `host` to non-loopback addresses directly in `config.jsonc`, so `--host 0.0.0.0` must be provided as a CLI argument.
:::

---

## 2. Docker Compose (Recommended)

Save the following content as `docker-compose.yml`:

```yaml title="docker-compose.yml"
services:
  aio-proxy:
    image: ghcr.io/aio-proxy/aio-proxy:latest
    container_name: aio-proxy
    pull_policy: always
    restart: unless-stopped
    ports:
      - '9317:9317'
    volumes:
      # Persist configuration, database, logs, and token caches
      - ~/.aio-proxy:/root/.aio-proxy
    # Must specify 0.0.0.0 inside container to receive mapped port traffic
    command: ['run', '--host', '0.0.0.0']
    logging:
      driver: 'json-file'
      options:
        max-size: '20m'
        max-file: '3'
```

### Start the Container

```sh
docker compose up -d
```

### Check Logs

```sh
docker compose logs -f aio-proxy
```

---

## 3. Directory Persistence

Mounting `~/.aio-proxy:/root/.aio-proxy` ensures persistent storage of:

- `config.jsonc`: Server configuration, provider definitions, and routing rules.
- `state.db`: SQLite database recording request traces, usage metrics, and historical logs.
- `tokens/`: Token storage and refresh metadata for OAuth providers.
