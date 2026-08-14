# Remote API Key Access Design

## Goal

Allow aio-proxy to bind to non-loopback hosts and optionally require caller API keys, while preserving the existing Dashboard password session for management access.

## Configuration

`server.host` accepts any non-empty bind host. `server.apiKeys` is an optional array of entries:

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "apiKeys": [{ "key": "{{env.AIO_PROXY_KEY}}", "label": "CI" }]
  }
}
```

`key` is non-empty and supports the existing environment template syntax. `label` is an optional non-empty display-only identifier. Keys are never returned by Dashboard configuration APIs or logs; labels may be returned.

An empty or absent `apiKeys` array intentionally leaves model APIs open. A non-empty array requires every model API request, including model listing, to send either `Authorization: Bearer <key>` or `X-API-Key: <key>`. The matched credential is stripped before routing to an upstream provider. Missing or invalid credentials receive 401. `/health` remains public.

## Management Access

Dashboard assets and its existing password-session endpoints can be reached remotely. When `server.password` is absent, non-loopback Dashboard and `/admin/*` access is rejected. A password-protected remote request uses the existing HttpOnly session cookie.

Dashboard and remote admin mutations validate that `Origin` has the same host as the request. No `server.publicOrigin` field is introduced. Direct connections are supported. A local reverse proxy is intentionally treated as loopback; trusted-proxy forwarding is outside this change.

Local `/admin/*` keeps its current session-less CLI compatibility. Remote `/admin/*` requires the Dashboard session.

## Verification

Tests cover configuration parsing and redaction, missing/invalid/valid API credentials across model listing and model APIs, credential stripping, remote Dashboard/Admin session requirements, local admin compatibility, and same-host Origin checks. Documentation includes the configuration example and direct-connection deployment constraint.
