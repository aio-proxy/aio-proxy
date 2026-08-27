# P0 Language Protocol Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish official language-generation ports on the existing `languageModel` pipeline: `POST /v1/completions`, `POST /v1/responses/compact`, and protocol-shaped 501s for remaining official Responses resource operations.

**Architecture:** Keep protocol enums `openai-compatible` and `openai-response`. Add a second Completions adapter instance with fixed `text_completion` writers instead of extending `ModelEgressContext`. Add compact as `openAIResponsesAdapter` context `operation: 'compact'`: dedicated parse, unary JSON, same-protocol raw only, cross-protocol 501. Register official Responses resource routes as thin 501s. Do not add a pipeline seam.

**Tech Stack:** TypeScript, Bun, Zod, Hono, existing `defineProtocolAdapter` / `handleProtocolRequest` pipeline, colocated `bun:test`.

**Spec:** [docs/superpowers/specs/2026-08-25-p0-language-protocol-ports-design.md](../specs/2026-08-25-p0-language-protocol-ports-design.md)

## Global Constraints

- No new protocol enum. Keep `openai-compatible` and `openai-response`.
- Do not extend `ModelEgressContext` or pass route `TContext` into `modelJson` / `modelSse`.
- Completions ingress must accept the official wire schema. Do not 400 a well-typed official Completions body because the model path cannot honor it.
- Completions transform 501s go through `modelUnsupported`, never `requestError`.
- Completions 501 envelope `type` stays `invalid_request_error`. Feature token lives in `message`.
- Do not join multi-prompts. Do not convert omitted/`null` `prompt` into an empty user message.
- Compact is unary JSON. `wantsStream` is `ctx.operation !== 'compact' && req.stream === true`.
- Compact `model: null` / omitted / `""` is parse-time 400 `invalid_request`. This is no-inference, not an official default.
- Compact `stream === true` is parse-time 400. Do not silently strip `true`.
- Compact optional JSON `null` is omitted in adapter semantics and kept on the raw wire.
- Compact `requestDiagnostics` is `[]`. Create keeps the background-dropped diagnostic.
- Compact raw no-op forwards original decoded body text. Reserialize only for model rewrite or `stream` strip.
- Do not reuse create `rawRequest` for compact. Do not strip compact `background`. Do not clamp compact `reasoning.effort`.
- Do not implement Responses `store`, `previous_response_id` replay, `background`, retrieve, delete, or cancel lifecycle.
- Do not register `GET /v1/responses` as a list port.
- Do not add compact as a naive `inboundCases` row in the dispatch matrix.
- Colocated tests. New non-test files stay under 500 lines; split before 400 if a file gains a second responsibility.
- Always prefix shell commands with `rtk`.
- Workspace is already the isolated worktree on `codex/p0-language-protocol-ports`. Do not create another worktree. Do not sync or rebase `main`.
- Changeset must target `aio-proxy` and `@aio-proxy/core` at the same `minor` level.

---

## File map

Completions (new adapter instance, shared internals, no chat schema union):

- Create: `packages/core/src/ingress/openai-legacy-completions/index.ts`
- Create: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts`
- Create: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts`
- Create: `packages/core/src/egress/openai-text-completion/index.ts`
- Create: `packages/core/src/egress/openai-text-completion/openai-text-completion.ts`
- Create: `packages/core/src/egress/openai-text-completion/openai-text-completion.test.ts`
- Create: `packages/core/src/protocol/openai-completions/completions-raw.ts`
- Create: `packages/core/src/protocol/openai-completions/openai-legacy-completions.ts`
- Create: `packages/core/src/protocol/openai-completions/openai-legacy-completions.test.ts`
- Modify: `packages/core/src/protocol/openai-completions/openai-completions.ts`
- Modify: `packages/core/src/protocol/openai-completions/index.ts`
- Modify: `packages/core/src/error.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/protocol/errors.ts`
- Modify: `packages/core/src/protocol/errors.test.ts`
- Modify: `packages/server/src/routes/openai-completions.ts`
- Create: `packages/server/src/routes/openai-completions-legacy.test.ts`

Compact + resource 501s (one Responses adapter, dedicated parse/raw):

- Create: `packages/core/src/ingress/openai-responses/compact.ts`
- Create: `packages/core/src/ingress/openai-responses/compact.test.ts`
- Create: `packages/core/src/protocol/openai-responses-compact.test.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts`
- Modify: `packages/core/src/protocol/adapter.ts` is **not** allowed unless a compile error proves `TContext` is missing on an existing hook. `parse`, `model`, `wantsStream`, `session`, `dimensions`, `requestDiagnostics`, `rawRequest`, and `modelInvocation` already take `TContext`.
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/openai-responses-unsupported.test.ts`
- Modify: `packages/server/src/routes/pipeline/diagnostics.test.ts`

Shared finish:

- Modify: `packages/server/__tests__/cross-protocol-routing.test.ts`
- Modify: `README.md`
- Modify: `README.zh-Hans.md`
- Create: `.changeset/p0-language-protocol-ports.md`

Do not grow `packages/core/src/ingress/openai-completions.ts` into a chat+legacy union. Do not reuse `parseOpenAIResponses` for compact.

Completions and Compact share only the pipeline and the finish-task docs. They are sequenced in one plan because they are one GitHub issue. Do not start Compact files before Task 5 is committed unless a later review reorders the plan.

---

### Task 1: Completions unsupported-feature error

**Files:**
- Modify: `packages/core/src/error.ts` after `OpenAIResponsesUnsupportedFeatureError`
- Modify: `packages/core/src/index.ts` named export list that already exports `OpenAIResponsesUnsupportedFeatureError`
- Modify: `packages/core/src/protocol/errors.ts` `openAICompletionsErrors.modelUnsupported`
- Modify: `packages/core/src/protocol/errors.test.ts`

**Interfaces:**
- Consumes: existing `AioProxyError`, `openAIInvalid(status, code, message)`, `openAICompletionsErrors.modelUnsupported`.
- Produces: `new OpenAICompletionsUnsupportedFeatureError(feature: string, path: string)` with `status = 501`. `openAICompletionsErrors.modelUnsupported(error)` returns 501 `{ error: { code: 'unsupported_feature', message: 'OpenAI Completions feature is not supported: <feature>', type: 'invalid_request_error' } }` for that class and still maps `ImageInputUnsupportedError`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/protocol/errors.test.ts`:

