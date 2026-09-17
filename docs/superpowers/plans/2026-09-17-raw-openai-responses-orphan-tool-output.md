# Raw OpenAI Responses Orphan Tool Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Same-protocol raw OpenAI Responses passthrough rewrites unpaired tool outputs (including Codex Desktop's `send_message_to_thread` item with no `call_id`) into user notes before the first upstream call, so NewAPI/OpenAI no longer 422 the whole turn.

**Architecture:** Reuse `repairOpenAIResponsesToolPairing`. Call it from `rewriteOpenAIResponsesRequest` when `body.input` is an array. Keep convert-path rejection of missing `call_id`, keep compact unrepaired, and do not classify generic 422 bodies. Verbatim byte forwarding stays for paired, unchanged-model bodies.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), existing `openAIResponsesAdapter.rawRequest` harness.

**Spec:** [docs/superpowers/specs/2026-09-17-raw-openai-responses-orphan-tool-output-design.md](../specs/2026-09-17-raw-openai-responses-orphan-tool-output-design.md)

## Global Constraints

- Repair on the **create** raw path only. Compact `rawRequest` must not call `repairOpenAIResponsesToolPairing`.
- Do not classify `{"error":{"message":"Unprocessable Entity","code":null}}` as a pairing retry.
- Convert / model path still throws `OpenAIResponsesUnsupportedFeatureError('function_call_output.call_id', 'input.0.call_id')` for a missing `call_id`.
- Do not drop the orphan payload. Carry it as a user note via the existing `orphanOutputNote` shape.
- A paired call/output with unchanged model, no `background`, and supported effort must still forward the original body **bytes**.
- No new files except this plan, the spec, tests already colocated with the adapter, and one changeset.
- Handwritten non-test implementation files stay under 500 lines. `packages/core/src/protocol/openai-responses.ts` is 295 lines today; do not grow it toward 400 by inlining repair.
- Changeset: `patch` on product package `aio-proxy` and internal package `@aio-proxy/core`. Same bump level. Do not target only `@aio-proxy/core`.
- No new dependencies. Do not add a body-rule engine, cooldown, or affinity change.
- Workspace is already an isolated git worktree. Do not create another worktree.

---

## File map

- `packages/core/src/protocol/openai-responses.ts` — `rewriteOpenAIResponsesRequest` already rewrites model / background / effort. Add the pairing repair there.
- `packages/core/src/protocol/openai-responses/tool-pairing-retry/tool-pairing-retry.ts` — existing `repairOpenAIResponsesToolPairing`. Do not change its note shape.
- `packages/core/src/protocol/openai-responses.test.ts` — create-path `rawRequest` contracts (verbatim bytes, background strip). Add the orphan-output cases here.
- `packages/core/src/protocol/openai-responses-compact.test.ts` — compact `rawRequest` must stay unrepaired.
- `packages/core/src/ingress/openai-responses/request.test.ts` — parse still accepts missing `call_id`. Update the comment that currently says raw forwards it verbatim.
- `packages/core/src/transform/openai-responses/openai-responses.test.ts` — convert still rejects missing `call_id`. Update the comment that currently says parse accepts it so raw can forward it.
- `.changeset/raw-openai-responses-orphan-tool-output.md` — user-facing release note.

---

### Task 1: Raw create path rewrites unpaired tool output

**Files:**
- Modify: `packages/core/src/protocol/openai-responses.test.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts:1-21` (import) and `:237-280` (`rewriteOpenAIResponsesRequest`)
- Modify: `packages/core/src/protocol/openai-responses-compact.test.ts`
- Modify: `packages/core/src/ingress/openai-responses/request.test.ts` (comment only)
- Modify: `packages/core/src/transform/openai-responses/openai-responses.test.ts` (comment only)
- Create: `.changeset/raw-openai-responses-orphan-tool-output.md`

**Interfaces:**
- Consumes: `repairOpenAIResponsesToolPairing(input: readonly unknown[]): unknown[] | undefined` from `packages/core/src/protocol/openai-responses/tool-pairing-retry/tool-pairing-retry.ts`. Returns `undefined` when every tool item pairs; otherwise a new `input` array with unpaired items replaced by notes.
- Consumes: `openAIResponsesAdapter.rawRequest(raw, parsed, resolvedModel, supportedEfforts, context)` already used by `openai-responses.test.ts`.
- Produces: create `rawRequest` applies pairing repair when `body.input` is an array. Compact context does not. Verbatim byte forwarding still happens when repair returns `undefined` and model / background / effort are unchanged.

