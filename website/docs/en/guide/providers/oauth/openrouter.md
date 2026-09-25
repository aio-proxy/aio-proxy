---
description: Connect OpenRouter accounts via OAuth PKCE.
---

# OpenRouter OAuth

Connect OpenRouter accounts using PKCE authorization code flow.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "openrouter": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-openrouter",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login openrouter
```
