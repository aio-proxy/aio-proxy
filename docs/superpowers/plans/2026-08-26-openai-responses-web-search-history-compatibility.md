# OpenAI Responses Hosted History and Custom Grammar Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore useful `grok-4.6` model attempts for the captured request family by safely omitting completed hosted-search evidence from model history and compiling unsupported xAI custom grammar tools into reversible ordinary function tools.

**Architecture:** The OpenAI Responses adapter recognizes one conservative hosted-history shape and carries safe diagnostics on the cached provider-neutral invocation. The xAI Grok OAuth runtime independently compiles valid text/grammar custom declarations, tool choice, and history at its outbound request boundary. Existing wire metadata restores model-produced function calls to client-facing `custom_tool_call` items; Cursor receives a characterization test but remains a separate production fault line.

**Tech Stack:** Bun 1.4, TypeScript 7, Zod 4, AI SDK 7, LogTape, `bun:test`, Changesets.

**Spec:** `docs/superpowers/specs/2026-08-26-openai-responses-web-search-history-compatibility-design.md`

## Global Constraints

- Same-protocol raw forwarding preserves every hosted-search and custom grammar field and retains exact bytes whenever existing top-level rewrite logic is a no-op.
- Model conversion may omit `web_search_call` only when `status === "completed"`, top-level `results` is not owned, and `action.sources` is not owned.
- Owned `results` or `action.sources` remains unsupported even when the value is `null` or an empty array.
- Never fabricate search calls, search results, visible text, grammar-conforming output, or proxy-owned tool execution.
- Grammar function fallback applies only to Responses custom tools; never convert `text.format.type === "grammar"` into a tool.
- xAI function fallback preserves tool name/description and uses exactly one required string property named `input`.
- Do not log search payloads, grammar definitions, tool names, model IDs, messages, request bodies, headers, credentials, or arbitrary upstream errors in downgrade diagnostics.
- Cursor production recovery is not an acceptance criterion for this plan; only its local function-tool transport boundary is characterized.
- Do not change OAuth lifecycle, catalog behavior, database schemas, dashboard UI, dependencies, or public plugin SDK types.
- Add a patch changeset for `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/plugin-xai-grok`, and `aio-proxy`.
- Before completion, run focused tests, affected package tests, `bun run check`, `bun run preflight`, and `git diff --check` through `rtk`.

---

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `packages/core/src/ingress/openai-responses/input-items.ts` | Defines the loose known `web_search_call` item. |
| `packages/core/src/ingress/openai-responses.test.ts` | Protects typed hosted-search ingress. |
| `packages/core/src/protocol/adapter.ts` | Carries typed model-invocation downgrade diagnostics. |
| `packages/core/src/transform/openai-responses/compat.ts` | Applies the completed/no-results/no-sources gate and adjacency reset. |
| `packages/core/src/transform/openai-responses/openai-responses.ts` | Returns converted messages and diagnostics together. |
| `packages/core/src/transform/openai-responses/compatibility.test.ts` | Covers safe omission and every unsafe owned-field shape. |
| `packages/core/src/protocol/openai-responses.ts` | Copies diagnostics onto the lazily cached invocation. |
| `packages/core/src/protocol/openai-responses-basic.test.ts` | Protects custom grammar function-call restoration on client egress. |
| `packages/core/src/egress/openai-responses-custom.test.ts` | Protects custom-call restoration metadata and fail-closed `input` decoding. |
| `packages/plugins/xai-grok/src/runtime/runtime.ts` | Compiles text and grammar custom tools into xAI-compatible functions. |
| `packages/plugins/xai-grok/src/runtime/runtime.test.ts` | Proves grammar reaches the real dynamic-fetch host and remains payload-safe. |
| `packages/server/src/server-log.ts` | Adds the hosted-search downgrade event variant. |
| `packages/server/src/routes/pipeline/logging.ts` | Shapes candidate identity plus typed diagnostics. |
| `packages/server/src/routes/pipeline/attempt/model.ts` | Emits diagnostics only for candidates that reach invocation. |
| `packages/server/src/routes/pipeline/attempt.test.ts` | Covers exact raw bytes and raw-to-model fallback without local 501. |
| `packages/server/src/logging/bridge/bridge.test.ts` | Protects event forwarding and info-level mapping. |
| `packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts` | Characterizes function-form `apply_patch` reaching mocked Cursor transport. |
| `.changeset/responses-hosted-history-grammar.md` | Publishes the compatibility fix through the product package. |

