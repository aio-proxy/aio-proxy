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

## Request capacity and body logging

```jsonc
{
  "server": {
    "requestBody": { "maxBytes": 268435456 },
    "logging": { "captureMaxBytes": 67108864 },
  },
}
```

`server.requestBody.maxBytes` defaults to 256 MiB and accepts integers from 1 MiB to 512 MiB (`1048576..536870912`). Ordinary JSON requests check both encoded transport bytes and decoded bytes, including compressed requests. Explicit image, audio and video limits remain separate; image generations and video keep their existing 64/128 MiB limits.

`server.logging.captureMaxBytes` defaults to 64 MiB and accepts integers from 0 to 64 MiB (`0..67108864`), per hop and direction. Setting it to 0 disables body capture while forwarding and diagnostics continue. Truncated logs retain the total observed `byteLength`, `truncated` and `captureLimitBytes`; omitted bodies use `privacy_policy`, `media_payload` or `capture_limit`. Sensitive or uninspectable bodies remain omitted. Privacy inspection keeps its independent 64 MiB budget, and the Dashboard keeps its existing 1,048,576 code-unit read limit.

Both budgets support hot reload for new requests. A request already started retains its entry configuration snapshot. Parsing, Base64, cloning and retries may occupy several times the request size in memory; raising the limit is not an upstream capacity guarantee.
