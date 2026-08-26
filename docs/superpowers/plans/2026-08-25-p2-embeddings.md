# P2 Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inbound OpenAI `POST /v1/embeddings` and Gemini `:embedContent` / `:batchEmbedContents` through the shared candidate loop: same-family raw, `embeddingModel` convert, fallback, usage, and protocol-shaped errors.

**Architecture:** Two stateless embedding adapters reuse the existing wire-family `ProviderProtocol` values (`openai-compatible`, `gemini`) and a parallel `defineEmbeddingProtocolAdapter` factory. `attemptCandidates` stays the only loop and branches on `capability: 'embedding'`: capability-aware raw first, then `createProviderV4Embed`, never `languageModel` / `ModelInvocation`. Convert settings live in per-value `providerOptions`; usage is recovered from the AI SDK result or Google `usageMetadata` before OpenAI egress.

**Tech Stack:** TypeScript, Bun test runner, Zod 4, Hono, AI SDK `embed` / `embedMany` (`ai` + `@ai-sdk/openai` / `@ai-sdk/openai-compatible` / `@ai-sdk/google`).

**Spec:** [docs/superpowers/specs/2026-08-25-p2-embeddings-design.md](../specs/2026-08-25-p2-embeddings-design.md)

## Global Constraints

- Embeddings is not chat. Text (or official OpenAI token-id `input`) goes in; float vectors come out. Do not route through `languageModel` or `ModelInvocation`.
- Reuse `ProviderProtocol.OpenAICompatible` and `ProviderProtocol.Gemini`. Do not add authored `ProviderProtocol` values.
- Same-family raw wins when `raw.resolve({ protocol, modelId, capability: 'embedding' })` returns a transport. Language-only resolvers must return `undefined` for `'embedding'`. A raw throw does not retry the same candidate's convert.
- Convert uses `embeddingModel` + AI SDK `embed({ model, value, providerOptions, abortSignal })` or `embedMany({ model, values, providerOptions, abortSignal })`. Never pass `values` to `embed`.
- OpenAI parse accepts the official `input` union. Token-id `input` is raw-forwarded and convert 501. Empty strings and every array form `maxItems: 2048` are parse 400. Do not parse-time guess 8192 / 300000 token counts.
- Gemini single and batch raw always write body `model` to `models/<resolvedModel>`, including omitted client models.
- Gemini legacy top-level aliases are only `taskType` / `title` / `outputDimensionality`. `autoTruncate` / `audioTrackExtraction` / `documentOcr` live only on `embedContentConfig`. Audio/OCR on that config is parse 400, not strip. `title` / `autoTruncate` convert is 501 + fallback.
- OpenAI convert egress requires `usage.prompt_tokens` and `usage.total_tokens`. Recover tokens from SDK `usage.tokens`, else `response.body.usageMetadata.promptTokenCount`. Still unknown is 502 + fallback, not a missing `usage` object and not zeros.
- Gemini convert may omit `usageMetadata` when usage is unknown. Raw must not strip upstream usage.
- Session is omitted (generated session). `wantsStream` is always false. No Images / P1 dependency.
- New non-test files stay under 500 lines and use colocated `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts` when adding a module.
- Prefix every shell command with `rtk`. Already in isolated worktree `codex/p2-embeddings`; do not create or switch worktrees.
- User-facing changeset is `minor` on `aio-proxy` and `@aio-proxy/plugin-sdk` plus every internal package that actually changes, same bump level.

---

## File map

- `packages/plugin-sdk/src/runtime.ts` — add optional `capability: 'language' | 'embedding'` to `RawResolver` input.
- `packages/core/src/protocol/adapter.ts` — add embedding types and `defineEmbeddingProtocolAdapter`.
- `packages/core/src/protocol/errors.ts` — OpenAI embeddings and Gemini embeddings `ProtocolErrorMapper`s; 502 unknown-usage helper.
- `packages/core/src/error.ts` — `EmbeddingConvertUnsupportedError` for token-id / title / autoTruncate convert.
- `packages/core/src/ingress/openai-embeddings/` — OpenAI embeddings Zod parse.
- `packages/core/src/egress/openai-embeddings/` — OpenAI embeddings JSON egress.
- `packages/core/src/protocol/openai-embeddings/` — OpenAI embeddings adapter.
- `packages/core/src/ingress/gemini-embeddings/` — Gemini embed / batch parse.
- `packages/core/src/egress/gemini-embeddings/` — Gemini embed / batch JSON egress.
- `packages/core/src/protocol/gemini-embeddings/` — Gemini embeddings adapter.
- `packages/core/src/ai-sdk-bridge/index.ts` — re-export `embed` / `embedMany`.
- `packages/core/src/provider/provider-v4.ts` — add `createProviderV4Embed`.
- `packages/core/src/protocol/index.ts` and `packages/core/src/index.ts` — public exports.
- `packages/server/src/runtime.ts` — `EmbeddingTransport`, optional `embedding` on `RuntimeProviderInstance`, `capability` on raw resolve.
- `packages/server/src/routes/pipeline/attempt/embedding.ts` — embedding raw + convert attempt.
- `packages/server/src/routes/pipeline/attempt/attempt.ts` — branch on embedding adapter.
- `packages/server/src/usage-capture/` — non-stream embedding usage finalize.
- `packages/server/src/routes/openai-embeddings.ts` — `POST /v1/embeddings`.
- `packages/server/src/routes/gemini-generate-content.ts` — recognize `:embedContent` / `:batchEmbedContents`.
- `packages/server/src/server/server.ts` — register the OpenAI embeddings route.
- `packages/server/src/provider-runtime/materialize.ts` — attach embedding convert for API / AI SDK providers.
- `packages/server/src/plugin-runtime/capabilities.ts` — pass `capability` into plugin raw; union `catalog.language` and `catalog.embedding`; attach `createProviderV4Embed`.
- `packages/plugins/kimi-code/src/runtime/runtime.ts` — decline `capability: 'embedding'`.
- `packages/plugins/openai-chatgpt/src/runtime/runtime.ts` — decline embeddings explicitly.
- `packages/server/__tests__/embeddings-routing.test.ts` — embeddings dispatch matrix (language matrix stays language-only).
- `README.md` and `README.zh-Hans.md` — inbound table rows.
- `.changeset/p2-embeddings.md` — lockstep minor note.

