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
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-muse-code",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login muse
```
