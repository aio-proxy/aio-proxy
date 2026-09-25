---
description: Configure OpenAI DALL-E and image generation/editing endpoints.
---

# OpenAI Images Protocol (`openai-image`)

Connects to image generation and editing endpoints (`/v1/images/generations`, `/v1/images/edits`).

```jsonc title="config.jsonc"
{
  "providers": {
    "image-service": {
      "kind": "api",
      "protocol": "openai-image",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["dall-e-3"],
    },
  },
}
```