Do not grow language adapters. Do not teach `cross-protocol-routing.test.ts` that `/v1/embeddings` is Chat Completions.

---

### Task 1: Embedding adapter factory and capability-aware RawResolver

**Files:**
- Modify: `packages/plugin-sdk/src/runtime.ts:74-78`
- Modify: `packages/core/src/protocol/adapter.ts`
- Test: `packages/core/__tests__/protocol/adapter.test.ts`
- Include in first commit: `docs/superpowers/specs/2026-08-25-p2-embeddings-design.md`
- Include in first commit: `docs/superpowers/plans/2026-08-25-p2-embeddings.md`

**Interfaces:**
- Consumes: existing `ProviderProtocol`, `ProtocolErrorMapper`.
- Produces: `EmbeddingProviderOptions`, `EmbeddingValue`, `EmbeddingInvocation`, `EmbeddingResult`, `EmbeddingProtocolAdapter`, `defineEmbeddingProtocolAdapter()`, and `RawResolver` input `capability?: 'language' | 'embedding'`.

- [ ] **Step 1: Write the failing factory test**

In `packages/core/__tests__/protocol/adapter.test.ts`, import `defineEmbeddingProtocolAdapter` from `../../src/index` and add:

```ts
import { ProviderProtocol } from '@aio-proxy/types';

import { defineEmbeddingProtocolAdapter } from './adapter';

test('defineEmbeddingProtocolAdapter freezes capability embedding and omits stream/session defaults', () => {
  const adapter = defineEmbeddingProtocolAdapter({
    capability: 'embedding',
    protocol: ProviderProtocol.OpenAICompatible,
    parse: async () => ({ model: 'm' }),
    model: (request) => request.model,
    rawRequest: async (raw) => raw,
    embeddingInvocation: () => ({ values: [{ value: 'hi' }] }),
    embeddingJson: (result) => result.embeddings,
      errors: {
      requestError: () => undefined,
      modelNotFound: (message) => Response.json({ message }, { status: 404 }),
      previousResponseConflict: () => new Response(null, { status: 409 }),
      tooLarge: () => new Response(null, { status: 413 }),
      unsupportedContentEncoding: () => new Response(null, { status: 415 }),
      unsupported: () => new Response(null, { status: 501 }),
      provider: () => undefined,
      rateLimited: () => new Response(null, { status: 429 }),
    },
  });
  expect(adapter.capability).toBe('embedding');
  expect(adapter.wantsStream({ model: 'm' }, { stream: true })).toBe(false);
});
```

- [ ] **Step 2: Run the test and confirm the factory is missing**

Run:

```bash
rtk bun test packages/core/__tests__/protocol/adapter.test.ts
```

Expected: FAIL because `defineEmbeddingProtocolAdapter` is not exported.

- [ ] **Step 3: Add the types and factory**

Append to `packages/core/src/protocol/adapter.ts`:

```ts
export type EmbeddingProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type EmbeddingValue = {
  readonly value: string;
  readonly providerOptions?: EmbeddingProviderOptions;
};

export type EmbeddingInvocation = {
  readonly values: readonly EmbeddingValue[];
  readonly encodingFormat?: 'float' | 'base64';
};

export type EmbeddingResult = {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage?: { readonly tokens?: number };
};

export type EmbeddingProtocolAdapter<TRequest, TContext> = Readonly<{
  capability: 'embedding';
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  dimensions: (request: TRequest, context: TContext) => AliasDimensions;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (
    raw: Request,
    request: TRequest,
    resolvedModel: string,
    context: TContext,
  ) => Promise<Request>;
  embeddingInvocation: (request: TRequest, context: TContext) => EmbeddingInvocation;
  embeddingJson: (result: EmbeddingResult, context: { readonly modelId: string }) => unknown;
  errors: ProtocolErrorMapper;
}>;

export function defineEmbeddingProtocolAdapter<TRequest, TContext>(
  definition: Omit<EmbeddingProtocolAdapter<TRequest, TContext>, 'dimensions' | 'requestDiagnostics' | 'wantsStream'> & {
    readonly dimensions?: EmbeddingProtocolAdapter<TRequest, TContext>['dimensions'];
    readonly requestDiagnostics?: EmbeddingProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
    readonly wantsStream?: EmbeddingProtocolAdapter<TRequest, TContext>['wantsStream'];
  },
): EmbeddingProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    wantsStream: definition.wantsStream ?? (() => false),
  });
}
```

In `packages/plugin-sdk/src/runtime.ts`, change `RawResolver` to:

```ts
export type RawResolver = (input: {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly metadata?: JsonValue;
  readonly capability?: 'language' | 'embedding';
}) => RawTransport | undefined;
```

Do not add `capability` onto language `ProtocolAdapter`.

- [ ] **Step 4: Re-run the factory test**

Run:

```bash
rtk bun test packages/core/__tests__/protocol/adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugin-sdk/src/runtime.ts packages/core/src/protocol/adapter.ts packages/core/__tests__/protocol/adapter.test.ts docs/superpowers/specs/2026-08-25-p2-embeddings-design.md docs/superpowers/plans/2026-08-25-p2-embeddings.md
rtk git commit -m "$(cat <<'EOF'
feat: add embedding protocol adapter factory

Introduce defineEmbeddingProtocolAdapter and optional RawResolver
capability so embeddings can dispatch without ModelInvocation.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 2: OpenAI embeddings parse

**Files:**
- Create: `packages/core/src/ingress/openai-embeddings/index.ts`
- Create: `packages/core/src/ingress/openai-embeddings/openai-embeddings.ts`
- Test: `packages/core/src/ingress/openai-embeddings/openai-embeddings.test.ts`

**Interfaces:**
- Consumes: Zod 4.
- Produces: `OpenAIEmbeddingsRequest`, `parseOpenAIEmbeddings(input: unknown): OpenAIEmbeddingsRequest` with `input` as `string | string[] | number[] | number[][]`, optional `encoding_format`, `dimensions`, `user`.

- [ ] **Step 1: Write failing parse tests**

```ts
import { expect, test } from 'bun:test';
import { ZodError } from 'zod';

