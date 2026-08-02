# Reasoning Effort Normalization Design

## Goal

Stop rejecting legitimate reasoning-effort values at ingress, and normalize the
requested effort against the effort levels each selected upstream model actually
advertises. The immediate trigger is Claude Code ultracode sending
`output_config.effort: "xhigh"`, which today fails with
`400 Invalid Anthropic Messages request: ... at output_config.effort` because the
Anthropic ingress schema hard-codes `z.enum(['low','medium','high','max'])` — a
set that contradicts `toAnthropicCapabilities`, which already advertises `xhigh`.

This design is the "normalize + capability downgrade" approach (CLIProxyAPI-style
归一化+能力降级): ingress accepts any effort string, and every candidate attempt
clamps the effort down to the highest level that candidate's model supports.

## Product Decisions

- Ingress accepts any reasoning-effort string. Validating effort against a fixed
  enum at parse time is wrong because the valid set is per-upstream-model, not
  global, and new levels appear over time.
- Effort is normalized per candidate, not once per request. Each candidate may be
  a different upstream model with a different supported set, so normalization runs
  inside the candidate loop against `candidate.modelId`.
- Normalization clamps down the ordered effort ladder to the nearest supported
  level ≤ the requested level. It never raises effort.
- The effort ladder is: `none < minimal < low < medium < high < xhigh < max`.
- A small alias map folds common spellings before clamping: `x-high`, `x_high`,
  `extrahigh` → `xhigh`.
- When the supported set is empty — the model is not in models.dev, or the
  capability lookup fails — effort is passed through unchanged. A models.dev
  outage degrades to today's behavior; it never turns into a 500 and never
  silently weakens a request for a model that does support the level.
- Normalization applies to all inbound protocols: Anthropic Messages, OpenAI
  Completions, OpenAI Responses, and Gemini generateContent.
- Normalization applies to both dispatch paths: raw API passthrough and AI SDK
  model invocation.
- Each protocol adapter rewrites effort in its own request shape. The candidate
  loop stays free of provider-kind and protocol branching, consistent with the
  Protocol Routing Architecture.
- The `variant` key keeps using the client's requested (raw) effort, unchanged.
  `variant()` feeds `router.resolve(model, variantKey)`, which selects the target
  upstream model via `resolveAliasTarget(config, variantKey)` — it runs before any
  candidate is chosen, so the per-candidate model (and thus its supported set) is
  not yet known. Normalization is strictly a per-candidate downstream concern and
  must not touch routing/variant selection, or it would create a circular
  dependency (pick a model to normalize against, but the model is picked by the
  effort). Effort-based alias routing continues to key on the original request.

## Non-goals

- Raising effort above what the client requested.
- Guessing capabilities when models.dev has no entry (we pass through, we do not
  invent a default ceiling).
- Adding a new configuration surface for effort. Normalization is automatic and
  driven entirely by advertised model capabilities.
- Changing how effort is transported to upstream providers beyond substituting a
  normalized value in the existing field.
- Token-count endpoints participating in effort normalization. They do not invoke
  the model and pass an empty supported set.

## The Effort Ladder and Where Effort Lives

Ordered ladder (index = rank):

```
none  minimal  low  medium  high  xhigh  max
```

`normalizeEffort(effort, supported)`:

1. Lowercase and apply the alias map (`x-high`/`x_high`/`extrahigh` → `xhigh`).
2. If `supported` is empty, return the aliased effort unchanged.
3. If the effort is already in `supported`, return it.
4. Otherwise walk down the ladder from the requested rank and return the first
   lower level present in `supported`.
5. If nothing lower is supported, return the lowest supported level.
6. Unknown strings not on the ladder pass through unchanged (empty support) or
   are treated as top-of-ladder when clamping against a known set.

Effort is carried differently per protocol:

| Protocol            | Raw body field                              | Model-invocation field                                   | `variant` key        |
| ------------------- | ------------------------------------------- | -------------------------------------------------------- | -------------------- |
| Anthropic Messages  | `output_config.effort`                      | `settings.providerOptions.aioProxy.thinking.effort`      | `output_config.effort` |
| OpenAI Completions  | `reasoning_effort`                          | `settings.reasoning` (AI SDK)                            | `reasoning_effort`   |
| OpenAI Responses    | `reasoning.effort`                          | `settings.reasoning` (AI SDK)                            | `reasoning.effort`   |
| Gemini              | `generationConfig.thinkingConfig.thinkingLevel` | `settings.reasoning` (AI SDK)                        | `thinkingLevel`      |

The AI SDK `settings.reasoning` field is the shared normalized representation for
the three non-Anthropic protocols; Anthropic uses its own
`providerOptions.aioProxy.thinking.effort`.

## Capability Source

`resolveSupportedEfforts(modelId)` lives in the server pipeline and returns a
`ReadonlySet<string>`:

