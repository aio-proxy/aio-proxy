---
description: Configure OpenAI Responses protocol providers for next-gen stateful conversations, tool calls, and multimodal sessions.
---

# OpenAI Responses Protocol (`openai-response`)

The `openai-response` protocol connects directly to OpenAI's native Responses API (`/v1/responses`).

```jsonc title="config.jsonc"
{
  "providers": {
    "openai-responses": {
      "kind": "api",
      "protocol": "openai-response",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-5", "gpt-4.5-preview"],
    },
  },
}
```

## Features

- **Raw Passthrough**: Client calls to `/v1/responses` are piped with zero-overhead streaming.
- **Cross-Protocol Fallback**: Clients sending standard `/v1/chat/completions` or Anthropic `/v1/messages` are automatically converted to Responses API model messages.
