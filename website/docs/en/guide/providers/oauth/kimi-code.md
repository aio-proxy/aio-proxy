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
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-kimi-code",
      "capability": "default",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login kimi
```