```
modelEffortValues((await getModels([modelId]))[modelId])
```

`modelEffortValues(model)` mirrors `server/.../model-capabilities.ts`:
`model.reasoning_options?.find(o => o.type === 'effort')?.values ?? []`, narrowed
at runtime so it accepts `unknown`. Any thrown error or missing model yields an
empty set (pass-through).

`getModels` is async with an LRU + file cache. Resolving per candidate inside the
attempt loop is acceptable: the first lookup warms the cache, subsequent lookups
for the same `modelId` are cache hits. The resolve is awaited once per candidate
attempt (alongside the upstream call it precedes), not per retry, and never blocks
on a cold path more than the existing model-capabilities lookups already do.

## Adapter Interface Change

`packages/core/src/protocol/adapter.ts` gains one parameter on each effort-bearing
method. Both keep `context`/`targetProtocol` in their existing final position:

```
rawRequest: (raw, request, resolvedModel, supportedEfforts, context) => Promise<Request>
modelInvocationForTarget: (invocation, targetProtocol, supportedEfforts) => ModelInvocation
```

`supportedEfforts: ReadonlySet<string>`. This is the only interface change. Every
adapter and every test call site updates to pass the set (tests pass `new Set()`
unless exercising normalization). The Gemini adapter's `rawRequest` currently has
`context` in the 4th slot; inserting `supportedEfforts` before it shifts `context`
to the 5th slot — this must be updated deliberately to avoid the argument-order
bug where `context` lands in the `supportedEfforts` position.

## Shared Helper Module

`packages/core/src/protocol/reasoning-effort/`

- `index.ts` — exports `normalizeEffort` and `modelEffortValues` only.
- `reasoning-effort.ts` — the ladder, alias map, `normalizeEffort`,
  `modelEffortValues`.
- `reasoning-effort.test.ts` — colocated behavior tests: alias folding, clamp
  down to nearest supported, empty-set pass-through, already-supported identity,
  clamp-to-lowest, unknown-string handling.

The module is protocol-agnostic and reusable by all four adapters.

## Per-Protocol Rewrite

Each adapter applies normalization in both of its paths:

- Raw path (`rawRequest`): rewrite the protocol's own effort field in the JSON
  body using the normalized value, folding into the existing model-rewrite so a
  clone is still returned when nothing changes.
- Model path (`modelInvocationForTarget`): rewrite the effort in the invocation
  settings — Anthropic rewrites `providerOptions.aioProxy.thinking.effort`; the
  other three rewrite `settings.reasoning`.

`variant` is unchanged and still returns the client's requested (raw) effort: it
is consumed by `router.resolve` for effort-based alias/model selection before any
candidate exists, so it cannot and must not carry a per-candidate normalized value.

## Ingress and Type Changes

- `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`:
  `OutputConfigSchema` effort becomes `z.string().optional()` (schema stays
  `.loose()`).
- `packages/core/src/protocol/anthropic-thinking.ts`: the adaptive-thinking
  effort type widens from `'low'|'medium'|'high'|'max'` to `string`. Presence/
  absence validation is unchanged.
- OpenAI Completions/Responses and Gemini ingress already accept `xhigh`; no
  ingress relaxation is required there, only the per-candidate downgrade wiring.

## Call-Site Wiring (server pipeline)

- `packages/server/src/routes/pipeline/attempt/effort-capability.ts` (new):
  `resolveSupportedEfforts(modelId)`.
- `raw.ts`: resolve the supported set for `candidate.modelId` and pass it to
  `adapter.rawRequest(...)` before `context`.
- `model-prepare.ts` (`resolveInvocation`): resolve the set for `candidate.modelId`
  and pass it to `adapter.modelInvocationForTarget(...)`.
- `token-count.ts`: pass `new Set()` to `modelInvocationForTarget` (no model call).

## Failure Behavior

- models.dev lookup failure or missing model → empty set → effort passes through
  unchanged. No request fails because capabilities could not be resolved.
- Normalization is pure and side-effect-free; it cannot fail a candidate on its
  own. Provider fallback semantics are unchanged.

## Testing

- `reasoning-effort.test.ts`: unit coverage of the normalization function
  (ladder, aliases, empty set, clamp behavior).
- Adapter tests updated to pass a supported set and assert:
  - `xhigh` requested against a `{low,medium,high}` model clamps to `high` in both
    the raw body and the model invocation.
  - `xhigh` requested against a model that supports `xhigh` is preserved.
  - Empty supported set passes the requested effort through unchanged.
  - `variant` still returns the client's raw effort (unaffected by normalization).
- A routing/regression test proving an inbound Anthropic request with
  `output_config.effort: "xhigh"` no longer 400s and is downgraded per candidate.

## Release

Changeset targets `@aio-proxy/core` and `aio-proxy` (core fix surfaced through the
product CLI package), summary prefixed `core:`. Bump level matched between the two.
