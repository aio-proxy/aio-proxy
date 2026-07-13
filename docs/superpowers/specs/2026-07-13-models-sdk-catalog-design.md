# Typed models.dev Catalog Design

## Problem

The shared models.dev catalog currently fetches `api.json` directly and manually narrows an `unknown` JSON value. That duplicates types already published by models.dev and leaves `/v1/models` token-limit fields as `null`, even though models.dev publishes context and output limits for every model.

## Decision

Add `@opencode-ai/models@0.0.11` to the workspace catalog and core package. The default catalog loader will call `Models.make().catalog()`, which returns the typed `Catalog` shape containing both provider offers and provider-agnostic model metadata.

Keep the server's existing six-hour promise cache. The SDK client is stateless and performs one request per call, so cache ownership remains in `createModelsDevCatalogTask()` and usage pricing and model listing continue to share one refresh lifecycle.

Do not use the package snapshot. Runtime behavior remains live-data-first, and a failed request continues to degrade to unavailable catalog metadata rather than silently using older bundled data.

## Catalog Interface

Replace the `unknown` fetch seam with a typed `() => Promise<Catalog>` loader so tests can inject catalog fixtures without manual runtime parsing.

Extend `ModelsDevCatalog` with one metadata lookup that returns:

```ts
type ModelsDevModelMetadata = {
  readonly displayName?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
};
```

Pricing lookup remains unchanged. OpenRouter prices still come from `catalog.providers.openrouter`.

Metadata lookup prefers provider-agnostic canonical entries from `catalog.models`, then provider-scoped entries from `catalog.providers` using the existing canonical OpenAI/Anthropic resolution and conflict rules. For token limits:

- `maxInputTokens` uses `limit.input ?? limit.context`;
- `maxTokens` uses `limit.output` when published;
- missing or conflicting metadata remains unresolved.

## Model List Behavior

`GET /v1/models` uses the winning route's alias and upstream model ID to resolve one catalog metadata record. OAuth display names still take precedence over models.dev names, while token limits may be filled from models.dev for OAuth and non-OAuth models alike.

When catalog data is available:

- `max_input_tokens` is the resolved `maxInputTokens` or `null`;
- `max_tokens` is the resolved `maxTokens` or `null`.

`capabilities` remains `null`. models.dev exposes useful generic flags such as reasoning, tool calling, structured output, and modalities, but those do not completely represent Anthropic's `ModelCapabilities` structure. The proxy must not convert unknown capability fields into false support claims.

An empty model list does not trigger a catalog request. Catalog errors do not fail the endpoint.

## Alternatives

### Use `Models.make().providers()`

This is closest to the current `api.json` request but keeps the existing cross-provider canonicalization burden and ignores the package's provider-agnostic metadata.

### Use `@opencode-ai/models/snapshot`

This removes network access but changes freshness semantics and can lag the live database by up to 24 hours.

### Infer Anthropic capabilities

Generic models.dev flags cover only part of Anthropic's capability schema. Returning a partially inferred structure would blur the distinction between unknown and unsupported, so capability enrichment is out of scope.

## Testing

Tests will verify the red-green behavior for:

- typed catalog fixtures supplying canonical display names and token limits;
- `limit.input` taking precedence over `limit.context`;
- `limit.context` acting as the input-limit fallback;
- OpenRouter pricing continuing to resolve from the same catalog;
- `/v1/models` returning token limits for canonical aliases and upstream IDs;
- OAuth display names remaining authoritative while limits come from models.dev;
- catalog failure and missing metadata retaining `null` limits;
- the six-hour shared cache still performing one SDK-backed catalog request.
