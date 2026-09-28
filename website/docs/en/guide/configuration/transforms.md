---
description: Fine-grained controls over request rewriting, model mapping, default parameters, and response headers.
---

# Request & Response Transforms

Transforms allow you to adjust incoming requests, inject default hyperparameters, or modify response payloads without modifying client code.

```jsonc title="config.jsonc"
{
  "router": {
    "models": {
      "gpt-5": {
        "params": {
          "temperature": 0.7,
          "max_tokens": 4096,
        },
        "overrides": {
          "openai": {
            "model": "gpt-5-turbo",
          },
        },
      },
    },
  },
}
```

## Practical Scenarios

1. **Parameter Clamping**: Ensure consistent temperature or enforce context length limits across different clients.
2. **Model Rewriting**: Expose a unified model name (`gpt-5`) externally, while mapping to provider-specific model IDs internally (`gpt-5-2026-preview`).
3. **Response Headers**: Inject custom debugging headers or trace IDs into client responses.
