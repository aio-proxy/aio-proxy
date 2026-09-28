---
description: Connect Anthropic Messages API upstreams, supporting prompt caching, system blocks, thinking tags, and tool use.
---

# Anthropic Messages Protocol (`anthropic`)

The `anthropic` protocol connects to Anthropic's native `/v1/messages` endpoint.

```jsonc title="config.jsonc"
{
  "providers": {
    "anthropic-direct": {
      "kind": "api",
      "protocol": "anthropic",
      "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "{{env.ANTHROPIC_API_KEY}}",
      "models": ["claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"],
    },
  },
}
```

## Features

- Native support for Anthropic headers (`anthropic-version`, `anthropic-beta`).
- Seamless translation for tools, thought blocks, and cache markers (`cache_control`).
