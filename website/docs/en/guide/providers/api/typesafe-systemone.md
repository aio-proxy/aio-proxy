---
description: Configure TypeSafe System One review, security audit, and evaluation pipelines in AIO Proxy.
---

# System One Evaluation Protocol (`typesafe-systemone`)

System One provides structured evaluation, scoring, and classification pipelines (`/v1/systemone/eval`).

```jsonc title="config.jsonc"
{
  "providers": {
    "system-one": {
      "kind": "api",
      "protocol": "typesafe-systemone",
      "baseURL": "https://eval.example.com",
      "apiKey": "{{env.SYSTEM_ONE_KEY}}",
      "models": ["system-one-security-v1"],
    },
  },
}
```

See [AI SDK Providers](../ai-sdk-providers) for using custom driver packages with type-safe evaluations.
