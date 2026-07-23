# Provider Attempt Failure Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a safe structured process log whenever a provider attempt fails, including failures that are swallowed by fallback.

**Architecture:** Keep logging in the existing shared candidate loop. Add one `request.provider_attempt_failed` server event, build it through the existing pipeline logging helper, and map it to `warn`; preserve SQLite request recording unchanged.

**Tech Stack:** Bun, TypeScript, LogTape, `bun:test`.

## Global Constraints

- Do not log request bodies, upstream response bodies, exception messages, arbitrary headers, credentials, or tokens.
- Include only request/provider identity, status, duration, failure kind, fallback decision, exception type, and a validated upstream request ID.
- Do not add dependencies or abstractions outside the existing server-log and pipeline logging paths.
- Keep inbound cancellation out of the failure event.

---

### Task 1: Log provider attempt failures

**Files:**
- Modify: `packages/server/src/routes/pipeline/raw-fallback.test.ts`
- Modify: `packages/server/src/routes/pipeline/internal-error-lifecycle.test.ts`
- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/logging/bridge/bridge.ts`
- Modify: `packages/server/src/logging/bridge/bridge.test.ts`
- Modify: `packages/server/src/routes/pipeline/logging.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.ts`

**Interfaces:**
- Consumes: existing `ProviderRouteSource.logger`, `RequestSession`, `RequestAttemptInput`, and `serverErrorType()`.
- Produces: `request.provider_attempt_failed` with `failureKind: "response" | "exception"` and `fallback: boolean`.

- [x] **Step 1: Write failing pipeline assertions**

Extend the raw `503`/`429` fallback test to return `x-request-id: upstream-primary`, then assert `harness.logs` contains:

```ts
expect.objectContaining({
  event: "request.provider_attempt_failed",
  providerId: "primary",
  statusCode: status,
  failureKind: "response",
  fallback: true,
  upstreamRequestId: "upstream-primary",
})
```

Also assert the serialized logs do not contain a sentinel placed in the upstream response body. Extend the network-throw test to assert the event has `failureKind: "exception"` and `errorType: "Error"`; extend the existing unmapped-provider-error lifecycle test to require the attempt event before the terminal `request.failed` event.

- [x] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/server/src/routes/pipeline/raw-fallback.test.ts`

Expected: FAIL because `harness.logs` is empty for both fallback paths.

- [x] **Step 3: Implement the minimum event and emission path**

Add the event type to `server-log.ts`, map it to `warn` in `SERVER_LOG_LEVEL`, and add a `logProviderAttemptFailed()` helper in pipeline `logging.ts`. The helper should derive shared request fields, copy the recorded attempt fields, use `serverErrorType()` only for exceptions, and accept only a validated `x-request-id` or `request-id` value of at most 256 safe identifier characters.

In `attempt.ts`, emit the event for:

```ts
// raw non-success response, before fallback or final return
failureKind: "response"

// mapped or unmapped provider exception, unless caused by inbound abort
failureKind: "exception"
```

Reuse the same `RequestAttemptInput` object for SQLite recording and process logging so status, provider identity, protocol, and duration cannot drift.

- [x] **Step 4: Cover the log-level mapping**

Add a representative provider-attempt event to the existing table-driven bridge test and assert it is forwarded at `SERVER_LOG_LEVEL[event]`, which must be `warn`.

- [x] **Step 5: Verify GREEN and regressions**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-fallback.test.ts
bun test packages/server/src/logging/bridge/bridge.test.ts
bun run check
bun run preflight
```

Expected: all commands pass with no new warnings.
