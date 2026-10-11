---
description: Use any package conforming to the Vercel AI SDK specification as a custom model driver in AIO Proxy.
---

# AI SDK Providers (`kind: "ai-sdk"`)

Beyond built-in HTTP protocols, AIO Proxy supports using any npm package that exports standard [Vercel AI SDK](https://ai-sdk.dev) provider factories as a native model driver.

```jsonc title="config.jsonc"
{
  "providers": {
    "cohere": {
      "kind": "ai-sdk",
      "packageName": "@ai-sdk/cohere",
      "options": {
        "apiKey": "{{env.COHERE_API_KEY}}",
      },
      "models": ["command-r-plus"],
    },
  },
}
```

## How It Works

1. **Flexible Ecosystem**: Any package exporting a standard `create*` factory function conforming to AI SDK standards can be loaded.
2. **Unified Dispatch**: Inbound requests (OpenAI Responses, Chat Completions, Anthropic Messages) are mapped into universal model messages and executed via the AI SDK driver.

## Sync Models with Upstream

Set `syncModels: true` instead of maintaining a manual `models` list. Discovery uses the package instance's `listModels` method when available, otherwise an OpenAI-compatible `/models` endpoint at `options.baseURL`. Without either, the Provider reports `CATALOG_UNSUPPORTED`.

```jsonc title="config.jsonc"
{
  "providers": {
    "relay": {
      "kind": "ai-sdk",
      "packageName": "@ai-sdk/openai-compatible",
      "options": {
        "name": "relay",
        "baseURL": "https://relay.example.com/v1",
        "apiKey": "{{env.RELAY_API_KEY}}",
      },
      "syncModels": true,
      "excludedModels": ["gpt-3.5-turbo"],
    },
  },
}
```

Sync is off by default and is mutually exclusive with a non-empty `models` list. `excludedModels` is only valid with `syncModels: true`; it hides exact model IDs without glob matching. Aliases may target hidden models, and manual `models` lists work as before.

Discovery runs immediately on startup and after config changes, then every hour. Failed refreshes retry after 5 minutes once the list is stale; an outage or empty response keeps the last good list. Before the first successful discovery, only aliases route. Changing `packageName` or `options.baseURL` discards the old list. Discovery never rewrites the config file.

The Dashboard models section offers a **Manual / Sync with upstream** switch, per-model hide controls, the last refreshed time, and a refresh button. [API Providers](./api/index.md) also support model sync.
