# Empty Function Call Arguments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay Codex OpenAI Responses no-argument function calls across protocols instead of returning 400.

**Architecture:** Keep the existing Responses-to-model-message converter and normalize only an exact empty `function_call.arguments` string before JSON parsing. All other values retain the current JSON parsing and invalid-request behavior.

**Tech Stack:** TypeScript, Bun test runner, AI SDK model messages.

## Global Constraints

- Modify only `packages/core/src/transform/openai-responses/compat.ts` and its colocated test.
- Preserve the 400 behavior for non-empty malformed JSON.
- Do not add dependencies or alter schemas, routing, or raw passthrough.

---

### Task 1: Normalize empty function-call arguments

**Files:**
- Modify: `packages/core/src/transform/openai-responses/openai-responses.test.ts`
- Modify: `packages/core/src/transform/openai-responses/compat.ts:221-228`

**Interfaces:**
- Consumes: `parseArguments(value: string, path: string): unknown` from `compat.ts`.
- Produces: a model `tool-call` part with `input: {}` for `function_call.arguments: ''`.

- [ ] **Step 1: Write the failing test**

Add beside `rejects invalid function arguments`:

```ts
test('converts empty function arguments to an empty object', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [{ type: 'function_call', call_id: 'call_1', name: 'get_goal', arguments: '' }],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_goal', input: {} }],
    },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern "empty function arguments"`

Expected: FAIL with `OpenAIResponsesTransformError` at `input.0.arguments`.

- [ ] **Step 3: Write minimal implementation**

Change `parseArguments` so its first statement is:

```ts
if (value === '') return {};
```

Keep the existing `JSON.parse` try/catch untouched so malformed non-empty JSON remains rejected.

- [ ] **Step 4: Run focused tests to verify behavior**

Run: `bun test packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern "empty function arguments|invalid function arguments"`

Expected: both tests PASS.

- [ ] **Step 5: Run package validation and commit**

Run: `bun test packages/core/src/transform/openai-responses/openai-responses.test.ts && bun run check`

Expected: exit 0.

Commit:

```bash
git add packages/core/src/transform/openai-responses/compat.ts packages/core/src/transform/openai-responses/openai-responses.test.ts docs/superpowers/plans/2026-08-06-empty-function-call-arguments.md
git commit -m "fix(core): accept empty function call arguments"
```