import { parseOpenAIEmbeddings } from './openai-embeddings';

test('accepts a nonempty string and a 2048-item string array', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: 'hi' }).input).toBe('hi');
  expect(parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2048 }, () => 'x') }).input).toHaveLength(2048);
});

test('rejects empty strings and 2049 string items', () => {
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: '' })).toThrow(ZodError);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: ['ok', ''] })).toThrow(ZodError);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, () => 'x') })).toThrow(ZodError);
});

test('accepts token-id number[] of 2048 and rejects 2049', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2048 }, (_, i) => i) }).input).toHaveLength(2048);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, (_, i) => i) })).toThrow(ZodError);
});

test('accepts number[][] up to 2048 outer items', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: [[1, 2], [3]] }).input).toEqual([[1, 2], [3]]);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, () => [1]) })).toThrow(ZodError);
});
```

- [ ] **Step 2: Run parse tests**

```bash
rtk bun test packages/core/src/ingress/openai-embeddings/openai-embeddings.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement parse**

Use a Zod union. `z.string().min(1)`, `z.array(z.string().min(1)).min(1).max(2048)`, `z.array(z.number()).min(1).max(2048)`, `z.array(z.array(z.number()).min(1)).min(1).max(2048)`. `model: z.string().min(1)`. `encoding_format: z.enum(['float', 'base64']).optional()`. `dimensions: z.number().int().positive().optional()`. `user: z.string().optional()`. Export `parseOpenAIEmbeddings` via `index.ts` re-export only.

- [ ] **Step 4: Re-run parse tests**

```bash
rtk bun test packages/core/src/ingress/openai-embeddings/openai-embeddings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/ingress/openai-embeddings
rtk git commit -m "$(cat <<'EOF'
feat: parse official OpenAI embeddings input union

Accept string, string[], token-id number[], and number[][] with
empty-string and 2048-item guards.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 3: OpenAI embeddings adapter

**Files:**
- Create: `packages/core/src/egress/openai-embeddings/index.ts`
- Create: `packages/core/src/egress/openai-embeddings/openai-embeddings.ts`
- Create: `packages/core/src/protocol/openai-embeddings/index.ts`
- Create: `packages/core/src/protocol/openai-embeddings/openai-embeddings.ts`
- Test: `packages/core/src/protocol/openai-embeddings/openai-embeddings.test.ts`
- Test: `packages/core/src/egress/openai-embeddings/openai-embeddings.test.ts`
- Modify: `packages/core/src/protocol/errors.ts` — add `openAIEmbeddingsErrors` (copy OpenAI completions mapper; `unsupported` message names embeddings transform dispatch; `requestError` accepts ZodError / SyntaxError / `InvalidCompressedRequestBodyError`)
- Modify: `packages/core/src/protocol/index.ts` and `packages/core/src/index.ts` — export the adapter and parse

**Interfaces:**
- Consumes: `parseOpenAIEmbeddings`, `defineEmbeddingProtocolAdapter`, `readJsonRequest` / `readRequestText` from `packages/core/src/protocol/request.ts`.
- Produces: `openAIEmbeddingsAdapter`, `writeOpenAIEmbeddingsResponse(result, { modelId, encodingFormat })`.

- [ ] **Step 1: Write failing adapter tests**

```ts
test('rawRequest rewrites body model and forwards token-id input bytes otherwise', async () => {
  const body = { model: 'alias', input: [1, 2, 3] };
  const raw = new Request('https://x/v1/embeddings', { method: 'POST', body: JSON.stringify(body) });
  const request = parseOpenAIEmbeddings(body);
  const forwarded = await openAIEmbeddingsAdapter.rawRequest(raw, request, 'text-embedding-3-small', {});
  expect(await forwarded.json()).toEqual({ model: 'text-embedding-3-small', input: [1, 2, 3] });
});

test('embeddingInvocation maps string[] and dimensions/user onto openai and openaiCompatible', () => {
  const invocation = openAIEmbeddingsAdapter.embeddingInvocation(
    parseOpenAIEmbeddings({ model: 'm', input: ['a', 'b'], dimensions: 8, user: 'u' }),
    {},
  );
  expect(invocation.values).toEqual([
    { value: 'a', providerOptions: { openai: { dimensions: 8, user: 'u' }, openaiCompatible: { dimensions: 8, user: 'u' } } },
    { value: 'b', providerOptions: { openai: { dimensions: 8, user: 'u' }, openaiCompatible: { dimensions: 8, user: 'u' } } },
  ]);
});

