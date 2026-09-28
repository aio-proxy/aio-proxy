---
description: Use any package conforming to the Vercel AI SDK specification as a custom model driver in AIO Proxy.
---

# AI SDK Providers (`kind: "ai-sdk"`)

Beyond built-in HTTP protocols, AIO Proxy supports using any npm package that exports standard [Vercel AI SDK](https://ai-sdk.dev) provider factories as a native model driver.

```jsonc title="config.jsonc"
{
  "providers": {
    "cohere": {
      "kind": "ai-sdk",
      "package": "@ai-sdk/cohere",
      "options": {
        "apiKey": "{{env.COHERE_API_KEY}}",
      },
      "models": ["command-r-plus"],
    },
  },
}
```

## How It Works

1. **Flexible Ecosystem**: Any package exporting a standard `create*` factory function conforming to AI SDK standards can be loaded.
2. **Unified Dispatch**: Inbound requests (OpenAI Responses, Chat Completions, Anthropic Messages) are mapped into universal model messages and executed via the AI SDK driver.
