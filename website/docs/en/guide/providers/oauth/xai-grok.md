---
description: Connect xAI Grok accounts to AIO Proxy via Device Flow.
---

# xAI Grok OAuth

Connect xAI Grok accounts using Device Code Flow.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "xai-grok": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-xai-grok",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login xai-grok
```
