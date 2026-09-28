---
description: Configure OpenAI Video and Sora video generation upstreams.
---

# OpenAI Video Protocol (`openai-video`)

Connects to video generation and remix endpoints.

```jsonc title="config.jsonc"
{
  "providers": {
    "video-service": {
      "kind": "api",
      "protocol": "openai-video",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["sora-1.0"],
    },
  },
}
```