- [x] **Step 1: Write the failing rawRequest tests**

Append these tests to `packages/core/src/protocol/openai-responses.test.ts`. Keep the existing verbatim-bytes test unchanged; it is the lock that paired bodies still skip JSON round-trip.

```ts
test('rewrites a synthetic tool output without call_id before raw forwarding', async () => {
  const body = {
    model: 'grok-4.6',
    input: [
      {
        type: 'function_call_output',
        id: 'fco_01a0ad8a-1779-7b22-b029-a81a7bb703ba',
        name: 'send_message_to_thread',
        namespace: 'codex_app',
        output: '<codex_delegation>watch failed</codex_delegation>',
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ],
  };
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'grok-4.6', new Set(), {});

  expect(await forwarded.json()).toEqual({
    model: 'grok-4.6',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[orphan tool result] <codex_delegation>watch failed</codex_delegation>',
          },
        ],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ],
  });
});

test('rewrites an output whose call_id has no matching call before raw forwarding', async () => {
  const body = {
    model: 'grok-4.6',
    input: [{ type: 'function_call_output', call_id: 'call_gone', output: 'exit code 0' }],
  };
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'grok-4.6', new Set(), {});

  expect(await forwarded.json()).toEqual({
    model: 'grok-4.6',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[orphan tool result; call_id=call_gone] exit code 0' }],
      },
    ],
  });
});

test('keeps a paired tool call and output on the raw path', async () => {
  const bodyText = JSON.stringify({
    model: 'grok-4.6',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    ],
  });
  const raw = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'grok-4.6', new Set(), {});

  expect(await forwarded.text()).toBe(bodyText);
});
```

- [x] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
bun test packages/core/src/protocol/openai-responses.test.ts --test-name-pattern "rewrites a synthetic tool output without call_id|rewrites an output whose call_id has no matching call|keeps a paired tool call"
```

Expected: the two rewrite tests FAIL because `rawRequest` still forwards the original `function_call_output`. The paired test PASS (already true today).

- [x] **Step 3: Apply pairing repair in rewriteOpenAIResponsesRequest**

In `packages/core/src/protocol/openai-responses.ts`, add this import next to the existing `openAIResponsesRawRetry` import:

```ts
import { repairOpenAIResponsesToolPairing } from './openai-responses/tool-pairing-retry';
```

Replace `rewriteOpenAIResponsesRequest` with:

```ts
async function rewriteOpenAIResponsesRequest(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  // Read the decoded body once so a no-op rewrite forwards it verbatim instead
  // of round-tripping through JSON, which would silently truncate large
  // integers and drop the client's exact byte representation.
  const bodyText = await readRequestText(raw);
  const { background: _background, ...body } = jsonObjectSchema.parse(JSON.parse(bodyText));
  const reasoning = body['reasoning'];
  const nextReasoning =
    typeof reasoning === 'object' &&
    reasoning !== null &&
    typeof (reasoning as { effort?: unknown }).effort === 'string'
      ? { ...reasoning, effort: normalizeEffort((reasoning as { effort: string }).effort, supportedEfforts) }
      : reasoning;
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  const repairedInput = Array.isArray(body['input']) ? repairOpenAIResponsesToolPairing(body['input']) : undefined;
  // Any of these force a re-serialization: a model rewrite, a stripped
  // `background` field, a clamped effort, or unpaired tool items that would
  // 400/422 upstream (Codex Desktop injects function_call_output with no
  // call_id). Only when none apply can we forward the untouched original bytes.
  const modelUnchanged = body['model'] === resolvedModel;
  const backgroundStripped = _background !== undefined;
  const effortUnchanged =
    nextReasoning === reasoning ||
    (typeof reasoning === 'object' &&
      reasoning !== null &&
      (nextReasoning as { effort?: unknown }).effort === (reasoning as { effort?: unknown }).effort);
  const forwardedBody =
    modelUnchanged && !backgroundStripped && effortUnchanged && repairedInput === undefined
      ? bodyText
      : JSON.stringify({
          ...body,
          model: resolvedModel,
          ...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }),
          ...(repairedInput === undefined ? {} : { input: repairedInput }),
        });
  return new Request(raw, {
    method: raw.method,
    body: forwardedBody,
    headers,
  });
}
```

Do not call `repairOpenAIResponsesToolPairing` from `rewriteOpenAIResponsesCompactRequest`. Do not change `openAIResponsesRawRetry` classification.

- [x] **Step 4: Run the create-path tests**

Run:

```bash
bun test packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts
```

Expected: PASS, including the existing verbatim-bytes test (`forwards the original body bytes verbatim when model, background, and effort are unchanged`) and `preserves an encrypted function call output part through parse and raw forwarding`.

- [x] **Step 5: Lock compact unrepaired**

In `packages/core/src/protocol/openai-responses-compact.test.ts`, add:

```ts
test('does not rewrite unpaired tool output on the compact raw path', async () => {
  const body = {
    model: 'gpt-5.1-codex-max',
    input: [{ type: 'function_call_output', name: 'send_message_to_thread', output: 'hi' }],
  };
  const raw = new Request('https://proxy.test/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, compactCtx);

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'gpt-5.1-codex-max', new Set(), compactCtx);

  expect(await forwarded.json()).toEqual(body);
});
```

If `compactCtx` is not already in scope in that file, use the same `compactCtx` the neighboring compact tests use (`{ operation: 'compact' }`).

Run:

```bash
bun test packages/core/src/protocol/openai-responses-compact.test.ts
```

Expected: PASS. Compact still forwards the unpaired output because `rewriteOpenAIResponsesCompactRequest` does not call the repair.

- [x] **Step 6: Confirm convert still rejects missing call_id**

Run:

```bash
bun test packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern "rejects a tool output without a call_id"
bun test packages/core/src/ingress/openai-responses/request.test.ts --test-name-pattern "synthetic tool output without call_id"
```

Expected: both PASS. Then update comments only.

In `packages/core/src/ingress/openai-responses/request.test.ts`, change the comment on `Given a synthetic tool output without call_id When parsed Then request is accepted` to:

```ts
// Codex Desktop injects cross-thread delegation as a function_call_output
// with no matching call, identified by name/namespace. Parse must not reject
// it; the create raw path rewrites it to a user note before forwarding.
```

In `packages/core/src/transform/openai-responses/openai-responses.test.ts`, change the comment on `rejects a tool output without a call_id as an unsupported feature` to:

```ts
// Parse accepts it so a later raw candidate can run. A model-only candidate
// cannot pair it with a call, and must reject in a way the pipeline can fall
// back from — a terminal 400 would skip that raw candidate. The raw path
// rewrites the item to a user note before the first upstream call.
```

Do not change the convert assertion.

- [x] **Step 7: Changeset**

Create `.changeset/raw-openai-responses-orphan-tool-output.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/core': patch
---

