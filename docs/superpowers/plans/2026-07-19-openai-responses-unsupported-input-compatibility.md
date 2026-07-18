# OpenAI Responses Unsupported Input Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept OpenAI Responses requests containing unsupported input items by logging a safe item type, dropping those items, and continuing cross-protocol model conversion instead of rejecting the whole request.

**Architecture:** Keep the compatibility behavior at the two existing protocol boundaries. The ingress schema parses each array element independently and compacts failed parses; the model-message transformer skips parsed item kinds it cannot represent. Do not add an intermediate representation, logging abstraction, or new dependency.

**Tech Stack:** Bun, TypeScript, Zod, `es-toolkit/array` `compact`, Bun test, Turborepo.

## Global Constraints

- Preserve string `input` behavior and all currently supported input item schemas.
- Log one `console.warn` per dropped item using only its `type`; use `unknown` when no safe type exists.
- Never print the full input item, message content, tool arguments, or role value.
- Keep top-level unsupported features such as `previous_response_id`, unsupported tools, and `store` model conversion unchanged.
- Use the existing `es-toolkit` dependency; add no package.
- Keep unit tests colocated with source and keep handwritten files under 300 lines.
- Run `bun run preflight` before review completion.
- Do not modify `.idea/dataSources.xml` or `docs/research/cross-protocol-reasoning-custom-tools-reference.md`.

---

### Task 1: Parse Input Arrays Item by Item

**Files:**
- Modify: `packages/core/src/ingress/openai-responses/index.ts`
- Modify: `packages/core/src/ingress/openai-responses/input-items.ts`
- Test: `packages/core/src/ingress/openai-responses.test.ts`
- Test: `packages/core/src/ingress/openai-responses/request.test.ts`

**Interfaces:**
- Consumes: `openAIResponsesInputItemSchema.safeParse(input: unknown)`.
- Produces: `OpenAIResponsesRequestSchema` whose array `input` output is `OpenAIResponsesInputItem[]` with unparseable elements removed.

- [ ] **Step 1: Replace rejection tests with failing compatibility tests**

In `packages/core/src/ingress/openai-responses.test.ts`, assert that known unsupported and extension item types are logged and removed while a supported message remains:

```ts
test("logs and ignores unsupported input items", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const additionalTools = { type: "additional_tools", role: "developer", tools: [] };
  const computerCall = { type: "computer_call", id: "computer_1" };

  try {
    expect(
      parseOpenAIResponses({
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "hello" }, additionalTools, computerCall],
      }).input,
    ).toEqual([{ role: "user", content: "hello" }]);
    expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "additional_tools");
    expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "computer_call");
  } finally {
    warn.mockRestore();
  }
});
```

In `packages/core/src/ingress/openai-responses/request.test.ts`, replace strict per-item rejection assertions with a privacy regression:

```ts
test("Given unparseable input items When parsed Then they are logged and ignored", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const sensitiveMarker = "secret-role-must-not-be-logged";
  const invalidRole = { role: sensitiveMarker, content: "bad" };
  const invalidContent = { role: "user", content: [{ type: "input_text" }] };

  try {
    expect(parseOpenAIResponses({ model: "gpt-5-mini", input: [invalidRole, invalidContent] }).input).toEqual([]);
    expect(warn).toHaveBeenNthCalledWith(1, "[aio-proxy] Unsupported OpenAI Responses input item", "unknown");
    expect(warn).toHaveBeenNthCalledWith(2, "[aio-proxy] Unsupported OpenAI Responses input item", "unknown");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveMarker);
  } finally {
    warn.mockRestore();
  }
});
```

- [ ] **Step 2: Run the ingress tests and verify RED**

Run:

```bash
bun test packages/core/src/ingress/openai-responses.test.ts packages/core/src/ingress/openai-responses/request.test.ts
```

Expected: the unsupported item case throws `OpenAIResponsesUnsupportedFeatureError`, and the malformed item case throws `ZodError`.

