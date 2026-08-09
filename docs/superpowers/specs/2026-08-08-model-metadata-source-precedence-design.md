# Model Metadata Source Precedence Design

## Status and scope

This design resolves [issue #169](https://github.com/aio-proxy/aio-proxy/issues/169). It supersedes only the source-precedence and token-limit projection rules in the earlier provider-metadata and Codex-client-model specs.

The work belongs in a future model-metadata PR. It is intentionally separate from [PR #170](https://github.com/aio-proxy/aio-proxy/pull/170), which only fixes Responses stream-error propagation.

In scope:

- preserve model metadata provenance across user config, upstream catalogs, and models.dev fallback;
- apply precedence per field for every Provider kind;
- support `metadata` and `metadata.extend` on OAuth Providers;
- project generic `limit.context`, `limit.input`, and `limit.output` into protocol-specific fields;
- retain the existing cross-Provider `min` / `max` policy after each Provider candidate is resolved;
- keep the existing cache and degraded-availability behavior.

Out of scope:

- hard-coding limits for a named model;
- changing model routing, Provider weight, or session affinity;
- inferring ChatGPT plan entitlements or API pricing policy;
- adding Codex-specific user-config fields;
- adding another cache for resolved or merged metadata;
- changing Responses error propagation from PR #170.

## Problem

`resolveEnabledModels()` currently merges user metadata and models.dev fallback into values such as `ResolvedModel.contextWindow`. That loses provenance before protocol projection.

For a matching Codex row, `codexClientModels()` cannot tell whether `contextWindow` came from explicit user config or models.dev. It therefore treats both as an override and replaces the official Codex values. The observed result for `gpt-5.6-sol` is `922000` instead of the official Codex value `272000`.

The same representation also prevents a general precedence rule:

- API and AI SDK Provider `metadata` is user config;
- OAuth runtime `metadata` comes from the provider's discovered catalog;
- models.dev is only fallback data;
- the official Codex catalog is protocol-specific upstream data.

All four are currently exposed through overlapping shapes, so a consumer cannot consistently implement `config > upstream > fallback`.

## Confirmed decisions

1. Precedence is **user config > relevant upstream metadata > models.dev fallback > protocol default**.
2. Precedence is resolved per field. A missing field falls through; explicit `false`, an empty array, and other valid explicit values do not.
3. A fully materialized `metadata.extend` result belongs to the user-config layer. Choosing `extend` is itself an explicit user configuration decision.
4. User config is an exact override and may increase an official value. An API Provider can therefore advertise a larger API limit than the built-in Codex product catalog.
5. Every Provider candidate resolves its own fields first. Only then are candidates sharing a public slug reconciled with the existing `min` / `max` policy.
6. Protocol projection is last. Generic metadata must not contain Codex wire-field names.
7. Aliases are self-contained public models. Fallback lookup uses the public slug and never silently inherits metadata from the upstream routing target.
8. No resolved/merged metadata cache is added.

## Field semantics

### Generic limits

The config shape continues to mirror models.dev:

```ts
type ModelLimit = {
  context?: number; // maximum total context
  input?: number;   // maximum input tokens
  output?: number;  // maximum output tokens
};
```

These values are distinct. `input` must not be replaced with `context`, and `output` must not be inferred from either.

### Codex limits

Codex uses different product semantics:

- `context_window` is the default context-window budget used when the user has not configured `model_context_window`;
- `max_context_window` is the ceiling applied to a user `model_context_window` override;
- `effective_context_window_percent` is independent headroom owned by Codex and is not derived from generic metadata;
- Codex has no direct `limit.output` wire field.

The Codex implementation documents `max_context_window` as the maximum allowed config override and prefers `context_window` whenever it is present. The introducing commit is [openai/codex@5bb193a](https://github.com/openai/codex/commit/5bb193aa88fef0f5ef3fbbd2c6253ba93d3f6521).

The [OpenAI API model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) independently reports GPT-5.6 Sol as `1,050,000` total context, `922,000` maximum input, and `128,000` maximum output. Those API capabilities do not redefine the Codex product catalog.

## Source model

Metadata sources remain separate until a consumer requests a field:

```ts
type ModelMetadataSources<TUpstream> = {
  readonly config?: ModelMetadata;
  readonly upstream: readonly TUpstream[];
  readonly fallback?: ModelMetadata;
};
```

This is a conceptual boundary, not a requirement to introduce a public abstraction with speculative extension points. The implementation should use the smallest representation that preserves these three layers.

- `config` is the Provider's parsed metadata, including materialized `extend` values.
- `upstream[]` contains ordered upstream sources relevant to the projection. For example, the official Codex row owns Codex-specific fields; an OAuth catalog owns provider-reported generic fields.
- `fallback` is the models.dev record for the public slug.

There is no second `effectiveMetadata` object stored alongside the sources. A consumer resolves only the fields it emits.

## Data flow

1. Config parsing validates Provider metadata.
2. Snapshot construction materializes `metadata.extend`; the result stays in the config layer.
3. Runtime materialization retains config metadata separately from provider-discovered upstream metadata. OAuth config no longer overwrites or masquerades as the plugin catalog, and vice versa.
4. `resolveEnabledModels()` groups routes by public slug and gathers each Provider candidate's source layers.
5. Each candidate resolves requested fields using `config > upstream > fallback`.
6. Numeric token-limit fields for candidates sharing a public slug are reconciled using `router.modelContextAggregation` (`min` by default, or `max`). Missing values do not participate.
7. The first candidate in Provider weight/config order continues to supply public identity and non-aggregated fields.
8. `listModels()` and `codexClientModels()` project the resolved semantic fields into their own wire shapes.

The aggregation step applies to `limit.context`, `limit.input`, and `limit.output` independently. Because each Provider candidate is resolved before aggregation, a lower-priority fallback from one candidate cannot outrank explicit config on another candidate inside that candidate's source stack.

## Field precedence matrix

| Semantic field | User config | Upstream | Fallback | Final default |
| --- | --- | --- | --- | --- |
| Display name | `metadata.name` | protocol/provider display name | models.dev `name` | public slug |
| Description | `metadata.description` | protocol/provider description | models.dev `description` | empty string where required |
| Total context | `limit.context` | provider-reported total context | models.dev `limit.context` | protocol default |
| Maximum input | `limit.input` | provider-reported maximum input | models.dev `limit.input` | unknown |
| Maximum output | `limit.output` | provider-reported maximum output | models.dev `limit.output` | unknown |
| Modalities | `capabilities.modalities` | protocol/provider modalities | models.dev modalities | protocol default/unknown |
| Reasoning options | `capabilities.reasoningOptions` | protocol/provider options | models.dev options | protocol default/unknown |
| Cost | `cost` | provider-reported cost | models.dev cost | unknown |
| Codex-only instructions, service tiers, promo fields | no generic mapping | official Codex row | synthesis template | existing static default |

For Codex projection, the official Codex row is the relevant upstream source for fields it owns and therefore outranks provider-generic metadata and models.dev. Explicit user config still outranks it.

## Protocol projections

### Standard `/v1/models`

The existing OpenAI/Anthropic superset shape remains stable:

- `max_input_tokens` is the resolved `limit.input`, never `limit.context`;
- `max_tokens` is the resolved `limit.output`;
- display name, description/capabilities where exposed, and timestamps follow the generic field matrix;
- unknown values remain `null` or the existing deterministic default.

### Codex `/v1/models?client_version=...`

Generic limits project to Codex as:

```ts
context_window = limit.input ?? limit.context;
max_context_window = limit.context ?? limit.input;
```

This is a conservative projection choice, not a claim that the generic and Codex fields are synonymous.

For every Provider candidate, resolve the two Codex semantic window values in this order:

1. project explicit user `limit.input` / `limit.context`;
2. use a matching official Codex row;
3. project provider-reported generic limits;
4. project models.dev fallback limits;
5. use the synthesis default.

After each candidate has a valid pair, apply `min` or `max` independently to the default and maximum windows. The wire projection then writes the two aggregated values. This makes the official row outrank fallback without preventing explicit config on any candidate.

Examples:

| Generic metadata | Codex projection |
| --- | --- |
| `{context: 400000, input: 272000, output: 128000}` | `context_window=272000`, `max_context_window=400000` |
| `{context: 1000000}` | both fields `1000000` |
| `{input: 922000}` | both fields `922000` |
| `{output: 128000}` only | no Codex window override |

#### Matching official row (Case A)

- With no explicit user field, retain the official Codex field verbatim. models.dev must not replace it.
- An explicit user field overrides only the fields to which it projects. User config may raise or lower the official values.
- Generic user fields such as `name`, `description`, modalities, and reasoning options override their mapped Codex fields; unrelated Codex-only fields remain from the official row.
- `slug` and `id` remain the public alias, and the existing instruction normalization remains unchanged.

For the current `gpt-5.6-sol` catalogs, no user limit produces the official `272000 / 272000`, despite models.dev advertising `922000 / 1050000`. A user API Provider configured with those generic API limits produces `922000 / 1050000`.

#### Synthesized row (Case B)

- Resolve config, provider upstream, then models.dev for each generic field.
- Apply the generic-to-Codex projection above.
- When neither projected field is available, retain the existing `272000` synthesis default.
- Continue cloning a complete Codex template for required non-generic fields, while removing promo/routing fields that must not leak to a third-party model.

### Alias isolation

models.dev fallback is queried by the public slug only. It does not fall through to `modelId`, because doing so leaks an upstream model's identity and capabilities into a distinct alias.

Users who intentionally want an alias to inherit a known models.dev model use `metadata.extend`. The materialized result then belongs to config and correctly outranks all upstream and fallback sources.

## Provider behavior

API and AI SDK Providers retain their existing `metadata` authoring shape.

OAuth Provider config gains the same optional `metadata` field and `metadata.extend` behavior. The OAuth plugin catalog remains upstream metadata. Snapshot/runtime materialization must preserve both layers rather than deep-merging them eagerly.

Provider selection and identity remain unchanged:

- Provider weight/config order chooses the primary candidate;
- the primary candidate supplies `owned_by` and non-aggregated identity fields;
- token limits are resolved per candidate and then reconciled across all candidates exposing the slug.

## Validation and degraded behavior

User config is the trust boundary:

- token limits must remain positive integers;
- when explicit config supplies both `input` and `context`, `input <= context` is required;
- when explicit config supplies both `output` and `context`, `output <= context` is required;
- invalid config marks that Provider invalid through the existing config-diagnostic path; values are not silently clamped.

External sources are fail-soft:

- Codex catalog lookup keeps the existing `fresh cache -> bounded download -> stale cache -> absent` flow;
- one malformed Codex row is skipped without failing the whole catalog;
- unavailable or malformed models.dev data is treated as a missing fallback;
- unavailable OAuth catalog data keeps the existing stale/unavailable Provider behavior;
- an invalid external token-limit field is ignored rather than copied into a client response;
- final Codex rows must satisfy `context_window <= max_context_window`.

The model-list endpoint remains available when either catalog is cold or unavailable. It synthesizes from the sources that remain and uses existing protocol defaults only as the last step.

## Cache behavior

Reuse the existing caches:

- Provider config snapshot;
- persisted OAuth plugin catalog and its fresh/stale state;
- the six-hour Codex file cache with stale fallback;
- the existing models.dev file and memory caches.

Do not cache the resolved cross-source object. Re-resolving a few fields from current cached inputs is cheap and avoids a new invalidation problem when config, an OAuth catalog, the Codex catalog, or models.dev changes.

`metadata.extend` materialization in a config snapshot is not a merged metadata cache. It is the parsed value of an explicit config entry and is replaced on the next snapshot build.

## Testing

Behavior tests must cover public contracts rather than implementation literals:

1. A matching official Codex row keeps `272000 / 272000` when models.dev reports `922000 / 1050000`.
2. Explicit API Provider metadata `{context: 1050000, input: 922000, output: 128000}` overrides the official Codex row and also projects to standard `max_input_tokens=922000` and `max_tokens=128000`.
3. Composite `{context: 400000, input: 272000, output: 128000}` produces Codex `272000 / 400000`.
4. A materialized `metadata.extend` entry has config-layer precedence.
5. OAuth `metadata` and `metadata.extend` behave like API Provider config while the plugin catalog remains the upstream layer.
6. A synthesized alias uses public-slug models.dev fallback and does not inherit its routing target's metadata.
7. Multiple Providers resolve independently before `min` and `max` aggregation for all token-limit fields.
8. Invalid user limit pairs reject the Provider; malformed external rows are skipped or ignored without returning 500.
9. Fresh, stale, missing, and write-failed Codex cache paths preserve the existing endpoint behavior.
10. A cold/unavailable models.dev catalog does not alter a valid official Codex row and does not fail model discovery.

Existing tests that assert `limit.context` always becomes both Codex fields must be replaced with the composite-field expectations above.

## Rejected alternatives

### Patch Case A to ignore every resolved `contextWindow`

This fixes the reported model but also prevents explicit user config from overriding official values.

### Always prefer models.dev

models.dev describes generic API capability, not Codex product policy. This is the current bug.

### Always prefer the Codex catalog

This preserves built-in Codex behavior but incorrectly caps explicitly configured API Providers.

### Add `codex.contextWindow` user fields

Protocol-specific config could express every nuance, but the existing generic `limit` object is sufficient for the confirmed use cases. Add protocol-specific fields only if a future model cannot be represented by the documented projection.

### Cache merged metadata

This saves negligible work and requires coordinated invalidation across four independently refreshed inputs. Resolve on demand instead.

## Acceptance criteria

- Source provenance is retained until field resolution.
- User config, including `extend`, wins per field and may increase official limits.
- Official Codex values win over provider-generic metadata and models.dev when the user did not override them.
- Generic `context`, `input`, and `output` retain distinct meanings in every protocol.
- OAuth and non-OAuth Providers share the same metadata authoring semantics.
- Cross-Provider aggregation occurs after per-Provider source resolution.
- No new cache, routing behavior, or model-specific hard-coded exception is introduced.
