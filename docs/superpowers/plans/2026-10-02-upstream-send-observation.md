# Upstream Send Observation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve #389 by preserving each actual HTTP send's transport metrics and response attribution.

**Architecture:** Reuse existing CLIENT spans, give each fetch an independent observation, and flush sends before their attempt ends. Preserve legacy aggregate fields and show explicit send information in the dashboard.

**Tech Stack:** Bun, TypeScript, OpenTelemetry, React, existing i18n.

**Spec:** `docs/superpowers/specs/2026-10-02-upstream-send-observation-design.md`

## Global Constraints

- Preserve existing bun.lock changes and routing/retry behavior; no new dependency.
- Per-send storage is fixed-size; never retain response bodies or per-frame histories.
- Keep non-test implementations below 500 lines; split wire.ts by HTTP-span responsibility.
- All UI copy uses i18n; retain privacy and legacy trace compatibility.

## Review Focus

- Concurrent response consumption must not overwrite another send's measurements.
- Fetch failure before headers still produces one failed send.
- HTTP 200 protocol rejection must be visible as a failed, superseded send.
- Unconsumed response bodies must not leave spans outside the final trace buffer.
- Multiple successful sources must not be assigned to one arbitrary final send.

### Task 1: Per-send observation and span lifecycle

**Files:** response-observation/{response-observation.ts,send-observation.ts}; request-logging/wire/{wire.ts,upstream-span.ts,wire.test.ts}; attempt/{attempt.ts,emit/emit.ts}; request-tracing/semantic/semantic.ts.

**Interfaces:** observeFetchStart returns an optional send observation; send observation binds a finish callback and exposes per-response body hooks. finishSends flushes before attempt end. Parent context is captured from the attempt span when entering inAttempt.

- [x] Add tests for retries, isolated metrics, fetch exceptions, concurrent reads, failed/cancelled and unconsumed bodies.
- [x] Run the tests and confirm missing per-send attributes/lifecycle fail.
- [x] Implement fixed-size send observations and extract the HTTP span collaborator.
- [x] Run wire, response-observation, emitter and span-tree tests.

### Task 2: Raw and SDK response attribution

**Files:** attempt/{raw.ts,raw-retry/raw-retry.ts}; response-observation; pipeline retry tests.

**Interfaces:** inheritObservedResponse transfers WeakMap identity; rejectObservedResponse marks protocol rewrite; selectResponse chooses the raw response; SDK content chooses only a unique viable consumed send.

- [x] Add failing raw 400/200 SSE replay and SDK retry trace tests, plus ambiguous-source coverage.
- [x] Implement attribution and controlled retry-reason attributes.
- [x] Run the affected pipeline tests and sensitive-request regression tests.

### Task 3: Dashboard and release verification

**Files:** traces/{lib/trace-attribute-names,lib/span-metrics,components/span-detail-panel}; i18n/messages/*.json; generated changeset.

- [x] Add failing tests for send identity, metrics and candidate counts.
- [x] Add localized send information and historical multiple-response explanation; compile i18n.
- [x] Author a short changeset with bun changeset targeting server, dashboard, i18n and aio-proxy.
- [x] Run bun run check and affected package tests; run preflight after build if feasible.
- [x] Review the diff and record actual verification results.

## Verification Results

- `bun run build`: 20 successful tasks.
- `bun run preflight`: exit 0; type-aware lint, formatting, and all 58 test/build tasks passed. Four existing React hook lint warnings remain in unrelated files.
- Focused regression checks passed, including raw JSON/SSE rewrites, real AI SDK text/tool retries, failed-body attribution, stable attempt parenting, fallback cancellation, cross-protocol routing, privacy, and dashboard trace rendering.
- Independent code review found no remaining defects after the regression fixes.