- [ ] **Step 3: Implement per-item safe parsing and compaction**

In `packages/core/src/ingress/openai-responses/index.ts`, use the existing dependency:

```ts
import { compact } from "es-toolkit/array";
```

Replace the array branch of `input` with:

```ts
z
  .array(
    z.unknown().transform((item) => {
      const parsed = openAIResponsesInputItemSchema.safeParse(item);
      if (!parsed.success) {
        const type =
          typeof item === "object" && item !== null && "type" in item && typeof item.type === "string"
            ? item.type
            : "unknown";
        console.warn("[aio-proxy] Unsupported OpenAI Responses input item", type);
      }
      return parsed.success ? parsed.data : undefined;
    }),
  )
  .min(1)
  .transform(compact)
```

Remove `unsupportedInputItemFeature` from the ingress pre-probe so built-in unsupported input items follow the same log-and-drop path. Delete its now-unused type list and function from `packages/core/src/ingress/openai-responses/input-items.ts`. Keep `unsupportedToolFeature` and `previous_response_id` handling unchanged.

- [ ] **Step 4: Run the ingress tests and verify GREEN**

Run:

```bash
bun test packages/core/src/ingress/openai-responses.test.ts packages/core/src/ingress/openai-responses/request.test.ts
```

Expected: all tests pass and mocked warnings contain only safe type strings.

- [ ] **Step 5: Commit the ingress boundary change**

```bash
git add packages/core/src/ingress/openai-responses/index.ts packages/core/src/ingress/openai-responses/input-items.ts packages/core/src/ingress/openai-responses.test.ts packages/core/src/ingress/openai-responses/request.test.ts
git commit -m "fix(core): ignore unsupported responses input items"
```

---

### Task 2: Skip Non-Portable Parsed Items During Model Conversion

**Files:**
- Modify: `packages/core/src/transform/openai-responses.ts`
- Test: `packages/core/src/transform/openai-responses.test.ts`

**Interfaces:**
- Consumes: `readonly OpenAIResponsesInputItem[]` from ingress.
- Produces: `ModelMessage[]` that excludes `reasoning` and `item_reference` items while preserving supported messages and function history.

- [ ] **Step 1: Write failing transform tests**

Change the existing reasoning and item-reference tests to include a supported user message after the unsupported item. Assert the conversion returns that message and emits:

```ts
expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "reasoning");
```

and:

```ts
expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "item_reference");
```

- [ ] **Step 2: Run the transform test and verify RED**

Run:

```bash
bun test packages/core/src/transform/openai-responses.test.ts
```

Expected: both tests throw `OpenAIResponsesUnsupportedFeatureError` before reaching the supported user message.

- [ ] **Step 3: Implement log-and-skip conversion**

In `inputMessages`, replace the two throws with one switch branch:

```ts
case "reasoning":
case "item_reference":
  console.warn("[aio-proxy] Unsupported OpenAI Responses input item", item.type);
  previousType = undefined;
  break;
```

Reset `previousType` so tool-call aggregation never spans an ignored semantic boundary. Leave invalid function arguments, image outputs, and `store: true` as errors.

- [ ] **Step 4: Run the transform test and verify GREEN**

Run:

```bash
bun test packages/core/src/transform/openai-responses.test.ts
```

Expected: all transform tests pass.

- [ ] **Step 5: Commit the model conversion change**

```bash
git add packages/core/src/transform/openai-responses.ts packages/core/src/transform/openai-responses.test.ts
git commit -m "fix(core): skip non-portable responses history"
```

---

### Task 3: Update Routing Contracts

**Files:**
- Modify: `packages/server/src/routes/openai-responses-fallback.integration.test.ts`
- Modify: `packages/server/src/routes/openai-responses-observability.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.test.ts`
- Modify: `packages/server/src/routes/pipeline/rejection-lifecycle.test.ts`

**Interfaces:**
- Consumes: the OpenAI Responses adapter's new log-and-drop model invocation behavior.
- Produces: routing tests that expect the first model candidate to handle reasoning/item-reference history after those items are dropped.

