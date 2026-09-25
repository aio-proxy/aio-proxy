---
description: Connect Moonshot Kimi Code accounts to AIO Proxy.
---

# Kimi Code OAuth

Connect Kimi Code subscription accounts.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "kimi": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-kimi-code",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login kimi
```
