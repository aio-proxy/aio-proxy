---
description: Connect OpenAI ChatGPT Pro / Team accounts to AIO Proxy with dynamic model discovery and automatic token renewal.
---

# OpenAI ChatGPT OAuth

Connect your personal OpenAI ChatGPT subscription account to AIO Proxy.

:::important{title="Compliance & Usage Restrictions"}
The ChatGPT OAuth integration is intended strictly for personal development and debugging purposes. Do not use this integration to redistribute access, proxy traffic for multiple users, or violate OpenAI Terms of Service.
:::

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-chatgpt": {
      "kind": "plugin",
      "plugin": "@aio-proxy/plugin-openai-chatgpt",
    },
  },
}
```

## Login

```sh
aio-proxy oauth login my-chatgpt
```

Follow the browser prompt to complete OpenAI authentication. AIO Proxy will automatically fetch the latest accessible models (such as `gpt-5`, `o3-mini`, and code-specialized variants) dynamically from upstream.
