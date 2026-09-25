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

## Protocol Matrix

- [OpenAI Responses Protocol](./openai-response.md)
- [OpenAI Compatible Protocol](./openai-compatible.md)
- [Anthropic Messages Protocol](./anthropic.md)
- [Google Gemini Protocol](./gemini.md)
- [OpenAI Images Protocol](./openai-image.md)
- [OpenAI Audio Protocol](./openai-audio.md)
- [OpenAI Video Protocol](./openai-video.md)
- [System One Evaluation Protocol](./typesafe-systemone.md)
