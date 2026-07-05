# Model Alias Config Design

## Goal

Split provider model configuration so `models` is only the upstream model pool, while `alias` owns every client-facing model name and future alias policy.

## Config Shape

```json
{
  "models": ["gemini-3.5-flash", "gemini-3.5-flash-medium", "gemini-3.5-flash-low"],
  "alias": {
    "gemini-3.5-flash": "gemini-3.5-flash",
    "gemini-3-flash-agent": {
      "model": "gemini-3.5-flash",
      "preserve": true,
      "variants": {
        "medium": {
          "model": "gemini-3.5-flash-medium",
          "preserve": true
        },
        "low": "gemini-3.5-flash-low"
      }
    }
  }
}
```

`models` is `string[]` and lists upstream model ids available through the provider.

`alias` is `Record<string, string | AliasConfig>`. The record key is the model id clients send to aio-proxy.

`alias.*.model` is the default upstream model id.

An alias may use string shorthand:

```json
{
  "gemini-3.5-flash": "gemini-3.5-flash"
}
```

This parses the same as:

```json
{
  "gemini-3.5-flash": {
    "model": "gemini-3.5-flash"
  }
}
```

`alias.*.preserve` exposes `alias.*.model` under its original model id as well as the alias key. It defaults to `false`.

`alias.*.variants` is optional metadata for future mode-based routing, such as thinking effort. Each variant value uses the same target shape as the alias itself, except nested `variants` are not needed.

A variant may use string shorthand:

```json
{
  "low": "gemini-3.5-flash-low"
}
```

This parses the same as:

```json
{
  "low": {
    "model": "gemini-3.5-flash-low"
  }
}
```

The first implementation validates and preserves variants, but routing uses only `alias.*.model`.

## Routing

The router registers these client-facing ids for each enabled provider:

1. Every `alias` key routes to `alias[key].model`.
2. If an alias has `preserve: true`, `alias[key].model` also routes to itself.

`models` entries do not route by themselves. This keeps upstream availability separate from user-facing exposure.

Provider-qualified lookup keeps the same behavior: `providerId/clientModelId` resolves only that provider's route.

## Validation

Each provider schema accepts:

```ts
models?: string[];
alias?: Record<string, string | {
  model: string;
  preserve?: boolean;
  variants?: Record<string, string | {
    model: string;
    preserve?: boolean;
  }>;
}>;
```

The Zod schema should reuse a shared alias target schema for `alias.*` and `alias.*.variants.*`. String shorthand should be normalized to `{ model: value, preserve: false }` during parsing so the rest of the code handles one output shape.

The schema rejects empty strings. Cross-field validation should reject alias targets and variant targets that are not listed in `models` when `models` is present.

## Migration

Existing `models: ["id"]` configs no longer expose routes unless an alias is added. To preserve current behavior, migrate each string model to a self-alias:

```json
{
  "models": ["gpt-5-mini"],
  "alias": {
    "gpt-5-mini": {
      "model": "gpt-5-mini"
    }
  }
}
```

Existing `models: [{ "alias": "mini", "id": "gpt-5-mini" }]` migrates to:

```json
{
  "models": ["gpt-5-mini"],
  "alias": {
    "mini": {
      "model": "gpt-5-mini"
    }
  }
}
```

If the old object also exposed the original model through a separate string entry, set `preserve: true`.

## Implementation Notes

Replace `ModelEntry` with a plain model id schema plus `AliasConfigSchema`.

Keep route construction centralized in `Router`; route files should not learn alias rules.

Update `/v1/models` to list alias keys and preserved original ids, not raw `models`.

Update OAuth model sync to write `models: string[]` plus self-alias entries when preserving original names is desired. Transport metadata should stay internal to OAuth runtime data, not leak into the public alias config shape.

## Tests

Add schema tests for string-only `models`, nested `alias`, `preserve`, `variants`, and invalid alias targets.

Update router tests for alias-only exposure, preserved original ids, provider-qualified aliases, duplicate aliases, and disabled providers.

Update server `/v1/models` tests so exposed models come from `alias`, not raw `models`.
