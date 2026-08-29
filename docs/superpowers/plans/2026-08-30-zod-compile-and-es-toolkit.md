# Zod 4.5 Compile + es-toolkit 1.52 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Zod to 4.5 and compile inbound request schemas with `z.compile()`, and upgrade es-toolkit to 1.52 with only the replacements that already match this repo's utility rules.

**Architecture:** Catalog bumps land first. Then wrap the *exported final* ingress Zod schemas with `z.compile()` so every model request hits the AOT fast path; invalid input still falls back to the standard parser, so error messages stay identical. es-toolkit work is a version bump plus a short, enumerated cleanup — not a repo-wide rewrite of loops.

**Tech Stack:** Bun catalog (`package.json` `workspaces.catalog`), Zod 4.5 `z.compile()`, es-toolkit 1.52 (`array` / `predicate` / `fp`), existing colocated ingress tests, Changesets.

**Spec:** User request 2026-08-30: (1) upgrade Zod to latest and enable [z.compile](https://zod.dev/compile); (2) upgrade es-toolkit to latest using [es-toolkit.dev/llms.txt](https://es-toolkit.dev/llms.txt), then adopt missing es-toolkit / `es-toolkit/fp` / `es-toolkit/iterator` uses only where they win.

## Global Constraints

- Catalog versions: `"zod": "^4.5.4"` and `"es-toolkit": "1.52.0"` in the root `package.json` `workspaces.catalog`. Do not pin a Zod 4.4.x leftover.
- `z.compile()` is applied only to the **final** schema. `.refine()`, `.extend()`, `.optional()`, `.pipe()`, `.transform()`, `.superRefine()`, and `.loose()` after `z.compile()` return an uncompiled schema.
- Do **not** `import "zod/compile"` (global mode). Zod documents that import as application-wide and not for libraries; `@aio-proxy/plugin-sdk` re-exports `zod`, the dashboard is a browser bundle (`new Function` / CSP), and `bun build --compile` does not honor `bunfig.toml` preload. Per-schema `z.compile()` works in `bun run`, tests, and the standalone CLI binary.
- Do **not** compile `ConfigSchema` / `ConfigAuthoringSchema` (boot/reload only, plus a top-level `.transform()` that rebuilds providers).
- Do **not** compile plugin-sdk credential/account schemas, dashboard form schemas, or anything using `z.coerce` / `.catch(callback)`.
- Do **not** switch `.parse()` / `.safeParse()` to `z.validate()`. Invalid requests must still produce `ZodError` for `packages/core/src/protocol/errors.ts` (`prettifyError`).
- Do **not** enable `z.compile(schema, { strict: true })` at module init on schemas that contain transforms, `.pipe()`, or custom `when` checks. Strict belongs in a unit test for the *simple* schemas only.
- es-toolkit: narrow imports (`es-toolkit/array`, `es-toolkit/object`, `es-toolkit/predicate`, `es-toolkit/fp`). Never `es-toolkit/compat`. Never add `es-toolkit` to a package that does not already declare `"es-toolkit": "catalog:"`.
- Leave every local `isRecord` / `isObject` copy as-is. Do **not** extract a shared helper, do **not** re-export from plugin-sdk, and **never** replace them with `isPlainObject` / `isJSONObject` / `compat/isObject` — those reject class instances, reject functions, or admit arrays.
- Do **not** convert protocol/stream/async/state-machine loops into `fp` or `iterator` pipelines (AGENTS.md Functional Pipelines).
- Do **not** import `es-toolkit/iterator`. Official docs: array helpers are the default when data is already an array and will be fully processed; iterator helpers win only for large/infinite sources or pipelines that stop early. This repo's collections are already arrays, tiny, or fully consumed (ChatGPT catalog `fp` pipe, SQLite `.iterate()` then Map+sort+slice). Native `.find`/`.some`/`.every` already short-circuit. Native `Iterator.prototype` already has map/filter/take; es-toolkit/iterator only adds cartesianProduct/chunk/count/dropWhile/head/iterate/partition/range/scan/takeWhile/uniqBy/zip — none of which we need.
- File layout: keep schemas in their current files. Do not add a `compileZod.ts` helper.
- Changesets: one patch note targeting `aio-proxy` plus every workspace package whose `package.json` lists `zod` or `es-toolkit` as `catalog:`.
- Verify with the package tests named in each task, then `bun run check` plus those tests; `bun run preflight` before finishing.

## Audit findings (do not expand)

Zod compile — compile these (per-request parse):

- `OpenAICompletionsRequestSchema` — `packages/core/src/ingress/openai-completions.ts`
- `OpenAILegacyCompletionsRequestSchema` — `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts`
- `OpenAIEmbeddingsRequestSchema` — `packages/core/src/ingress/openai-embeddings/openai-embeddings.ts`
- `AnthropicMessagesRequestSchema` — `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`
- `GeminiGenerateContentRequestSchema` — `packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts`
- `GeminiInteractionsBodySchema` — `packages/core/src/ingress/gemini-interactions/gemini-interactions.ts`
- `GeminiEmbedContentRequestSchema` / `GeminiBatchEmbedContentsRequestSchema` — `packages/core/src/ingress/gemini-embeddings/gemini-embeddings.ts`
- `OpenAIImageGenerationsInputSchema` / `OpenAIImageEditsInputSchema` — `packages/core/src/ingress/openai-image/openai-image.ts` (module-private; wrap the consts the parse functions already call)

Zod compile — skip:

- `ConfigSchema` / authoring schemas in `packages/types`
- Dashboard search schemas with `z.coerce` and `.catch(undefined)` (`packages/dashboard/src/modules/traces/lib/trace-search/trace-search.ts`)
- Plugin SDK / OAuth credential schemas
- `OpenAIResponsesRequestSchema` — `inputItemSchema` `console.warn`s on unknown items; Zod's invalid-input fallback re-runs transforms, so compile doubles the diagnostic
- `jsonObjectSchema` in `packages/core/src/protocol/request.ts` (one-shot model rewrite, not the request body parser)

es-toolkit — do:

- Bump catalog `1.50.0-dev.2001` → `1.52.0`
- `isEqual` barrel imports → `es-toolkit/predicate` (2 files)
- `[...new Set(array)]` → `uniq(...)` at spread-Set-back-to-array sites in packages that already depend on es-toolkit

es-toolkit — skip:

- `es-toolkit/iterator`: do not import (see Global Constraints)
- `es-toolkit/fp` beyond the ChatGPT catalog that already uses it
- Sharing `isRecord` / replacing local copies with `isPlainObject`
- `pickBy` / `omitBy` / `mapValues` for `Object.fromEntries` reconstitutions — es-toolkit 1.52 assigns into `{}`, so an own `"__proto__"` key mutates the prototype or disappears; `pickBy`/`omitBy` also return `Partial<T>`
- `groupByProviderOptions` (WeakMap fingerprint cache, not `groupBy`)
- `flattenAliasVariants` (domain canonicalization, not `flatten`)
- `packages/logger` unique+sort (no es-toolkit dep)
- `new Set(...)` kept as a Set for `has` / lookup
- Adding es-toolkit to `plugin-sdk`, `xai-grok`, `kimi-code`, `cursor`

---

### Task 1: Bump Zod in the catalog

**Files:**
- Modify: `package.json` (`workspaces.catalog.zod`)
- Modify: `bun.lock` (via `bun install`)

**Interfaces:**
- Consumes: nothing
- Produces: every `"zod": "catalog:"` workspace package resolves `zod@4.5.4` (or the latest 4.5.x `bun install` records). `import { z } from 'zod'` gains `z.compile`.

- [ ] **Step 1: Change the catalog pin**

In root `package.json`, inside `workspaces.catalog`, replace:

```json
"zod": "^4.4.3",
```

with:

```json
"zod": "^4.5.4",
```

- [ ] **Step 2: Install**

Run: `bun install`

Expected: lockfile updates; `packages/core/node_modules/zod/package.json` `"version"` is `4.5.4` or a later 4.5.x.

- [ ] **Step 3: Confirm `z.compile` exists**

Run:

```bash
bun -e 'import { z } from "zod"; const s = z.compile(z.object({ n: z.number() })); console.log(s.parse({ n: 1 }).n)'
```

Expected: prints `1`. If `z.compile is not a function`, the catalog did not resolve 4.5 — fix the pin / lockfile before any schema change.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: bump zod catalog to 4.5"
```

---

### Task 2: Compile OpenAI Completions + Embeddings + Legacy Completions

These three schemas are objects/unions/arrays with no async refinements. They are the strict-compile proving ground.

**Files:**
- Modify: `packages/core/src/ingress/openai-completions.ts`
- Modify: `packages/core/src/ingress/openai-embeddings/openai-embeddings.ts`
- Modify: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts`
- Create: `packages/core/src/ingress/compile.test.ts`
- Test: `packages/core/__tests__/ingress/openai-completions.test.ts`
- Test: `packages/core/src/ingress/openai-embeddings/openai-embeddings.test.ts`
- Test: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts`

**Interfaces:**
- Consumes: `z.compile` from Task 1
- Produces: the same exported schema names and parse helpers; compiled clones. Call sites keep `OpenAICompletionsRequestSchema.parse`, `parseOpenAIEmbeddings`, `parseOpenAILegacyCompletions`.

- [ ] **Step 1: Pre-wrap `{ strict: true }` probe (must PASS on the uncompiled schemas)**

Create `packages/core/src/ingress/compile.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { OpenAICompletionsRequestSchema } from './openai-completions';
import { OpenAIEmbeddingsRequestSchema } from './openai-embeddings/openai-embeddings';
import { OpenAILegacyCompletionsRequestSchema } from './openai-legacy-completions/openai-legacy-completions';

test('OpenAI Completions / Embeddings / Legacy Completions schemas compile', () => {
  expect(() => z.compile(OpenAICompletionsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAIEmbeddingsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAILegacyCompletionsRequestSchema, { strict: true })).not.toThrow();
});
```

This is a **pre-wrap eject probe**, not proof that the export already carries a fast path. Recompiling an already-exported schema with `{ strict: true }` also passes on the uncompiled original. If this throws `ZodCompileUnsupportedError` / `ZodCompileAsyncError`, **stop — do not wrap**. After Step 3 the same test still only proves the schema remains compilable; the wrap itself is the fast path.

- [ ] **Step 2: Run the new test against current schemas**

Run: `bun test packages/core/src/ingress/compile.test.ts`

Expected: PASS (uncompiled simple schemas should be compilable). If FAIL with `ZodCompileUnsupportedError`, stop and inspect the schema before wrapping — do not ship a silent eject.

- [ ] **Step 3: Wrap the three exported schemas**

`packages/core/src/ingress/openai-completions.ts` — change the export to compile last:

```ts
export const OpenAICompletionsRequestSchema = z.compile(
  z.object({
    model: IdSchema,
    messages: z.array(MessageSchema).min(1),
    prompt_cache_key: z.string().optional(),
    metadata: SessionMetadataSchema.optional(),
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']), LooseObjectSchema]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    response_format: LooseObjectSchema.optional(),
    reasoning_effort: z.string().optional(),
  }),
);
```

Keep `parseOpenAICompletions` as `return OpenAICompletionsRequestSchema.parse(input)`.

`packages/core/src/ingress/openai-embeddings/openai-embeddings.ts`:

```ts
export const OpenAIEmbeddingsRequestSchema = z.compile(
  z.object({
    model: z.string().min(1),
    input: OpenAIEmbeddingsInputSchema,
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
    user: z.string().optional(),
  }),
);
```

`packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts` — wrap the existing `.object({...}).loose()`:

```ts
export const OpenAILegacyCompletionsRequestSchema = z.compile(
  z
    .object({
      model: z.string().min(1),
      prompt: promptSchema.optional(),
      suffix: z.string().nullable().optional(),
      max_tokens: z.number().int().nullable().optional(),
      temperature: z.number().nullable().optional(),
      top_p: z.number().nullable().optional(),
      n: z.number().int().nullable().optional(),
      stream: z.boolean().nullable().optional(),
      stream_options: z
        .object({
          include_usage: z.boolean().optional(),
          include_obfuscation: z.boolean().optional(),
        })
        .catchall(z.unknown())
        .nullable()
        .optional(),
      logprobs: z.number().int().nullable().optional(),
      echo: z.boolean().nullable().optional(),
      stop: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      presence_penalty: z.number().nullable().optional(),
      frequency_penalty: z.number().nullable().optional(),
      best_of: z.number().int().nullable().optional(),
      logit_bias: z.record(z.string(), z.number()).nullable().optional(),
      user: z.string().nullable().optional(),
      seed: z.number().int().nullable().optional(),
      prompt_cache_key: z.string().nullable().optional(),
      metadata: z
        .object({
          session_id: z.string().optional(),
          conversation_id: z.string().optional(),
        })
        .catchall(z.unknown())
        .optional(),
      session_id: z.string().optional(),
      conversation_id: z.string().optional(),
    })
    .loose(),
);
```

Do not compile `IdSchema` / `MessageSchema` intermediates.

- [ ] **Step 4: Run the existing parse tests plus compile.test.ts**

Run:

```bash
bun test packages/core/src/ingress/compile.test.ts \
  packages/core/__tests__/ingress/openai-completions.test.ts \
  packages/core/src/ingress/openai-embeddings/openai-embeddings.test.ts \
  packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts \
  packages/core/src/protocol/openai-completions/openai-completions.test.ts
```

Expected: all PASS. Invalid fixtures must still throw `ZodError` with the same issue paths (`['messages', 0, 'role']`, `['model']`, etc.).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ingress/openai-completions.ts \
  packages/core/src/ingress/openai-embeddings/openai-embeddings.ts \
  packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts \
  packages/core/src/ingress/compile.test.ts
git commit -m "perf: compile OpenAI Completions and Embeddings request schemas"
```

---

### Task 3: Compile Gemini Embeddings + OpenAI Images

**Files:**
- Modify: `packages/core/src/ingress/gemini-embeddings/gemini-embeddings.ts`
- Modify: `packages/core/src/ingress/openai-image/openai-image.ts`
- Modify: `packages/core/src/ingress/compile.test.ts`
- Test: `packages/core/src/ingress/gemini-embeddings/gemini-embeddings.test.ts`
- Test: `packages/core/src/ingress/openai-image/openai-image.test.ts`

**Interfaces:**
- Consumes: `z.compile` from Task 1
- Produces: same `parseGeminiEmbedContent`, `parseGeminiBatchEmbedContents`, `parseOpenAIImageGenerations`, `parseOpenAIImageEdits` signatures.

- [ ] **Step 1: Extend compile.test.ts**

Add imports and assertions. Probe with `{ strict: true }` first. If it throws, **do not wrap** that schema. A 4.5.4 probe of the current Gemini embed schemas compiled successfully (sync `.transform` / `.superRefine` / `.strip()` are supported); still run the probe in this repo after Task 1 because that is the only eject check.

```ts
import {
  GeminiBatchEmbedContentsRequestSchema,
  GeminiEmbedContentRequestSchema,
} from './gemini-embeddings/gemini-embeddings';
```

If `z.compile(GeminiEmbedContentRequestSchema, { strict: true })` throws, skip wrapping it. Do not wrap a schema that ejects — that is a no-op with extra syntax.

- [ ] **Step 2: Probe Gemini embed compile**

Run:

```bash
bun -e 'import { z } from "zod"; import { GeminiEmbedContentRequestSchema } from "./packages/core/src/ingress/gemini-embeddings/gemini-embeddings.ts"; z.compile(GeminiEmbedContentRequestSchema, { strict: true }); console.log("ok")'
```

Expected: `ok`, **or** a `ZodCompileUnsupportedError`. Record which, then wrap accordingly.

- [ ] **Step 3: Wrap Gemini embed schemas**

```ts
export const GeminiEmbedContentRequestSchema = z.compile(
  z
    .object({
      model: z.string().optional(),
      content: contentSchema,
      embedContentConfig: embedContentConfigSchema.optional(),
      taskType: z.string().optional(),
      title: z.string().optional(),
      outputDimensionality: z.number().int().optional(),
    })
    .strip(),
);

export const GeminiBatchEmbedContentsRequestSchema = z.compile(
  z.object({
    requests: z.array(GeminiEmbedContentRequestSchema).min(1).max(100),
  }),
);
```

Compile `GeminiBatchEmbedContentsRequestSchema` last. If the child is already compiled, the parent still needs its own compile for the array/object wrapper.

- [ ] **Step 4: Wrap OpenAI Image input schemas**

In `packages/core/src/ingress/openai-image/openai-image.ts`, the parse functions call module-private schemas. Compile those consts:

```ts
const OpenAIImageGenerationsInputSchema = z.compile(z.object(imageRequestFields).superRefine(refineImageN));

const OpenAIImageEditsInputSchema = z.compile(
  z
    .object({
      ...imageRequestFields,
      images: z.array(imageSourceSchema).min(1),
      mask: imageSourceSchema.nullable().optional(),
    })
    .superRefine(refineImageN),
);
```

`refineImageN` stays as-is. Compile after `.superRefine`.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test packages/core/src/ingress/compile.test.ts \
  packages/core/src/ingress/gemini-embeddings/gemini-embeddings.test.ts \
  packages/core/src/ingress/openai-image/openai-image.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ingress/gemini-embeddings/gemini-embeddings.ts \
  packages/core/src/ingress/openai-image/openai-image.ts \
  packages/core/src/ingress/compile.test.ts
git commit -m "perf: compile Gemini embed and OpenAI image request schemas"
```

---

### Task 4: Compile Anthropic Messages, Gemini GenerateContent, Gemini Interactions

Synchronous `.transform`, `.pipe`, `.superRefine`, `.loose()`, and `.strip()` **do compile** on Zod 4.5.4. Skip `OpenAIResponsesRequestSchema`: `inputItemSchema` calls `console.warn` on unknown items, and compiled invalid-input fallback re-runs that transform (one warning becomes two). Probe the remaining three with `{ strict: true }` first; wrap only if the probe passes.

**Files:**
- Modify: `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`
- Modify: `packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts`
- Modify: `packages/core/src/ingress/gemini-interactions/gemini-interactions.ts`
- Test: `packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts`
- Test: `packages/core/src/ingress/gemini-generate-content/gemini-generate-content.test.ts`
- Test: `packages/core/src/ingress/gemini-interactions/gemini-interactions.test.ts`

**Interfaces:**
- Consumes: `z.compile` from Task 1
- Produces: same `AnthropicMessagesRequestSchema`, `parseGeminiGenerateContent`, `parseGeminiInteractions` / `safeParseGeminiInteractions`.

- [ ] **Step 1: Pre-wrap `{ strict: true }` probe**

Run:

```bash
bun -e 'import { z } from "zod";
import { AnthropicMessagesRequestSchema } from "./packages/core/src/ingress/anthropic-messages/anthropic-messages.ts";
import { GeminiGenerateContentRequestSchema } from "./packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts";
z.compile(AnthropicMessagesRequestSchema, { strict: true });
z.compile(GeminiGenerateContentRequestSchema, { strict: true });
console.log("ok")'
```

Plus a one-liner for `GeminiInteractionsBodySchema` after temporarily exporting it or inlining the probe in a test file. Expected: `ok`. If any throw, skip that schema. Do **not** compile `OpenAIResponsesRequestSchema`.

- [ ] **Step 2: Wrap Anthropic Messages last**

In `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`, compile only `AnthropicMessagesRequestSchema`. Nested `.pipe()` blocks (`ToolResultBlockSchema`, `ThinkingBlockSchema`) stay as they are; compile the parent.

Replace `export const AnthropicMessagesRequestSchema = z.object({` with `export const AnthropicMessagesRequestSchema = z.compile(z.object({` and close the extra `)` after the object.

- [ ] **Step 3: Wrap Gemini GenerateContent and Interactions last**

`packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts`:

```ts
export const GeminiGenerateContentRequestSchema = z.compile(
  z.object({
    model: idSchema,
    contents: z.array(contentSchema).min(1),
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
    systemInstruction: systemInstructionSchema.optional(),
    tools: z.array(toolSchema).optional(),
    generationConfig: generationConfigSchema.optional(),
    safetySettings: z.array(safetySettingSchema).optional(),
  }),
);
```

`packages/core/src/ingress/gemini-interactions/gemini-interactions.ts` — `GeminiInteractionsBodySchema` is module-private today. Compile it:

```ts
const GeminiInteractionsBodySchema = z.compile(
  z
    .object({
      model: z.string().optional(),
      agent: z.string().optional(),
      input: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
      system_instruction: z.string().optional(),
      stream: z.boolean().optional(),
      tools: z.unknown().optional(),
      response_format: z.unknown().optional(),
      generation_config: z.unknown().optional(),
      agent_config: z.unknown().optional(),
      store: z.boolean().optional(),
      background: z.boolean().optional(),
      previous_interaction_id: z.string().optional(),
      environment: z.unknown().optional(),
      labels: z.unknown().optional(),
      safety_settings: z.unknown().optional(),
      service_tier: z.unknown().optional(),
      webhook_config: z.unknown().optional(),
    })
    .catchall(z.unknown())
    .superRefine((body, ctx) => {
      const modelPresent = body.model !== undefined;
      const agentPresent = body.agent !== undefined;
      if (modelPresent === agentPresent) {
        ctx.addIssue({ code: 'custom', message: xorMessage, path: ['model'] });
        return;
      }
      const selected = (modelPresent ? body.model : body.agent)?.trim() ?? '';
      if (selected === '') {
        ctx.addIssue({ code: 'custom', message: xorMessage, path: [modelPresent ? 'model' : 'agent'] });
      }
    }),
);
```

Keep `safeParseGeminiInteractions` calling `GeminiInteractionsBodySchema.safeParse`.

- [ ] **Step 4: Run protocol + ingress tests**

Run:

```bash
bun test \
  packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts \
  packages/core/src/protocol/anthropic-messages/anthropic-messages.test.ts \
  packages/core/src/ingress/gemini-generate-content/gemini-generate-content.test.ts \
  packages/core/src/protocol/gemini-generate-content/gemini-generate-content.test.ts \
  packages/core/src/ingress/gemini-interactions/gemini-interactions.test.ts
```

Expected: PASS. Anthropic `tool_result` without `tool_use_id` still fails. Gemini interactions still require exactly one of `model`/`agent`. OpenAI Responses tests are unchanged (schema not compiled).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ingress/anthropic-messages/anthropic-messages.ts \
  packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts \
  packages/core/src/ingress/gemini-interactions/gemini-interactions.ts
git commit -m "perf: compile Anthropic and Gemini inbound request schemas"
```

---


### Task 5: Bump es-toolkit and narrow barrel imports

**Files:**
- Modify: `package.json` (`workspaces.catalog["es-toolkit"]`)
- Modify: `bun.lock` (via `bun install`)
- Modify: `packages/dashboard/src/modules/routing/components/model-metadata-editor/model-metadata-editor.tsx`
- Modify: `packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.ts`

**Interfaces:**
- Produces: catalog `es-toolkit@1.52.0`. `isEqual` contract unchanged.

- [ ] **Step 1: Pin + install**

Replace `"es-toolkit": "1.50.0-dev.2001"` with `"es-toolkit": "1.52.0"` in root `package.json` catalog. Run `bun install`.

- [ ] **Step 2: Confirm modules this repo already imports**

```bash
bun -e 'import { uniq } from "es-toolkit/array"; import { pickBy, omitBy, mapValues } from "es-toolkit/object"; import { isEqual, isPlainObject } from "es-toolkit/predicate"; import { pipe, filter, map, sortBy } from "es-toolkit/fp"; console.log(uniq([1,1,2]), pickBy({a:1,b:0}, v => v>0), mapValues({a:"1"}, v => Number(v)))'
```

Expected: no throw. `uniq([1,1,2])` → `[1,2]`. `pickBy({a:1,b:0}, v => v>0)` → `{a:1}`. `mapValues({a:"1"}, v => Number(v))` → `{a:1}`.

- [ ] **Step 3: Narrow barrel `isEqual`**

`model-metadata-editor.tsx` and `oauth-provider-edit.ts`:

```ts
import { isEqual } from 'es-toolkit/predicate';
```

- [ ] **Step 4: Dashboard unit tests**

Run: `bun run --filter @aio-proxy/dashboard test:unit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock \
  packages/dashboard/src/modules/routing/components/model-metadata-editor/model-metadata-editor.tsx \
  packages/dashboard/src/modules/providers/lib/oauth-provider-edit/oauth-provider-edit.ts
git commit -m "chore: bump es-toolkit to 1.52 and narrow isEqual imports"
```

---

### Task 6: `uniq` for spread-Set arrays

Only `[...new Set(xs)]` that is immediately used as an array. Leave `new Set` kept for `.has`.

**Files:**
- Modify: `packages/server/src/plugin-runtime/catalog.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (already imports `uniq`)
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts`
- Modify: `packages/plugins/google-antigravity/src/protocol/tool-schema.ts`
- Modify: `packages/plugins/google-antigravity/src/protocol/web-search.ts`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-alias/provider-alias-variants.tsx`
- Modify: `packages/dashboard/src/components/tags-input/use-tags-input.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/remove.ts`

**Interfaces:**
- Consumes: `uniq` from `es-toolkit/array` — `(array: readonly T[]) => T[]`, first-occurrence order
- Produces: same unique arrays

- [ ] **Step 1: server (already has es-toolkit)**

`capabilities.ts`:

```ts
aliasTargets: config.alias === undefined ? undefined : uniq(Object.values(config.alias).flatMap(aliasTargetModels)),
```

`catalog.ts` — add `import { uniq } from 'es-toolkit/array'` if missing:

```ts
clientModels: provider === undefined ? [] : uniq(modelRoutes(provider).map((route) => route.alias)),
```

`materialize.ts` — add the same import:

```ts
return uniq(Object.values(alias).flatMap(aliasTargetModels));
```

```ts
clientModels: uniq(modelRoutes(provider).map((route) => route.alias)),
```

```ts
const clientModels = uniq(modelRoutes(provider).map((route) => route.alias));
```

`provider-draft-operations.ts`:

```ts
return { ok: true, models: uniq(page.models) };
```

```ts
return uniq(models);
```

- [ ] **Step 2: antigravity (already has es-toolkit)**

`tool-schema.ts`:

```ts
import { uniq } from 'es-toolkit/array';

function uniqueStrings(values: readonly unknown[]): string[] {
  return uniq(values.filter((value): value is string => typeof value === 'string'));
}
```

`web-search.ts`:

```ts
import { uniq } from 'es-toolkit/array';

const blockedDomains = uniq(tools.flatMap((tool) => nonEmpty(tool.blockedDomains) ?? []));
```

- [ ] **Step 3: dashboard (already has es-toolkit)**

`oauth-provider-group-row.tsx`:

```ts
import { uniq } from 'es-toolkit/array';

const models = uniq(group.accounts.flatMap(({ provider }) => provider.clientModels));
```

`provider-alias-variants.tsx`:

```ts
import { uniq } from 'es-toolkit/array';

const messages = uniq(issues.map(aliasIssueMessage));
```

`use-tags-input.ts`:

```ts
import { uniq } from 'es-toolkit/array';

() => uniq([...options, ...value]).map((item) => ({ value: item })),
```

- [ ] **Step 4: CLI (already has es-toolkit)**

`packages/cli/src/plugin-commands/plugin/remove.ts`:

```ts
import { uniq } from 'es-toolkit/array';

const names = uniq([...deps.builtInNames, ...configured]).sort();
```

Skip `packages/logger/src/redact/redact.ts` (`[...new Set(...)].sort`) — logger has no es-toolkit dep; do not add one for a unique+sort.

Skip `packages/dashboard/src/modules/providers/lib/request-transforms/mongo-expression-adapter.ts` if the Set is over a string's characters (`[...new Set(typeof options === 'string' ? options : '')]`) — that is a unique-grapheme walk, not a list uniq; leave it.

- [ ] **Step 5: Tests**

```bash
bun test packages/server/src/plugin-runtime packages/server/src/provider-runtime \
  packages/server/src/dashboard-routes/provider-draft \
  packages/plugins/google-antigravity/src/protocol \
  packages/cli/src/plugin-commands/plugin
bun run --filter @aio-proxy/dashboard test:unit
```

Expected: PASS. No new uniq unit test.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/plugin-runtime/catalog.ts \
  packages/server/src/plugin-runtime/capabilities.ts \
  packages/server/src/provider-runtime/materialize.ts \
  packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts \
  packages/plugins/google-antigravity/src/protocol/tool-schema.ts \
  packages/plugins/google-antigravity/src/protocol/web-search.ts \
  packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx \
  packages/dashboard/src/modules/providers/components/provider-alias/provider-alias-variants.tsx \
  packages/dashboard/src/components/tags-input/use-tags-input.ts \
  packages/cli/src/plugin-commands/plugin/remove.ts
git commit -m "refactor: use es-toolkit uniq for spread-Set arrays"
```

---

### Task 7: Changeset + preflight

**Files:**
- Create: `.changeset/zod-compile-es-toolkit.md`

**Interfaces:**
- Consumes: all prior tasks
- Produces: patch release note

- [ ] **Step 1: Changeset**

```md
---
'aio-proxy': patch
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/types': patch
'@aio-proxy/cli': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/plugin-google-antigravity': patch
---

Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52, narrow `isEqual` imports, and replace spread-Set arrays with `uniq` where the package already depends on es-toolkit.
```

Patch, not minor. No user-facing config or SDK contract change. Do **not** list cursor / kimi-code / xai-grok (no source change after dropping shared `isRecord`).

- [ ] **Step 2: Format + preflight**

Run: `bun run format` then `bun run preflight`

Expected: oxlint type-aware + oxfmt check + all unit tests pass. Ingress invalid-path tests still report `ZodError`. OpenAI Responses unknown-item still logs once.

- [ ] **Step 3: Commit**

```bash
git add .changeset/zod-compile-es-toolkit.md
git commit -m "chore: add changeset for zod 4.5 compile and es-toolkit 1.52"
```

---

## Self-review

**Spec coverage**

- Zod latest: Task 1 (`^4.5.4`).
- `z.compile`: Tasks 2–4, per-schema, final schema only. Global `import "zod/compile"` skipped (plugin-sdk library + compiled binary + dashboard). OpenAI Responses skipped because compiled fallback double-runs `console.warn`.
- es-toolkit latest: Task 5 (`1.52.0`).
- Missing es-toolkit uses: Task 5 barrel imports, Task 6 `uniq`.
- `isRecord`: left local. Not `isPlainObject`.
- `pickBy`/`omitBy`/`mapValues`: not used for `Object.fromEntries` reconstitutions (`"__proto__"` + `Partial<T>`).
- `es-toolkit/fp`: already used in ChatGPT catalog; no new pipeline found that is side-effect-free, multi-step, *and* would beat a single loop.
- `es-toolkit/iterator`: explicitly unused — no production array is large/infinite *and* early-exit.

**Placeholders:** none.

**Type consistency:** exported schema names and parse helpers do not change. `z.compile` returns a Zod schema with the same input/output types.

**Out of scope if asked later:** `import "zod/compile"` in `packages/cli/src/main.ts` + `renderCompiledEntry` first line, only after plugin-sdk is confirmed not to define schemas at import time in the CLI graph; dashboard `z.config({ jitless: true })` if a CSP is added; adding es-toolkit to logger / xai-grok / kimi-code / cursor.

**Review (sol max):** ship with the fixes above applied. Per-schema compile is correct. Do not wrap schemas that eject. Do not share `isRecord`. Do not replace `Object.fromEntries` with `pickBy`/`omitBy`/`mapValues`.