```ts
import { ImageInputUnsupportedError, OpenAICompletionsUnsupportedFeatureError } from '../error';

test('maps Completions unsupported features through modelUnsupported as 501', async () => {
  const response = openAICompletionsErrors.modelUnsupported?.(
    new OpenAICompletionsUnsupportedFeatureError('prompt_array', 'prompt'),
  );
  expect(response?.status).toBe(501);
  expect(await response?.json()).toEqual({
    error: {
      code: 'unsupported_feature',
      message: 'OpenAI Completions feature is not supported: prompt_array',
      type: 'invalid_request_error',
    },
  });
});
```

Keep the existing image-input `modelUnsupported` test. Do not map this class through `requestError`.

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
rtk bun test packages/core/src/protocol/errors.test.ts --test-name-pattern "maps Completions unsupported features"
```

Expected: FAIL because `OpenAICompletionsUnsupportedFeatureError` is not exported.

- [ ] **Step 3: Write the error class and mapper**

Add next to `OpenAIResponsesUnsupportedFeatureError` in `packages/core/src/error.ts`:

```ts
export class OpenAICompletionsUnsupportedFeatureError extends AioProxyError {
  readonly code = 'UNSUPPORTED_OPENAI_COMPLETIONS_FEATURE';
  readonly status = 501;

  constructor(
    readonly feature: string,
    readonly path: string,
  ) {
    super(
      'OpenAICompletionsUnsupportedFeatureError',
      `OpenAI Completions feature is not supported: ${feature} at ${path}`,
    );
  }
}
```

Export it from `packages/core/src/index.ts` in the same named list as `OpenAIResponsesUnsupportedFeatureError`.

Replace Completions `modelUnsupported` in `packages/core/src/protocol/errors.ts`:

```ts
modelUnsupported: (error) => {
  if (error instanceof OpenAICompletionsUnsupportedFeatureError) {
    return openAIInvalid(501, 'unsupported_feature', `OpenAI Completions feature is not supported: ${error.feature}`);
  }
  return error instanceof ImageInputUnsupportedError
    ? openAIInvalid(501, 'unsupported_feature', 'Image input cannot be represented by this provider')
    : undefined;
},
```

Import the new class. Do not change Completions `unsupported()` (`not_implemented`). Do not change Responses `type: 'unsupported_feature'`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/protocol/errors.test.ts
```

Expected: PASS, including the existing image-input case.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/error.ts packages/core/src/index.ts packages/core/src/protocol/errors.ts packages/core/src/protocol/errors.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: map Completions unsupported features through modelUnsupported

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: Official Completions ingress

**Files:**
- Create: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts`
- Create: `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts`
- Create: `packages/core/src/ingress/openai-legacy-completions/index.ts`

**Interfaces:**
- Consumes: Zod. Chat parser `parseOpenAICompletions` stays on `messages`.
- Produces: `OpenAILegacyCompletionsRequest` and `parseOpenAILegacyCompletions(input: unknown): OpenAILegacyCompletionsRequest`. Required field is `model` (`z.string().min(1)`). Official `prompt` is omitted, `null`, `string`, `string[]`, `number[]`, or `number[][]`. Official `n`, `stop`, `echo`, `suffix`, `logprobs` (including `0`), `best_of`, `stream_options`, and remaining Completions fields are accepted. Parse does not rewrite omitted/`null` `prompt` to `""`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { ZodError } from 'zod';

import { parseOpenAILegacyCompletions } from './openai-legacy-completions';

test.each([
  [{}, 'omitted'],
  [{ prompt: null }, 'null'],
  [{ prompt: '' }, 'empty string'],
  [{ prompt: 'hello' }, 'string'],
  [{ prompt: ['only'] }, 'one-element string array'],
  [{ prompt: ['a', 'b'] }, 'multi string array'],
  [{ prompt: [1, 2, 3] }, 'token array'],
  [{ prompt: [[1, 2], [3]] }, 'array of token arrays'],
  [{ n: 2 }, 'n > 1'],
  [{ n: null }, 'n null'],
  [{ best_of: null }, 'best_of null'],
  [{ logprobs: 0 }, 'logprobs 0'],
  [{ stream_options: { include_usage: true } }, 'stream_options'],
] as const)('accepts official Completions %s', (extra, _label) => {
  const parsed = parseOpenAILegacyCompletions({ model: 'davinci', ...extra });
  expect(parsed.model).toBe('davinci');
  if (!('prompt' in extra)) expect(parsed.prompt).toBeUndefined();
  else expect(parsed.prompt).toEqual(extra.prompt);
});

test('does not rewrite omitted prompt to empty string', () => {
  const parsed = parseOpenAILegacyCompletions({ model: 'davinci' });
  expect('prompt' in parsed && parsed.prompt === '').toBe(false);
});

test('rejects empty model and does not reject official option shapes', () => {
  expect(() => parseOpenAILegacyCompletions({ model: '' })).toThrow(ZodError);
  expect(() => parseOpenAILegacyCompletions({ model: 'davinci', n: 4, stop: ['\n'] })).not.toThrow();
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
rtk bun test packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write the official schema**

Create `packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.ts`:

```ts
import { z } from 'zod';

const tokenArraySchema = z.array(z.number());
const promptSchema = z.union([
  z.string(),
  z.array(z.string()),
  tokenArraySchema,
  z.array(tokenArraySchema),
  z.null(),
]);

export const OpenAILegacyCompletionsRequestSchema = z
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
  .passthrough();

export type OpenAILegacyCompletionsRequest = z.output<typeof OpenAILegacyCompletionsRequestSchema>;

