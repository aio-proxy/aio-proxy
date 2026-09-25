---
description: Connect Google Gemini API upstreams natively with multimodal content and safety settings.
---

# Google Gemini Protocol (`gemini`)

The `gemini` protocol connects to Google's native Gemini API (`/v1beta/models/*:generateContent`).

```jsonc title="config.jsonc"
{
  "providers": {
    "google-gemini": {
      "kind": "api",
      "protocol": "gemini",
      "baseURL": "https://generativelanguage.googleapis.com",
      "apiKey": "{{env.GEMINI_API_KEY}}",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
  },
}
```

## Features

- Supports `x-goog-api-key` header and query parameter authentication.
- Converts between OpenAI messages and Gemini `contents` multimodal blocks.
