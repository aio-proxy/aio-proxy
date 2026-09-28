---
description: Connect Cursor IDE subscription accounts to AIO Proxy with dynamic upstream model discovery.
---

# Cursor OAuth

Integrate your Cursor IDE subscription account to access models through AIO Proxy.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-cursor": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-cursor",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login my-cursor
```
