---
'aio-proxy': patch
'@aio-proxy/server': patch
'@aio-proxy/types': patch
---

Fix model-metadata projection and billing gaps:

- `/v1/models` now reflects per-provider config metadata overrides — capabilities,
  `limit.output` (max tokens), and modalities — not just the display name and
  context window. Metadata inherited via `extend` surfaces the same way.
- `max_input_tokens` now reports the model's maximum input tokens
  (`limit.input`) rather than the total context window, so a model whose context
  window exceeds its input limit no longer over-advertises its input capacity.
- A flat per-request fee (`cost.request`) is now billed on a successful response
  that carries no token usage, instead of being silently dropped.
- The generated config JSON Schema references the models.dev model-id enum for
  `metadata.extend`, so editors can autocomplete and validate the slug.
