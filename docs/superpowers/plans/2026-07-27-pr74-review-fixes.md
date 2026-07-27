# PR 74 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the accepted trace/session review issues and make response-chain ownership collision-safe without CPA-style response rewriting.

**Architecture:** Keep each fix at its existing boundary: token-count owns its request lifecycle, request-log projection owns the legacy sentinel, and passthrough observation owns optional response-ID validation. Do not add a new affinity abstraction or dependency.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/SQLite, `bun:test`.

## Global Constraints

- Use Provider ID and Provider weight terminology.
- Write a failing behavior test before each production change.
- Invalid optional response metadata must not roll back trace or usage persistence.
- Keep tests colocated with source when adding or materially moving tests.
- Keep CPA alignment narrow: record the producing Provider ID and ambiguity, but do not add account-pool scheduling or downstream response-ID rewriting.

---

### Task 1: Finish token-count traces on unexpected errors

**Files:**
- Modify: `packages/server/src/routes/token-count.ts`
- Test: existing colocated token-count lifecycle tests under `packages/server/src/routes/`

**Interfaces:**
- Consumes: `RequestTraceSession.finish`, protocol error mapping, retained request-body cleanup.
- Produces: exact rethrow with terminal `failure/internal_error`, or `cancelled` for an aborted request.

- [ ] Add a failing test where an unmapped request/format exception escapes after tracing begins; assert exact rethrow, released body, and `{ outcome: 'failure', errorCode: 'internal_error' }` without HTTP status.
- [ ] Run the targeted test and confirm it fails because no terminal completion is recorded.
- [ ] Add a failing test where a token counter throws an unmapped value; assert the attempt ends as failure and the route does not return an estimate.
- [ ] Run the targeted test and confirm it fails because the route currently reports success.
- [ ] Add the minimal outer lifecycle catch, rethrow unmapped provider failures, and construct the response before recording success.
- [ ] Run the targeted token-count tests and confirm they pass.

### Task 2: Preserve the legacy unparsed-model sentinel

**Files:**
- Modify: `packages/core/src/db/trace-store/request-logs/request-logs.ts`
- Test: `packages/core/src/db/trace-store/request-logs/request-logs.test.ts` or the nearest existing behavior test.

**Interfaces:**
- Consumes: nullable `trace_span.requested_model_id`.
- Produces: schema-valid `DashboardRequestLog.requestedModelId`.

- [ ] Add a failing test for a completed root with `requestedModelId = null`; assert the projected log contains the literal `<unparsed>` and passes `DashboardRequestLogsResponseSchema`.
- [ ] Run the targeted test and confirm the current empty string fails the assertion/schema.
- [ ] Change only the projection fallback from `''` to `'<unparsed>'`.
- [ ] Run the targeted request-log tests and confirm they pass.

### Task 3: Treat invalid completed response IDs as absent state metadata

**Files:**
- Modify: `packages/server/src/passthrough-usage/usage.ts` or the response-observation module that owns `completedResponseId`.
- Modify: `packages/server/src/logical-session-store/logical-session-store.ts`.
- Test: the colocated passthrough-observation tests.
- Test: `packages/server/src/logical-session-store/logical-session-store.test.ts`.
- Modify defensively only if required: `packages/core/src/db/trace-store/session-state/session-state.ts`.

**Interfaces:**
- Consumes: completed OpenAI Responses JSON/SSE payload IDs.
- Produces: a normalized non-empty response ID, or no state mapping.

- [ ] Add a failing passthrough test proving `id: '   '` is not emitted as `observation.responseId`.
- [ ] Add a failing completion/persistence test proving invalid optional response metadata cannot leave a successful trace running or discard usage.
- [ ] Add a failing memory-fallback test proving two long IDs sharing the first 512 characters remain distinct.
- [ ] Run both tests and confirm the current throw/rollback behavior.
- [ ] Trim and validate the ID at the observation boundary; return `undefined` for blank values while leaving response bytes untouched.
- [ ] Add only the smallest persistence guard needed so invalid optional mapping cannot abort terminal persistence.
- [ ] Hash the full trimmed ID for the in-memory map instead of reusing the 512-character Session normalizer.
- [ ] Run the targeted passthrough and trace/session tests and confirm they pass.

### Task 4: Bind response chains to their producing Provider

**Files:**
- Modify: `packages/core/src/db/schema/session-response.ts`
- Modify: `packages/core/src/db/trace-store/session-state/session-state.ts`
- Modify: `packages/core/src/db/trace-store/types.ts`
- Modify: `packages/core/src/db/trace-store/trace-lifecycle/trace-lifecycle.ts`
- Modify: `packages/server/src/logical-session-store/logical-session-store.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts`
- Test: existing core session-state and server logical-session/pipeline tests.
- Regenerate: the unreleased migration SQL and snapshot.

**Interfaces:**
- Consumes: successful completion `finalProviderId`, response ID, and session identity.
- Produces: an unambiguous `{ identity, providerId }` response owner used ahead of ordinary session affinity, or a protocol-shaped rejection for an ambiguous ID.

- [ ] Add failing core tests for same-owner refresh and different-owner ambiguity without overwrite.
- [ ] Add a failing server test proving `previous_response_id` prioritizes the producing Provider even if ordinary session affinity points elsewhere.
- [ ] Add a failing server test proving an ambiguous persisted or in-memory ID is rejected before Provider dispatch.
- [ ] Run the targeted tests and confirm current global last-write-wins behavior.
- [ ] Add Provider ID and ambiguity columns; on collision, retain no usable owner and return an explicit ambiguous resolution.
- [ ] Carry an unambiguous response owner separately from the revisioned session-affinity observation and prioritize it in the candidate loop.
- [ ] Map an ambiguous `previous_response_id` to the inbound protocol's invalid-request response before candidate dispatch.
- [ ] Regenerate the unreleased migration artifacts and run the targeted tests GREEN.

### Task 5: Verify the integrated change

**Files:**
- Verify only; no new production files.

- [ ] Run all new targeted tests.
- [ ] Run `bun run --filter @aio-proxy/core test:unit` and `bun run --filter @aio-proxy/server test:unit`.
- [ ] Run `bun run check` and `git diff --check`.
- [ ] Review `git status --short` and confirm the diff contains only the accepted fixes, their tests, the Anthropic nullable-usage fix, migration artifacts, and this plan.