export function parseOpenAILegacyCompletions(input: unknown): OpenAILegacyCompletionsRequest {
  return OpenAILegacyCompletionsRequestSchema.parse(input);
}
```

Create `packages/core/src/ingress/openai-legacy-completions/index.ts` that only re-exports the parser and type. Do not import or modify `packages/core/src/ingress/openai-completions.ts`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/ingress/openai-legacy-completions/openai-legacy-completions.test.ts packages/core/src/protocol/openai-completions/openai-completions.test.ts
```

Expected: PASS. Chat Completions tests still parse `messages`, not `prompt`.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/ingress/openai-legacy-completions
rtk git commit -m "$(cat <<'EOF'
feat: parse official OpenAI Completions wire bodies

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: Completions raw rewrite helper

**Files:**
- Create: `packages/core/src/protocol/openai-completions/completions-raw.ts`
- Modify: `packages/core/src/protocol/openai-completions/openai-completions.ts` `rawRequest`
- Modify: `packages/core/src/protocol/openai-completions/openai-completions.test.ts` only if the existing verbatim-bytes test import path changes. Prefer keeping that test as-is.

**Interfaces:**
- Consumes: `readRequestText`, `normalizeEffort` from `packages/core/src/protocol/request.ts` and `packages/core/src/protocol/reasoning-effort/index.ts`.
- Produces: `rewriteOpenAICompletionsRaw(raw: Request, resolvedModel: string, supportedEfforts: ReadonlySet<string>): Promise<Request>`. Rewrites `model` when the router resolved a different id. Clamps string `reasoning_effort` when present (chat needs this). Forwards original decoded body text when model and effort are unchanged. Does not insert `messages`, `prompt`, or `reasoning_effort`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/protocol/openai-completions/openai-completions.test.ts`:

```ts
import { rewriteOpenAICompletionsRaw } from './completions-raw';

