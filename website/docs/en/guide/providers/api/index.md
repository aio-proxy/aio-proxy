---
description: Overview of configuring API providers in AIO Proxy across standard protocols and authentication methods.
---

# API Providers Overview

API Providers represent direct upstream HTTP endpoints accessed via API Keys. AIO Proxy supports seven native protocol families and supports transparent passthrough as well as semantic cross-protocol conversion.

```jsonc title="config.jsonc"
{
  "providers": {
    "provider-id": {
      "kind": "api",
      "protocol": "openai-compatible", // or openai-response, anthropic, gemini, etc.
      "baseURL": "https://api.example.com/v1",
      "apiKey": "{{env.UPSTREAM_API_KEY}}",
      "models": ["gpt-5", "claude-sonnet-4-6"],
      "priority": 100, // Failover tier (higher attempted first)
      "weight": 1, // Traffic weight within the same tier
    },
  },
}
```

## Sync Models with Upstream

Set `syncModels: true` to follow the upstream model list without editing the config. Sync is off by default; a manual `models` list keeps its existing behavior.

```jsonc title="config.jsonc"
{
  "providers": {
    "relay": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://relay.example.com",
      "apiKey": "{{env.RELAY_API_KEY}}",
      "syncModels": true,
      "excludedModels": ["gpt-3.5-turbo"],
    },
  },
}
```

`syncModels: true` and a non-empty `models` list are mutually exclusive. `excludedModels` is only valid with `syncModels: true` and hides exact model IDs, with no glob matching. Aliases may target hidden models.

- **Refresh**: Discovery runs immediately on startup and after config changes, then every hour. Failed refreshes retry after 5 minutes once the list is stale; a failed manual refresh of a fresh list waits until it is stale.
- **Availability**: An upstream outage or empty response keeps the last good list. Before the first successful discovery, only aliases route; config loading does not wait for the network.
- **Upstream changes**: Changing the primary endpoint's `baseURL`, `protocol`, or endpoint form (top-level `protocol`/`baseURL` versus `endpoints`) discards the old list.
- **Discovery scope**: Only the primary endpoint is queried, using its protocol's model-list API. Secondary endpoints are not queried, and discovery never rewrites the config file.

In the Dashboard models section, use the **Manual / Sync with upstream** switch. Sync mode shows the discovered list with per-model hide controls, the last refreshed time, and a refresh button. [AI SDK Providers](../ai-sdk-providers.md) support the same mode when their upstream catalog can be discovered.

## Protocol Matrix

- [OpenAI Responses Protocol](./openai-response.md)
- [OpenAI Compatible Protocol](./openai-compatible.md)
- [Anthropic Messages Protocol](./anthropic.md)
- [Google Gemini Protocol](./gemini.md)
- [OpenAI Images Protocol](./openai-image.md)
- [OpenAI Audio Protocol](./openai-audio.md)
- [OpenAI Video Protocol](./openai-video.md)
- [System One Evaluation Protocol](./typesafe-systemone.md)

- [OpenAI Decisions (`openai-decisions`)](./openai-decisions.md)
