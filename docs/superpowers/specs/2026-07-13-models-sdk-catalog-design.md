# Typed models.dev Catalog Design

## Problem

The shared models.dev catalog currently fetches `api.json` directly and manually narrows an `unknown` JSON value. That duplicates types already published by models.dev and leaves `/v1/models` token-limit fields as `null`, even though models.dev publishes context and output limits for every model.

## Decision

Add `@opencode-ai/models@0.0.11` to the workspace catalog and core package. The default catalog loader will call `Models.make().catalog()`, which returns the typed `Catalog` shape containing both provider offers and provider-agnostic model metadata. Add `date-fns@^4.4.0` as a direct server dependency for release-date parsing and Unix timestamp conversion.

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
  readonly capabilities?: ModelsDevCapabilities;
  readonly releaseDate?: string;
};
```

`ModelsDevCapabilities` is an explicit subset of Anthropic's `ModelCapabilities` containing only `effort`, `image_input`, `pdf_input`, `structured_outputs`, and `thinking`. The model-list item type replaces the SDK's full `capabilities` field with this subset-or-null type; it does not claim that the partial object is a complete Anthropic capability record.

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
- `created_at` parses models.dev `release_date` (`YYYY-MM-DD`) at UTC midnight with date-fns `parseISO`, validates it with `isValid`, and serializes the parsed date with `toISOString()`;
- `created` uses date-fns `getUnixTime` for the same parsed instant.

If `release_date` is missing or malformed, both timestamp fields retain their existing Unix epoch fallback. The OpenAI and Anthropic timestamp fields must always describe the same instant. Do not implement custom calendar parsing or manual Unix timestamp arithmetic.

When catalog data supplies the relevant signals, `capabilities` contains only fields that can be mapped without inventing support:

- `effort` comes from the `effort` reasoning option and its accepted values;
- `image_input` and `pdf_input` come from input modalities;
- `structured_outputs` comes from `structured_output`;
- `thinking.supported` comes from `reasoning`;
- `thinking.types.adaptive` comes from the `effort` reasoning option;
- `thinking.types.enabled` comes from `budget_tokens` or `toggle` reasoning options.

The response omits `batch`, `citations`, `code_execution`, and `context_management` because models.dev does not publish those signals. It must not emit `supported: false` for unknown capabilities. If no trustworthy catalog metadata is available, `capabilities` remains `null`.

An empty model list does not trigger a catalog request. Catalog errors do not fail the endpoint.

## Alternatives

### Use `Models.make().providers()`

This is closest to the current `api.json` request but keeps the existing cross-provider canonicalization burden and ignores the package's provider-agnostic metadata.

### Use `@opencode-ai/models/snapshot`

This removes network access but changes freshness semantics and can lag the live database by up to 24 hours.

### Return a complete Anthropic capability object

models.dev does not publish enough information for `batch`, `citations`, `code_execution`, or `context_management`. Filling those required SDK fields with `supported: false` would confuse unknown with unsupported, so the response intentionally exposes only the reliable subset.

## Testing

Tests will verify the red-green behavior for:

- typed catalog fixtures supplying canonical display names and token limits;
- `limit.input` taking precedence over `limit.context`;
- `limit.context` acting as the input-limit fallback;
- capability subsets mapping effort values, image/PDF modalities, structured output, and thinking modes;
- unavailable capability signals being omitted rather than reported as unsupported;
- release dates producing matching RFC 3339 and Unix-second timestamp fields;
- missing or malformed release dates retaining the epoch fallback;
- OpenRouter pricing continuing to resolve from the same catalog;
- `/v1/models` returning token limits for canonical aliases and upstream IDs;
- OAuth display names remaining authoritative while limits come from models.dev;
- catalog failure and missing metadata retaining `null` limits;
- the six-hour shared cache still performing one SDK-backed catalog request.