### Task 1: Recognize and safely omit completed hosted-search evidence

**Files:**
- Modify: `packages/core/src/ingress/openai-responses/input-items.ts`
- Modify: `packages/core/src/ingress/openai-responses.test.ts`
- Modify: `packages/core/src/protocol/adapter.ts`
- Modify: `packages/core/src/transform/openai-responses/types.ts`
- Modify: `packages/core/src/transform/openai-responses/compat.ts`
- Modify: `packages/core/src/transform/openai-responses/openai-responses.ts`
- Modify: `packages/core/src/transform/openai-responses/compatibility.test.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts`

**Interfaces:**
- Consumes: parsed `OpenAIResponsesRequest.input`, ordered call/result conversion, and `OpenAIResponsesUnsupportedFeatureError`.
- Produces:

```ts
export type ModelInvocationDiagnostic = Readonly<{
  feature: 'web_search_call';
  action: 'dropped';
  reason: 'completed_without_results_or_sources';
  inputIndex: number;
}>;
```

- Produces `convertOpenAIResponsesInput(...): { messages: ModelMessage[]; diagnostics: ModelInvocationDiagnostic[] }`.

- [ ] **Step 1: Write the failing ingress preservation test**

Add to `packages/core/src/ingress/openai-responses.test.ts`:

```ts
test('preserves completed web search history as a known input item', () => {
  const item = {
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: { type: 'search', query: 'private-marker' },
  } as const;

  expect(parseOpenAIResponses({ model: 'gpt-5.6-terra', input: [item] }).input).toEqual([item]);
});
```

- [ ] **Step 2: Write the failing safe-omission and unsafe-shape tests**

Add to `packages/core/src/transform/openai-responses/compatibility.test.ts`:

```ts
test('drops completed web search evidence without results or action sources', () => {
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'open_page' } },
      { role: 'assistant', content: 'Prior answer.' },
      { role: 'user', content: 'Continue.' },
    ],
  });

  expect(openAIResponsesToModelMessages(request)).toMatchObject({
    messages: [
      { role: 'assistant', content: 'Prior answer.' },
      { role: 'user', content: 'Continue.' },
    ],
    diagnostics: [{
      feature: 'web_search_call',
      action: 'dropped',
      reason: 'completed_without_results_or_sources',
      inputIndex: 0,
    }],
  });
});

test.each([
  ['missing status', { type: 'web_search_call' }],
  ['in-progress status', { type: 'web_search_call', status: 'in_progress' }],
  ['failed status', { type: 'web_search_call', status: 'failed' }],
  ['unknown status', { type: 'web_search_call', status: 'mystery' }],
  ['owned results null', { type: 'web_search_call', status: 'completed', results: null }],
  ['owned results empty', { type: 'web_search_call', status: 'completed', results: [] }],
  ['owned results populated', { type: 'web_search_call', status: 'completed', results: [{ title: 'x' }] }],
  ['owned sources null', { type: 'web_search_call', status: 'completed', action: { sources: null } }],
  ['owned sources empty', { type: 'web_search_call', status: 'completed', action: { sources: [] } }],
  ['owned sources populated', { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'x' }] } }],
])('keeps %s raw-only on the model path', (_name, item) => {
  const request = parseOpenAIResponses({ model: 'gpt-5.6-terra', input: [item] });
  expect(() => openAIResponsesToModelMessages(request)).toThrow(OpenAIResponsesUnsupportedFeatureError);
});
```

Retain the existing adjacency test and change its hosted item to the new known shape so it proves `state.previous = undefined`.

- [ ] **Step 3: Run the core tests and verify RED**

Run:

```bash
rtk bun test \
  packages/core/src/ingress/openai-responses.test.ts \
  packages/core/src/transform/openai-responses/compatibility.test.ts
```

Expected: known ingress and safe omission fail because `web_search_call` still uses the unsupported sentinel; unsafe cases remain rejected.

- [ ] **Step 4: Add the loose known item schema**

In `input-items.ts`, add a `.loose()` schema with `type`, optional `id`, optional string `status`, optional unknown `action`, and optional unknown `results`. Register only `web_search_call`; do not add preview or other hosted families.

- [ ] **Step 5: Add and propagate the diagnostic contract**