test('legacy Completions raw keeps omitted and null prompt bytes', async () => {
  const omitted = '{"model":"upstream","seed":9007199254740993}';
  const forwarded = await rewriteOpenAICompletionsRaw(
    new Request('https://x/v1/completions', { method: 'POST', body: omitted }),
    'upstream',
    new Set(['low', 'medium', 'high']),
  );
  expect(await forwarded.text()).toBe(omitted);
  expect(forwarded.url).toContain('/v1/completions');

  const nullable = '{"model":"src","prompt":null}';
  const rewritten = await rewriteOpenAICompletionsRaw(
    new Request('https://x/v1/completions', { method: 'POST', body: nullable }),
    'davinci',
    new Set(),
  );
  expect(await rewritten.json()).toEqual({ model: 'davinci', prompt: null });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-completions/openai-completions.test.ts --test-name-pattern "legacy Completions raw"
```

Expected: FAIL because `completions-raw` does not exist.

- [ ] **Step 3: Extract the shared rewrite**

Move the current chat `rawRequest` body into `rewriteOpenAICompletionsRaw` in `packages/core/src/protocol/openai-completions/completions-raw.ts`. Keep the existing comments about decoded body text and `Number.MAX_SAFE_INTEGER`. Chat `rawRequest` becomes:

```ts
async rawRequest(raw, _request, resolvedModel, supportedEfforts) {
  return rewriteOpenAICompletionsRaw(raw, resolvedModel, supportedEfforts);
},
```

Do not inject `prompt: ""`. Do not change URL pathname; `new Request(raw, { method, body, headers })` already preserves `/v1/completions`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-completions/openai-completions.test.ts
```

Expected: PASS, including the existing chat verbatim-bytes test.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/openai-completions/completions-raw.ts packages/core/src/protocol/openai-completions/openai-completions.ts packages/core/src/protocol/openai-completions/openai-completions.test.ts
rtk git commit -m "$(cat <<'EOF'
refactor: share Completions raw rewrite without inserting prompt

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 4: Legacy Completions adapter and model-path 501s

**Files:**
- Create: `packages/core/src/protocol/openai-completions/openai-legacy-completions.ts`
- Create: `packages/core/src/protocol/openai-completions/openai-legacy-completions.test.ts`
- Modify: `packages/core/src/protocol/openai-completions/index.ts`

**Interfaces:**
- Consumes: `parseOpenAILegacyCompletions`, `rewriteOpenAICompletionsRaw`, `OpenAICompletionsUnsupportedFeatureError`, `openAICompletionsErrors`, `defineProtocolAdapter`, `EmptyProtocolContext`.
- Produces: `openAILegacyCompletionsAdapter` with `protocol: ProviderProtocol.OpenAICompatible`. `model(request) => request.model`. `wantsStream: (request) => request.stream === true`. `modelInvocation(request)` returns one user message for a single string prompt or a one-element `string[]`, and throws `OpenAICompletionsUnsupportedFeatureError` in spec table order. `settings` contains only non-null `temperature`, `top_p`, `maxTokens`, `seed`, `presencePenalty`, `frequencyPenalty`. No `stream`. No `user`. This task does not register `/v1/completions`. Point `modelJson` / `modelSse` at the existing chat writers so the adapter typechecks; Task 5 replaces those writers and adds the route. Do not assert `text_completion` here.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/protocol/openai-completions/openai-legacy-completions.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { OpenAICompletionsUnsupportedFeatureError } from '../../error';
import { parseOpenAILegacyCompletions } from '../../ingress/openai-legacy-completions';
import { openAICompletionsErrors } from '../errors';
import { openAILegacyCompletionsAdapter } from './openai-legacy-completions';

function parse(body: Record<string, unknown>) {
  return parseOpenAILegacyCompletions({ model: 'davinci', ...body });
}

function invoke(body: Record<string, unknown>) {
  return openAILegacyCompletionsAdapter.modelInvocation(parse(body), {});
}

test('converts a single string prompt to one user message and omits stream and user', () => {
  const invocation = invoke({
    prompt: 'hello',
    n: null,
    best_of: null,
    temperature: null,
    user: 'u1',
    stream: false,
  });
  expect(invocation.messages).toEqual([{ role: 'user', content: 'hello' }]);
  expect(invocation.settings).toEqual({});
  expect(openAILegacyCompletionsAdapter.wantsStream(parse({ stream: true }), {})).toBe(true);
  expect(openAILegacyCompletionsAdapter.wantsStream(parse({ stream: null }), {})).toBe(false);
});

test.each([
  [{}, 'prompt_omitted', 'prompt'],
  [{ prompt: null }, 'prompt_omitted', 'prompt'],
  [{ prompt: ['a', 'b'] }, 'prompt_array', 'prompt'],
  [{ prompt: [1, 2] }, 'prompt_tokens', 'prompt'],
  [{ prompt: 'x', n: 2 }, 'n', 'n'],
  [{ prompt: 'x', stop: '\n' }, 'stop', 'stop'],
  [{ prompt: 'x', echo: true }, 'echo', 'echo'],
  [{ prompt: 'x', suffix: 'tail' }, 'suffix', 'suffix'],
  [{ prompt: 'x', logprobs: 0 }, 'logprobs', 'logprobs'],
  [{ prompt: 'x', best_of: 2 }, 'best_of', 'best_of'],
  [{ prompt: 'x', logit_bias: { '1': 1 } }, 'logit_bias', 'logit_bias'],
  [{ prompt: 'x', stream_options: { include_usage: true } }, 'stream_options', 'stream_options'],
] as const)('501s %s from modelInvocation', async (body, feature, path) => {
  expect(() => invoke(body)).toThrow(new OpenAICompletionsUnsupportedFeatureError(feature, path));
  try {
    invoke(body);
  } catch (error) {
    const response = openAICompletionsErrors.modelUnsupported?.(error);
    expect(response?.status).toBe(501);
    expect(JSON.stringify(await response?.json())).toContain(feature);
  }
});

test('one-element string array is one prompt and n/best_of null do not 501', () => {
  expect(invoke({ prompt: ['hello'], n: null, best_of: null }).messages).toEqual([
    { role: 'user', content: 'hello' },
  ]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-completions/openai-legacy-completions.test.ts
```

Expected: FAIL because `openAILegacyCompletionsAdapter` does not exist.

- [ ] **Step 3: Implement the legacy adapter**

Create `packages/core/src/protocol/openai-completions/openai-legacy-completions.ts` as a second `defineProtocolAdapter` instance. Parse with `parseOpenAILegacyCompletions(await readJsonRequest(raw))`. Session hints: `prompt_cache_key` / metadata / `session_id` / `conversation_id`, skipping `null`. Transcript is `request.prompt`. `rawRequest` calls `rewriteOpenAICompletionsRaw`. Temporary `modelJson` / `modelSse` may be the chat writers.

`modelInvocation` must apply this table in order after treating JSON `null` as omitted:

1. omitted/`null` prompt → `prompt_omitted`
2. `string[]` length != 1 → `prompt_array`
3. token array or array of token arrays → `prompt_tokens`
4. numeric `n !== 1` → `n`
5. non-null `stop` → `stop`
6. `echo === true` → `echo`
7. non-null / non-`""` `suffix` → `suffix`
8. any non-null `logprobs` including `0` → `logprobs`
9. numeric `best_of !== 1` → `best_of`
10. non-empty `logit_bias` → `logit_bias`
11. non-null `stream_options` → `stream_options`

Faithful path: single `string` (including `""`) or `string[]` length 1 → `[{ role: 'user', content: thatString }]`. Map only non-null `temperature`, `top_p`, `max_tokens`→`maxTokens`, `seed`, `presence_penalty`→`presencePenalty`, `frequency_penalty`→`frequencyPenalty`. Do not put `stream` or `user` in `settings`. Do not invent tools.

Export it from `packages/core/src/protocol/openai-completions/index.ts`. Do not edit `packages/server/src/routes/openai-completions.ts` in this task.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-completions packages/core/src/ingress/openai-legacy-completions
```

Expected: PASS. Existing chat adapter tests still emit chat parse/raw behavior.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/openai-completions
rtk git commit -m "$(cat <<'EOF'
feat: add legacy Completions adapter with model-path 501s

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 5: Legacy Completions egress

**Files:**
- Create: `packages/core/src/egress/openai-text-completion/openai-text-completion.ts`
- Create: `packages/core/src/egress/openai-text-completion/openai-text-completion.test.ts`
- Create: `packages/core/src/egress/openai-text-completion/index.ts`
- Modify: `packages/core/src/protocol/openai-completions/openai-legacy-completions.ts` writers
- Modify: `packages/server/src/routes/openai-completions.ts`
- Create: `packages/server/src/routes/openai-completions-legacy.test.ts`

**Interfaces:**
- Consumes: `ModelEgressContext`, `createCancellableEgressStream`, `openAILegacyCompletionsAdapter`.
- Produces: `writeOpenAITextCompletionResponse` / `writeOpenAITextCompletionSSE`. JSON `object: "text_completion"` with `id` prefix `cmpl-`, `created`, `model`, `choices[].text`, `choices[].index`, `choices[].logprobs` (`null` when unavailable), optional `usage`. Every SSE chunk carries the same identity fields; partial chunks have `finish_reason: null`; stream ends with `data: [DONE]`. Chat instance must still emit `chat.completion`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/egress/openai-text-completion/openai-text-completion.test.ts` that feeds a one-delta + finish stream into both writers and asserts:

```ts
expect(json.object).toBe('text_completion');
expect(json.id.startsWith('cmpl-')).toBe(true);
expect(json.created).toEqual(expect.any(Number));
expect(json.model).toBe('davinci');
expect(json.choices[0]).toMatchObject({ text: 'hello', index: 0, logprobs: null });
```

Decode SSE and assert every `data:` JSON object except `[DONE]` has `object: 'text_completion'`, `id`, `created`, `model`, `choices[0].index`, and `choices[0].logprobs === null`.

Create `packages/server/src/routes/openai-completions-legacy.test.ts` that POSTs `{ model, prompt: 'hello' }` to `/v1/completions` against a model-only `ai-sdk` provider (copy `aiSdkProvider` + `textStream` from `packages/server/__tests__/openai-responses.test-support.ts`) and asserts status 200, `object: 'text_completion'`, identity fields, and `choices[0].logprobs === null`. Add a second case `{ prompt: 'hello', n: 2 }` against the same model-only provider and assert 501 `prompt` feature is **not** used; assert `n` and no provider invoke.

- [ ] **Step 2: Run them to make sure they fail**

Run:

```bash
rtk bun test packages/core/src/egress/openai-text-completion/openai-text-completion.test.ts packages/server/src/routes/openai-completions-legacy.test.ts
```

Expected: FAIL because the text-completion writers do not exist.

- [ ] **Step 3: Implement the writers and wire them**

Follow `packages/core/src/egress/openai-completions.ts` structure, but emit `text` instead of chat `message`, prefix ids with `cmpl-`, and never emit `chat.completion`. Point `openAILegacyCompletionsAdapter.modelJson` / `modelSse` at these writers. Do not change the chat adapter writers.

Register the route in `packages/server/src/routes/openai-completions.ts`:

```ts
export function createOpenAICompletionsRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post('/v1/chat/completions', (context) =>
      handleProtocolRequest({
        adapter: openAICompletionsAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post('/v1/completions', (context) =>
      handleProtocolRequest({
        adapter: openAILegacyCompletionsAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    );
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/egress/openai-text-completion packages/core/src/protocol/openai-completions packages/server/src/routes/openai-completions-legacy.test.ts
```

Expected: PASS. Chat Completions adapter tests still describe `chat.completion` writers.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/egress/openai-text-completion packages/core/src/protocol/openai-completions/openai-legacy-completions.ts packages/server/src/routes/openai-completions.ts packages/server/src/routes/openai-completions-legacy.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: emit official text_completion JSON and SSE

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 6: Compact ingress

**Files:**
- Create: `packages/core/src/ingress/openai-responses/compact.ts`
- Create: `packages/core/src/ingress/openai-responses/compact.test.ts`

**Interfaces:**
- Consumes: Zod. Create parser `parseOpenAIResponses` stays required-`input`.
- Produces: `OpenAIResponsesCompactRequest` with success `model: string` (non-empty). `parseOpenAIResponsesCompact(input: unknown): OpenAIResponsesCompactRequest`. Official recognition first: `model` is `string | null`; `input` omitted/`null`/`string`/array including `[]`; optional nullable `instructions`, `previous_response_id`, `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`, `service_tier`; extra fields survive `.passthrough()`. Then parse throws `OpenAIResponsesTransformError('model')` for `null` / omitted / `""`, and `OpenAIResponsesTransformError('stream')` for `stream === true`. Do not throw `OpenAIResponsesUnsupportedFeatureError`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/ingress/openai-responses/compact.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { OpenAIResponsesTransformError } from '../../error';
import { parseOpenAIResponses } from './index';
import { parseOpenAIResponsesCompact } from './compact';

test('accepts omitted and null compact input when model is a non-empty string', () => {
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max' }).input).toBeUndefined();
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: null }).input).toBeNull();
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: [] }).input).toEqual([]);
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: '' }).model).toBe('gpt-5.1-codex-max');
});

test('create parse still rejects missing input', () => {
  expect(() => parseOpenAIResponses({ model: 'gpt-5.1-codex-max' })).toThrow();
});

test.each([{}, { model: null }, { model: '' }] as const)('400s compact model %s', (body) => {
  expect(() => parseOpenAIResponsesCompact(body)).toThrow(OpenAIResponsesTransformError);
  try {
    parseOpenAIResponsesCompact(body);
  } catch (error) {
    expect(error).toMatchObject({ path: 'model' });
  }
});

test('400s compact stream true and does not treat null model as a wrong JSON type', () => {
  expect(() => parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', stream: true })).toThrow(
    new OpenAIResponsesTransformError('stream'),
  );
  expect(() => parseOpenAIResponsesCompact({ model: null })).not.toThrow(/expected string/i);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
rtk bun test packages/core/src/ingress/openai-responses/compact.test.ts
```

Expected: FAIL because `compact.ts` does not exist.

- [ ] **Step 3: Write the compact parser**

Parse with a loose official schema (`model: z.union([z.string(), z.null()]).optional()`, `input` optional union of string / array / null, optional nullable compact fields, `.passthrough()`). After Zod succeeds, if `stream === true` throw `new OpenAIResponsesTransformError('stream')`. If `model` is not a non-empty string, throw `new OpenAIResponsesTransformError('model')`. Return `{ ...parsed, model }` so TypeScript narrows `model` to `string`. Do not call `parseOpenAIResponses`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/ingress/openai-responses/compact.test.ts packages/core/src/ingress/openai-responses/request.test.ts
```

Expected: PASS. Create `request.test.ts` still requires semantic `input`.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/ingress/openai-responses/compact.ts packages/core/src/ingress/openai-responses/compact.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: parse official compact bodies without create input rules

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 7: Compact adapter semantics and route

**Files:**
- Modify: `packages/core/src/protocol/openai-responses.ts`
- Create: `packages/core/src/protocol/openai-responses-compact.test.ts`
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/openai-responses-unsupported.test.ts`
- Modify: `packages/server/src/routes/pipeline/diagnostics.test.ts`

**Interfaces:**
- Consumes: `parseOpenAIResponsesCompact`, `OpenAIResponsesUnsupportedFeatureError`, existing create parse/rewrite/session helpers.
- Produces: `export type OpenAIResponsesContext = { readonly operation?: 'create' | 'compact' }`. Adapter type becomes `defineProtocolAdapter<OpenAIResponsesRequest | OpenAIResponsesCompactRequest, OpenAIResponsesContext>`. `parse` dispatches on `context.operation`. `wantsStream: (req, ctx) => ctx.operation !== 'compact' && req.stream === true`. `requestDiagnostics: (req, ctx) => ctx.operation === 'compact' ? [] : existing create behavior`. `model(request)` returns `request.model` and does not throw. Session/dimensions treat official optional JSON `null` as omitted. Compact `modelInvocation` throws `new OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact')`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/protocol/openai-responses-compact.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { OpenAIResponsesUnsupportedFeatureError } from '../error';
import { openAIResponsesErrors } from './errors';
import { openAIResponsesAdapter } from './openai-responses';

const compactCtx = { operation: 'compact' } as const;

function compactRequest(body: Record<string, unknown>) {
  return openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    compactCtx,
  );
}

test('compact wantsStream is always false and stream true 400s before model()', async () => {
  await expect(compactRequest({ model: 'gpt-5.1-codex-max', stream: true })).rejects.toBeDefined();
  const parsed = await compactRequest({ model: 'gpt-5.1-codex-max', stream: false });
  expect(openAIResponsesAdapter.wantsStream(parsed, compactCtx)).toBe(false);
  expect(openAIResponsesAdapter.model(parsed, compactCtx)).toBe('gpt-5.1-codex-max');
});

test('compact optional nulls do not enter session or dimensions', async () => {
  const parsed = await compactRequest({
    model: 'gpt-5.1-codex-max',
    previous_response_id: null,
    prompt_cache_key: null,
    service_tier: null,
    background: true,
  });
  expect(openAIResponsesAdapter.session?.(parsed, compactCtx)).toMatchObject({
    candidates: [],
  });
  expect(openAIResponsesAdapter.session?.(parsed, compactCtx)?.previousResponseId).toBeUndefined();
  expect(openAIResponsesAdapter.dimensions(parsed, compactCtx)).toEqual({});
  expect(openAIResponsesAdapter.requestDiagnostics(parsed, compactCtx)).toEqual([]);
});

test('compact modelInvocation is 501 responses_compact', async () => {
  const parsed = await compactRequest({ model: 'gpt-5.1-codex-max' });
  expect(() => openAIResponsesAdapter.modelInvocation(parsed, compactCtx)).toThrow(
    new OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact'),
  );
  try {
    openAIResponsesAdapter.modelInvocation(parsed, compactCtx);
  } catch (error) {
    expect(openAIResponsesErrors.modelUnsupported?.(error)?.status).toBe(501);
  }
});
```

Add to `packages/server/src/routes/openai-responses-unsupported.test.ts`:

```ts
test('Given compact model null When POST is requested Then invalid request is returned before provider invocation', async () => {
  let invoked = false;
  const provider = aiSdkProvider(() => {
    invoked = true;
    return textStream([]);
  });
  const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
  const response = await app.request('/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: null, input: null }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: 'invalid_request', type: 'invalid_request_error' },
  });
  expect(invoked).toBe(false);
});
```

Add a diagnostics test that `handleProtocolRequest` with `context: { operation: 'compact' }` and `background: true` produces **no** `request.feature_downgraded` log. Keep the existing create diagnostic test.

- [ ] **Step 2: Run them to make sure they fail**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-compact.test.ts packages/server/src/routes/openai-responses-unsupported.test.ts packages/server/src/routes/pipeline/diagnostics.test.ts
```

Expected: FAIL on compact parse dispatch / missing route.

- [ ] **Step 3: Wire the adapter and route**

Change `openAIResponsesAdapter` to `OpenAIResponsesContext`. `parse` uses `parseOpenAIResponsesCompact` when `context.operation === 'compact'`. Implement `wantsStream` and `requestDiagnostics` exactly as the spec snippet. In `session` and `dimensions`, coerce `null` to omitted before `.trim()` / `candidate()`. Compact `modelInvocation` throws before building a ToolSet. Create path when `operation` is omitted stays identical.

Register static compact before `:id`:

```ts
.post('/v1/responses/compact', (context) =>
  handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: { operation: 'compact' },
    rawRequest: context.req.raw,
    source,
  }),
)
```

Create route stays `context: {}`. Existing `GET /v1/responses/:id` stays 501 `response_retrieval`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-compact.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/protocol/openai-responses.test.ts packages/server/src/routes/openai-responses-unsupported.test.ts packages/server/src/routes/pipeline/diagnostics.test.ts
```

Expected: PASS. Create `requestDiagnostics` still logs background drop. Existing create adapter tests pass with `{}` context.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/openai-responses.ts packages/core/src/protocol/openai-responses-compact.test.ts packages/server/src/routes/openai-responses.ts packages/server/src/routes/openai-responses-unsupported.test.ts packages/server/src/routes/pipeline/diagnostics.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: route compact through Responses adapter with parse-time guards

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 8: Compact dedicated raw rewrite

**Files:**
- Modify: `packages/core/src/protocol/openai-responses.ts` `rawRequest`
- Modify: `packages/core/src/protocol/openai-responses-compact.test.ts`

**Interfaces:**
- Consumes: `readRequestText`. Create `rewriteOpenAIResponsesRequest` stays create-only.
- Produces: `rewriteOpenAIResponsesCompactRequest(raw, resolvedModel): Promise<Request>`. Preserve path `/v1/responses/compact`. Preserve omitted/`null` `input`. Preserve `background` / `reasoning` extras. Strip any remaining `stream` key. Rewrite `model` only when resolved id differs. If `model` is unchanged and the body has no `stream` key, forward the original decoded body text. Reserialize only for model rewrite or stream strip.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/protocol/openai-responses-compact.test.ts`:

```ts
test('compact raw no-op forwards original decoded bytes including a large integer', async () => {
  const bodyText =
    '{"model":"gpt-5.1-codex-max","seed":9007199254740993,"previous_response_id":null,"background":true}';
  const raw = new Request('https://proxy.test/v1/responses/compact', { method: 'POST', body: bodyText });
  const parsed = await openAIResponsesAdapter.parse(raw, compactCtx);
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'gpt-5.1-codex-max', new Set(), compactCtx);
  expect(await forwarded.text()).toBe(bodyText);
  expect(new URL(forwarded.url).pathname).toBe('/v1/responses/compact');
});

test('compact raw strips leftover stream and rewrites model only then', async () => {
  const raw = new Request('https://proxy.test/v1/responses/compact', {
    method: 'POST',
    body: JSON.stringify({ model: 'src', stream: false, input: null, background: true }),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, compactCtx);
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'upstream', new Set(['low']), compactCtx);
  expect(await forwarded.json()).toEqual({ model: 'upstream', input: null, background: true });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-compact.test.ts --test-name-pattern "compact raw"
```

Expected: FAIL. Create rewrite strips `background` and/or reserializes the large integer.

- [ ] **Step 3: Implement compact-only rewrite**

`rawRequest` must call the create rewrite only when `context.operation !== 'compact'`. Compact rewrite reads `bodyText` once, `JSON.parse`s for inspection, and returns `new Request(raw, { method, body: bodyText, headers })` when `body.model === resolvedModel` and `!Object.hasOwn(body, 'stream')`. Otherwise `JSON.stringify({ ...bodyWithoutStream, model: resolvedModel })`. Delete `content-encoding` / `content-length` like create. Do not strip `background`. Do not clamp `reasoning.effort`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-compact.test.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts
```

Expected: PASS. Create raw still strips `background` and still preserves create no-op bytes.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/openai-responses.ts packages/core/src/protocol/openai-responses-compact.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: rewrite compact raw without create background or effort mutations

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 9: Official Responses resource 501s

**Files:**
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/openai-responses-unsupported.test.ts`

**Interfaces:**
- Consumes: `openAIResponsesAdapter.errors.unsupported(feature: string)`.
- Produces: `GET /v1/responses/:id` stays `response_retrieval`. Add `DELETE /v1/responses/:id` → `response_delete`, `POST /v1/responses/:id/cancel` → `response_cancel`, `GET /v1/responses/:id/input_items` → `response_input_items`. Do not register `GET /v1/responses`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/src/routes/openai-responses-unsupported.test.ts`:

```ts
test.each([
  ['DELETE', '/v1/responses/resp-1', 'response_delete'],
  ['POST', '/v1/responses/resp-1/cancel', 'response_cancel'],
  ['GET', '/v1/responses/resp-1/input_items', 'response_input_items'],
] as const)('Given %s %s When requested Then %s is 501 without a provider', async (method, path, feature) => {
  let invoked = false;
  const provider = aiSdkProvider(() => {
    invoked = true;
    return textStream([]);
  });
  const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
  const response = await app.request(path, { method });
  expect(response.status).toBe(501);
  expect(await response.json()).toEqual(unsupportedEnvelope(feature));
  expect(invoked).toBe(false);
});

test('Given GET /v1/responses When requested Then the list path stays unregistered', async () => {
  const app = await createServer({ config: { providers: {} } });
  const response = await app.request('/v1/responses');
  expect(response.status).toBe(404);
  const body = await response.text();
  expect(body).not.toContain('response_list');
});
```

Keep the existing retrieve test.

- [ ] **Step 2: Run them to make sure they fail**

Run:

```bash
rtk bun test packages/server/src/routes/openai-responses-unsupported.test.ts --test-name-pattern "response_delete|response_cancel|response_input_items|list path"
```

Expected: FAIL with Hono 404 on the new paths.

- [ ] **Step 3: Register the thin 501 routes**

```ts
.get('/v1/responses/:id', () => openAIResponsesAdapter.errors.unsupported('response_retrieval'))
.delete('/v1/responses/:id', () => openAIResponsesAdapter.errors.unsupported('response_delete'))
.post('/v1/responses/:id/cancel', () => openAIResponsesAdapter.errors.unsupported('response_cancel'))
.get('/v1/responses/:id/input_items', () => openAIResponsesAdapter.errors.unsupported('response_input_items'))
```

Static `/v1/responses/compact` must stay registered before `:id`. Do not add `GET /v1/responses`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/server/src/routes/openai-responses-unsupported.test.ts
```

Expected: PASS. Retrieve still 501. Compact POST still does not 404.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routes/openai-responses.ts packages/server/src/routes/openai-responses-unsupported.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: return protocol-shaped 501s for remaining Responses resources

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 10: Dispatch matrix, README, changeset

**Files:**
- Modify: `packages/server/__tests__/cross-protocol-routing.test.ts`
- Modify: `README.md` API table around the current Chat Completions / Responses rows
- Modify: `README.zh-Hans.md` matching API table
- Create: `.changeset/p0-language-protocol-ports.md`

**Interfaces:**
- Consumes: existing `inboundCases`, `provider()`, `request()`, `expectModelResponse()`.
- Produces: Completions inbound coverage that is **not** a fifth `inboundCases` protocol. Compact coverage that is **not** an `inboundCases` row. README inbound rows plus one sentence about resource 501s. User-facing changeset on `aio-proxy` and `@aio-proxy/core` `minor`.

- [ ] **Step 1: Write the failing dispatch tests**

Add dedicated tests after the `inboundCases` loop. Do not push compact or completions into `inboundCases`. Do not reuse `request(inboundCases[n], …)` for these paths: `InboundCase` is the create/chat union. Add this helper next to `request()`:

```ts
async function requestPath(
  path: string,
  body: unknown,
  providers: readonly RuntimeProviderInstance[],
  method: string = 'POST',
) {
  const app = await createServer({
    config: { providers: {} },
    dbHome: tempHome(),
    providerInstances: providers,
  });
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  });
}
```

```ts
test('Completions inbound uses openai-compatible raw only when protocols match', async () => {
  const same = provider(ProviderProtocol.OpenAICompatible, 'same');
  const response = await requestPath('/v1/completions', { model: 'm', prompt: 'hello' }, [same.value]);
  expect(response.status).toBe(200);
  expect(same.calls).toEqual({ model: 0, raw: 1 });
});

test('Completions inbound cross-protocol emits text_completion identity fields', async () => {
  const other = provider(ProviderProtocol.OpenAIResponse, 'other');
  const response = await requestPath('/v1/completions', { model: 'm', prompt: 'hello' }, [other.value]);
  expect(response.status).toBe(200);
  expect(other.calls).toEqual({ model: 1, raw: 0 });
  expect(await response.json()).toMatchObject({
    object: 'text_completion',
    model: expect.any(String),
    created: expect.any(Number),
    choices: [{ index: 0, logprobs: null }],
  });
});

test('Completions unfaithful n=2 501s model-only and still raw-forwards later', async () => {
  const modelOnly = provider(ProviderProtocol.OpenAIResponse, 'model-only');
  const rawLater = provider(ProviderProtocol.OpenAICompatible, 'raw-later');
  const body = { model: 'm', prompt: 'hello', n: 2 };
  const blocked = await requestPath('/v1/completions', body, [modelOnly.value]);
  expect(blocked.status).toBe(501);
  expect(modelOnly.calls.raw).toBe(0);
  const forwarded = await requestPath('/v1/completions', body, [modelOnly.value, rawLater.value]);
  expect(forwarded.status).toBe(200);
  expect(rawLater.calls).toEqual({ model: 0, raw: 1 });
});

test('compact same-protocol raw is unary JSON and omitted input still 200s', async () => {
  let upstreamStream: boolean | undefined;
  const fixture = provider(ProviderProtocol.OpenAIResponse, 'compact-raw');
  fixture.value.raw = {
    resolve: ({ protocol }) =>
      protocol === ProviderProtocol.OpenAIResponse
        ? {
            invoke: async (_req, _ctx, options) => {
              upstreamStream = options?.upstreamStream;
              fixture.calls.raw += 1;
              return Response.json({ object: 'response.compaction', output: [] });
            },
          }
        : undefined,
  };
  const response = await requestPath('/v1/responses/compact', { model: 'm' }, [fixture.value]);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: 'response.compaction' });
  expect(upstreamStream).toBe(false);
  expect(fixture.calls).toEqual({ model: 0, raw: 1 });
});

test.each([
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
] as const)('compact %s is 501 responses_compact and does not model-invoke', async (protocol) => {
  const fixture = provider(protocol, 'other');
  const response = await requestPath('/v1/responses/compact', { model: 'm', input: null }, [fixture.value]);
  expect(response.status).toBe(501);
  expect(JSON.stringify(await response.json())).toContain('responses_compact');
  expect(fixture.calls).toEqual({ model: 0, raw: 0 });
});
```

The `provider()` helper already increments `calls.raw` inside its default `raw` function. If you replace `raw.resolve`, keep `calls` updates consistent with the assertions above.

- [ ] **Step 2: Run them to make sure they fail**

Run:

```bash
rtk bun test packages/server/__tests__/cross-protocol-routing.test.ts --test-name-pattern "Completions inbound|compact"
```

Expected: FAIL until Tasks 4–8 are present. If those tasks are already committed, the new assertions should fail only where matrix wiring is still missing.

- [ ] **Step 3: Keep the matrix helpers honest and update docs**

Do not add compact to `inboundCases` (those rows expect 200 model conversion to `object: "response"`). Do not change the existing four-protocol create matrix.

In both README API tables, add after Chat Completions / Responses:

| OpenAI Completions | `POST /v1/completions` |
| OpenAI Responses compact | `POST /v1/responses/compact` |

Add one sentence under each table:

English: `Remaining official Responses resource operations (`GET /v1/responses/:id`, `DELETE /v1/responses/:id`, `POST /v1/responses/:id/cancel`, `GET /v1/responses/:id/input_items`) return a protocol-shaped 501.`

Chinese: `其余官方 Responses 资源操作（`GET /v1/responses/:id`、`DELETE /v1/responses/:id`、`POST /v1/responses/:id/cancel`、`GET /v1/responses/:id/input_items`）返回协议形 501。`

Do not document `GET /v1/responses` as a list port.

Create `.changeset/p0-language-protocol-ports.md`:

```md
---
"@aio-proxy/core": minor
"aio-proxy": minor
---

openai: add Completions and Responses compact ports

`POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404.
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```bash
rtk bun test packages/server/__tests__/cross-protocol-routing.test.ts packages/server/src/routes/openai-completions-legacy.test.ts packages/server/src/routes/openai-responses-unsupported.test.ts
```

Expected: PASS. Existing chat/create inbound rows still expect their current 200 shapes.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/__tests__/cross-protocol-routing.test.ts README.md README.zh-Hans.md .changeset/p0-language-protocol-ports.md
rtk git commit -m "$(cat <<'EOF'
docs: cover Completions and compact ports in matrix and README

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Two Completions adapter instances, no egress seam | 4 |
| Completions HTTP route `POST /v1/completions` | 5 |
| Official Completions wire ingress | 2 |
| Completions raw model rewrite, omitted/`null` prompt bytes | 3 |
| Completions model-path 501 table, no join, no empty user, no silent drop | 4 |
| Null Completions sampling normalization; `wantsStream`; no `user`/`stream` in settings | 4 |
| `text_completion` identity fields and `logprobs: null` | 5 |
| Dedicated compact parser; omitted/`null` input; model/`stream` parse 400 | 6, 7 |
| Compact unary JSON / `wantsStream` / empty diagnostics | 7 |
| Compact optional null semantics | 7 |
| Compact dedicated raw allowlist + no-op bytes | 8 |
| Compact cross-protocol 501 `responses_compact` | 7, 10 |
| Resource 501s delete/cancel/input_items; no list route | 9 |
| Dispatch matrix + README + changeset | 10 |
| Create `store` / `background` left unchanged | 7, 9 (do not edit create transform) |

## Placeholder scan

No TBD / later / “similar to Task N” steps. Each task has concrete files, commands, and assertions.

## Type consistency

- `OpenAICompletionsUnsupportedFeatureError(feature, path)` is produced in Task 1 and thrown in Task 4.
- `parseOpenAILegacyCompletions` / `OpenAILegacyCompletionsRequest` are produced in Task 2 and consumed in Tasks 3–5.
- `rewriteOpenAICompletionsRaw` is produced in Task 3 and consumed in Task 4.
- `openAILegacyCompletionsAdapter` is produced in Task 4; Task 5 replaces only its writers.
- `OpenAIResponsesContext.operation` is `'create' | 'compact'`; missing `operation` means create.
- `parseOpenAIResponsesCompact` success type has `model: string`.
- Compact 501 feature token is `responses_compact`. Resource tokens are `response_retrieval`, `response_delete`, `response_cancel`, `response_input_items`.