test('embeddingInvocation rejects token-id input for convert', () => {
  expect(() =>
    openAIEmbeddingsAdapter.embeddingInvocation(parseOpenAIEmbeddings({ model: 'm', input: [1, 2] }), {}),
  ).toThrow(EmbeddingConvertUnsupportedError);
});
```

Also test egress writes required `usage` when tokens are present, and that `writeOpenAIEmbeddingsResponse` throws or returns a sentinel the pipeline will turn into 502 when `result.usage` is missing (do not emit a body without `usage`).

- [ ] **Step 2: Run adapter tests**

```bash
rtk bun test packages/core/src/protocol/openai-embeddings packages/core/src/egress/openai-embeddings
```

Expected: FAIL.

- [ ] **Step 3: Implement adapter, egress, and errors**

`rawRequest`: parse JSON, set `model` to `resolvedModel`, rebuild `Request` with original method/signal and stripped `content-length` / `content-encoding`. Forward other fields including token-id `input`.

`embeddingInvocation`: if `input` is `number[]` or `number[][]`, throw `EmbeddingConvertUnsupportedError('token-id')`. Otherwise build one `EmbeddingValue` per string. If `dimensions` or `user` exist, set both `providerOptions.openai` and `providerOptions.openaiCompatible`. Set `encodingFormat` from `encoding_format`.

`embeddingJson` / `writeOpenAIEmbeddingsResponse`: if `result.usage` is missing, throw `EmbeddingUsageRequiredError`. Else return `{ object: 'list', data: embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding: encode(embedding) })), model: context.modelId, usage: { prompt_tokens: tokens, total_tokens: tokens } }`. Base64-encode each vector only when `encodingFormat === 'base64'`.

`openAIEmbeddingsErrors.requestError` must map `EmbeddingConvertUnsupportedError` to 501 (`not_implemented` / `unsupported_feature`) so parse stays 400-only.

- [ ] **Step 4: Re-run adapter tests**

```bash
rtk bun test packages/core/src/protocol/openai-embeddings packages/core/src/egress/openai-embeddings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/openai-embeddings packages/core/src/egress/openai-embeddings packages/core/src/protocol/errors.ts packages/core/src/error.ts packages/core/src/protocol/index.ts packages/core/src/index.ts
rtk git commit -m "$(cat <<'EOF'
feat: add OpenAI embeddings inbound adapter

Rewrite resolved model on raw, map convert providerOptions, and require
usage on OpenAI egress.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 4: Gemini embeddings parse

**Files:**
- Create: `packages/core/src/ingress/gemini-embeddings/index.ts`
- Create: `packages/core/src/ingress/gemini-embeddings/gemini-embeddings.ts`
- Test: `packages/core/src/ingress/gemini-embeddings/gemini-embeddings.test.ts`

**Interfaces:**
- Consumes: Zod 4.
- Produces: `GeminiEmbedContentRequest`, `GeminiBatchEmbedContentsRequest`, `parseGeminiEmbedContent`, `parseGeminiBatchEmbedContents`.

- [ ] **Step 1: Write failing parse tests**

Cover: single text; joined text parts with no separator; empty joined text 400; non-text part 400; `embedContentConfig` with `taskType` / `title` / `outputDimensionality` / `autoTruncate`; `embedContentConfig.audioTrackExtraction` and `documentOcr` 400; top-level legacy only `taskType` / `title` / `outputDimensionality` (a top-level `autoTruncate` is not treated as config and must not 400 as OCR — ignore unknown top-level keys or leave them unparsed); empty `requests` 400; batch item inherits the same single-item rules.

```ts
test('rejects embedContentConfig.audioTrackExtraction rather than stripping it', () => {
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'doc' }] },
      embedContentConfig: { audioTrackExtraction: {} },
    }),
  ).toThrow(ZodError);
});

test('does not treat top-level autoTruncate as a legacy alias', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'doc' }] },
    autoTruncate: true,
  });
  expect(parsed.embedContentConfig?.autoTruncate).toBeUndefined();
});
```

- [ ] **Step 2: Run parse tests**

```bash
rtk bun test packages/core/src/ingress/gemini-embeddings/gemini-embeddings.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement parse**

Text parts only (`z.object({ text: z.string() }).strict()` or equivalent). Join later in the adapter. `embedContentConfig` schema: optional `taskType`, `title`, `outputDimensionality`, `autoTruncate`, and reject if `audioTrackExtraction` or `documentOcr` is present (`superRefine`). Top-level optional `taskType` / `title` / `outputDimensionality` only. Batch: `requests: z.array(single).min(1)`.

- [ ] **Step 4: Re-run parse tests**

```bash
rtk bun test packages/core/src/ingress/gemini-embeddings/gemini-embeddings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/ingress/gemini-embeddings
rtk git commit -m "$(cat <<'EOF'
feat: parse Gemini embed and batch embed requests

Accept official embedContentConfig, limit legacy aliases, and reject
audio/OCR instead of stripping them.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 5: Gemini embeddings adapter

**Files:**
- Create: `packages/core/src/egress/gemini-embeddings/` (`index.ts`, `gemini-embeddings.ts`, `gemini-embeddings.test.ts`)
- Create: `packages/core/src/protocol/gemini-embeddings/` (`index.ts`, `gemini-embeddings.ts`, `gemini-embeddings.test.ts`)
- Modify: `packages/core/src/protocol/errors.ts` — `geminiEmbeddingsErrors` (same shape as `geminiGenerateContentErrors`; `unsupported` says embeddings transform dispatch)
- Modify: `packages/core/src/protocol/index.ts` and `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Gemini parse + `defineEmbeddingProtocolAdapter`.
- Produces: `geminiEmbeddingsAdapter`, context `{ model: string; action: 'embedContent' | 'batchEmbedContents' }`, `writeGeminiEmbeddingsResponse`.

- [ ] **Step 1: Write failing raw/convert tests**

```ts
test('single embed raw always writes body model even when the client omitted it', async () => {
  const raw = new Request('https://x/v1beta/models/alias:embedContent', {
    method: 'POST',
    body: JSON.stringify({ content: { parts: [{ text: 'hi' }] } }),
  });
  const request = parseGeminiEmbedContent({ content: { parts: [{ text: 'hi' }] } });
  const forwarded = await geminiEmbeddingsAdapter.rawRequest(raw, request, 'gemini-embedding-001', {
    model: 'alias',
    action: 'embedContent',
  });
  expect(new URL(forwarded.url).pathname).toBe('/v1beta/models/gemini-embedding-001:embedContent');
  expect(await forwarded.json()).toMatchObject({ model: 'models/gemini-embedding-001' });
});

test('batch raw rewrites every requests[i].model including omitted and leftover aliases', async () => {
  const raw = new Request('https://x/v1beta/models/alias:batchEmbedContents', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { content: { parts: [{ text: 'a' }] } },
        { model: 'models/old', content: { parts: [{ text: 'b' }] } },
      ],
    }),
  });
  const request = parseGeminiBatchEmbedContents(JSON.parse(await raw.clone().text()));
  const forwarded = await geminiEmbeddingsAdapter.rawRequest(raw, request, 'gemini-embedding-001', {
    model: 'alias',
    action: 'batchEmbedContents',
  });
  const body = await forwarded.json();
  expect(body.requests[0].model).toBe('models/gemini-embedding-001');
  expect(body.requests[1].model).toBe('models/gemini-embedding-001');
});