Add `ModelInvocationDiagnostic` and optional `diagnostics` to `ModelInvocation`. Change the Responses transform result to always return a diagnostics array and copy a non-empty array onto the cached invocation.

- [ ] **Step 6: Implement the exact gate and adjacency reset**

Add these helpers in `compat.ts`:

```ts
function hasOwnedActionSources(item: Extract<OpenAIResponsesInputItem, { type: 'web_search_call' }>): boolean {
  const action = item.action;
  return typeof action === 'object' && action !== null && Object.hasOwn(action, 'sources');
}

function canDropCompletedWebSearch(item: Extract<OpenAIResponsesInputItem, { type: 'web_search_call' }>): boolean {
  return item.status === 'completed' && !Object.hasOwn(item, 'results') && !hasOwnedActionSources(item);
}
```

For an eligible item, clear `state.previous`, append the diagnostic, and emit no message. Otherwise call `rejectOpenAIResponsesFeature('web_search_call', path)`.

- [ ] **Step 7: Run focused and package core verification**

Run:

```bash
rtk bun test \
  packages/core/src/ingress/openai-responses.test.ts \
  packages/core/src/transform/openai-responses/compatibility.test.ts \
  packages/core/src/protocol/openai-responses-basic.test.ts \
  packages/core/src/protocol/openai-responses.test.ts
rtk bun run --filter @aio-proxy/core test:unit
```

Expected: all pass; unknown typed items remain raw-only and source/result-bearing hosted items still reject model conversion.

- [ ] **Step 8: Commit the core behavior**

```bash
rtk git add packages/core/src/ingress/openai-responses packages/core/src/transform/openai-responses packages/core/src/protocol
rtk git commit -m "fix(core): degrade completed hosted search history" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Compile xAI grammar custom tools into reversible function tools

**Files:**
- Modify: `packages/plugins/xai-grok/src/runtime/runtime.ts`
- Modify: `packages/plugins/xai-grok/src/runtime/runtime.test.ts`
- Modify: `packages/core/src/protocol/openai-responses-basic.test.ts`
- Modify: `packages/core/src/egress/openai-responses-custom.test.ts`

**Interfaces:**
- Consumes: valid Responses custom tool metadata and the existing text custom-tool compiler.
- Produces no public API. Each outbound fetch attempt that converts one or more grammar declarations emits exactly one payload-safe warning containing only stable `(feature, action, reason)` constants and forwards function declarations with the canonical `{ input: string }` schema.

- [ ] **Step 1: Replace the local-501 tests with failing host-dispatch tests**

Change the existing `rejects grammar custom tools locally without calling Grok` test to assert:

```ts
expect(hostCalls).toBe(1);
expect(response.status).toBe(200);
expect(await captured?.json()).toEqual({
  model: 'grok-4.6',
  tools: [{
    type: 'function',
    name: 'apply_patch',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
      additionalProperties: false,
    },
  }],
  tool_choice: { type: 'function', name: 'apply_patch' },
  input: [
    { type: 'function_call', call_id: 'call_1', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  ],
});
```

Use the trace-derived shape `name: 'apply_patch'`, `syntax: 'lark'`, and a short non-sensitive grammar fixture. Update the nested grammar test to expect the nested declaration to become a function rather than a 501.

- [ ] **Step 2: Add a once-per-fetch, payload-safe warning test**

Spy on `console.warn` and dispatch one outbound request containing two accepted grammar declarations, including a nested declaration. Put `private-tool-name-marker` in one tool name and `private-grammar-marker` in a definition. Assert exactly one warning is emitted for that fetch attempt and that its arguments contain only:

```ts
[
  '[aio-proxy] xAI Grok Responses compatibility downgrade',
  'custom_tool.grammar',
  'function_fallback',
  'provider_lacks_native_grammar',
]
```

Invoke the dynamic fetch a second time and assert the warning count becomes two, proving retries or repeated attempts warn once per outbound fetch rather than once per declaration. Assert `JSON.stringify(warningCalls)` contains neither private marker.

- [ ] **Step 3: Run the xAI runtime tests and verify RED**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/runtime.test.ts
```

Expected: grammar cases still return the existing local 501 and host call count remains zero.

- [ ] **Step 4: Compile valid grammar formats through the existing function path**

Delete `unsupportedGrammarCustomTool()` and remove the local-`Response` path completely. Use these exact return types and signatures:

