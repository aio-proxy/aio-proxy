# Local Production Trace Semantic Fixes

**Spec:** `docs/superpowers/specs/2026-09-18-trace-timeline-design.md`

**Goal:** Align newly recorded traces with the approved three-layer HTTP / logical inference / provider inference semantics, preserve true start order, and retain read compatibility for historical traces.

**Global constraints:** Use existing tracing, storage, migration, and projection mechanisms. Do not infer provider identity or HTTP templates. Do not backfill historical rows. Preserve the unrelated `bun.lock` edit. Work test-first and do not commit or deploy unless separately requested.

## Task 1: Tighten the trace contract and provider identity

**Produces:** The binding spec; optional `genAiProviderName` on OAuth runtime metadata; built-in values for OpenAI, Anthropic, Gemini, xAI, and OpenRouter only; provider inference attributes with no protocol-derived identity or duplicate model/TTFT/token keys.

**Consumes:** Existing `OAuthRuntimeResult`, `RuntimeProviderInstance`, provider attempt emission, and semantic attribute registry.

1. Finish the spec edits for conditional raw/model trees, root ownership, provider ownership, usage naming, and start ordering.
2. Add focused tests proving generic `openai-response` providers omit `gen_ai.provider.name`, built-ins expose their declared identity, and provider spans use only the approved standard keys.
   - Expected RED: current protocol mapping emits `openai`; runtime type lacks explicit metadata.
3. Add the optional runtime field and propagate it without guessing.
4. Update provider emission and registry keys; keep historical projection fallbacks.
5. Run the affected plugin SDK, built-in plugin, and server tests.
   - Expected GREEN: focused suites pass with generic providers omitting identity.

## Task 2: Correct root and logical inference semantics

**Produces:** Root named `{method} {http.route}` with standard HTTP attributes and minimal aio-proxy facts; logical inference with caller model, attempts, logical TTFT, and failover only after a successful multi-attempt call.

**Consumes:** Task 1 semantic keys and runtime provider metadata.

1. Add request-recorder and pipeline tests for root attributes, model-conversion prepare, raw no-prepare, single success, failover, all-failed, 4xx, cancellation, and missing usage.
   - Expected RED: root contains diagnostics/GenAI/default operation/TTFT; single-attempt traces contain failover.
2. Reuse existing recorder and inference span setters to move/remove attributes at their source.
3. Keep summary columns but stop projecting GenAI attributes onto the root; preserve old-key reads.
4. Run the focused server and core trace tests.
   - Expected GREEN: root and logical layer satisfy the spec after persistence round-trip.

## Task 3: Name and sanitize HTTP spans, then add usage.resolve

**Produces:** Explicit route/template propagation; HTTP client names `{method} {url.template}` with method-only fallback; redacted `url.full`; upstream metrics under `aio_proxy.upstream.*`; `aio_proxy.usage.resolve` around validation and pricing.

**Consumes:** Existing protocol adapter route knowledge, observed fetch wrapper, request trace session, and `finalizeUsage`.

1. Add tests for `/v1/responses`, missing-template fallback, credentials/query redaction, header/status/server attributes, response-body metric ownership, and usage resolve success/undefined/error.
   - Expected RED: current HTTP span is only `POST`, raw URL is not fully redacted, and no usage span exists.
2. Pass explicit low-cardinality templates from route/adapters to the observed fetch wrapper; never derive them from `url.path`.
3. Wrap only validation plus pricing with the existing span registry/session primitives.
4. Run focused server route, wire, and usage tests.
   - Expected GREEN: raw carpool-shaped traffic records `POST /v1/responses`; undefined usage remains UNSET and thrown validation/pricing records ERROR.

## Task 4: Persist deterministic start order and keep history compatible

**Produces:** Nullable `start_sequence`; root sequence `0`; onStart-assigned child sequence; query/layout ordering by sequence with `(startedAt, spanId)` fallback; no data rewrite.

**Consumes:** Buffering span processor output, trace schema/migrations, trace store types/queries, `DashboardTraceSpan`, and dashboard layout.

1. Add processor, storage round-trip, query, and layout tests using reverse-lexicographic span IDs.
   - Expected RED: same-millisecond siblings sort by random IDs and the schema/type lacks sequence.
2. Add the nullable column through the existing migration mechanism and thread it through persisted span records.
3. Assign sequence at start, reserve root `0`, and order siblings by sequence when both values are present; otherwise use the historical stable fallback.
4. Add projection compatibility tests for old diagnostics/model/cache-write fields and new standard keys.
5. Run focused core/server/dashboard tests.
   - Expected GREEN: new traces preserve `session → inference` and `route → provider`; old traces remain deterministic.

## Task 5: Release metadata and full verification

**Produces:** One minor changeset covering `aio-proxy`, `@aio-proxy/plugin-sdk`, and every affected internal package; verified repository state; independent whole-branch review.

**Consumes:** All prior tasks.

1. Add or rewrite the shortest applicable changeset describing the shipped public trace semantics and runtime metadata.
2. Run affected package tests and `bun run check`.
3. Run `bun run preflight`, then build and `bun run lint:types` as required by the repository.
4. Generate a whole-branch review package and obtain one fresh-context review; fix Important/Critical findings test-first in one pass and ledger Minor findings.
5. Inspect `git diff` and confirm `bun.lock` remains user-owned and excluded.

## Review Focus

- No code path derives `gen_ai.provider.name` from protocol, Provider ID, URL, or package name.
- No actual path is promoted into an HTTP span name; URL credentials and every query value are redacted.
- Root read projection cannot reintroduce `gen_ai.*`; old diagnostics/model/cache-write traces remain readable.
- `failover_ms` cannot appear for one attempt or an all-failed operation.
- Sequence is allocated on start, not end, and old rows remain nullable without backfill.
- Usage validation/pricing errors close `usage.resolve` as ERROR without changing usage capture behavior.

## Deferred external verification

Formal-process restart, SQLite backup, live traffic generation, and UI/browser verification mutate state outside this worktree. Perform them only after separate authorization; repository verification does not claim those steps occurred.