test('maps TASK_TYPE_UNSPECIFIED to omitted and keeps title/autoTruncate for 501 grouping', () => {
  const invocation = geminiEmbeddingsAdapter.embeddingInvocation(
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'hi' }] },
      embedContentConfig: { taskType: 'TASK_TYPE_UNSPECIFIED', title: 'Doc', autoTruncate: true },
    }),
    { model: 'm', action: 'embedContent' },
  );
  expect(invocation.values[0]?.providerOptions?.google).toEqual({ title: 'Doc', autoTruncate: true });
});
```

Also assert convert egress writes `{ embedding: { values }, usageMetadata: { promptTokenCount } }` when usage is present and omits `usageMetadata` when usage is absent. Same for batch `{ embeddings: [{ values }] }`.

- [ ] **Step 2: Run tests**

```bash
rtk bun test packages/core/src/protocol/gemini-embeddings packages/core/src/egress/gemini-embeddings
```

Expected: FAIL.

- [ ] **Step 3: Implement adapter**

Always set path `/v1beta/models/${encodeURIComponent(resolvedModel)}:${action}` and always set body `model` / each `requests[i].model` to `models/${resolvedModel}`. Preserve accepted official config fields already on the parsed request. Join text parts with `''`. Normalize options: config first, then only the three legacy aliases; `TASK_TYPE_UNSPECIFIED` omitted; `autoTruncate` only from config. If `title` or `autoTruncate` remains, still put them on the value's `providerOptions.google` so later convert can 501. Map `outputDimensionality` onto `google.outputDimensionality`, `openai.dimensions`, and `openaiCompatible.dimensions`. Map `taskType` onto `google.taskType`.

- [ ] **Step 4: Re-run tests**

```bash
rtk bun test packages/core/src/protocol/gemini-embeddings packages/core/src/egress/gemini-embeddings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/protocol/gemini-embeddings packages/core/src/egress/gemini-embeddings packages/core/src/protocol/errors.ts packages/core/src/protocol/index.ts packages/core/src/index.ts
rtk git commit -m "$(cat <<'EOF'
feat: add Gemini embeddings inbound adapter

Unconditionally rewrite single and batch body models and normalize
embedContentConfig for convert.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 6: HTTP routes and README

**Files:**
- Create: `packages/server/src/routes/openai-embeddings.ts`
- Modify: `packages/server/src/routes/gemini-generate-content.ts`
- Test: `packages/server/src/routes/gemini-generate-content-embed.test.ts`
- Modify: `packages/server/src/server/server.ts:25-28` and `:360-371`
- Modify: `README.md:272-282` and the matching inbound table in `README.zh-Hans.md` (around the existing Gemini generateContent rows)

**Interfaces:**
- Consumes: `openAIEmbeddingsAdapter`, `geminiEmbeddingsAdapter`, `handleProtocolRequest`.
- Produces: `POST /v1/embeddings`; Gemini suffixes `:embedContent` and `:batchEmbedContents` on the existing `/v1beta/models/*` router; unknown Gemini actions stay 404.

- [ ] **Step 1: Write a failing route test**

Export a small `geminiModelsRouteTarget(pathname)` from `gemini-generate-content.ts` (rename/move the current private `routeTarget`) and test:

```ts
expect(geminiModelsRouteTarget('/v1beta/models/m:embedContent')).toEqual({
  kind: 'embed',
  model: 'm',
  action: 'embedContent',
});
expect(geminiModelsRouteTarget('/v1beta/models/m:batchEmbedContents')?.action).toBe('batchEmbedContents');
expect(geminiModelsRouteTarget('/v1beta/models/m:unknownAction')).toBeUndefined();
expect(geminiModelsRouteTarget('/v1beta/models/m:generateContent')).toMatchObject({ kind: 'generate', stream: false });
```

- [ ] **Step 2: Run the route test**

```bash
rtk bun test packages/server/src/routes/gemini-generate-content-embed.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement routes**

`createOpenAIEmbeddingsRoutes` mirrors `createOpenAICompletionsRoutes` but posts `/v1/embeddings` with `openAIEmbeddingsAdapter` and `context: {}`.

Extend Gemini routing with `kind: 'generate' | 'embed' | 'count'`. On embed, call `handleProtocolRequest` with `geminiEmbeddingsAdapter` and `{ model, action }`. Register `createOpenAIEmbeddingsRoutes(state)` next to the other inbound routes in `server.ts`. Add the three README rows without replacing generateContent rows.

- [ ] **Step 4: Re-run the route test**

```bash
rtk bun test packages/server/src/routes/gemini-generate-content-embed.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routes/openai-embeddings.ts packages/server/src/routes/gemini-generate-content.ts packages/server/src/routes/gemini-generate-content-embed.test.ts packages/server/src/server/server.ts README.md README.zh-Hans.md
rtk git commit -m "$(cat <<'EOF'
feat: register OpenAI and Gemini embeddings routes

Add POST /v1/embeddings and explicit Gemini embed suffixes while
keeping unknown actions as 404.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

`handleProtocolRequest` still types `ProtocolAdapter` after this task. In the two new/updated route call sites, pass `adapter: openAIEmbeddingsAdapter as never` and `adapter: geminiEmbeddingsAdapter as never`. Task 9 widens the options type and removes those casts.

---

### Task 7: createProviderV4Embed

**Files:**
- Modify: `packages/core/src/ai-sdk-bridge/index.ts` — export `embed` and `embedMany` from `ai`
- Modify: `packages/core/src/provider/provider-v4.ts`
- Test: `packages/core/src/provider/provider-v4.embed.test.ts`

**Interfaces:**
- Consumes: `EmbeddingInvocation`, `EmbeddingResult`, `ProviderV4`.
- Produces:

