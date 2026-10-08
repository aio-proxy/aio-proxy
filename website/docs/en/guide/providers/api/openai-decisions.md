---
title: OpenAI Decisions
---

# OpenAI Decisions evaluation protocol (`openai-decisions`)

`POST /v1/decisions` evaluates text or inline base64 images using `predicate`, `choice`, and `score` questions. See the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/decisions). OpenAI currently supports `gpt-6-luna`; aio-proxy resolves configured models and aliases without hardcoding that restriction.

```json
{
  "providers": {
    "openai-judge": {
      "kind": "api",
      "protocol": "openai-decisions",
      "baseURL": "https://api.openai.com",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-6-luna"]
    }
  }
}
```

You can also add `openai-decisions` to a Provider's `endpoints` alongside other protocols. The legacy `protocol`/`baseURL` pair takes an origin; `endpoints[].baseURL` takes an SDK base path, such as `https://api.openai.com/v1`.

```bash
curl http://127.0.0.1:9317/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6-luna",
    "input": "I was charged twice.",
    "questions": [{
      "type": "choice",
      "name": "department",
      "instructions": "Which department should handle this?",
      "choices": [
        {"value": "billing", "description": "Payments and refunds"},
        {"value": "other", "description": "Other requests"}
      ]
    }]
  }'
```

## Shared evaluation pipeline

Decisions and SystemOne share the `evaluation` capability, model routing, Provider priority/weight, and fallback:

- Matching native endpoints use raw passthrough, rewriting only the resolved model and preserving extensions, distributions, and refusals.
- Decisions can use SystemOne/AI SDK evaluation providers: `predicate` maps to `noul`, choice values retain their original types, and score levels retain labels and descriptions. API SystemOne conversion requires an installed `@ai-sdk/typesafe-ai` package.
- SystemOne can use native Decisions endpoints. Structured `state` becomes JSON text evidence; valid Decisions user messages retain multimodal inputs.
- Converted Decisions choice/score answers require complete distributions and confidence. Unsupported results fall back to the next Provider. SystemOne cannot represent a Decisions refusal, so that candidate also falls back.

The endpoint is non-streaming. Images must use inline `data:image/...;base64,...` URLs; hosted HTTP(S) URLs and `file_id` inputs are unsupported. Named questions must have unique names.

Native Decisions usage records input tokens and zero output tokens. Converted calls record the actual upstream evaluation usage. Cost estimation uses the project's configured-price precedence; evaluation channels can have their own price overrides.
