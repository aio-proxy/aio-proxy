---
description: Connect Muse Code accounts to AIO Proxy.
---

# Muse Code OAuth

Connect Muse Code subscription accounts.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "muse": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-muse-code",
      "capability": "default",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login muse
```
