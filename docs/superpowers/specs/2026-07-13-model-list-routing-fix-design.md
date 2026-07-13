# Model List And Routing Fix Design

## Problem

API and AI SDK providers may configure `models` without configuring `alias`. The current shared `modelRoutes()` helper ignores `models`, so these model ids are absent from `/v1/models`, dashboard provider summaries, and the runtime router. A configured upstream model is therefore advertised as unavailable and cannot receive requests.

The same gap affects partially aliased providers: once aliases exist, unaliased entries in `models` are also omitted.

## Desired Semantics

For API and AI SDK providers, `models` defines the upstream model pool and every entry remains client-accessible. An alias key adds a client-facing route, or overrides the self-route when the key is also a configured model id.

Their client-facing routes are:

1. Every alias key, routed to its configured default target and variants.
2. Every model id in `models` that is not shadowed by a same-named alias key, routed to itself.
3. Every alias or variant target with `preserve: true` that is not already exposed by `models` or an alias key, routed under its original model id.

Equivalently, the visible id set is:

```text
models + alias keys + preserve:true targets
```

When the same id exists in both `models` and `alias`, the alias route wins.

This produces the following behavior:

| Configuration | Client-facing model ids |
| --- | --- |
| `models: ["a", "b"]`, no alias | `a`, `b` |
| alias `x -> a`, `preserve: false` | `x`, `a`, `b` |
| alias `x -> a`, `preserve: true` | `x`, `a`, `b` |
| `models: ["old", "new"]`, alias `old -> new` | `old`, `new`; both route to `new` |
| alias `x -> a`, variant `high -> b`, both not preserved | `x`, `a`, `b` |

OAuth providers keep their existing derived-alias behavior; this change does not expose OAuth runtime model metadata independently of those aliases.

## Architecture

Keep the exposure rule in `packages/core/src/router.ts`, next to `modelRoutes()`. A shared helper will compute original model ids that remain directly routable. Both `Router` construction and `modelRoutes()` will consume that helper, so routing, `/v1/models`, and enabled-provider dashboard summaries cannot drift.

For API and AI SDK providers, the helper begins with `provider.models`, removes ids shadowed by alias keys, then adds targets marked `preserve: true`. Alias routes retain their full `AliasConfig`, preserving variant resolution. OAuth providers begin with no direct model ids and continue to expose their derived alias routes.

Disabled-provider dashboard summaries will also use `modelRoutes()` instead of maintaining a separate alias-or-model fallback rule. Disabled providers remain excluded from runtime routing and `/v1/models`.

## Alternatives Considered

### Normalize models into self-aliases

Provider factories could synthesize self-aliases for every unaliased model. This mutates runtime configuration semantics, overlaps with OAuth alias derivation, and creates more state than the router needs.

### Patch each consumer independently

The server model endpoint and router could each merge `models` and `alias`. This would duplicate the same rule and leave dashboard summaries vulnerable to another mismatch.

The shared core helper is the smallest change that fixes the root cause for every consumer.

## Error And Collision Behavior

Existing validation remains unchanged: configured alias and variant targets must belong to `models` when `models` is present. Existing provider-qualified collision checks also remain in force.

If an alias key equals a configured model id, the alias replaces that model's self-route. Existing validation still rejects an alias that conflicts with a separately preserved original model id. Identical self-routes are deduplicated.

## Testing

Tests will cover:

- API and AI SDK providers with only `models` are listed and routable.
- Configured default and variant targets remain routable under their original ids even when `preserve` is false.
- An alias key overrides a same-named configured model while the target model remains routable.
- A preserved target not otherwise configured remains visible under its original id.
- OAuth derived-alias routing remains unchanged.
- `/v1/models` and dashboard `clientModels` reflect the shared route set.
- Disabled providers remain absent from runtime routing and `/v1/models`.

The implementation will follow a red-green cycle: update the existing tests to express the corrected behavior, observe the expected failures, make the minimal core change, and run focused plus package-level verification.