```ts
type CustomToolCompileContext = { grammarFallbackApplied: boolean };

async function outgoingBody(request: Request): Promise<BodyInit | undefined>;
function compileCompatibleCustomTools(value: object): boolean;
function compileToolList(tools: unknown, context: CustomToolCompileContext): boolean;
function compileCustomDeclaration(tool: unknown, context: CustomToolCompileContext): boolean;
```

Remove every `instanceof Response` branch from `createXAIGrokDynamicFetch()`, `outgoingBody()`, `compileCompatibleCustomTools()`, and recursive `compileToolList()` processing. `compileCompatibleCustomTools()` owns one context for the entire body, calls both top-level and nested tool-list compilation, and emits the constant-only warning once after compilation when `grammarFallbackApplied` is true.

In `compileCustomDeclaration()`:

- preserve `format === undefined` as the existing text-compatible custom-tool shape;
- accept `{ type: 'text' }`;
- accept `{ type: 'grammar', syntax: 'regex' | 'lark', definition: string }`;
- set `context.grammarFallbackApplied = true` for each accepted grammar declaration without serializing its name or definition; and
- apply the existing `type = function`, canonical parameters, and `format` deletion.

Emit the warning once per outbound fetch attempt with literal scalar arguments:

```ts
console.warn(
  '[aio-proxy] xAI Grok Responses compatibility downgrade',
  'custom_tool.grammar',
  'function_fallback',
  'provider_lacks_native_grammar',
);
```

Leave invalid/unknown format objects untouched so the runtime does not pretend to understand them.

Add a regression case for `{ type: 'custom', name: 'plain_custom' }` with no `format`: it still reaches the host as the canonical function tool and emits no grammar warning.

- [ ] **Step 5: Preserve tool choice and history conversion**

Keep the existing `custom -> function` tool-choice rewrite and `custom_tool_call` / output history compiler. Extend tests so one grammar request exercises all three shapes together.

- [ ] **Step 6: Protect client-facing custom-call restoration and fail closed on malformed wrappers**

Add a protocol test in `openai-responses-basic.test.ts` that parses a request containing the grammar custom declaration, obtains `invocation.tools?.apply_patch?.metadata` from `openAIResponsesAdapter.modelInvocation(...)`, and puts that exact metadata on the mock stream's `tool-input-start` part before emitting JSON arguments:

```ts
const toolMetadata = invocation.tools?.apply_patch?.metadata;
if (toolMetadata === undefined) throw new TypeError('Expected parsed custom tool metadata');

const stream = aiSdkPartStream([
  { type: 'tool-input-start', id: 'call_1', toolName: 'apply_patch', toolMetadata },
  { type: 'tool-input-delta', id: 'call_1', delta: '{"input":"*** Begin Patch"}' },
  { type: 'tool-input-end', id: 'call_1' },
]);
```

Pass the stream to `writeOpenAIResponsesResponse()` and assert the OpenAI Responses output item is:

```ts
expect.objectContaining({
  type: 'custom_tool_call',
  name: 'apply_patch',
  input: '*** Begin Patch',
})
```

This test must fail if the function wrapper leaks to the client or if the raw string cannot be restored.

In `packages/core/src/egress/openai-responses-custom.test.ts`, add a table-driven test using the existing custom `toolMetadata` fixture. For each malformed arguments string below, emit `tool-input-start`, one `tool-input-delta`, and `tool-input-end`, then assert `writeOpenAIResponsesResponse()` rejects with `OpenAIResponsesTransformError`:

Import `OpenAIResponsesTransformError` from `../error` for the type assertion.

```ts
test.each([
  ['missing input', '{}'],
  ['non-string input', '{"input":42}'],
  ['extra object fields', '{"input":"pwd","extra":true}'],
])('rejects custom call arguments with %s', async (_name, argumentsText) => {
  await expect(
    writeOpenAIResponsesResponse(
      aiSdkPartStream([
        { type: 'tool-input-start', id: 'call_1', toolName: 'exec', toolMetadata: metadata },
        { type: 'tool-input-delta', id: 'call_1', delta: argumentsText },
        { type: 'tool-input-end', id: 'call_1' },
      ]),
      { modelId: 'test-model' },
    ),
  ).rejects.toBeInstanceOf(OpenAIResponsesTransformError);
});
```

