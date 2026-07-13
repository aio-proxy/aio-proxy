# Model List And Routing Fix Design

## Problem

API and AI SDK providers may configure `models` without configuring `alias`. The current shared `modelRoutes()` helper ignores `models`, so these model ids are absent from `/v1/models`, dashboard provider summaries, and the runtime router. A configured upstream model is therefore advertised as unavailable and cannot receive requests.

The same gap affects partially aliased providers: once aliases exist, unaliased entries in `models` are also omitted.

## Desired Semantics

`models` defines the provider's upstream model pool. Models are client-accessible by their original id unless an alias target deliberately replaces that original route.

For every enabled provider, client-facing routes are:

1. Every alias key, routed to its configured default target and variants.
2. Every model id in `models` that is not targeted by an alias or alias variant.
3. Every alias or variant target with `preserve: true`, routed under its original model id.

Equivalently, the visible set is:

```text
(models - alias and variant targets) + alias keys + preserve:true targets
```

This produces the following behavior:

| Configuration | Client-facing model ids |
| --- | --- |
| `models: ["a", "b"]`, no alias | `a`, `b` |
| alias `x -> a`, `preserve: false` | `x`, `b` |
| alias `x -> a`, `preserve: true` | `x`, `a`, `b` |
| alias `x -> a`, variant `high -> b`, both not preserved | `x` |

An explicit self-alias remains client-facing because its alias key is added even though its target is removed from the unaliased model set.

## Architecture

Keep the exposure rule in `packages/core/src/router.ts`, next to `modelRoutes()`. A shared helper will compute original model ids that remain directly routable. Both `Router` construction and `modelRoutes()` will consume that helper, so routing, `/v1/models`, and enabled-provider dashboard summaries cannot drift.

The helper will begin with `provider.models`, remove every default and variant target, then add back targets marked `preserve: true`. Alias routes retain their full `AliasConfig`, preserving variant resolution.

Disabled-provider dashboard summaries will also use `modelRoutes()` instead of maintaining a separate alias-or-model fallback rule. Disabled providers remain excluded from runtime routing and `/v1/models`.

## Alternatives Considered

### Normalize models into self-aliases

Provider factories could synthesize self-aliases for every unaliased model. This mutates runtime configuration semantics, overlaps with OAuth alias derivation, and creates more state than the router needs.

### Patch each consumer independently

The server model endpoint and router could each merge `models` and `alias`. This would duplicate the same rule and leave dashboard summaries vulnerable to another mismatch.

The shared core helper is the smallest change that fixes the root cause for every consumer.

## Error And Collision Behavior

Existing validation remains unchanged: configured alias and variant targets must belong to `models` when `models` is present. Existing provider-qualified collision checks also remain in force.

If an alias key equals a directly exposed model id but points elsewhere, the existing router collision error remains the source of truth. Identical self-routes are deduplicated.

## Testing

Tests will cover:

- API and AI SDK providers with only `models` are listed and routable.
- An unaliased model remains visible when another model has an alias.
- A non-preserved default alias target is hidden under its original id.
- A preserved default alias target remains visible under its original id.
- Variant targets follow the same preserve rule.
- `/v1/models` and dashboard `clientModels` reflect the shared route set.
- Disabled providers remain absent from runtime routing and `/v1/models`.

The implementation will follow a red-green cycle: update the existing tests to express the corrected behavior, observe the expected failures, make the minimal core change, and run focused plus package-level verification.
