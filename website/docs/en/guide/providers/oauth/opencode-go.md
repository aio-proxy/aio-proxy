---
description: Connect OpenCode Go accounts to AIO Proxy.
---

# OpenCode Go OAuth

Connect OpenCode Go accounts.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "opencode-go": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-opencode-go",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login opencode-go
```