- [ ] **Step 7: Run xAI and core round-trip verification**

Run:

```bash
rtk bun test \
  packages/plugins/xai-grok/src/runtime/runtime.test.ts \
  packages/core/src/protocol/openai-responses-basic.test.ts \
  packages/core/src/egress/openai-responses-custom.test.ts \
  packages/core/src/transform/openai-responses/roundtrip.test.ts
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: the real xAI dynamic fetch reaches its host mock, the grammar definition and tool name are absent from the warning, the grammar definition is absent from the outbound body, and client egress restores `custom_tool_call`.

- [ ] **Step 8: Commit the xAI compatibility behavior**

```bash
rtk git add \
  packages/plugins/xai-grok/src/runtime \
  packages/core/src/protocol/openai-responses-basic.test.ts \
  packages/core/src/egress/openai-responses-custom.test.ts
rtk git commit -m "fix(xai-grok): fall back grammar tools to functions" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Emit safe diagnostics, protect exact raw bytes, and characterize Cursor

**Files:**
- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/routes/pipeline/logging.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.test.ts`
- Modify: `packages/server/src/logging/bridge/bridge.test.ts`
- Modify: `packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts`
- Create: `.changeset/responses-hosted-history-grammar.md`

**Interfaces:**
- Consumes: Task 1 diagnostics and existing attempt identity.
- Produces the hosted-search `request.feature_downgraded` log variant with reason `completed_without_results_or_sources`.

- [ ] **Step 1: Rewrite the server regression around real boundaries**

Replace the fake `xAI-like 503 -> Cursor-like success` scenario with a protocol regression containing both captured features. The fixture must be deliberately noncanonical so parse/re-serialize cannot accidentally satisfy the byte-fidelity assertion:

```ts
const sensitiveQuery = 'private-search-marker';
const sensitiveGrammar = 'private-grammar-marker';
const rawText =
  '{  "tools" : [{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"private-grammar-marker"}}], "input" : [{"type":"web_search_call","status":"completed","action":{"type":"search","query":"private-search-marker"}},{"role":"assistant","content":"Prior answer."},{"role":"user","content":"Continue."}], "seed":9007199254740993, "model" : "requested-model" }';
const originalBytes = new TextEncoder().encode(rawText);
```

The raw candidate returns 422 and asserts:

```ts
expect(new Uint8Array(await request.clone().arrayBuffer())).toEqual(originalBytes);
```

The following model candidate succeeds and asserts it receives only surrounding messages plus a function tool named `apply_patch` with the canonical input schema. Do not label the stub as xAI or Cursor; their real runtime boundaries are covered in Task 2 and Step 6 below.

- [ ] **Step 2: Run the server regression and verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/server test:unit -- src/routes/pipeline/attempt.test.ts
```

Expected: model conversion still returns the hosted-search 501 and no downgrade event exists.

- [ ] **Step 3: Extend the server log union and logger helper**

Add the exact hosted-search variant and implement `logModelInvocationDiagnostics(...)` using only typed diagnostic fields plus attempt identity. Keep `request.feature_downgraded` at info level.

- [ ] **Step 4: Emit diagnostics only after candidate capability checks**

In `attempt/model.ts`, call `assertCandidateSupported()` first. Emit diagnostics immediately before starting/invoking the model attempt. Raw attempts and model candidates rejected by another capability emit no hosted-search downgrade event.

- [ ] **Step 5: Narrow the privacy assertion**

Filter only `request.feature_downgraded` events and assert their serialization contains neither the search query marker nor the grammar marker. Do not assert that all debug logs omit request bodies.

- [ ] **Step 6: Add the Cursor request-context handshake characterization test**

In `cursor-model.test.ts`, add a test that supplies:

```ts
options.tools = [{
  type: 'function',
  name: 'apply_patch',
  description: 'Apply a patch',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  },
}];
options.toolChoice = { type: 'tool', toolName: 'apply_patch' };
```

Add a server-frame helper that creates an `execServerMessage` carrying `requestContextArgs` with `ExecServerMessageSchema` and `RequestContextArgsSchema`. Configure the mock transport frames to yield that request before `text('ok')` and `turnEnded()`. Drain the model stream, then:

Extend the test imports with `ExecServerMessageSchema`, `RequestContextArgsSchema`, and `ValueSchema`, plus `toJson` from `@bufbuild/protobuf`.

