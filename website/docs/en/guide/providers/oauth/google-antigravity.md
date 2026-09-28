---
description: Connect Google Antigravity accounts to AIO Proxy.
---

# Google Antigravity OAuth

Connect Google Antigravity accounts using OAuth PKCE.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "google-antigravity": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-google-antigravity",
      "capability": "default",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login google-antigravity
```
