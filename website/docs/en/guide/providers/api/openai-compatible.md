---
description: Connect OpenAI chat completions compatible endpoints (DeepSeek, Groq, Moonshot, Ollama, vLLM, etc.).
---

# OpenAI-Compatible Protocol (`openai-compatible`)

The `openai-compatible` protocol connects to any service adhering to the OpenAI `/v1/chat/completions` specification.

```jsonc title="config.jsonc"
{
  "providers": {
    "deepseek": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "{{env.DEEPSEEK_API_KEY}}",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "priority": 100,
    },
  },
}
```

## Features

- Full streaming SSE support.
- Translates reasoning tokens (`reasoning_content`) for models like DeepSeek R1 into standard thought blocks.
