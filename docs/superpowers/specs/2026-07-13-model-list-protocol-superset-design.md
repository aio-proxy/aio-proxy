# Model List Protocol Superset Design

## Problem

`GET /v1/models` currently concatenates every enabled provider's client-facing routes. If multiple providers expose the same model id, the response contains duplicates with different `owned_by` values.

The response also implements only the OpenAI Models list shape. Anthropic clients expect pagination fields at the top level and additional metadata on every model. OAuth model discovery already supplies human-readable names, but runtime materialization currently reduces those model records to string ids and loses `displayName`.

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
  capabilities: null,
  max_input_tokens: null,
  max_tokens: null,
}
```

The proxy does not currently have release timestamps, capability descriptions, or token limits for general configured providers. Unknown timestamps use Unix epoch values: `created: 0` and `created_at: "1970-01-01T00:00:00Z"`. Unknown capability and token-limit fields are `null`, which the installed Anthropic SDK types allow.

## OAuth Metadata

Runtime OAuth providers gain an optional model metadata map keyed by upstream model id. It preserves the existing OAuth discovery `displayName` without changing the string model ids used by routing.

- ChatGPT OAuth builds the map from `OPENAI_CHATGPT_MODELS`.
- GitHub Copilot builds the map from its cached model records and retains the optional `displayName` already stored during login.
- API and AI SDK providers do not synthesize metadata.

The endpoint iterates `modelRoutes(provider)`. For each route, it exposes `route.alias` as `id` and looks up metadata using `route.modelId`. This allows an OAuth alias to inherit the human-readable name of its upstream target. If the winning provider has no `displayName`, `display_name` falls back to the client-facing id.

## Implementation Boundary

Keep aggregation and response shaping in `packages/server/src/server.ts`, because this is an HTTP representation concern. Continue using the shared core `modelRoutes()` helper so the listed model ids cannot drift from runtime routing.

Extend only the server runtime OAuth type and the two OAuth runtime constructors to carry model metadata. Do not change provider configuration schemas, core router behavior, raw provider model definitions, or add dependencies.

## Error Behavior

The endpoint performs no upstream requests. Missing or incomplete metadata is handled with deterministic fallback values, so one provider's metadata cannot make model listing fail.

Disabled providers remain excluded. An empty provider set returns an empty `data` array, `has_more: false`, and null boundary ids.

## Alternatives Considered

### Return a protocol-specific response based on headers

This would preserve narrow wire shapes but would not satisfy the requirement that one response be the complete superset of both interfaces.

### Add a response-format query parameter

This adds client configuration and multiple output paths without improving compatibility for clients that call `/v1/models` directly.

### Read OAuth auth storage from the route handler

The endpoint could inspect vendor payloads directly, but that would couple HTTP response code to authentication storage and duplicate vendor-specific parsing. Carrying normalized metadata on the runtime provider keeps the route stateless and vendor-neutral.

## Testing

Regression tests will prove that:

- duplicate client model ids collapse to one entry;
- the highest-weight provider supplies `owned_by` and metadata;
- equal weights preserve configuration order;
- OpenAI-only and Anthropic-only provider models both remain in the union;
- every entry contains all required OpenAI and Anthropic fields;
- ChatGPT and GitHub Copilot OAuth display names are preserved;
- an OAuth alias inherits its target model's display name;
- configured providers without metadata fall back to their client-facing id;
- empty results contain valid pagination boundary fields.

Implementation will use a red-green TDD cycle, followed by focused server and OAuth runtime tests, package tests, static checks, and a build.