```ts
export type ProviderV4Embed = (
  invocation: EmbeddingInvocation,
  options: { readonly modelId: string; readonly signal?: AbortSignal; readonly logicalRequest?: unknown },
) => Promise<EmbeddingResult>;

export function createProviderV4Embed(
  providerId: string,
  provider: ProviderV4,
  deps?: { readonly embed?: typeof embed; readonly embedMany?: typeof embedMany },
): ProviderV4Embed;
```

- [ ] **Step 1: Write failing call-shape and usage tests**

Inject fake `embed` / `embedMany`:

```ts
test('one-value group calls embed with singular value', async () => {
  const calls: unknown[] = [];
  const embedFn = async (args: { value: string }) => {
    calls.push(args);
    return { embedding: [0.1], usage: { tokens: 3 }, response: { body: {} } };
  };
  const run = createProviderV4Embed('p', providerFixture(), { embed: embedFn as never, embedMany: async () => {
    throw new Error('embedMany');
  } });
  const result = await run({ values: [{ value: 'a', providerOptions: { openai: { dimensions: 8 } } }] }, { modelId: 'm' });
  expect(calls[0]).toMatchObject({ value: 'a', providerOptions: { openai: { dimensions: 8 } } });
  expect(result.usage).toEqual({ tokens: 3 });
});

test('multi-value group calls embedMany with values', async () => {
  const embedManyFn = async (args: { values: string[] }) => {
    expect(args.values).toEqual(['a', 'b']);
    return { embeddings: [[0.1], [0.2]], usage: { tokens: 4 }, responses: [{ body: {} }] };
  };
  const run = createProviderV4Embed('p', providerFixture(), { embed: async () => {
    throw new Error('embed');
  }, embedMany: embedManyFn as never });
  const result = await run(
    { values: [{ value: 'a' }, { value: 'b' }] },
    { modelId: 'm' },
  );
  expect(result.embeddings).toEqual([[0.1], [0.2]]);
});

test('recovers Google usageMetadata when SDK usage is undefined', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => ({
      embedding: [0.1],
      usage: { tokens: Number.NaN },
      response: { body: { usageMetadata: { promptTokenCount: 9 } } },
    }) as never,
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  expect((await run({ values: [{ value: 'a' }] }, { modelId: 'm' })).usage).toEqual({ tokens: 9 });
});

test('unsets usage when each group is valid but the sum overflows MAX_SAFE_INTEGER', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async ({ value }: { value: string }) => ({
      embedding: [0.1],
      usage: { tokens: value === 'a' ? Number.MAX_SAFE_INTEGER : 1 },
      response: { body: {} },
    }) as never,
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  const result = await run(
    {
      values: [
        { value: 'a', providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } } },
        { value: 'b', providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } } },
      ],
    },
    { modelId: 'm' },
  );
  expect(result.usage).toBeUndefined();
  expect(result.embeddings).toHaveLength(2);
});
```

`providerFixture()` returns `{ embeddingModel: () => ({}) } as ProviderV4`.

- [ ] **Step 2: Run tests**

```bash
rtk bun test packages/core/src/provider/provider-v4.embed.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement grouping, call shapes, and usage recovery**

Group values by structural equality of normalized `providerOptions` (omit empty namespaces). If any value has `providerOptions.google.title` or `providerOptions.google.autoTruncate`, throw `EmbeddingConvertUnsupportedError('title')` / `'autoTruncate'` before calling the SDK. One-value groups call `embed({ model: provider.embeddingModel(modelId), value, providerOptions, abortSignal })`. Two-plus call `embedMany({ model, values, providerOptions, abortSignal })`. Restore original order. Per group, accept `usage.tokens` only when `Number.isSafeInteger(tokens) && tokens >= 0`; else read `promptTokenCount` from that call's response body. Add into a running total and re-check `Number.isSafeInteger(total) && total >= 0`. Any unknown or overflow unsets `usage` on the result (do not throw here — OpenAI egress / pipeline decides 502).

Wrap thrown SDK errors in `AiSdkProviderError(providerId, error)`.

- [ ] **Step 4: Re-run tests**

```bash
rtk bun test packages/core/src/provider/provider-v4.embed.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/provider/provider-v4.ts packages/core/src/provider/provider-v4.embed.test.ts packages/core/src/ai-sdk-bridge/index.ts
rtk git commit -m "$(cat <<'EOF'
feat: embed through Provider V4 with grouped providerOptions

Call embed vs embedMany correctly and recover Google usageMetadata
before summing tokens.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 8: Runtime embedding capability and materialization

**Files:**
- Modify: `packages/server/src/runtime.ts:33-67`
- Modify: `packages/server/src/provider-runtime/materialize.ts:41-85`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts:25-57` and `:114-135`
- Modify: `packages/core/src/provider/ai-sdk/ai-sdk.ts` — optional `embed` on `AiSdkProviderInstance` when `embeddingModel` exists
- Test: `packages/server/src/plugin-runtime/capabilities.test.ts`
- Test: `packages/server/src/provider-runtime/materialize.test.ts`

**Interfaces:**
- Consumes: `createProviderV4Embed`, `EmbeddingInvocation`, `EmbeddingResult`.
- Produces:

```ts
export type EmbeddingTransport = {
  readonly embed: (
    invocation: EmbeddingInvocation,
    options: { readonly modelId: string; readonly signal?: AbortSignal; readonly logicalRequest: LogicalRequestContext },
  ) => Promise<EmbeddingResult>;
};

