---
description: Configure network listening, loopback security, CORS origins, API keys, and dashboard protection.
---

# Server & Security (`server`)

The `server` configuration section controls HTTP service bindings, access authentication, and Dashboard security policies.

```jsonc title="config.jsonc"
{
  "server": {
    "port": 9317,
    "cors": {
      "origin": ["http://localhost:3000", "https://chat.example.com"],
    },
    "apiKeys": [
      {
        "key": "{{env.PROXY_SECRET_KEY}}",
        "name": "Production Client Key",
      },
    ],
    "dashboard": {
      "enabled": true,
      "password": "{{env.DASHBOARD_PASSWORD}}",
    },
  },
}
```

## Security & Network Boundaries

### 1. Loopback Protection

By design, `config.jsonc` restricts the listening address to the local loopback interface (`127.0.0.1` / `localhost`). Non-loopback bindings cannot be defined in the file.

- When running in Docker, you must explicitly supply `--host 0.0.0.0` as a command-line startup argument.

### 2. API Key Authentication (`apiKeys`)

- When `server.apiKeys` is empty or omitted, AIO Proxy runs in development mode, allowing unauthenticated local requests.
- When one or more keys are defined, all incoming API requests (e.g. `/v1/*`) must supply `Authorization: Bearer <key>`.

### 3. Dashboard Password Protection (`dashboard.password`)

- By default, the Dashboard is accessible locally without a password.
- When deploying to a remote host, configure `dashboard.password` to enforce session cookie authentication before granting access to traces, settings, and OAuth credentials.