Codex Desktop tool results that arrive without a matching call are rewritten to a user note on the OpenAI Responses raw path, so third-party relays no longer reject the whole turn.
```

- [x] **Step 8: Preflight the touched packages**

Run:

```bash
bun test packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/protocol/openai-responses-compact.test.ts packages/core/src/protocol/openai-responses/tool-pairing-retry/tool-pairing-retry.test.ts packages/core/src/transform/openai-responses/openai-responses.test.ts packages/core/src/ingress/openai-responses/request.test.ts
```

Expected: PASS.

If `bun run check` is cheap in this worktree, run it too. Do not claim done on a failing oxlint/oxfmt check.

- [x] **Step 9: Commit**

```bash
git add \
  packages/core/src/protocol/openai-responses.ts \
  packages/core/src/protocol/openai-responses.test.ts \
  packages/core/src/protocol/openai-responses-compact.test.ts \
  packages/core/src/ingress/openai-responses/request.test.ts \
  packages/core/src/transform/openai-responses/openai-responses.test.ts \
  docs/superpowers/specs/2026-09-17-raw-openai-responses-orphan-tool-output-design.md \
  docs/superpowers/plans/2026-09-17-raw-openai-responses-orphan-tool-output.md \
  .changeset/raw-openai-responses-orphan-tool-output.md
git commit -m "fix(core): rewrite unpaired Responses tool outputs on the raw path

Codex Desktop injects function_call_output without call_id. Third-party
relays 422 that item; repair it to a user note before the first attempt.

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-review

1. Spec coverage: first-attempt repair, no generic-422 classifier, convert rejection unchanged, compact unrepaired, payload preserved as a note, verbatim bytes for paired bodies, changeset on `aio-proxy` + `@aio-proxy/core`.
2. Placeholders: none. Tests and the `rewriteOpenAIResponsesRequest` body are copied in full.
3. Types: `repairOpenAIResponsesToolPairing(readonly unknown[]) => unknown[] | undefined` matches the existing export used by `openAIResponsesRawRetry`.
