# Model List Protocol Superset Design

## Problem

`GET /v1/models` currently concatenates every enabled provider's client-facing routes. If multiple providers expose the same model id, the response contains duplicates with different `owned_by` values.

The response also implements only the OpenAI Models list shape. Anthropic clients expect pagination fields at the top level and additional metadata on every model. OAuth model discovery already supplies human-readable names, but runtime materialization currently reduces those model records to string ids and loses `displayName`. Non-OAuth providers can reuse the models.dev catalog that the server already fetches for usage pricing instead of always falling back to a raw model id.

## Desired Behavior

`GET /v1/models` returns one response that is a structural superset of the OpenAI and Anthropic Models list responses.

The model collection follows these rules:

1. Include every client-facing route from every enabled provider, regardless of provider kind or protocol.
2. Aggregate entries by the client-facing model `id`.
3. When multiple providers expose the same id, keep the first provider in routing priority order. Configuration parsing already orders providers by descending `weight` and preserves configuration order for equal or absent weights, so the selected `owned_by` matches routing priority.
4. Use metadata from the selected provider and selected route. Do not merge metadata from a lower-priority provider into the winning entry.

## Response Shape

The top-level object contains the union of both list response shapes:

```ts
{
  object: "list",
  data: ModelEntry[],
  has_more: false,
  first_id: string | null,
  last_id: string | null,
}
```

`first_id` and `last_id` identify the first and last returned model. Both are `null` for an empty list. The endpoint returns the complete collection in one response, so `has_more` is always `false`.

Each model entry contains the union of OpenAI `Model` and Anthropic `ModelInfo`:

```ts
{
  id: string,
  object: "model",
  created: number,
  owned_by: string,
  type: "model",
  display_name: string,
  created_at: string,
  capabilities: ModelsDevCapabilities | null,
  max_input_tokens: number | null,
  max_tokens: number | null,
}
```

When models.dev metadata is available, the proxy fills release timestamps, token limits, and the reliable capability subset documented in [Typed models.dev Catalog Design](./2026-07-13-models-sdk-catalog-design.md). Unknown timestamps use Unix epoch values: `created: 0` and `created_at: "1970-01-01T00:00:00Z"`. Unknown capability and token-limit fields remain `null`.

## Model Display Names

Display-name resolution is provider-aware and follows this order:

1. For OAuth providers, prefer vendor metadata for the route's upstream `modelId`.
2. Query the cached models.dev catalog by the client-facing alias first, then by the upstream `modelId`; OAuth vendor names remain authoritative when present.
3. If no trustworthy metadata is available, use the client-facing model id.

### OAuth Metadata

Runtime OAuth providers gain an optional model metadata map keyed by upstream model id. It preserves the existing OAuth discovery `displayName` without changing the string model ids used by routing.

- ChatGPT OAuth builds the map from `OPENAI_CHATGPT_MODELS`.
- GitHub Copilot builds the map from its cached model records and retains the optional `displayName` already stored during login.
- API and AI SDK providers do not synthesize metadata.

The endpoint iterates `modelRoutes(provider)`. For each OAuth route, it exposes `route.alias` as `id` and looks up vendor metadata using `route.modelId`. This allows an OAuth alias to inherit the human-readable name of its upstream target.

### models.dev Metadata

Generalize the existing six-hour models.dev price catalog task into one cached catalog task that serves both usage pricing and display-name lookup. `/v1/models` and usage capture share the same fetch result and refresh lifecycle; the model-list endpoint must not introduce a second models.dev request path.

OpenRouter publishes complete model records under qualified IDs. Lookup first uses an exact OpenRouter ID, then the existing unique bare-ID index produced by splitting qualified IDs on `/`. If OpenRouter does not contain the model, recognized OpenAI and Anthropic IDs use their canonical provider entry; other models use metadata only when matching providers agree. Conflicting fallback metadata remains unresolved instead of being chosen arbitrarily.

Lookup checks the client-facing alias before the upstream id. This lets an API provider expose a canonical alias such as `claude-opus-4-6` for an opaque upstream target while still receiving the catalog name `Claude Opus 4.6`.

## Implementation Boundary

Keep aggregation and response shaping in `packages/server/src/server.ts`, because this is an HTTP representation concern. Continue using the shared core `modelRoutes()` helper so the listed model ids cannot drift from runtime routing.

Extend the core models.dev catalog with display-name lookup while preserving its existing pricing interface. Expose the same cached catalog task to the model-list route and usage capture. The route awaits the catalog task, but catalog failure degrades to OAuth metadata or the model id rather than failing the request. The catalog task remains injectable for hermetic server tests.

The server runtime OAuth type and the two OAuth runtime constructors carry vendor model metadata. Provider configuration schemas, core router behavior, and raw provider model definitions remain unchanged. The typed models.dev SDK and date-fns additions are isolated to catalog loading and release-date conversion.

## Error Behavior

The endpoint may trigger the shared cached models.dev task. Fetch or parse failure is already treated as unavailable catalog data and must not fail `/v1/models`. Missing, conflicting, or incomplete metadata is handled with deterministic fallback values, so one provider's metadata cannot make model listing fail.

Disabled providers remain excluded. An empty provider set returns an empty `data` array, `has_more: false`, and null boundary ids.

## Alternatives Considered

### Return a protocol-specific response based on headers

This would preserve narrow wire shapes but would not satisfy the requirement that one response be the complete superset of both interfaces.

### Add a response-format query parameter

This adds client configuration and multiple output paths without improving compatibility for clients that call `/v1/models` directly.

### Read OAuth auth storage from the route handler

The endpoint could inspect vendor payloads directly, but that would couple HTTP response code to authentication storage and duplicate vendor-specific parsing. Carrying normalized metadata on the runtime provider keeps the route stateless and vendor-neutral.

### Fetch models.dev separately for model listing

This would duplicate network traffic and cache policy. Sharing the existing catalog task keeps one source, one six-hour cache, and one failure path.

## Testing

Regression tests will prove that:

- duplicate client model ids collapse to one entry;
- the highest-weight provider supplies `owned_by` and metadata;
- equal weights preserve configuration order;
- OpenAI-only and Anthropic-only provider models both remain in the union;
- every entry contains all required OpenAI and Anthropic fields;
- ChatGPT and GitHub Copilot OAuth display names are preserved;
- an OAuth alias inherits its target model's display name;
- exact and unique-bare OpenRouter metadata wins when available;
- OpenAI and Anthropic ids fall back to their canonical models.dev provider metadata;
- other non-OAuth aliases and model ids use unambiguous models.dev names;
- limits, partial capabilities, and release timestamps come from the same selected metadata record;
- conflicting fallback or missing models.dev names fall back to the client-facing id;
- models.dev failure still returns a valid model list;
- model listing and usage pricing share one cached catalog task;
- empty results contain valid pagination boundary fields.

Implementation will use a red-green TDD cycle, followed by focused server and OAuth runtime tests, package tests, static checks, and a build.