export type RuntimeRawCapability = {
  readonly resolve: (input: {
    readonly protocol: ProviderProtocol;
    readonly modelId: string;
    readonly capability?: 'language' | 'embedding';
  }) => RawTransport | undefined;
};
```

`RuntimeProviderInstance` may include any combination of `raw`, `model`, and `embedding` (at least one).

- [ ] **Step 1: Write failing materialization tests**

Assert OAuth `createRuntimeProvider` unions `catalog.language` and `catalog.embedding` into `models`. Assert `raw.resolve({ protocol, modelId, capability: 'embedding' })` forwards `capability` to the plugin resolver. Assert an API provider with a Gemini or OpenAI-compatible primary endpoint gets `embedding` when the bridged package exposes `embeddingModel`.

- [ ] **Step 2: Run those existing test files**

```bash
rtk bun test packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/provider-runtime/materialize.test.ts
```

Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Pass `capability` through `rawCapability`. For models: `exposedModelIds([...catalog.language, ...catalog.embedding].map((item) => item.id), config.models)` with unique ids. Attach `embedding: { embed: createProviderV4Embed(config.id, result.provider) }` whenever `validateProviderV4` succeeds (Provider V4 always has `embeddingModel`; unsupported implementations fail at invoke). API/AI SDK materialization attaches the same when the loaded/bridged provider has `embeddingModel`. Metadata lookup must include embedding catalog descriptors.

- [ ] **Step 4: Re-run materialization tests**

```bash
rtk bun test packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/provider-runtime/materialize.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/runtime.ts packages/server/src/provider-runtime/materialize.ts packages/server/src/plugin-runtime/capabilities.ts packages/core/src/provider/ai-sdk/ai-sdk.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/provider-runtime/materialize.test.ts
rtk git commit -m "$(cat <<'EOF'
feat: materialize embedding transports and capability-aware raw

Expose embedding convert beside raw/model and forward embedding
capability into plugin raw resolvers.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 9: Pipeline embedding attempt and usage capture

**Files:**
- Create: `packages/server/src/routes/pipeline/attempt/embedding.ts`
- Test: `packages/server/src/routes/pipeline/attempt/embedding.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:19-33` and `:150-167`
- Modify: `packages/server/src/routes/pipeline/index.ts:18-23`
- Modify: `packages/server/src/usage-capture/shared.ts` and `usage-capture.ts` — add `embedding(...)` that finalizes `inputTokens` / `totalTokens` from `EmbeddingResult.usage.tokens` via existing `finalizeUsage` / `UsageRowSchema`
- Test: `packages/server/src/usage-capture/usage-capture.embedding.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProtocolAdapter`, `EmbeddingTransport`, `createAttemptEmitter` / fallback helpers already used by `attemptRawCandidate`.
- Produces: `attemptEmbeddingCandidate`; `HandleProtocolRequestOptions.adapter` becomes `ProtocolAdapter | EmbeddingProtocolAdapter`.

- [ ] **Step 1: Write failing pipeline unit tests**

Use a fake adapter + fake provider:

```ts
test('language-only raw that returns undefined falls through to embedding convert', async () => {
  const embed = mock(async () => ({ embeddings: [[0.1]], usage: { tokens: 2 } }));
  const provider = {
    id: 'kimi',
    kind: ProviderKind.OAuth,
    enabled: true,
    raw: { resolve: ({ capability }: { capability?: string }) => (capability === 'embedding' ? undefined : { invoke: async () => new Response('nope') }) },
    embedding: { embed },
  };
  const response = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter, provider), slot(provider));
  expect(response.kind).toBe('return');
  expect(embed).toHaveBeenCalled();
});

test('OpenAI convert with unknown usage after recovery is 502 and can fallback', async () => {
  const provider = {
    id: 'g',
    kind: ProviderKind.Api,
    enabled: true,
    embedding: { embed: async () => ({ embeddings: [[0.1]] }) },
  };
  const step = await attemptEmbeddingCandidate(ctx(openAIEmbeddingsAdapter, provider, { hasNext: true }), slot(provider));
  expect(step.kind).toBe('fallback');
  expect(step.lastFailure.status).toBe(502);
});
```

Wire `ctx` / `slot` like `packages/server/src/routes/pipeline/attempt.test.ts` already does for language attempts.

- [ ] **Step 2: Run the new tests**

```bash
rtk bun test packages/server/src/routes/pipeline/attempt/embedding.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the embedding attempt**

Detect embedding adapters with `'capability' in adapter && adapter.capability === 'embedding'`. For each candidate:

1. `raw.resolve({ protocol: adapter.protocol, modelId: candidate.modelId, capability: 'embedding' })`. If present, rewrite via `adapter.rawRequest(raw, request, modelId, context)` (no effort set) and reuse the existing raw success/fallback status rules. Do not retry convert on the same candidate after a raw throw or non-fallback status.
2. Else if `provider.embedding` exists, call `embeddingInvocation`. Catch `EmbeddingConvertUnsupportedError` → `adapter.errors.unsupported(feature)` and fallback if `hasNext`. If invocation values carry `google.title` or `google.autoTruncate`, same 501. Call `embedding.embed(invocation, { modelId, signal: rawRequest.signal, logicalRequest })`. If inbound adapter is OpenAI embeddings and `result.usage` is missing, treat as 502 `upstream_error` (`openAIInvalid(502, 'upstream_error', 'Embedding usage was not reported')`) and fallback if `hasNext`. Else `Response.json(adapter.embeddingJson(result, { modelId }))`. Capture usage with the new non-stream helper only when `result.usage` is present.
3. Else `unsupportedDispatch`.

Remove the Task 6 route casts.

- [ ] **Step 4: Re-run attempt + usage tests**

```bash
rtk bun test packages/server/src/routes/pipeline/attempt/embedding.test.ts packages/server/src/usage-capture/usage-capture.embedding.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routes/pipeline packages/server/src/usage-capture packages/server/src/routes/openai-embeddings.ts packages/server/src/routes/gemini-generate-content.ts
rtk git commit -m "$(cat <<'EOF'
feat: dispatch embeddings through the shared candidate loop

Try capability-aware raw then embedding convert, and fail OpenAI
egress when usage cannot be recovered.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

### Task 10: Kimi/ChatGPT raw decline and embeddings dispatch matrix