- [ ] **Step 1: Remove obsolete early-rejection cases**

Delete the `unsupported built-in item` case from `openai-responses-observability.test.ts`. Delete the two rejection-lifecycle tests that expect `computer_call` or an invalid item role to produce a parse-time 400/501. The privacy guarantee is now covered by the mocked-console ingress test.

In `openai-responses-fallback.integration.test.ts`, keep only `store: true` in `rawOnlyFeatures`; reasoning and item references are no longer raw-only.

- [ ] **Step 2: Update model-candidate expectations**

In `pipeline/attempt.test.ts`, change the reasoning case to assert:

```ts
expect(await response.json()).toMatchObject({ output_text: "model response", status: "completed" });
expect(model.calls.model).toHaveLength(1);
expect(raw.calls.raw).toHaveLength(0);
```

Change the item-reference case to assert the first model provider succeeds, the second provider is not invoked, and `modelInvocation` is materialized once:

```ts
expect(response.status).toBe(200);
expect(materializations).toBe(1);
expect(first.calls.model).toHaveLength(1);
expect(second.calls.model).toHaveLength(0);
```

- [ ] **Step 3: Run affected server tests**

Run with the server preload:

```bash
bun run --filter @aio-proxy/server test:unit -- src/routes/openai-responses-observability.test.ts src/routes/openai-responses-fallback.integration.test.ts src/routes/pipeline/rejection-lifecycle.test.ts src/routes/pipeline/attempt.test.ts
```

Expected: 11 tests pass, 0 fail.

- [ ] **Step 4: Commit routing contract changes**

```bash
git add packages/server/src/routes/openai-responses-fallback.integration.test.ts packages/server/src/routes/openai-responses-observability.test.ts packages/server/src/routes/pipeline/attempt.test.ts packages/server/src/routes/pipeline/rejection-lifecycle.test.ts
git commit -m "test(server): accept dropped responses history"
```

---

### Task 4: Replay the Regression and Verify the Workspace

**Files:**
- Verify only; no production files.

**Interfaces:**
- Consumes: the captured 318-item request at `/Users/baran/.codex/attachments/012218db-ba16-44e3-909d-326391ded145/pasted-text.txt`.
- Produces: proof that ingress and model conversion complete without the original 400 or a later 501.

- [ ] **Step 1: Replay the captured request**

Run:

```bash
bun -e 'import { openAIResponsesToModelMessages, parseOpenAIResponses } from "./packages/core/src/index.ts"; const body = await Bun.file("/Users/baran/.codex/attachments/012218db-ba16-44e3-909d-326391ded145/pasted-text.txt").json(); const warnings = new Map(); console.warn = (_message, type) => warnings.set(type, (warnings.get(type) ?? 0) + 1); const parsed = parseOpenAIResponses(body); const converted = openAIResponsesToModelMessages(parsed); console.log(JSON.stringify({ rawInputItems: body.input.length, parsedInputItems: parsed.input.length, modelMessages: converted.messages.length, warnings: Object.fromEntries(warnings) }));'
```

Expected:

```json
{"rawInputItems":318,"parsedInputItems":228,"modelMessages":131,"warnings":{"additional_tools":1,"custom_tool_call":40,"custom_tool_call_output":40,"agent_message":9,"reasoning":97}}
```

- [ ] **Step 2: Run the complete repository verification**

Run:

```bash
bun run preflight
```

Expected: all workspace unit tests, type tests, artifact tests, and `dev-task-graph.test.ts` pass. Existing non-failing Biome warnings may still be printed.

- [ ] **Step 3: Check the final diff before review**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the ten planned tracked files plus the plan are modified. `.idea/dataSources.xml` and the research document remain untracked and untouched.

- [ ] **Step 4: Review before committing the recovered implementation**

Use `code-review` with fixed point `HEAD` and this plan as the spec source. Do not commit until the Standards and Spec findings are resolved or explicitly accepted.
