# OpenAI Responses Cross-Protocol Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow OpenAI Responses requests with top-level `instructions` and a hosted `web_search` declaration to reach cross-protocol model candidates without changing raw Responses forwarding.

**Architecture:** Keep the raw route untouched. On the model route, normalize top-level `instructions` into a leading system message and recognize only the hosted `web_search` declaration so it can be deliberately excluded from the generic function ToolSet. All other hosted tool types retain the existing unsupported-feature behavior.

**Tech Stack:** TypeScript, Zod, Bun test, AI SDK model messages.

## Global Constraints

- Preserve same-protocol OpenAI Responses raw request bytes.
- Do not turn hosted `web_search` into a function tool or execute a proxy-owned search.
- Keep unsupported hosted tools rejected on the model path.
- Keep handwritten implementation files below 300 lines.
- Add a patch changeset for both `@aio-proxy/core` and `aio-proxy`.

---

### Task 1: Convert top-level instructions on the model path

**Files:**
- Modify: `packages/core/src/ingress/openai-responses/index.ts`
- Modify: `packages/core/src/transform/openai-responses/openai-responses.ts`
- Test: `packages/core/src/transform/openai-responses/openai-responses.test.ts`

**Interfaces:**
- Consumes: `OpenAIResponsesRequest.instructions?: string`
- Produces: a leading `{ role: 'system', content: instructions }` model message when the field is present.

- [ ] **Step 1: Write the failing test**

```ts
test('prepends top-level instructions as a system message', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    instructions: 'Follow the repository guidance.',
    input: 'hello',
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    { role: 'system', content: 'Follow the repository guidance.' },
    { role: 'user', content: 'hello' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern 'prepends top-level instructions'`

Expected: FAIL because model conversion rejects the unknown `instructions` field.

- [ ] **Step 3: Write minimal implementation**

```ts
// OpenAIResponsesRequestSchema
instructions: z.string().optional(),

// openAIResponsesToModelMessages
messages: [
  ...(request.instructions === undefined ? [] : [{ role: 'system' as const, content: request.instructions }]),
  ...inputMessages,
],
```

Add `instructions` to the model-path supported top-level key set. Do not modify raw request rewriting.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern 'prepends top-level instructions'`

Expected: PASS.

### Task 2: Accept and omit hosted web search on the model path

**Files:**
- Modify: `packages/core/src/ingress/openai-responses/tools.ts`
- Modify: `packages/core/src/transform/openai-responses/tools.ts`
- Modify: `packages/core/src/ingress/openai-responses/index.ts`
- Test: `packages/core/src/ingress/openai-responses/request.test.ts`
- Test: `packages/core/src/transform/openai-responses/openai-responses.test.ts`

**Interfaces:**
- Consumes: `tools: [{ type: 'web_search' }]`
- Produces: no AI SDK function tool and one `web_search`/`tools.0.type` dropped diagnostic on a model invocation.

- [ ] **Step 1: Write the failing tests**

```ts
expect(parseOpenAIResponses({ model: 'gpt-5-mini', input: 'x', tools: [{ type: 'web_search' }] }).tools).toEqual([
  { type: 'web_search' },
]);

expect(openAIResponsesToModelMessages(request).tools).toBeUndefined();
expect(warn).toHaveBeenCalledWith(
  '[aio-proxy] OpenAI Responses model conversion degraded',
  'web_search',
  'tools.0.type',
  'dropped',
);
```

Keep the existing `file_search` assertion unchanged so an unrelated hosted tool still parses as the unsupported sentinel.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/ingress/openai-responses/request.test.ts packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern 'web search|raw-only'`

Expected: FAIL because `web_search` is currently converted to `__aio_proxy_unsupported_tool__` and model conversion throws 501.

- [ ] **Step 3: Write minimal implementation**

```ts
const webSearchToolSchema = z.object({ type: z.literal('web_search') }).loose();

// Normalize only the known hosted tool; all other sentinels still reject.
if (tool.type === 'web_search') {
  warnOpenAIResponsesDegradation('web_search', `${path}.type`, 'dropped');
  continue;
}
```

Export the web-search tool type from the ingress barrel and add it to `OpenAIResponsesTool`. Do not add it to `OpenAIResponsesExecutableTool`, because that type represents AI SDK function-tool materialization.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/ingress/openai-responses/request.test.ts packages/core/src/transform/openai-responses/openai-responses.test.ts --test-name-pattern 'web search|raw-only'`

Expected: PASS; `web_search` is accepted and omitted, while `file_search` remains unsupported.

### Task 3: Release metadata and verification

**Files:**
- Create: `.changeset/<generated-name>.md`

**Interfaces:**
- Produces: patch release notes for `@aio-proxy/core` and `aio-proxy` describing OpenAI Responses cross-protocol compatibility.

- [ ] **Step 1: Create the changeset**

Run: `bun changeset`

Select patch releases for `@aio-proxy/core` and `aio-proxy`, then describe that OpenAI Responses model routing now accepts top-level `instructions` and hosted `web_search` from compatible clients.

- [ ] **Step 2: Run focused regression tests**

Run: `bun test packages/core/src/ingress/openai-responses/request.test.ts packages/core/src/transform/openai-responses/openai-responses.test.ts`

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run: `bun run preflight`

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no changes outside the implementation, tests, changeset, and existing untracked `.reference`.
