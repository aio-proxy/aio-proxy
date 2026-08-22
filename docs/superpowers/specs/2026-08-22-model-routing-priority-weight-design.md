# Model-level priority and weight routing design

**Date:** 2026-08-22
**Status:** Approved design; implementation not started

## Summary

aio-proxy will separate Provider priority from Provider weight and add exact, client-model-level routing policies.

- **Priority** selects failover tiers. Higher values are tried first.
- **Weight** distributes requests within one priority tier.
- Provider-level values are defaults.
- `router.models.<model>.providers.<providerId>` sparsely overrides those defaults for one client-requested model.
- Session affinity may move an eligible bound Provider ahead of higher-priority tiers. Response ownership remains stronger than session affinity.
- Requests with a stable logical session use the same deterministic weighted pre-attempt candidate order for token-count and generation when their routing snapshot is unchanged. Capability eligibility, local estimation, cooldown, and runtime failure may still make the actual counting and generation Providers differ. Requests with generated session keys remain independently random.

The design keeps the existing model-first Router, Provider model catalogs, aliases, protocol dispatch, candidate fallback, cooldown, and snapshot lifecycle. It does not introduce OmniRoute-style combos, named policies, a rule engine, or a stateful load-balancing scheduler.

## Problem

The current `weight` field is described and implemented as Provider priority: configuration loading sorts Providers by descending weight, equal or missing values preserve configuration order, and every model exposed by a Provider inherits that same global order.

This cannot express either of the desired behaviors:

1. Separate failover priority from same-tier traffic distribution.
2. Route client model `m` as `A > B > C`, while routing model `n` as `B > C > A`.

The current global ordering also prevents a Provider from being primary for one model and a fallback for another without duplicating Provider configuration.

## Reference findings

The design uses the reference projects as behavioral evidence, not as runtime dependencies.

### new-api

`new-api` is the closest reference for the selected algorithm:

- Channel/ability records carry both priority and weight.
- Higher priority selects the active tier.
- Weight performs random selection within that tier.
- Retry advances to later priority tiers.
- The ability relation is scoped by group, model, and channel, allowing routing values to vary by model.

