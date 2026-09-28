---
description: Connect Claude Pro / Team subscription accounts as a transparent proxy for Claude Code or Claude Desktop.
---

# Claude Pro / Team OAuth

Connect your Anthropic Claude subscription account to AIO Proxy.

:::important{title="Compliance & Usage Restrictions"}
Anthropic strictly regulates third-party software access to Claude subscription credentials. This integration acts as a transparent proxy designed exclusively for managing multi-subscription routing within **Claude Code CLI** or **Claude Desktop**. Do not route requests from other third-party autonomous agents through this provider, as doing so may risk account suspension.
:::

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-claude": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-claude-code",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login my-claude
```
