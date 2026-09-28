---
description: Connect GitHub Copilot and Copilot Business/Enterprise accounts via Device Flow.
---

# GitHub Copilot OAuth

Connect GitHub Copilot using standard OAuth Device Flow.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-copilot": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-github-copilot",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login my-copilot
```
