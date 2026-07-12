# Protocol Egress Metadata and Official SDK Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve upstream response metadata when available, generate stable unique fallbacks for streaming, and type every protocol response/event with the official provider SDK.

**Architecture:** Add a small `ModelEgressContext` to the existing protocol adapter seam and pass the selected candidate model from the shared pipeline. Each egress writer consumes native AI SDK `TextStreamPart` events, uses `finish-step.response` for non-streaming metadata, and creates protocol-specific fallback identifiers before streaming begins.

**Tech Stack:** Bun, TypeScript 6, AI SDK 7, `@anthropic-ai/sdk`, `openai`, `@google/genai`, Bun test.

## Global Constraints

- Follow CPA behavior: reuse upstream metadata when available; otherwise generate a unique response-local fallback.
- Use complete official SDK response and stream event types; do not use `Partial` to hide missing required fields.
- Do not change raw same-protocol passthrough behavior.
- Keep provider invocation as `ReadableStream<TextStreamPart<ToolSet>>`; do not introduce private stream events.
- Write and run failing tests before each production change.

---

### Task 1: Add the egress metadata seam

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/routes/pipeline.ts`
- Modify: `packages/server/_test/pipeline-helpers.ts`
- Test: `packages/server/_test/pipeline.test.ts`

**Interfaces:**
- Produces: `type ModelEgressContext = { readonly modelId: string }`
- Changes: `modelJson(stream, egressContext)` and `modelSse(stream, egressContext)`

- [x] **Step 1: Write failing pipeline tests**

Add adapter spies that capture the second argument and assert both JSON and SSE model paths receive `{ modelId: "hybrid-model" }` for the selected candidate.

- [x] **Step 2: Verify RED**

Run: `rtk bun test packages/server/_test/pipeline.test.ts`

Expected: FAIL because the adapter methods receive only the stream.

- [x] **Step 3: Implement the minimal seam**

Define and export `ModelEgressContext`, update the adapter function signatures, and call writers as:

```ts
const egress = { modelId: candidate.modelId } satisfies ModelEgressContext;
adapter.modelSse(stream, egress);
await adapter.modelJson(captured.value, egress);
```

- [x] **Step 4: Verify GREEN**

Run: `rtk bun test packages/server/_test/pipeline.test.ts packages/core/_test/protocol`

Expected: PASS.

### Task 2: Add official SDK type dependencies

**Files:**
- Modify: `package.json`
- Modify: `packages/core/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces type-only imports from `@anthropic-ai/sdk`, `openai`, and `@google/genai`.

- [x] **Step 1: Add pinned catalog entries and core dependencies**

Use the currently verified versions:

```json
"@anthropic-ai/sdk": "0.111.0",
"openai": "6.46.0",
"@google/genai": "2.11.0"
```

- [x] **Step 2: Install and verify resolution**

Run: `rtk bun install`

Expected: exit 0 and lockfile entries for all three packages.

### Task 3: Align Anthropic Messages egress

**Files:**
- Modify: `packages/core/src/egress/anthropic-messages.ts`
- Modify: `packages/core/src/protocol/anthropic-messages.ts`
- Test: `packages/core/_test/egress/anthropic-messages.test.ts`
- Test: `packages/server/_test/anthropic-messages.test.ts`

**Interfaces:**
- Returns: official `Message`
- Emits: official `RawMessageStreamEvent`

- [x] **Step 1: Write failing metadata tests**

Add a `finish-step` fixture with `response: { id: "msg_upstream", modelId: "claude-upstream", timestamp }`. Assert non-streaming output reuses both values. Add two streaming calls and assert each `message_start.message.id` starts with `msg_`, differs between calls, remains stable within a call, and uses the provided egress model.

- [x] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/anthropic-messages.test.ts`

Expected: FAIL on fixed ID/model and incomplete official fields.

- [x] **Step 3: Implement official response and event shapes**

Import `Message`, `RawMessageStreamEvent`, content block, stop reason, and usage types from `@anthropic-ai/sdk/resources/messages/messages`. Generate fallback IDs with `msg_${crypto.randomUUID()}`. Capture `finish-step.response` for JSON. Supply the required official message, usage, text block, and stream event fields.

- [x] **Step 4: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress/anthropic-messages.test.ts packages/server/_test/anthropic-messages.test.ts`

