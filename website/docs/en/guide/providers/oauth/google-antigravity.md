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
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-google-antigravity",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login google-antigravity
```