**Files:**
- Modify: `packages/plugins/kimi-code/src/runtime/runtime.ts:54-62`
- Test: `packages/plugins/kimi-code/src/runtime/runtime.raw.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts:35-38`
- Test: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`
- Create: `packages/server/__tests__/embeddings-routing.test.ts`
- Create: `.changeset/p2-embeddings.md`

**Interfaces:**
- Consumes: `RawResolver` `capability`, live server from `#server-test-lifecycle` like `cross-protocol-routing.test.ts`.
- Produces: language-only OAuth raw returns `undefined` for embeddings; HTTP matrix for the spec table.

- [ ] **Step 1: Write failing Kimi and matrix tests**

In `runtime.raw.test.ts`:

```ts
test('declines embeddings so convert can run on the same candidate', async () => {
  const runtime = await createKimiRuntime(context(validCredential(), catalog()));
  expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'openai-model', capability: 'embedding' })).toBeUndefined();
  expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'openai-model', capability: 'language' })).toBeDefined();
});
```

In `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`, extend the existing `returns a ProviderV4 with same-protocol raw capability only` test:

```ts
expect(runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5', capability: 'embedding' })).toBeUndefined();
expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-5.5', capability: 'embedding' })).toBeUndefined();
```

In `embeddings-routing.test.ts`, copy the `createServer` / fake-provider pattern from `cross-protocol-routing.test.ts`. Cover at least:

| Inbound | Candidate | Expected |
| --- | --- | --- |
| OpenAI embeddings | API `openai-compatible` raw | raw invoke, not language invoke |
| OpenAI embeddings | API `gemini` raw only | embedding convert |
| OpenAI embeddings | API `openai-response` | convert, not raw |
| OpenAI embeddings | API `anthropic` | 501 then next candidate |
| Gemini embed / batch | API `gemini` raw | raw path is the matching action |
| Gemini embed | API `openai-compatible` | convert; body is Gemini envelope |
| OpenAI embeddings | single Kimi-style language-only raw + `embedding.embed` | convert; raw resolve saw `capability: 'embedding'` and returned undefined |
| Gemini unknown action | any | 404 |

Also assert OpenAI convert that returns embeddings but no recoverable usage is 502.

- [ ] **Step 2: Run the new tests**

```bash
rtk bun test packages/plugins/kimi-code/src/runtime/runtime.raw.test.ts packages/server/__tests__/embeddings-routing.test.ts
```

Expected: FAIL on the embedding decline / matrix cases.

- [ ] **Step 3: Implement plugin declines**

Kimi `raw(input)`: if `input.capability === 'embedding'` return `undefined` before path allowlisting. ChatGPT `raw`: return `undefined` when `capability === 'embedding'` (it already ignores `openai-compatible`, but make the decline explicit). Do not special-case plugin names in the pipeline.

Add `.changeset/p2-embeddings.md`:

```md
---
"aio-proxy": minor
"@aio-proxy/plugin-sdk": minor
"@aio-proxy/core": minor
"@aio-proxy/server": minor
"@aio-proxy/plugin-kimi-code": minor
"@aio-proxy/plugin-openai-chatgpt": minor
---

Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.
```

Use those exact package names. Product packages `aio-proxy` and `@aio-proxy/plugin-sdk` must be listed so the GitHub Release note is not empty.

- [ ] **Step 4: Re-run plugin + matrix tests**

```bash
rtk bun test packages/plugins/kimi-code/src/runtime/runtime.raw.test.ts packages/server/__tests__/embeddings-routing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/kimi-code packages/plugins/openai-chatgpt packages/server/__tests__/embeddings-routing.test.ts .changeset/p2-embeddings.md
rtk git commit -m "$(cat <<'EOF'
feat: keep language-only OAuth raw from shadowing embeddings

Decline embedding capability in Kimi and ChatGPT raw resolvers and
cover the embeddings dispatch matrix.

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

Then run scoped verification (not a claim of full-repo green):

```bash
rtk bun test packages/core/src/ingress/openai-embeddings packages/core/src/ingress/gemini-embeddings packages/core/src/protocol/openai-embeddings packages/core/src/protocol/gemini-embeddings packages/core/src/provider/provider-v4.embed.test.ts packages/server/src/routes/pipeline/attempt/embedding.test.ts packages/server/__tests__/embeddings-routing.test.ts packages/plugins/kimi-code/src/runtime/runtime.raw.test.ts
```

Expected: PASS. Do not claim `bun run preflight` unless you run it.

---

## Spec coverage

- OpenAI parse union, empty string, 2048/2049 for `string[]` and `number[]` — Task 2
- Token-id raw forward + convert 501 — Tasks 3, 9, 10
- OpenAI required usage + Google `usageMetadata` recovery + unknown 502 — Tasks 3, 7, 9, 10
- Gemini config / legacy aliases / audio-OCR reject / `TASK_TYPE_UNSPECIFIED` / title+autoTruncate 501 — Tasks 4, 5, 7, 9
- Single + batch unconditional body `model` rewrite — Task 5
- embed vs embedMany call shapes + overflow omit — Task 7
- Capability-aware raw, Kimi-style single candidate — Tasks 1, 8, 9, 10
- Routes, 404 unknown Gemini action, README — Task 6
- Shared candidate loop, no language invoke — Task 9
- Usage capture finite safe integers — Task 9
- Changeset product packages — Task 10
- 8192 / 300000 not parse-time — Task 2 (explicitly not implemented)

## Type names locked by this plan

- `defineEmbeddingProtocolAdapter`, `EmbeddingProtocolAdapter`, `EmbeddingInvocation`, `EmbeddingValue`, `EmbeddingResult`, `EmbeddingProviderOptions`
- `parseOpenAIEmbeddings`, `openAIEmbeddingsAdapter`, `writeOpenAIEmbeddingsResponse`
- `parseGeminiEmbedContent`, `parseGeminiBatchEmbedContents`, `geminiEmbeddingsAdapter`, `writeGeminiEmbeddingsResponse`
- `createProviderV4Embed`, `ProviderV4Embed`, `EmbeddingTransport`
- `attemptEmbeddingCandidate`
- `EmbeddingConvertUnsupportedError`, `EmbeddingUsageRequiredError`