Expected: PASS.

### Task 4: Align OpenAI Chat Completions egress

**Files:**
- Modify: `packages/core/src/egress/openai-completions.ts`
- Modify: `packages/core/src/protocol/openai-completions.ts`
- Test: `packages/core/_test/egress/openai-completions.test.ts`
- Test: `packages/server/_test/openai-completions.test.ts`

**Interfaces:**
- Returns: official `ChatCompletion`
- Emits: official `ChatCompletionChunk`

- [x] **Step 1: Write failing official metadata tests**

Assert JSON output reuses `finish-step.response.id/modelId/timestamp`, and streaming chunks include one stable fallback ID plus required `created` and `model` fields.

- [x] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/openai-completions.test.ts`

Expected: FAIL because current JSON ignores finish-step metadata and required fields are absent.

- [x] **Step 3: Implement official Chat types**

Import `ChatCompletion` and `ChatCompletionChunk` from `openai/resources/chat/completions/completions`. Map AI SDK usage, choices, assistant messages, tool calls, creation time, and model to the complete official structures.

- [x] **Step 4: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress/openai-completions.test.ts packages/server/_test/openai-completions.test.ts`

Expected: PASS.

### Task 5: Align OpenAI Responses egress

**Files:**
- Modify: `packages/core/src/egress/openai-responses.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts`
- Test: `packages/core/_test/egress/openai-responses.test.ts`
- Test: `packages/server/_test/openai-responses.test.ts`

**Interfaces:**
- Returns: official `Response`
- Emits: official `ResponseStreamEvent`

- [x] **Step 1: Write failing identity and event consistency tests**

Assert non-streaming reuses finish-step response metadata. Parse streaming frames and assert response, reasoning, message, `item_id`, and completed payload references are internally consistent, have increasing `sequence_number` values, and differ across independent responses.

- [x] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/openai-responses.test.ts`

Expected: FAIL on fixed IDs and missing official fields.

- [x] **Step 3: Implement complete Response objects/events**

Import `Response` and `ResponseStreamEvent` from `openai/resources/responses/responses`. Create response-local `resp_`, `msg_`, and `rs_` identifiers, a monotonic sequence counter, complete top-level response defaults, and typed event constructors using `Extract<ResponseStreamEvent, { type: T }>`.

- [x] **Step 4: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress/openai-responses.test.ts packages/server/_test/openai-responses.test.ts`

Expected: PASS.

### Task 6: Align Gemini generateContent egress

**Files:**
- Modify: `packages/core/src/egress/gemini-generate-content.ts`
- Modify: `packages/core/src/protocol/gemini-generate-content.ts`
- Test: `packages/core/_test/egress/gemini-generate-content.test.ts`
- Test: `packages/server/_test/gemini-generate-content.test.ts`

**Interfaces:**
- Uses official serializable fields of `GenerateContentResponse` and official `Candidate`, `Content`, `Part`, and `GenerateContentResponseUsageMetadata`.

- [x] **Step 1: Write failing metadata tests**

Assert JSON reuses finish-step `id/modelId`; streaming chunks share one generated `responseId`, expose the selected model as `modelVersion`, and independent streams use different IDs.

- [x] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/gemini-generate-content.test.ts`

Expected: FAIL because current output omits both metadata fields.

- [x] **Step 3: Implement typed Gemini wire responses**

Use official nested types and a serializable response type based on the official response fields. Generate a response-local ID before streaming and capture finish-step response metadata for JSON.

- [x] **Step 4: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress/gemini-generate-content.test.ts packages/server/_test/gemini-generate-content.test.ts`

Expected: PASS.

### Task 7: Final compatibility verification

**Files:**
- Modify only if verification identifies a regression.

- [x] **Step 1: Run all core/server unit tests**

Run: `rtk bun run --filter @aio-proxy/core test:unit`

Run: `rtk bun run --filter @aio-proxy/server test:unit`

Expected: PASS with zero failures.

- [x] **Step 2: Run static checks and builds**

Run: `rtk bun run check`

Run: `rtk bun run build`

Expected: both exit 0.

- [x] **Step 3: Inspect the final diff**

Run: `rtk git diff --check`

Run: `rtk git status --short`

Expected: no whitespace errors and only intended protocol/dependency/test changes.