Relevant snapshot sources include `.reference/new-api/model/ability.go` and `.reference/new-api/model/channel.go`. The public project is [QuantumNous/new-api](https://github.com/QuantumNous/new-api).

### claude-code-hub

`claude-code-hub` also separates Provider priority and weight and describes weight as weighted-random probability within one priority. It supports Provider-level `group_priorities` and may migrate session ownership to a higher-priority Provider.

Its configuration is Provider-centered rather than an exact client-model policy map, so aio-proxy does not copy its placement. The public project is [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub).

### OmniRoute and 9router

OmniRoute models routes as model-centered combos. A combo contains provider/model/account targets, allowing different requested combo models to use different target chains. Its `priority` and `weighted` values are mutually exclusive strategies rather than two fields in one tiered selector.

aio-proxy borrows the model-centered configuration perspective, but not the combo abstraction, strategy registry, target lifecycle, or model-to-combo mapping system. The inspected OmniRoute snapshot is `.reference/OmniRoute` at `b052c91014b6d9f08857382960a084d6e3d3cb72`. The public project is [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute).

### CLIProxyAPI

CLIProxyAPI exposes root-level `routing.strategy` and session-affinity settings. Its weighted scheduler is useful evidence for credential selection, but it does not provide the exact model-to-Provider sparse override required here.

## Goals

- Give priority and weight independent, documented meanings.
- Allow exact client model IDs to override Provider defaults sparsely.
- Preserve the existing Provider catalog and alias configuration as the only source of candidate eligibility and upstream model mapping.
- Keep routing stateless across requests except for the existing affinity and response-owner stores.
- Use one selection contract for generation and token-count requests.
- Keep token-count and generation pre-attempt routing order aligned when both carry the same stable logical session identity, without promising identical capability outcomes or letting token-count mutate affinity state.
- Make effective routing visible and editable in the Dashboard.
- Keep `/v1/models` stable even though request selection becomes random.
- Preserve unknown model/Provider references in authored configuration while ignoring them at runtime.

## Non-goals

- Glob, regular-expression, tag, protocol, or request-dimension routing rules.
- Named or reusable routing policies.
- OmniRoute-style combos or selectable routing strategies.
- Smooth weighted round-robin or any cross-request balancing counter.
- Stateful token-count stickiness, weighted rendezvous hashing, or request-ID-based pseudo-stickiness.
- Creating a model candidate or upstream model mapping from `router.models`.
- Changing the existing `provider-id/model` explicit routing syntax.
- Automatic migration or rewriting of existing Provider weight values.
- Warnings or errors for unknown Provider IDs or models in `router.models`.
- A giant editable matrix, route simulator, cross-model bulk draft, or field-level autosave in the Dashboard.

## Configuration contract

### Provider defaults

Every Provider gains normalized priority and weight defaults:

```yaml
providers:
  provider-a:
    kind: api
    priority: 0
    weight: 1000
```

- `priority` is an integer in the effective range `0..10000`, defaults to `0`, and higher values are preferred.
- `weight` accepts an authored finite number, defaults to `1`, and larger effective values receive more same-tier traffic. It is normalized with `Math.round`, then clamped to the effective integer range `0..10000`.
- An integer priority below `0` is clamped to `0`; an integer priority above `10000` is clamped to `10000`.
- A finite weight is rounded first, then values below `0` clamp to `0` and values above `10000` clamp to `10000`.
- Priority fractions, strings, `NaN`, infinite values, and non-number inputs fail validation. Weight strings, `NaN`, infinite values, and non-number inputs fail rather than being coerced.
- `enabled: false` is a hard global disable and cannot be overridden per model.
- Provider-level `weight: 0` makes the Provider ineligible by default, but a positive model override may re-enable it for that model.

Clamping is a runtime normalization, not a background config rewrite:

- Loading or reloading a file never writes the clamped value back to disk.
- Dashboard read models expose the authored number, effective rounded/clamped integer, and `wasNormalized` state.
- A deliberate Provider or model-routing Save writes the normalized effective value for every numeric routing field included in that edited object.
- Settings or unrelated config mutations that do not replace the Provider/model policy preserve its authored raw value.

This keeps passive reload non-mutating while making an explicit edit converge to canonical values. The Dashboard shows the pending normalization before Save; it is not a startup warning and does not change the decision to silently ignore unknown Provider/model references.

### Per-model policies

The existing top-level `router` object gains `models`:

```yaml
router:
  modelContextAggregation: min
  models:
    model-m:
      providers:
        provider-a:
          priority: 30
          weight: 6000
        provider-b:
          priority: 30
          weight: 4000
        provider-c:
          priority: 20
```

The key under `router.models` is an exact client-requested model ID. It is not an upstream model ID and does not use glob matching.

Each Provider entry and each field is optional:

- A missing Provider entry inherits both Provider defaults.
- A missing `priority` inherits the Provider priority.
- A missing `weight` inherits the Provider weight.
- Effective `weight: 0` makes that Provider ineligible for the model.
- Clearing both fields removes the Provider override.
- Removing the last Provider override removes the model policy when it has no other fields.

The model policy object deliberately contains a `providers` child. This lets future routing-related fields live beside it without changing the Provider map, but this release implements only `providers`.

### Candidate eligibility

`router.models` can only modify a candidate already exposed through the Provider's existing direct models or aliases. It cannot add a model, choose an upstream target, or change alias variants.

Unknown client model IDs and unknown Provider IDs are retained in authored configuration and silently ignored by runtime routing. Dashboard mutations preserve those entries even though they are not displayed.

Request classification is exact and slash-safe:

1. Try the complete request model string in the Provider-qualified route map.
2. If it matches, select that Provider directly.
3. Otherwise, try the same complete string as a normal client model ID, including strings containing `/`.
4. If neither map contains it, return the existing model-not-found error.

Provider-qualified routing therefore wins an exact collision with a normal alias. Dashboard APIs carry model IDs in query values or JSON bodies rather than path segments.

An explicit Provider-qualified request bypasses priority and weight, including `weight: 0`; `enabled: false` remains a hard block because disabled Providers are not materialized into the route map. Weight zero means “ineligible for normal model routing,” not “the Provider can never be reached explicitly.”

## Compatibility

Existing configuration files remain structurally valid and are not rewritten. Their behavior changes immediately:

```yaml
providers:
  provider-a: { weight: 100 }
  provider-b: { weight: 10 }
```

Previously, every request tried `provider-a` before `provider-b`. Under the new contract, both Providers have default priority `0` and receive approximately `100:10` traffic within that tier.

This is an intentional routing behavior change. The release requires a minor changeset and prominent release notes. No legacy routing branch or automatic weight-to-priority migration is added.

Configuration order remains a deterministic tie-breaker for catalog representation and diagnostics, but it is no longer the request order for positive-weight candidates in the same priority tier.

The release documentation includes an explicit preservation guide:

| Old configuration | New configuration to preserve intent |
| --- | --- |
| Unique old weights used as fixed order | Copy old `weight` to `priority`; set new `weight: 1`. |
| Equal old weights whose config order mattered | Assign explicit descending priorities in the old config order; set `weight: 1`. |
| Omitted old weight | It previously remained eligible at priority zero; set a positive new weight, normally `1`. |
| Fractional old weight | Assign priority from the old descending order; the new weight is rounded with `Math.round` if retained as a traffic ratio. |
| Negative or greater-than-10000 old weight | Assign explicit in-range priorities that preserve the old total order; do not copy values that would collapse under clamp. |
| Old `weight: 0` | It previously remained an eligible fallback; set new `weight: 1` and the intended priority. |
| `enabled: false` | No change; it remains the hard disable. |

## Candidate selection

For an unqualified client model request, routing performs these steps:

1. Resolve the existing Provider candidates and upstream model targets through the current Router and alias-variant logic.
2. Discard Providers with `enabled: false`.
3. Merge Provider defaults with the exact client-model policy.
4. Discard candidates whose effective weight is `0`.
5. Group remaining candidates by effective priority.
6. Visit priority groups from highest to lowest.
7. Within each group, build a weighted order without replacement using either the stable-session deterministic source or the production random source.
8. Flatten the groups into the sequential candidate list.

Weighted ordering for one priority group repeatedly draws a candidate in proportion to its weight, removes it, then repeats with the remaining candidates. It has no shared counters or multi-instance coordination.

### Stable-session ordering

The logical session source determines the draw source:

- A non-generated logical session key uses a deterministic SHA-256 counter stream seeded by the logical session key and exact client-requested model ID.
- A `generated` logical session uses ordinary non-cryptographic randomness independently for each request.

The deterministic stream also incorporates the priority tier and draw index. The current ordered candidate IDs and weights are inputs to the weighted draw itself, so a separate policy revision is not added to the seed. A routing change naturally changes the result; adding a revision would remap unrelated sessions more aggressively without preserving additional state.

This reuses the weighted-permutation algorithm for both modes. Weighted rendezvous hashing is not introduced because minimal remapping under candidate-set changes is not a current requirement.

Token-count and generation receive the same pre-attempt candidate order only when they resolve the same stable logical session key, exact client model, candidate set, and weights. Requests without a shared session/conversation/prompt-cache identity remain independently random. A configuration or catalog change between the two calls may also change the order.

This contract does not require the actual counting and generation Providers to match. Token-count may skip a Provider without count capability, reject an incompatible materialization, fall back after a count failure, or use local estimation; generation may independently skip a cooled Provider or fail at runtime. Those differences occur after the shared routing order is produced.

For this policy:

```text
priority 30: A(weight 6000), B(weight 4000)
priority 20: C(weight 10000)
```

A is first approximately 60% of the time and B approximately 40%. If the selected Provider fails, the other priority-30 Provider is attempted before C.

### Special ordering

The final precedence is:

```text
response owner
  > session affinity
  > priority tier
  > deterministic stable-session or per-request-random weight order
```

- Existing response ownership remains the strongest preference.
- Existing session affinity may move a lower-priority bound Provider to the front for prompt-cache continuity.
- Response ownership and affinity only reorder candidates that remain eligible after `enabled` and effective-weight filtering.
- Token-count reads response ownership and active affinity but keeps `mutateSessionState: false`; it never creates or refreshes affinity merely by counting.
- Cooldown skips an attempted candidate without changing the relative order of the remaining candidates.
- Candidate failure continues to the next candidate, preserving the final failure when none succeed.

The generation pipeline and token-count path use the same candidate ordering contract.

### No eligible candidates

If every candidate is disabled or has effective weight `0`, the model is not routable:

- It is omitted from `/v1/models`.
- Requests use the existing protocol-shaped model-unavailable/not-found behavior rather than a temporary upstream-failure response.
- A still-enabled Provider may remain reachable through an exact Provider-qualified request because that path bypasses weight filtering.

## Model catalog representation

Random request routing must not make `/v1/models` metadata fluctuate. Public catalog resolution first builds the same normal-routing candidate set used by requests: enabled Providers that expose the model and have positive effective weight. Disabled, zero-weight, unresolved, and unavailable runtime candidates do not participate in public metadata or limit resolution.

The representative Provider for a public model is selected deterministically from that set by:

1. Highest effective priority.
2. Highest effective weight.
3. Original configuration order.

The representative supplies `owned_by` and non-limit Provider-specific metadata. The existing `modelContextAggregation` contract remains in force for context, input, and output limits, but aggregation is restricted to the same positive-weight routable candidate set. This deterministic choice is for catalog representation only and does not affect request randomization.

## Runtime ownership

### Types and configuration

`@aio-proxy/types` owns:

- Provider priority and weight schemas, defaults, and integer clamping.
- `router.models` policy schemas.
- Dashboard DTOs and mutation bodies.
- Removal of configuration-time Provider sorting by weight so original configuration order remains available as a tie-breaker.

Unknown model and Provider references are not cross-validated during config parsing.

### Core Router

`@aio-proxy/core` remains responsible for model-first candidate resolution. Router resolution first checks an exact Provider-qualified route, then falls back to the exact normal client-model map with the complete string. It applies exact client-model policies only on the normal route, exposes each candidate's effective priority, effective weight, source metadata, and configuration index, and produces the weighted tier order.

The weighted ordering primitive accepts a draw source. Tests inject deterministic draws; production uses either the stable-session SHA-256 counter stream or the platform random source. This is a test seam for one algorithm, not a general scheduler abstraction.

### Server

The server keeps the only sequential attempt loop. It applies response-owner and affinity reordering to the Router's eligible ordered candidates, then performs the existing capability dispatch, cooldown handling, fallback, usage capture, request recording, and stream preflight.

Token-count uses the same Router output and special ordering rules rather than maintaining a second routing algorithm. It passes the logical session source into ordering, but does not mutate affinity or response ownership.

Snapshot replacement remains atomic. Requests holding an old snapshot finish with the old policy; new requests use the new snapshot.

## Observability

Every Provider attempt records:

- Routing contract version `2`.
- Effective Provider priority.
- Effective Provider weight.
- Whether priority came from the Provider default or model override.
- Whether weight came from the Provider default or model override.
- Selection source, including Provider-qualified, response owner, session affinity, deterministic session, and weighted random.

Fallback is not a selection-source enum value. Existing `attemptIndex > 0` identifies fallback attempts independently, allowing an attempt to be both a fallback and ordered by deterministic session, random weight, affinity, or ownership.

The legacy Provider weight trace field is not reinterpreted as the sole source of truth. New nullable route-effective priority/weight, inheritance-source, selection-source, and contract-version attributes are projected and stored separately. Historical rows without contract version `2` retain the documented legacy meaning: their Provider weight represented fixed routing priority. UI and queries never infer v2 semantics from old rows.

The database change uses additive nullable columns and includes both fresh-database and upgrade-from-existing-database migration tests. Generation and token-count attempts emit the same v2 routing attributes when they attempt an upstream Provider.

Unknown model or Provider references in `router.models` do not emit startup warnings, request warnings, or Dashboard warnings.

## Dashboard

### Navigation and page

Add `Routing` under the existing Configuration navigation at `/routing`.

The page lists every currently known client model route in a TanStack Table using the shared shadcn Table. Its inventory is independent of the active runtime Provider array:

- API and AI SDK routes come from authored Provider models and aliases.
- OAuth routes come from persisted validated catalogs plus authored aliases, even when the account is disabled or the runtime is unavailable.
- Alias, preserve, and variant visibility use the same route algebra as runtime routing.
- No runtime Provider is created merely to populate the Dashboard inventory.

This includes routes whose current effective candidate count is zero, so an operator can repair a model disabled by weight or Provider state. The table provides the repository-standard client-side sorting, filtering, pagination, and column visibility.

Core columns are:

- Model ID.
- Effective route summary, for example `P30: A 60% / B 40% → P20: C`.
- Eligible Provider count.
- Whether the model has explicit overrides.
- Row action to edit routing.

All known model routes are shown, including single-Provider models, models without overrides, and models that are currently unavailable. Model search and filters control large catalogs. Mobile retains horizontal table scrolling.

### Model editor

Selecting a model opens a shadcn Sheet. It contains:

- The exact client model ID.
- A live preview of effective priority tiers and approximate same-tier shares.
- One row per currently known Provider candidate, including disabled and effective-zero-weight candidates.
- Provider ID/name and state.
- Provider default priority and weight.
- Optional model override inputs.
- Effective priority, effective weight, and inheritance source.

An empty input means inherit. It displays the Provider default as supporting text rather than materializing that value into the model policy. Effective `weight: 0` is labeled as disabled for that model.

Reset clears one Provider's model override. Save and Cancel operate on the complete visible draft for one model. Save applies the model changes in one atomic config transaction; there is no per-field autosave or cross-model draft.

### Dashboard API

The typed Dashboard API exposes:

- A query returning all known client model route summaries, the Provider data required by the editor, an opaque raw-policy revision, and the exact baseline Provider ID set visible in the draft.
- A model-granular mutation that submits the desired overrides, the policy revision, and that baseline Provider ID set.

Inside the config-file transaction, the server recomputes the raw model-policy revision. A mismatch returns typed `409 stale_revision`, changes nothing, and leaves the client draft open. When the revision matches, the server replaces entries only for the baseline Provider IDs from the opened draft. Entries outside that baseline are always preserved, even if a catalog refresh has made them newly known since the Sheet opened. The server deletes an empty model policy only when no preserved entries or future fields remain.

This combines optimistic concurrency with the existing atomic file lock: the lock prevents torn writes, the policy revision prevents concurrent policy overwrite, and the baseline set prevents catalog drift from turning a formerly unknown entry into accidental deletion.

Provider create/edit forms and the Provider table gain priority alongside weight. Weight copy changes from priority language to same-tier traffic distribution language. New Provider defaults become `priority: 0` and `weight: 1`.

### UI states and constraints

- Loading uses existing table and Sheet skeleton patterns.
- Query failure exposes a retry action; a missing config path renders the page read-only with an actionable state.
- An empty route catalog points the user to Provider configuration.
- Save errors remain in the Sheet and preserve the draft.
- A stale revision keeps the draft, identifies that routing changed, and offers reload/reapply rather than silently retrying.
- Save controls are disabled while pending; disappearance of a model or Provider is handled as stale data rather than clearing fields.
- Successful save closes or refreshes the editor through TanStack Query invalidation.
- Controls use TanStack Form, shared shadcn components, Base UI behavior, visible focus, and i18n copy.
- The page follows the established quiet operational Dashboard identity; it does not add decorative data visualization or custom control styling.

## Error handling

- Unknown model or Provider references: retain and silently ignore.
- Integer priority below `0` or above `10000`: clamp to the nearest boundary.
- Finite weight: `Math.round`, then clamp to `0..10000`.
- Fractional priority, strings, `NaN`, infinite values, and other invalid types: fail validation.
- Exact Provider-qualified route: bypass priority/weight but still require an enabled materialized Provider.
- Slash-containing request that does not match a Provider-qualified route: retry as an exact normal client model before returning model not found.
- All candidates disabled or zero-weight: model unavailable/not found.
- Candidate runtime failure: continue the ordered fallback chain and preserve the final failure.
- Dashboard mutation failure: make no config change and return typed field or request feedback.
- Dashboard policy revision mismatch: return typed `409 stale_revision`, make no config change, and preserve the editor draft.

## Testing

Tests protect behavior rather than restating schema literals.

### Types and config

- Existing Provider config loads with priority `0` and preserves its weight value under the new meaning.
- Omitted priority and weight produce `0` and `1`.
- Out-of-range integer priorities clamp.
- Finite weights round with `Math.round` and then clamp, including fractional, negative, and greater-than-10000 legacy values.
- Priority fractions and invalid numeric types fail; weight strings and non-finite values fail.
- Passive reload leaves non-canonical authored values untouched; Dashboard read models expose raw/effective/wasNormalized; an explicit save writes canonical values.
- Config parsing preserves Provider authoring order.
- Sparse model policies parse and preserve unresolved references.

### Core

- Exact client-model overrides change only that model, including a normal alias containing `/` when no Provider-qualified route matches.
- An exact Provider-qualified collision wins over the normal alias; multiple-slash and missing-qualified-target cases follow the classification contract.
- Upstream model IDs and alias variants do not accidentally select model policies.
- Provider defaults and individual missing fields inherit correctly.
- Weight `0` removes a candidate; a positive model override can re-enable a Provider defaulted to weight `0`.
- Priority groups remain ordered.
- A deterministic random sequence proves weighted selection without replacement and same-tier fallback order.
- Explicit `provider-id/model` routing remains single-Provider, ignores weight zero, and still rejects `enabled: false`.
- Deterministic catalog representation uses priority, weight, then config order.
- Limit aggregation excludes disabled and zero-weight candidates while preserving configured min/max behavior among routable candidates.

### Server

- A same-tier failure tries the remaining same-tier Provider before a lower priority.
- Session affinity moves an eligible lower-priority Provider first.
- Response ownership remains stronger than affinity.
- Disabled and zero-weight Providers are not resurrected by affinity or ownership.
- Cooldown and final-error preservation remain unchanged.
- Token-count and generation observe the same ordering rules.
- Matching stable logical sessions produce the same deterministic pre-attempt candidate order for token-count and generation; generated sessions remain independently random.
- Count capability filtering, local estimation, count failure, generation cooldown, and generation failure may produce different actual Providers without violating the shared-order contract.
- Token-count does not create or refresh affinity, and a config/catalog change between count and generation is allowed to change the deterministic result.
- Trace projection records effective values and sources.
- Trace migration preserves legacy weight semantics, reads an upgraded database, and records v2 attributes for generation and token-count attempts.
- Old and new snapshots may coexist while in-flight requests finish without sharing policy state.

### Dashboard API and UI

- Model queries return effective, default, and override values.
- Model inventory includes disabled API/AI SDK routes and persisted OAuth catalog routes without materializing a runtime Provider.
- Saving one model is atomic, checks the raw-policy revision, and preserves entries outside the opened baseline Provider set.
- A stale raw policy or competing window edit returns `409 stale_revision` without losing the draft; catalog drift or model/Provider disappearance preserves entries outside the opened baseline instead of deleting them.
- Clearing visible overrides removes only the intended entries.
- The table shows all known client model routes, including unavailable routes, and a stable route summary.
- The Sheet distinguishes inherited and explicit values, recomputes shares, handles weight `0`, resets overrides, and preserves drafts on failure.
- Provider forms and tables present priority and the new weight meaning.

### Completion gate

Run the smallest affected package tests while implementing, then finish with `bun run preflight`.

## Documentation and release

- Update README routing rules and configuration examples.
- Update the root `AGENTS.md` routing invariants, schema descriptions, and examples so they no longer describe weight as fixed priority.
- Explain that Provider weight no longer defines a global fixed order.
- Include the old-to-new migration table, especially omitted weight, equal-weight config-order ties, and old `weight: 0`.
- Document `router.models`, exact model matching, inheritance, weight `0`, explicit Provider routing, affinity precedence, and deterministic catalog representation.
- Add a minor Changeset targeting the public `aio-proxy` package and every changed internal package at the same bump level, following the repository's fixed-group release rules.
