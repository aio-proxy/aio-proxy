---
description: AIO Proxy 核心服务器配置：监听地址、端口、API Key 鉴权、Dashboard 密码、日志与 OpenTelemetry。
---

# 服务与安全

AIO Proxy 的服务本体与安全行为通过配置文件的顶级 `server` 字段进行控制。

完整配置示例：

```jsonc title="config.jsonc"
{
  "server": {
    "host": "127.0.0.1",
    "port": 9317,
    "requireApiKey": true,
    "apiKeys": [
      { "key": "sk-aio-primary-key", "label": "生产客户端" },
      { "key": "{{env.CLIENT_SECRET_KEY}}", "label": "测试环境" },
    ],
    "password": "{{env.DASHBOARD_PASSWORD}}",
    "logging": {
      "enabled": true,
      "dir": "~/.aio-proxy/logs",
      "level": "info",
      "retentionDays": 7,
    },
    "retry": {
      "retryAfterCapMs": 30000,
    },
  },
}
```

## 网络绑定与外部暴露

- **`host`**：监听主机地址，默认为 `127.0.0.1`。
  - **安全约束**：出于本地安全防护考虑，AIO Proxy 原生限制仅能绑定在本地回环地址（`127.0.0.1`、`::1` 或 `localhost`）。
  - **远程访问建议**：若需要在局域网或远程服务器提供服务，请在 AIO Proxy 前置部署反向代理（如 Nginx、Caddy、Traefik）或安全内网穿透隧道（如 Cloudflare Tunnel、Tailscale），并在外层终结 TLS 和进行严格的 IP 访问控制。
- **`port`**：HTTP 监听端口，默认为 `9317`。

## 客户端鉴权 (API Keys)

AIO Proxy 可以作为一个安全的模型网关，防止未经授权的客户端随意调用上游额度。

- **`apiKeys`**：合法的调用者密钥列表，支持对象格式 `{ "key": "...", "label": "..." }`，可利用 `label` 区分不同客户端或项目。
- **`requireApiKey`**：是否强制开启鉴权。
  - 设为 `true` 时，所有针对模型接口（如 `/v1/chat/completions`、`/v1/responses` 等）的请求必须在请求头中携带 `Authorization: Bearer <key>`，且该 Key 必须在 `apiKeys` 列表中。
  - 设为 `false`（或未设置）：即使声明了 `apiKeys`，系统也不会阻断未携带凭证的请求，适合开发阶段调试。

> 注意：向 AIO Proxy 发送请求时请使用这里配置的 AIO Proxy 密钥，**不要**将上游提供商的真实 API Key 作为调用凭证发给 AIO Proxy。

## Dashboard 控制台密码保护

- **`password`**：保护 Dashboard 管理后台的密码明文或 Argon2id PHC 哈希字符串。
  - **作用范围**：该密码**仅保护 Dashboard 页面与内部管理 API**，不会干扰客户端调用模型接口。
  - **会话持久化**：首次登录成功后，凭据会在浏览器端安全持久化；只要每 6 天内访问一次，登录状态便会自动滑动续期，无需反复输入。
  - **全局吊销**：只要在配置文件中修改或轮换 `password`，所有浏览器设备上已颁发的有效会话均会瞬间失效。

## 本地日志系统 (`logging`)

- **`enabled`**：是否将运行日志持久化写入本地磁盘文件（默认为 `false`，仅控制台输出）。
- **`dir`**：日志存储目录（支持绝对路径或 `~/...` 简写）。
- **`level`**：日志详细程度，支持 `debug`、`info`、`warn`、`error`，默认为 `info`。
- **`retentionDays`**：日志自动清理保留天数（默认 `3` 天，支持 `1..365`），防止占用过多磁盘。

## 限流与重试控制 (`retry`)

- **`retryAfterCapMs`**：当上游提供商返回 HTTP 429 且附带 `Retry-After` 响应头时，AIO Proxy 在冷却该提供商时所能采纳的最大等待毫秒数上限（默认为 `30000` ms 即 30 秒）。避免某些极端上游返回数天的冷却时间导致该 Provider 被永久挂起。
