---
description: Maintain model catalogs, aliases, pricing tiers, and reasoning flags.
---

# Metadata & Catalog (`catalog`)

AIO Proxy maintains a built-in model metadata catalog for intelligent routing and cost calculation. You can extend or override model capabilities via `catalog`.

```jsonc title="config.jsonc"
{
  "catalog": {
    "models": [
      {
        "id": "deepseek/deepseek-chat",
        "name": "DeepSeek V3",
        "aliases": ["deepseek-v3", "deepseek"],
        "reasoning": false,
        "pricing": {
          "inputTokenMicrocents": 14,
          "outputTokenMicrocents": 28,
        },
      },
    ],
  },
}
```

## Features

- **Aliases**: Map multiple client-side model names to one authoritative model entry.
- **Pricing**: Micro-cent pricing definitions used by Dashboard and OTEL exporters to compute usage costs per token.
- **Reasoning**: Declare whether a model supports reasoning tokens (e.g. `o1`, `o3`), allowing proper message schema conversions.