1. assert the first client write decodes as the existing `runRequest`;
2. decode the subsequent framed write with `fromBinary(AgentClientMessageSchema, frame.subarray(5))`;
3. assert it is `execClientMessage -> requestContextResult -> success`;
4. read `result.value.requestContext?.tools` and assert one tool has `name`, `toolName`, and `providerIdentifier` equal to `apply_patch`, `apply_patch`, and `pi-agent`; and
5. decode `tool.inputSchema` with `fromBinary(ValueSchema, ...)`, convert it with `toJson(ValueSchema, ...)`, and assert it equals the supplied schema exactly.

Keep the final stream-part assertion at `finish`. This test proves the function tool crosses Cursor's local request-context handshake; it must not be described as a production Cursor fix.

- [ ] **Step 7: Add bridge coverage and run focused verification**

Add a representative hosted-search downgrade entry to `bridge.test.ts`, then run:

```bash
rtk bun run --filter @aio-proxy/server test:unit -- \
  src/routes/pipeline/attempt.test.ts \
  src/logging/bridge/bridge.test.ts \
  src/routes/pipeline/diagnostics.test.ts
rtk bun test packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts
```

Expected: exact raw bytes are preserved, the model candidate is invoked, downgrade logs are payload-safe, and function-form `apply_patch` reaches mocked Cursor transport.

- [ ] **Step 8: Add the product changeset**

Create `.changeset/responses-hosted-history-grammar.md`:

```markdown
---
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

Continue OpenAI Responses model fallback across completed hosted-search history and fall back xAI Grok OAuth custom grammar declarations to ordinary function tools with reversible client wire restoration.
```

- [ ] **Step 9: Run affected packages and repository-wide verification**

Run:

```bash
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
rtk bun run --filter @aio-proxy/plugin-cursor test:unit
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run check
rtk bun run preflight
rtk git diff --check
```

Expected: every command exits zero with no new warnings.

- [ ] **Step 10: Review the final diff against the spec**

Run:

```bash
rtk git diff --stat
rtk git diff -- \
  packages/core/src/ingress/openai-responses \
  packages/core/src/transform/openai-responses \
  packages/core/src/protocol \
  packages/plugins/xai-grok/src/runtime \
  packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts \
  packages/server/src/server-log.ts \
  packages/server/src/routes/pipeline \
  packages/server/src/logging/bridge/bridge.test.ts \
  .changeset/responses-hosted-history-grammar.md
```

Confirm that raw payloads are untouched, xAI receives no grammar definition, client egress restores custom calls, unsafe hosted items still reject, and no production Cursor recovery claim appears.

- [ ] **Step 11: Commit diagnostics, characterization, and release note**

```bash
rtk git add \
  docs/superpowers/specs/2026-08-26-openai-responses-web-search-history-compatibility-design.md \
  docs/superpowers/plans/2026-08-26-openai-responses-web-search-history-compatibility.md \
  packages/server/src/server-log.ts \
  packages/server/src/routes/pipeline \
  packages/server/src/logging/bridge/bridge.test.ts \
  packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts \
  .changeset/responses-hosted-history-grammar.md
rtk git commit -m "fix(server): trace Responses compatibility downgrades" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Final Acceptance Checklist

- [ ] Completed `web_search_call` history with no owned results or action sources no longer causes an aio-generated model-conversion 501.
- [ ] Active, ambiguous, result-bearing, and source-bearing hosted items remain raw-only.
- [ ] Same-protocol raw candidates receive the exact original request bytes when no top-level rewrite is required.
- [ ] The captured `apply_patch` Lark grammar reaches the real xAI dynamic-fetch host as a function tool instead of a local 501.
- [ ] xAI tool choice and custom call/output history use matching function wire shapes.
- [ ] Client egress restores a model-produced function call to `custom_tool_call` with raw string input.
- [ ] Hosted-search and xAI runtime downgrade diagnostics contain no search payload, grammar payload, tool name, or model ID; xAI warns once per outbound fetch attempt.
- [ ] Cursor's mocked `requestContextArgs` handshake returns the expected function-tool MCP name and decoded schema, with production Cursor recovery explicitly excluded.
- [ ] Changeset targets the affected internal packages and the `aio-proxy` product package at patch level.
- [ ] `rtk bun run preflight` and `rtk git diff --check` pass.
