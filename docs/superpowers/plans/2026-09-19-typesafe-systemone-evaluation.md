# TypeSafe System One Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeSafe System One client can `POST /v1/systemone` through aio-proxy and get evaluations, with model-first routing, priority/weight failover, usage recording, and TypeSafe-shaped errors.

**Architecture:** A seventh `InboundCapability` (`evaluation`) and a new `ProviderProtocol` wire family (`typesafe-systemone`). One stateless core adapter, one thin route, one new arm in the existing candidate loop. Same-protocol raw passthrough wins; otherwise convert through the AI SDK's `experimental_evaluate`. Capability is granted from discovered transports, never from protocol metadata alone.

**Tech Stack:** Bun, Hono, `ai@7.0.107` `experimental_evaluate`, `@ai-sdk/provider@4.0.17`, zod v4, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-19-typesafe-systemone-evaluation-design.md`

## Global Constraints

- Protocol value is exactly `ProviderProtocol.TypeSafeSystemOne = 'typesafe-systemone'`. Route path is exactly `POST /v1/systemone`.
- Never hardcode a model ID (`jev-latest`, `typesafe-ai/jev`) in implementation code. Test fixtures may name them.
- Five catalog bumps, all required: `ai` 7.0.8 to 7.0.107, `@ai-sdk/provider` 4.0.1 to 4.0.17, `@ai-sdk/openai` 4.0.4 to 4.0.71, `@ai-sdk/anthropic` 4.0.3 to 4.0.58, `@ai-sdk/google` 4.0.3 to 4.0.76. Do NOT add `@ai-sdk/typesafe-ai` or `@ai-sdk/gateway` to the repo: user-configured `ai-sdk` packages install on demand via `npmAdd`.
- `state` is a string, object, or array. `null`, numbers, and booleans are rejected at parse, matching `isInput()` in `ai@7.0.107`.
- Reject any number anywhere in the body that parses to a non-finite value. `JSON.parse('1e400')` is `Infinity`.
- Unknown fields are preserved through parse and raw, and projected away at convert. `noul.criteria` projects to exactly `true`/`false`, preserving absence. `state` and `instructions` are never projected.
- Raw passthrough is byte-for-byte. No response-body validation, no `model` normalization, no error-shape normalization on raw.
- `probabilities` is required on convert-generated choice/score answers; a missing one fails the candidate with `errors.unsupported('evaluation_distribution')` and falls back.
- Evaluation capability is granted from a discovered transport OR a `typesafe-systemone` endpoint. Never from the protocol table alone.
- A convert probe result is a fact about the convert transport only, never a verdict on the candidate. Raw availability admits regardless of probe state and must not wait on it.
- Evaluation uses a generated logical session. No affinity, no response ownership.
- `maxRetries: 0` on every `experimental_evaluate` call. The pipeline owns retry.
- Handwritten non-test implementation files stay under 500 lines.
- One changeset targeting BOTH `aio-proxy` and `@aio-proxy/plugin-sdk`, plus every changed internal package, at matching bump levels.
- **Do not gate on `bun run preflight`. It cannot pass on macOS.** `lint:types` is red on a pristine tree and gated by nothing in CI, and 21 `@aio-proxy/cli` tests are Linux-only. Use the differential gate in `.superpowers/sdd/baseline.md` instead: `bun run check` PASS, every touched package's tests green, `types`/`plugin-sdk`/`core` at 0 fail, and no new `lint:types` file or error beyond the recorded baseline. Linux CI is the final authority.

## File structure

```
packages/types/src/provider-endpoints/
  provider-endpoints.ts                      # + TypeSafeSystemOne enum value

packages/plugin-sdk/src/
  runtime.ts                                 # + ProtocolId value, + RawResolver capability 'evaluation'

packages/core/src/protocol/
  adapter.ts                                 # + 'evaluation' capability, evaluation adapter types, factory, guard
  typesafe-systemone/
    index.ts                                 # export-only barrel
    typesafe-systemone.ts                    # adapter definition
    parse.ts                                 # body parse + rejection rules
    egress.ts                                # evaluationJson
    errors.ts                                # TypeSafe-shaped ProtocolErrorMapper
    parse.test.ts
    egress.test.ts
    typesafe-systemone.test.ts

packages/core/src/provider/
  provider-v4.ts                             # + createProviderV4Evaluate
  provider-v4-evaluate.test.ts               # SDK-boundary tests

packages/core/src/ai-sdk-package-protocol/    # renamed+relocated from image-input
  index.ts
  ai-sdk-package-protocol.ts                 # + '@ai-sdk/typesafe-ai' arm
  ai-sdk-package-protocol.test.ts

packages/server/src/
  runtime.ts                                 # + optional evaluation runtime capability
  routes/systemone.ts                        # thin route
  routes/pipeline/attempt/
    attempt.ts                               # dispatch arm + case
    evaluation.ts                            # attemptEvaluationCandidate
    evaluation.test.ts
    raw.ts                                   # credential stripping reachable from evaluation
    capability-filter/capability-filter.ts   # evaluation arm
  provider-runtime/
    capability-index/capability-index.ts     # protocol rows, synthesizesEvaluation, supportsEvaluation
    materialize/                             # evaluation transport + lazy memoized probe
    evaluation-discovery/
      index.ts
      evaluation-discovery.ts                # probe states + memoization
      evaluation-discovery.test.ts
  server/api-key-auth/api-key-auth.ts        # /v1/systemone branch in authenticationError
  usage-capture/
    evaluation-capture/
      index.ts
      evaluation-capture.ts
      evaluation-capture.test.ts
  passthrough-usage/                         # typesafe-systemone extractor arms
```

---
### Task 1: Bump the five AI SDK packages

The feature cannot work on the pinned versions: `experimental_evaluate` arrived in `ai@7.0.103`, `Experimental_EvaluationModelV4` is absent from `@ai-sdk/provider@4.0.1`, and the pinned provider packages have no `evaluationModel`. This task ships no feature code, so a reviewer can judge the upgrade on its own.

**Files:**
- Modify: `package.json` (the `workspaces.catalog` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `experimental_evaluate`, `Experimental_EvaluationMockModelV4` (from `ai/test`), and `Experimental_EvaluationModelV4` (from `@ai-sdk/provider`) become importable. `openai.evaluationModel`, `anthropic.evaluationModel`, `google.evaluationModel` become available.

- [ ] **Step 1: Read the recorded baseline**

Read `.superpowers/sdd/baseline.md`. The tree is already red in known places and your job is to add nothing to it. Do NOT run `bun run preflight` — it cannot pass on macOS.

- [ ] **Step 2: Edit the catalog**

In `package.json`, inside `workspaces.catalog`, set exactly these five values:

```json
"ai": "7.0.107",
"@ai-sdk/provider": "4.0.17",
"@ai-sdk/openai": "4.0.71",
"@ai-sdk/anthropic": "4.0.58",
"@ai-sdk/google": "4.0.76"
```

Leave `@ai-sdk/openai-compatible`, `@ai-sdk/mistral`, `@ai-sdk/groq`, and `@ai-sdk/xai` untouched.

- [ ] **Step 3: Install**

Run: `bun install`
Expected: lockfile updates, no peer-dependency errors.

- [ ] **Step 4: Verify the new exports actually exist**

Run:
```bash
bun -e "import('ai').then(m => console.log('experimental_evaluate:', typeof m.experimental_evaluate))"
bun -e "import('ai/test').then(m => console.log('mock:', typeof m.Experimental_EvaluationMockModelV4))"
```
Expected: `experimental_evaluate: function` and `mock: function`. If either is `undefined`, the bump did not take — do not proceed.

- [ ] **Step 5: Run the differential gate**

Run, in order:
```bash
bun run check
bun run --filter @aio-proxy/types test:unit
bun run --filter @aio-proxy/plugin-sdk test:unit
bun run --filter @aio-proxy/core test:unit
bun run --filter @aio-proxy/server test:unit
bun run lint:types 2>&1 | grep -oE "packages/[a-z-]+/src/[^:]+" | sort | uniq -c | sort -rn
```
Expected: `check` PASS; types 406/0, plugin-sdk 91/0, core 1924/0; server green (record its counts, this is its first measurement); the `lint:types` per-file table identical to `.superpowers/sdd/baseline-lint-types.txt`.

A ~95-patch `ai` jump touches every provider path. Any NEW failure or type error is in scope: fix it. Do not silence one with a skipped or deleted test.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): bump ai and provider packages for evaluation support"
```

---

### Task 2: Widen the protocol and capability type unions

Adding the enum value breaks every exhaustive `ProviderProtocol` switch. That is the point: the compiler enumerates the work. This task adds no behavior — each new arm either mirrors a sibling or explicitly declines.

**Files:**
- Modify: `packages/types/src/provider-endpoints/provider-endpoints.ts`
- Modify: `packages/plugin-sdk/src/runtime.ts:7-15` (`ProtocolId`), `:84-92` (`RawResolver`)
- Modify: `packages/core/src/protocol/adapter.ts:12` (`InboundCapability`)
- Modify: every file the compiler flags. Expect: `core/src/provider/api-bridge`, `core/src/provider/api`, `server/src/passthrough-usage/*`, `server/src/provider-runtime/probe`, `server/src/provider-runtime/capability-index`, `server/src/plugin-runtime`, `cli/src/plugin-commands/form/render.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at the type level.
- Produces: `ProviderProtocol.TypeSafeSystemOne` (value `'typesafe-systemone'`), `ProtocolId` includes `'typesafe-systemone'`, `InboundCapability` includes `'evaluation'`, `RawResolver` input accepts `capability: 'evaluation'`.

- [ ] **Step 1: Add the enum value**

In `packages/types/src/provider-endpoints/provider-endpoints.ts`, append to `ProviderProtocol`:

```ts
export enum ProviderProtocol {
  OpenAIResponse = 'openai-response',
  OpenAICompatible = 'openai-compatible',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
  GeminiInteractions = 'gemini-interactions',
  OpenAIImage = 'openai-image',
  OpenAIAudio = 'openai-audio',
  OpenAIVideo = 'openai-video',
  TypeSafeSystemOne = 'typesafe-systemone',
}
```

- [ ] **Step 2: Widen the plugin SDK unions**

In `packages/plugin-sdk/src/runtime.ts`, add to `ProtocolId`:

```ts
export type ProtocolId =
  | 'openai-compatible'
  | 'openai-response'
  | 'anthropic'
  | 'gemini'
  | 'gemini-interactions'
  | 'openai-image'
  | 'openai-audio'
  | 'openai-video'
  | 'typesafe-systemone';
```

and widen the `RawResolver` capability field:

```ts
  readonly capability?: 'language' | 'embedding' | 'speech' | 'transcription' | 'evaluation';
```

Do not add a `ModelCatalog` bucket and do not add a plugin-facing evaluation capability.

- [ ] **Step 3: Add the inbound capability**

In `packages/core/src/protocol/adapter.ts`:

```ts
export type InboundCapability =
  | 'language'
  | 'image'
  | 'embedding'
  | 'speech'
  | 'transcription'
  | 'video'
  | 'evaluation';
```

- [ ] **Step 4: Let the compiler find every exhaustive switch**

Run: `bun run lint:types 2>&1 | tail -40`
Expected: FAIL, listing the non-exhaustive switches and incomplete `Record<ProviderProtocol, ...>` tables.

- [ ] **Step 5: Fix each flagged site**

For `packages/server/src/provider-runtime/capability-index/capability-index.ts`, add the row (the rest of that file is Task 8):

```ts
  [ProviderProtocol.TypeSafeSystemOne]: ['evaluation'],
```

For each `passthrough-usage` extractor switch, add a `typesafe-systemone` arm. Task 12 fills in real token extraction; for now return the same "no usage" result the switch's least-capable arm returns, so this task stays behavior-free.

For `probe`, `plugin-runtime`, `api-bridge`, `api`, and the CLI form renderer, add an arm that declines: evaluation is not a language/chat origin, so these must not treat it as one. Where the switch maps a protocol to an AI SDK package, return `undefined` rather than inventing a mapping.

- [ ] **Step 6: Verify types pass with no behavior change**

Run: `bun run lint:types && bun run test:unit 2>&1 | tail -20`
Expected: PASS. No existing test should change behavior — if one does, you added behavior instead of an arm.

- [ ] **Step 7: Commit**

```bash
git add -A packages/types packages/plugin-sdk packages/core packages/server packages/cli
git commit -m "feat(types): add typesafe-systemone protocol and evaluation capability"
```

---
### Task 3: Evaluation adapter contract in core

A parallel factory beside `defineEmbeddingProtocolAdapter`. The concrete type must carry every field the pipeline reads, or the shared loop will not compile against it.

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts`
- Test: `packages/core/src/protocol/adapter.evaluation.test.ts`

**Interfaces:**
- Consumes: `InboundCapability` including `'evaluation'` from Task 2.
- Produces: `EvaluationQuestion`, `EvaluationInvocation`, `EvaluationAnswer`, `EvaluationResult`, `EvaluationProtocolAdapter<TRequest, TContext>`, `defineEvaluationProtocolAdapter(...)`, `isEvaluationProtocolAdapter(adapter)`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/protocol/adapter.evaluation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { ProviderProtocol } from '@aio-proxy/types';

import {
  defineEvaluationProtocolAdapter,
  isEvaluationProtocolAdapter,
  type EvaluationResult,
} from './adapter';

const adapter = defineEvaluationProtocolAdapter<{ readonly model: string }, Record<never, never>>({
  protocol: ProviderProtocol.TypeSafeSystemOne,
  parse: async () => ({ model: 'm' }),
  model: (request) => request.model,
  rawRequest: async (raw) => raw,
  evaluationInvocation: () => ({ state: 's', questions: {} }),
  evaluationJson: (result: EvaluationResult, context) => ({
    model: context.responseModelId,
    answers: result.answers,
  }),
  errors: {} as never,
});

describe('defineEvaluationProtocolAdapter', () => {
  it('fills the defaults the shared pipeline reads', () => {
    const request = { model: 'm' };
    const context = {};
    expect(adapter.capability).toBe('evaluation');
    expect(adapter.wantsStream(request, context)).toBe(false);
    expect(adapter.session).toBeUndefined();
    expect(adapter.dimensions(request, context)).toEqual({});
    expect(adapter.requestDiagnostics(request, context)).toEqual([]);
  });

  it('is recognized by the capability guard and not confused with embedding', () => {
    expect(isEvaluationProtocolAdapter(adapter)).toBe(true);
    expect(isEvaluationProtocolAdapter({ capability: 'embedding' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/adapter.evaluation.test.ts`
Expected: FAIL with `defineEvaluationProtocolAdapter is not a function` (or a TS resolution error).

- [ ] **Step 3: Implement the types and factory**

Append to `packages/core/src/protocol/adapter.ts`:

```ts
export type EvaluationQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: unknown;
      readonly criteria?: { readonly true?: string; readonly false?: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: unknown;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | { readonly type: 'score'; readonly instructions: unknown; readonly criteria: readonly string[] };

export type EvaluationInvocation = {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, EvaluationQuestion>>;
};

export type EvaluationAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities?: Readonly<Record<string, number>>;
      readonly confidence?: number;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly probabilities?: Readonly<Record<string, number>>;
      readonly confidence?: number;
    };

export type EvaluationResult = {
  readonly answers: Readonly<Record<string, EvaluationAnswer>>;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
};

export type EvaluationEgressContext = { readonly responseModelId: string };

export type EvaluationProtocolAdapter<TRequest, TContext> = Readonly<{
  capability: 'evaluation';
  protocol: ProviderProtocol;
  bodyLimits: (raw: Request, context: TContext) => RequestBodyLimits;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  dimensions: (request: TRequest, context: TContext) => AliasDimensions;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  // Evaluation never resolves a logical session. Declared so the shared pipeline
  // can read `session` off any adapter, exactly as the embedding adapter does.
  session?: undefined;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (
    raw: Request,
    request: TRequest,
    resolvedModel: string,
    context: TContext,
  ) => Promise<Request>;
  evaluationInvocation: (request: TRequest, context: TContext) => EvaluationInvocation;
  evaluationJson: (result: EvaluationResult, context: EvaluationEgressContext) => unknown;
  errors: ProtocolErrorMapper;
}>;

export function isEvaluationProtocolAdapter<TRequest, TContext>(adapter: {
  readonly capability?: string;
}): adapter is EvaluationProtocolAdapter<TRequest, TContext> {
  return adapter.capability === 'evaluation';
}

export function defineEvaluationProtocolAdapter<TRequest, TContext>(
  definition: Omit<
    EvaluationProtocolAdapter<TRequest, TContext>,
    'capability' | 'bodyLimits' | 'dimensions' | 'requestDiagnostics' | 'session' | 'wantsStream'
  > & {
    readonly bodyLimits?: EvaluationProtocolAdapter<TRequest, TContext>['bodyLimits'];
    readonly dimensions?: EvaluationProtocolAdapter<TRequest, TContext>['dimensions'];
    readonly requestDiagnostics?: EvaluationProtocolAdapter<
      TRequest,
      TContext
    >['requestDiagnostics'];
  },
): EvaluationProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    capability: 'evaluation',
    bodyLimits: definition.bodyLimits ?? defaultBodyLimits,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    wantsStream: () => false,
  });
}
```

Also extend the union so the pipeline can accept it:

```ts
export type AnyProtocolAdapter<TRequest, TContext> =
  | ProtocolAdapter<TRequest, TContext>
  | EmbeddingProtocolAdapter<TRequest, TContext>
  | EvaluationProtocolAdapter<TRequest, TContext>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/protocol/adapter.evaluation.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/adapter.ts packages/core/src/protocol/adapter.evaluation.test.ts
git commit -m "feat(core): add evaluation protocol adapter contract"
```

---
### Task 4: System One request parsing

The strictest part of the feature. This is aio-proxy's own inbound contract, not a copy of a TypeSafe zod schema — that package only validates outbound requests (two length checks). Reject at the edge rather than forwarding junk and mapping an upstream 422 back.

**Files:**
- Create: `packages/core/src/protocol/typesafe-systemone/parse.ts`
- Create: `packages/core/src/protocol/typesafe-systemone/parse.test.ts`

**Interfaces:**
- Consumes: `EvaluationQuestion` from Task 3.
- Produces: `parseSystemOneBody(raw: Request): Promise<SystemOneRequest>` where `SystemOneRequest = { readonly model: string; readonly state: unknown; readonly questions: Readonly<Record<string, EvaluationQuestion>>; readonly body: Readonly<Record<string, unknown>> }`. `body` is the original parsed JSON, retained so raw rewrite forwards unknown fields. Throws `SystemOneParseError { readonly message: string }` on any rejection.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/protocol/typesafe-systemone/parse.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { parseSystemOneBody, SystemOneParseError } from './parse';

const post = (body: string, contentType: string | undefined = 'application/json') =>
  new Request('https://proxy.test/v1/systemone', {
    method: 'POST',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body,
  });

const valid = {
  model: 'jev-latest',
  state: 'the agent closed the ticket',
  questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } },
};
const withBody = (patch: Record<string, unknown>) => post(JSON.stringify({ ...valid, ...patch }));

describe('parseSystemOneBody accepts', () => {
  it('string, object, and array state', async () => {
    for (const state of ['text', { a: 1 }, [1, 2]]) {
      expect((await parseSystemOneBody(withBody({ state }))).state).toEqual(state);
    }
  });

  it('all three question types', async () => {
    const questions = {
      a: { type: 'noul', instructions: 'i' },
      b: { type: 'choice', instructions: 'i', criteria: { x: 'desc', y: null } },
      c: { type: 'score', instructions: 'i', criteria: ['low', 'high'] },
    };
    expect(Object.keys((await parseSystemOneBody(withBody({ questions }))).questions)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('boundary sizes: 255 choice options and 2 or 10 score levels', async () => {
    const criteria = Object.fromEntries([...Array(255)].map((_, i) => [`o${i}`, null]));
    await parseSystemOneBody(withBody({ questions: { q: { type: 'choice', instructions: 'i', criteria } } }));
    for (const levels of [2, 10]) {
      const score = [...Array(levels)].map((_, i) => `l${i}`);
      await parseSystemOneBody(withBody({ questions: { q: { type: 'score', instructions: 'i', criteria: score } } }));
    }
  });

  it('preserves unknown fields at every level', async () => {
    const questions = { q: { type: 'noul', instructions: 'i', criteria: { true: 't', weird: 'w' }, extra: 1 } };
    const parsed = await parseSystemOneBody(withBody({ questions, topLevelExtra: 'keep' }));
    expect((parsed.body as Record<string, unknown>).topLevelExtra).toBe('keep');
    const q = (parsed.body as { questions: Record<string, Record<string, unknown>> }).questions.q;
    expect(q.extra).toBe(1);
    expect((q.criteria as Record<string, unknown>).weird).toBe('w');
  });

  it('a missing content-type when the body is valid JSON, and a charset parameter', async () => {
    await parseSystemOneBody(post(JSON.stringify(valid), undefined));
    await parseSystemOneBody(post(JSON.stringify(valid), 'application/json; charset=utf-8'));
  });
});

describe('parseSystemOneBody rejects', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['invalid JSON', '{nope'],
    ['a JSON primitive body', '42'],
    ['null state', JSON.stringify({ ...valid, state: null })],
    ['number state', JSON.stringify({ ...valid, state: 1 })],
    ['boolean state', JSON.stringify({ ...valid, state: true })],
    ['an absent state key', JSON.stringify({ model: 'm', questions: valid.questions })],
    ['a missing model', JSON.stringify({ state: 's', questions: valid.questions })],
    ['an empty model', JSON.stringify({ ...valid, model: '' })],
    ['missing questions', JSON.stringify({ model: 'm', state: 's' })],
    ['array questions', JSON.stringify({ ...valid, questions: [] })],
    ['empty questions', JSON.stringify({ ...valid, questions: {} })],
    ['an unknown type', JSON.stringify({ ...valid, questions: { q: { type: 'nope', instructions: 'i' } } })],
    ['missing instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul' } } })],
    ['null instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul', instructions: null } } })],
    ['number instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul', instructions: 1 } } })],
    ['choice without criteria', JSON.stringify({ ...valid, questions: { q: { type: 'choice', instructions: 'i' } } })],
    ['empty choice criteria', JSON.stringify({ ...valid, questions: { q: { type: 'choice', instructions: 'i', criteria: {} } } })],
    ['a non-string non-null criteria value', JSON.stringify({ ...valid, questions: { q: { type: 'choice', instructions: 'i', criteria: { a: 5 } } } })],
    ['score criteria that is not an array', JSON.stringify({ ...valid, questions: { q: { type: 'score', instructions: 'i', criteria: {} } } })],
    ['one score level', JSON.stringify({ ...valid, questions: { q: { type: 'score', instructions: 'i', criteria: ['only'] } } })],
    ['a non-string score level', JSON.stringify({ ...valid, questions: { q: { type: 'score', instructions: 'i', criteria: ['a', 2] } } })],
    ['a non-finite number nested in state', JSON.stringify({ ...valid }).replace('"the agent closed the ticket"', '{"n":1e400}')],
  ];

  it.each(cases)('%s', async (_label, body) => {
    expect(parseSystemOneBody(post(body))).rejects.toBeInstanceOf(SystemOneParseError);
  });

  it('256 choice options and 11 score levels', async () => {
    const criteria = Object.fromEntries([...Array(256)].map((_, i) => [`o${i}`, null]));
    expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'choice', instructions: 'i', criteria } } })),
    ).rejects.toBeInstanceOf(SystemOneParseError);
    const score = [...Array(11)].map((_, i) => `l${i}`);
    expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'score', instructions: 'i', criteria: score } } })),
    ).rejects.toBeInstanceOf(SystemOneParseError);
  });

  it('an unsupported media type even when the body is valid JSON', async () => {
    expect(parseSystemOneBody(post(JSON.stringify(valid), 'text/plain'))).rejects.toBeInstanceOf(
      SystemOneParseError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/typesafe-systemone/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/protocol/typesafe-systemone/parse.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import type { EvaluationQuestion } from '../adapter';

const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;

export class SystemOneParseError extends Error {}

export type SystemOneRequest = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, EvaluationQuestion>>;
  readonly body: Readonly<Record<string, unknown>>;
};

const reject = (message: string): never => {
  throw new SystemOneParseError(message);
};

// The same shape ai@7.0.107 `isInput()` accepts: string, array, or plain object.
const isInputValue = (value: unknown): boolean =>
  typeof value === 'string' || Array.isArray(value) || isPlainObject(value);

// JSON has no Infinity literal, but `JSON.parse('1e400')` yields Infinity.
const hasNonFinite = (value: unknown): boolean => {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFinite);
  if (isPlainObject(value)) return Object.values(value).some(hasNonFinite);
  return false;
};

const assertMediaType = (raw: Request): void => {
  const header = raw.headers.get('content-type');
  if (header === null) return;
  const mediaType = header.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') reject(`Unsupported content type: ${mediaType}`);
};

const parseQuestion = (id: string, value: unknown): EvaluationQuestion => {
  if (!isPlainObject(value)) return reject(`questions.${id} must be an object`);
  if (!isInputValue(value.instructions)) {
    return reject(`questions.${id}.instructions must be a string, object, or array`);
  }
  const criteria = value.criteria;
  if (value.type === 'noul') {
    if (criteria !== undefined && !isPlainObject(criteria)) {
      return reject(`questions.${id}.criteria must be an object`);
    }
    return value as unknown as EvaluationQuestion;
  }
  if (value.type === 'choice') {
    if (!isPlainObject(criteria)) return reject(`questions.${id}.criteria must be an option map`);
    const keys = Object.keys(criteria);
    if (keys.length === 0) reject(`questions.${id}.criteria must be nonempty`);
    if (keys.length > MAX_CHOICE_OPTIONS) {
      reject(`questions.${id}.criteria supports at most ${MAX_CHOICE_OPTIONS} options`);
    }
    for (const key of keys) {
      const description = criteria[key];
      if (description !== null && typeof description !== 'string') {
        reject(`questions.${id}.criteria.${key} must be a string or null`);
      }
    }
    return value as unknown as EvaluationQuestion;
  }
  if (value.type === 'score') {
    if (!Array.isArray(criteria)) return reject(`questions.${id}.criteria must be an array`);
    if (criteria.length < MIN_SCORE_LEVELS) {
      reject(`questions.${id}.criteria needs at least ${MIN_SCORE_LEVELS} levels`);
    }
    if (criteria.length > MAX_SCORE_LEVELS) {
      reject(`questions.${id}.criteria supports at most ${MAX_SCORE_LEVELS} levels`);
    }
    if (criteria.some((level) => typeof level !== 'string')) {
      reject(`questions.${id}.criteria levels must be strings`);
    }
    return value as unknown as EvaluationQuestion;
  }
  return reject(`questions.${id}.type must be noul, choice, or score`);
};

export async function parseSystemOneBody(raw: Request): Promise<SystemOneRequest> {
  assertMediaType(raw);

  let body: unknown;
  try {
    body = JSON.parse(await raw.text());
  } catch {
    return reject('Request body is not valid JSON');
  }
  if (!isPlainObject(body)) return reject('Request body must be a JSON object');
  if (hasNonFinite(body)) reject('Request body contains a non-finite number');

  const { model, state, questions } = body;
  if (typeof model !== 'string' || model.length === 0) reject('model must be a nonempty string');
  if (!('state' in body)) reject('state is required');
  if (!isInputValue(state)) reject('state must be a string, object, or array');
  if (!isPlainObject(questions)) return reject('questions must be a nonempty question map');
  const ids = Object.keys(questions);
  if (ids.length === 0) reject('questions must be a nonempty question map');

  const parsed = Object.fromEntries(ids.map((id) => [id, parseQuestion(id, questions[id])]));
  return { model: model as string, state, questions: parsed, body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/protocol/typesafe-systemone/parse.test.ts`
Expected: PASS, every accept and reject case.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/typesafe-systemone/parse.ts packages/core/src/protocol/typesafe-systemone/parse.test.ts
git commit -m "feat(core): parse System One evaluation requests"
```

---

### Task 5: System One egress, errors, and the adapter itself

Egress owns the convert envelope and the refusal of a distribution-less answer. It does NOT own fallback — that is Task 10.

**Files:**
- Create: `packages/core/src/protocol/typesafe-systemone/egress.ts`
- Create: `packages/core/src/protocol/typesafe-systemone/errors.ts`
- Create: `packages/core/src/protocol/typesafe-systemone/typesafe-systemone.ts`
- Create: `packages/core/src/protocol/typesafe-systemone/index.ts`
- Create: `packages/core/src/protocol/typesafe-systemone/egress.test.ts`
- Modify: `packages/core/src/protocol/index.ts` (export the adapter)

**Interfaces:**
- Consumes: `parseSystemOneBody`, `SystemOneRequest`, `SystemOneParseError` (Task 4); `defineEvaluationProtocolAdapter`, `EvaluationResult` (Task 3).
- Produces: `typeSafeSystemOneAdapter`, and `EvaluationDistributionError` thrown by egress when a choice/score answer lacks `probabilities`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/protocol/typesafe-systemone/egress.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import type { EvaluationResult } from '../adapter';
import { EvaluationDistributionError, systemOneJson } from './egress';

const context = { responseModelId: 'public-jev' };

describe('systemOneJson', () => {
  it('echoes the requested public slug, not the upstream id', () => {
    const result: EvaluationResult = { answers: { a: { type: 'noul', noul: 0.9 } } };
    expect(systemOneJson(result, context)).toMatchObject({ model: 'public-jev' });
  });

  it('writes probabilities and confidence when present, and never writes legend', () => {
    const result: EvaluationResult = {
      answers: {
        c: { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 0.8 },
        s: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 } },
      },
    };
    const body = systemOneJson(result, context) as {
      answers: Record<string, Record<string, unknown>>;
    };
    expect(body.answers.c).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1 },
      confidence: 0.8,
    });
    expect(body.answers.s.confidence).toBeUndefined();
    expect(body.answers.s.legend).toBeUndefined();
  });

  it('refuses a choice or score answer with no distribution', () => {
    const result: EvaluationResult = { answers: { c: { type: 'choice', choice: 'billing' } } };
    expect(() => systemOneJson(result, context)).toThrow(EvaluationDistributionError);
  });

  it('omits usage entirely when none was reported', () => {
    const result: EvaluationResult = { answers: { a: { type: 'noul', noul: 0.1 } } };
    expect(systemOneJson(result, context)).not.toHaveProperty('usage');
  });

  it('writes snake_case usage when reported', () => {
    const result: EvaluationResult = {
      answers: { a: { type: 'noul', noul: 0.1 } },
      usage: { inputTokens: 312, outputTokens: 48 },
    };
    expect(systemOneJson(result, context)).toMatchObject({
      usage: { input_tokens: 312, output_tokens: 48 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/typesafe-systemone/egress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement egress**

Create `packages/core/src/protocol/typesafe-systemone/egress.ts`:

```ts
import type { EvaluationAnswer, EvaluationEgressContext, EvaluationResult } from '../adapter';

export class EvaluationDistributionError extends Error {}

const answerJson = (id: string, answer: EvaluationAnswer): Record<string, unknown> => {
  if (answer.type === 'noul') return { type: 'noul', noul: answer.noul };
  if (answer.probabilities === undefined) {
    throw new EvaluationDistributionError(
      `Answer ${id} is a ${answer.type} without probabilities, which System One requires`,
    );
  }
  const scalar = answer.type === 'choice' ? { choice: answer.choice } : { score: answer.score };
  return {
    type: answer.type,
    ...scalar,
    probabilities: answer.probabilities,
    // `confidence` is nullish upstream: omit rather than write null.
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
};

export function systemOneJson(result: EvaluationResult, context: EvaluationEgressContext): unknown {
  const answers = Object.fromEntries(
    Object.entries(result.answers).map(([id, answer]) => [id, answerJson(id, answer)]),
  );
  const { inputTokens, outputTokens } = result.usage ?? {};
  const usage =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : {
          ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
          ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
        };
  return { model: context.responseModelId, answers, ...(usage === undefined ? {} : { usage }) };
}
```

- [ ] **Step 4: Implement the error mapper**

Create `packages/core/src/protocol/typesafe-systemone/errors.ts`. The body shape is the one TypeSafe's own provider package parses.

```ts
import type { ProtocolErrorMapper } from '../adapter';

const body = (message: string, errorType: string): string =>
  JSON.stringify({ message, error_type: errorType });

const json = (message: string, errorType: string, status: number): Response =>
  new Response(body(message, errorType), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const systemOneErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof Error ? json(error.message, 'invalid_request_error', 400) : undefined,
  modelNotFound: (message) => json(message, 'not_found_error', 404),
  previousResponseConflict: () => json('Not supported for evaluation', 'invalid_request_error', 400),
  tooLarge: () => json('Request body is too large', 'invalid_request_error', 413),
  unsupportedContentEncoding: () =>
    json('Unsupported content encoding', 'invalid_request_error', 415),
  unsupported: (feature) => json(`Unsupported: ${feature}`, 'not_supported_error', 501),
  provider: () => undefined,
  rateLimited: (retryAfterSeconds) =>
    new Response(body('Rate limited', 'rate_limit_error'), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    }),
};
```

- [ ] **Step 5: Implement the adapter and barrel**

Create `packages/core/src/protocol/typesafe-systemone/typesafe-systemone.ts`:

```ts
import { ProviderProtocol } from '@aio-proxy/types';

import { defineEvaluationProtocolAdapter, type EvaluationQuestion } from '../adapter';
import { systemOneJson } from './egress';
import { systemOneErrors } from './errors';
import { parseSystemOneBody, type SystemOneRequest } from './parse';

export type SystemOneContext = Readonly<Record<never, never>>;

// Convert projects the SDK question envelope; it never rewrites evaluation data.
// `noul.criteria` must carry only `true`/`false`: ai@7.0.107 rejects any other key
// on a boolean question. Absence is preserved rather than materialized as undefined.
const projectQuestion = (question: EvaluationQuestion): EvaluationQuestion => {
  if (question.type !== 'noul' || question.criteria === undefined) return question;
  const { true: yes, false: no } = question.criteria;
  const criteria = {
    ...(yes === undefined ? {} : { true: yes }),
    ...(no === undefined ? {} : { false: no }),
  };
  return {
    type: 'noul',
    instructions: question.instructions,
    ...(Object.keys(criteria).length === 0 ? {} : { criteria }),
  };
};

export const typeSafeSystemOneAdapter = defineEvaluationProtocolAdapter<
  SystemOneRequest,
  SystemOneContext
>({
  protocol: ProviderProtocol.TypeSafeSystemOne,
  parse: async (raw) => await parseSystemOneBody(raw),
  model: (request) => request.model,
  rawRequest: async (raw, request, resolvedModel) =>
    new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      // Forward the original body with only `model` rewritten, preserving unknown fields.
      body: JSON.stringify({ ...request.body, model: resolvedModel }),
    }),
  evaluationInvocation: (request) => ({
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, projectQuestion(question)]),
    ),
  }),
  evaluationJson: systemOneJson,
  errors: systemOneErrors,
});
```

Create `packages/core/src/protocol/typesafe-systemone/index.ts`:

```ts
export { EvaluationDistributionError } from './egress';
export { SystemOneParseError } from './parse';
export { typeSafeSystemOneAdapter, type SystemOneContext } from './typesafe-systemone';
export type { SystemOneRequest } from './parse';
```

Then re-export it from `packages/core/src/protocol/index.ts` alongside the other adapters.

- [ ] **Step 6: Add the raw-rewrite and projection tests**

Create `packages/core/src/protocol/typesafe-systemone/typesafe-systemone.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { typeSafeSystemOneAdapter } from './typesafe-systemone';

const request = {
  model: 'public-jev',
  state: 's',
  questions: {
    q: { type: 'noul' as const, instructions: 'i', criteria: { true: 't', weird: 'w' } },
  },
  body: {
    model: 'public-jev',
    state: 's',
    questions: { q: { type: 'noul', instructions: 'i', criteria: { true: 't', weird: 'w' } } },
    topLevelExtra: 'keep',
  },
};

describe('typeSafeSystemOneAdapter', () => {
  it('rewrites only model on raw and preserves unknown fields', async () => {
    const raw = new Request('https://proxy.test/v1/systemone', {
      method: 'POST',
      body: JSON.stringify(request.body),
    });
    const upstream = await typeSafeSystemOneAdapter.rawRequest(raw, request, 'jev-latest', {});
    const body = (await upstream.json()) as Record<string, unknown>;
    expect(body.model).toBe('jev-latest');
    expect(body.topLevelExtra).toBe('keep');
    expect((body.questions as Record<string, Record<string, unknown>>).q.criteria).toEqual({
      true: 't',
      weird: 'w',
    });
  });

  it('projects noul criteria down to true/false for convert', () => {
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(request, {});
    expect(invocation.questions.q).toEqual({
      type: 'noul',
      instructions: 'i',
      criteria: { true: 't' },
    });
  });

  it('preserves absence rather than creating undefined criteria properties', () => {
    const bare = { ...request, questions: { q: { type: 'noul' as const, instructions: 'i' } } };
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(bare, {});
    expect('criteria' in invocation.questions.q).toBe(false);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/core/src/protocol/typesafe-systemone/`
Expected: PASS, all three files.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/protocol/typesafe-systemone packages/core/src/protocol/index.ts
git commit -m "feat(core): add TypeSafe System One evaluation adapter"
```

---
### Task 6: The SDK boundary — createProviderV4Evaluate

This is where `noul` becomes `boolean`, where confidence is lifted out of `providerMetadata`, and where `maxRetries: 0` is set. These cannot be tested through `evaluationJson`: by then `EvaluationResult` carries inline confidence and the metadata is gone.

**Files:**
- Modify: `packages/core/src/provider/provider-v4.ts`
- Create: `packages/core/src/provider/provider-v4-evaluate.test.ts`

**Interfaces:**
- Consumes: `EvaluationInvocation`, `EvaluationResult` (Task 3).
- Produces: `createProviderV4Evaluate(providerId: string, provider: unknown)` returning `{ evaluate(invocation: EvaluationInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal }): Promise<EvaluationResult> }`. Throws `AiSdkProviderError` when the package has no `evaluationModel`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/provider/provider-v4-evaluate.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Experimental_EvaluationMockModelV4 } from 'ai/test';

import { createProviderV4Evaluate } from './provider-v4';

const providerWith = (model: unknown) => ({ evaluationModel: () => model });

const mock = (options: {
  readonly answers: Record<string, unknown>;
  readonly providerMetadata?: Record<string, unknown>;
}) =>
  new Experimental_EvaluationMockModelV4({
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    doEvaluate: async () => ({
      answers: options.answers,
      ...(options.providerMetadata === undefined
        ? {}
        : { providerMetadata: options.providerMetadata }),
    }),
  });

describe('createProviderV4Evaluate', () => {
  it('sends noul as boolean and maps the answer back to noul', async () => {
    let seen: unknown;
    const model = new Experimental_EvaluationMockModelV4({
      supportedQuestionTypes: ['boolean'],
      doEvaluate: async (options: { questions: unknown }) => {
        seen = options.questions;
        return { answers: { q: { type: 'boolean', probability: 0.97 } } };
      },
    });
    const transport = createProviderV4Evaluate('p', providerWith(model));
    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );
    expect((seen as Record<string, { type: string }>).q.type).toBe('boolean');
    expect(result.answers.q).toEqual({ type: 'noul', noul: 0.97 });
  });

  it('lifts confidence out of providerMetadata keyed by question id', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(
        mock({
          answers: { c: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } },
          providerMetadata: { typesafe: { confidence: { c: 0.84 } } },
        }),
      ),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { c: { type: 'choice', instructions: 'i', criteria: { billing: null } } } },
      { modelId: 'm' },
    );
    expect(result.answers.c).toMatchObject({ confidence: 0.84 });
  });

  it('carries string, object, and array state through to doEvaluate intact', async () => {
    for (const state of ['text', { a: 1 }, [1, 2]]) {
      let seen: unknown;
      const model = new Experimental_EvaluationMockModelV4({
        supportedQuestionTypes: ['boolean'],
        doEvaluate: async (options: { state: unknown }) => {
          seen = options.state;
          return { answers: { q: { type: 'boolean', probability: 0.5 } } };
        },
      });
      await createProviderV4Evaluate('p', providerWith(model)).evaluate(
        { state, questions: { q: { type: 'noul', instructions: 'i' } } },
        { modelId: 'm' },
      );
      expect(seen).toEqual(state);
    }
  });

  it('does not retry a retryable provider failure: exactly one doEvaluate call', async () => {
    let calls = 0;
    const model = new Experimental_EvaluationMockModelV4({
      supportedQuestionTypes: ['boolean'],
      doEvaluate: async () => {
        calls += 1;
        throw Object.assign(new Error('upstream 503'), { statusCode: 503, isRetryable: true });
      },
    });
    const transport = createProviderV4Evaluate('p', providerWith(model));
    await expect(
      transport.evaluate({ state: 's', questions: { q: { type: 'noul', instructions: 'i' } } }, { modelId: 'm' }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('throws when the package exposes no evaluationModel', () => {
    expect(() => createProviderV4Evaluate('p', {})).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/provider/provider-v4-evaluate.test.ts`
Expected: FAIL — `createProviderV4Evaluate` is not exported.

- [ ] **Step 3: Implement the wrapper**

Add to `packages/core/src/provider/provider-v4.ts`. Leave the language and embedding paths untouched.

```ts
import { experimental_evaluate } from 'ai';
import { isRecord } from '@aio-proxy/shared';

import type { EvaluationAnswer, EvaluationInvocation, EvaluationResult } from '../protocol/adapter';

type EvaluateOptions = { readonly modelId: string; readonly signal?: AbortSignal };

const confidenceFor = (metadata: unknown, id: string): number | undefined => {
  if (!isRecord(metadata)) return undefined;
  const typesafe = metadata.typesafe;
  if (!isRecord(typesafe) || !isRecord(typesafe.confidence)) return undefined;
  const value = typesafe.confidence[id];
  return typeof value === 'number' ? value : undefined;
};

const toEvaluationAnswer = (
  id: string,
  answer: Record<string, unknown>,
  metadata: unknown,
): EvaluationAnswer => {
  const confidence = confidenceFor(metadata, id);
  const withConfidence = confidence === undefined ? {} : { confidence };
  if (answer.type === 'boolean') {
    return { type: 'noul', noul: answer.probability as number };
  }
  if (answer.type === 'choice') {
    return {
      type: 'choice',
      choice: answer.choice as string,
      ...(answer.probabilities === undefined
        ? {}
        : { probabilities: answer.probabilities as Record<string, number> }),
      ...withConfidence,
    };
  }
  return {
    type: 'score',
    score: answer.score as number,
    ...(answer.probabilities === undefined
      ? {}
      : { probabilities: answer.probabilities as Record<string, number> }),
    ...withConfidence,
  };
};

// SDK questions use `boolean` where the System One wire uses `noul`.
const toSdkQuestions = (invocation: EvaluationInvocation): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(invocation.questions).map(([id, question]) =>
      question.type === 'noul' ? [id, { ...question, type: 'boolean' }] : [id, question],
    ),
  );

export function createProviderV4Evaluate(providerId: string, provider: unknown) {
  return {
    async evaluate(
      invocation: EvaluationInvocation,
      options: EvaluateOptions,
    ): Promise<EvaluationResult> {
      if (!isRecord(provider) || typeof provider.evaluationModel !== 'function') {
        throw new AiSdkProviderError(`Provider ${providerId} does not support evaluation`);
      }
      const model = (provider.evaluationModel as (id: string) => unknown)(options.modelId);
      const result = await experimental_evaluate({
        // Always an explicitly resolved model INSTANCE, never a bare string id.
        // At ai@7.0.107 a string resolves through `AI_SDK_DEFAULT_PROVIDER ?? gateway`,
        // so passing one would silently route to Gateway instead of this candidate:
        // the request would succeed against the wrong provider and bill the wrong account.
        model: model as never,
        state: invocation.state as never,
        questions: toSdkQuestions(invocation) as never,
        // The pipeline owns retry and fallback; an SDK retry would hide attempts from traces.
        maxRetries: 0,
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      });
      const answers = Object.fromEntries(
        Object.entries(result.answers as Record<string, Record<string, unknown>>).map(
          ([id, answer]) => [id, toEvaluationAnswer(id, answer, result.providerMetadata)],
        ),
      );
      const { inputTokens, outputTokens } = result.usage ?? {};
      const usage =
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : {
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            };
      return { answers, ...(usage === undefined ? {} : { usage }) };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/provider/provider-v4-evaluate.test.ts`
Expected: PASS, all five cases. If the `Experimental_EvaluationMockModelV4` constructor signature differs from the one assumed here, read `node_modules/ai/test.d.ts` and adjust the fixtures, not the production behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provider/provider-v4.ts packages/core/src/provider/provider-v4-evaluate.test.ts
git commit -m "feat(core): add evaluation transport over experimental_evaluate"
```

---
### Task 7: Rename the AI SDK package classifier and add the typesafe-ai arm

`imageTargetProtocolForPackage` is no longer about images — it decides an `ai-sdk` provider's primary protocol. Adding a non-image protocol under the image name would entrench the confusion, so rename and relocate it in the same change.

**Files:**
- Create: `packages/core/src/ai-sdk-package-protocol/ai-sdk-package-protocol.ts`
- Create: `packages/core/src/ai-sdk-package-protocol/index.ts`
- Create: `packages/core/src/ai-sdk-package-protocol/ai-sdk-package-protocol.test.ts`
- Modify: `packages/core/src/image-input/image-input.ts:112-125` (remove the function)
- Modify: every import site the compiler flags

**Interfaces:**
- Consumes: `ProviderProtocol.TypeSafeSystemOne` (Task 2).
- Produces: `aiSdkPackagePrimaryProtocol(packageName: string): ProviderProtocol | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/ai-sdk-package-protocol/ai-sdk-package-protocol.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { ProviderProtocol } from '@aio-proxy/types';

import { aiSdkPackagePrimaryProtocol } from './ai-sdk-package-protocol';

describe('aiSdkPackagePrimaryProtocol', () => {
  it('pins the single-capability TypeSafe package to the System One protocol', () => {
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/typesafe-ai')).toBe(
      ProviderProtocol.TypeSafeSystemOne,
    );
  });

  it('leaves multi-capability packages unclassified so they keep synthesizing language', () => {
    // Pinning the Gateway would suppress language synthesis and break chat through it.
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/gateway')).toBeUndefined();
    expect(aiSdkPackagePrimaryProtocol('@some/unknown-provider')).toBeUndefined();
  });
});
```

Keep whatever existing assertions the old function had for the four image-capable packages; move them into this file so the behavior stays covered after the rename.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/ai-sdk-package-protocol/`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the function and add the arm**

Create `packages/core/src/ai-sdk-package-protocol/ai-sdk-package-protocol.ts` holding the switch previously at `image-input.ts:112-125`, renamed, with one new arm:

```ts
import { ProviderProtocol } from '@aio-proxy/types';

/**
 * The primary wire protocol an `ai-sdk` provider package speaks, or `undefined` when the
 * package serves several capabilities and must not be pinned to one.
 *
 * Only map single-capability packages. A multi-capability package such as
 * `@ai-sdk/gateway` must stay unclassified: pinning it would make
 * `synthesizesLanguage` return false and break chat through the Gateway.
 */
export function aiSdkPackagePrimaryProtocol(packageName: string): ProviderProtocol | undefined {
  switch (packageName) {
    // ... the four existing arms, copied verbatim from image-input.ts
    case '@ai-sdk/typesafe-ai':
      return ProviderProtocol.TypeSafeSystemOne;
    default:
      return undefined;
  }
}
```

Create `packages/core/src/ai-sdk-package-protocol/index.ts`:

```ts
export { aiSdkPackagePrimaryProtocol } from './ai-sdk-package-protocol';
```

Delete the old function from `image-input.ts` and update every import the compiler flags, including `createAiSdkProvider`.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/src/ai-sdk-package-protocol/ && bun run lint:types 2>&1 | tail -20`
Expected: PASS and no type errors. Existing image tests must still pass — if any fail, an arm was dropped in the move.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core/src
git commit -m "refactor(core): rename AI SDK package protocol classifier and map typesafe-ai"
```

---

### Task 8: Capability index

`PROTOCOL_CAPABILITIES` answers "could this wire family serve evaluation at all". It is NOT what makes convert reachable — the transport predicate is. Do not reintroduce a causal link between them.

**Files:**
- Modify: `packages/server/src/provider-runtime/capability-index/capability-index.ts`
- Modify: `packages/server/src/provider-runtime/capability-index/capability-index.test.ts`

**Interfaces:**
- Consumes: `ProviderProtocol.TypeSafeSystemOne`, `InboundCapability` `'evaluation'` (Task 2).
- Produces: `supportsEvaluation(index: ModelCapabilityIndex, modelId: string): boolean`; `CapabilityIndexInput` gains `readonly hasEvaluationTransport?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `capability-index.test.ts`:

```ts
describe('evaluation capability', () => {
  it('grants evaluation from a discovered transport even with no protocol', () => {
    // The unclassified Gateway case: no primary protocol, no extras, but a real transport.
    const index = buildModelCapabilityIndex({
      models: ['some-eval-model'],
      hasEvaluationTransport: true,
    });
    expect(supportsEvaluation(index, 'some-eval-model')).toBe(true);
  });

  it('grants evaluation from a System One endpoint even with no transport', () => {
    const index = buildModelCapabilityIndex({
      models: ['m'],
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      extraProtocols: [ProviderProtocol.TypeSafeSystemOne],
    });
    expect(supportsEvaluation(index, 'm')).toBe(true);
  });

  it('denies evaluation for openai-compatible with no transport and no System One endpoint', () => {
    const index = buildModelCapabilityIndex({
      models: ['m'],
      primaryProtocol: ProviderProtocol.OpenAICompatible,
    });
    expect(supportsEvaluation(index, 'm')).toBe(false);
  });

  it('denies evaluation for a non-System-One extra endpoint', () => {
    // openai-response appears in PROTOCOL_CAPABILITIES, but API convert materializes
    // from the primary package only, so this provider has no usable transport.
    const index = buildModelCapabilityIndex({
      models: ['m'],
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      extraProtocols: [ProviderProtocol.OpenAIResponse],
    });
    expect(supportsEvaluation(index, 'm')).toBe(false);
  });

  it('does not put a System One provider in the language pool', () => {
    const index = buildModelCapabilityIndex({
      models: ['m'],
      primaryProtocol: ProviderProtocol.TypeSafeSystemOne,
    });
    expect(supportsLanguage(index, 'm')).toBe(false);
    expect(supportsEvaluation(index, 'm')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/provider-runtime/capability-index/`
Expected: FAIL — `supportsEvaluation` is not exported.

- [ ] **Step 3: Implement**

In `capability-index.ts`, add the input field:

```ts
  /**
   * True when materialization actually discovered an `evaluationModel` on the loaded
   * package. Unlike the protocol table this reflects a transport that exists.
   */
  readonly hasEvaluationTransport?: boolean;
```

Give `TypeSafeSystemOne` its row and add `'evaluation'` to the three protocols whose AI SDK packages expose `evaluationModel`. `openai-compatible` is deliberately excluded: `@ai-sdk/openai-compatible` has none. `gemini-interactions` is not an evaluation origin.

```ts
  [ProviderProtocol.OpenAIResponse]: ['language', 'embedding', 'evaluation'],
  [ProviderProtocol.OpenAICompatible]: ['language', 'embedding'],
  [ProviderProtocol.Anthropic]: ['language', 'embedding', 'evaluation'],
  [ProviderProtocol.Gemini]: ['language', 'embedding', 'evaluation'],
  [ProviderProtocol.GeminiInteractions]: ['language', 'embedding'],
  [ProviderProtocol.TypeSafeSystemOne]: ['evaluation'],
```

Add the synthesis predicate. It deliberately does NOT mirror `synthesizesEmbedding`, which tests only the primary protocol and would deny a provider whose System One origin is an extra endpoint:

```ts
const hasProtocol = (input: CapabilityIndexInput, protocol: ProviderProtocol): boolean =>
  input.primaryProtocol === protocol || (input.extraProtocols ?? []).includes(protocol);

function synthesizesEvaluation(input: CapabilityIndexInput): boolean {
  return (
    input.hasEvaluationTransport === true ||
    hasProtocol(input, ProviderProtocol.TypeSafeSystemOne)
  );
}

export function supportsEvaluation(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('evaluation') === true;
}
```

Wire `synthesizesEvaluation` into `buildModelCapabilityIndex` so finite IDs gain `'evaluation'` when it returns true.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/server/src/provider-runtime/capability-index/`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/provider-runtime/capability-index
git commit -m "feat(server): grant evaluation capability from discovered transports"
```

---
### Task 9: Discovery lifecycle and evaluation materialization

`createAiSdkProvider()` is synchronous and returns a wrapper; the real provider arrives through an async memoized `providerTask()`. `materializeRuntimeProvider()` is synchronous and builds the capability index. So the probe cannot run where the index is built — it runs lazily, once, before evaluation filtering.

**Files:**
- Create: `packages/server/src/provider-runtime/evaluation-discovery/evaluation-discovery.ts`
- Create: `packages/server/src/provider-runtime/evaluation-discovery/index.ts`
- Create: `packages/server/src/provider-runtime/evaluation-discovery/evaluation-discovery.test.ts`
- Modify: `packages/server/src/provider-runtime/materialize/` (attach the transport)
- Modify: `packages/server/src/runtime.ts` (optional `evaluation` capability)

**Interfaces:**
- Consumes: `createProviderV4Evaluate` (Task 6).
- Produces: `EvaluationTransport = { evaluate(invocation: EvaluationInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal }): Promise<EvaluationResult> }`; `EvaluationDiscovery = { kind: 'supported'; evaluate: EvaluationTransport } | { kind: 'unsupported' } | { kind: 'failed'; error: Error }`; `createEvaluationDiscovery(providerId: string, loadProvider: () => Promise<unknown>): () => Promise<EvaluationDiscovery>`. `RuntimeProviderInstance` gains `readonly evaluation?: EvaluationTransport`.

- [ ] **Step 1: Write the failing test**

Create `evaluation-discovery.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { createEvaluationDiscovery } from './evaluation-discovery';

describe('createEvaluationDiscovery', () => {
  it('reports supported when the loaded package exposes evaluationModel', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({ evaluationModel: () => ({}) }));
    expect((await discover()).kind).toBe('supported');
  });

  it('reports unsupported when the package genuinely lacks it', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({}));
    expect((await discover()).kind).toBe('unsupported');
  });

  it('reports failed rather than throwing when the package cannot load', async () => {
    const discover = createEvaluationDiscovery('p', async () => {
      throw new Error('ProviderNotInstalledError');
    });
    const result = await discover();
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.error.message).toContain('ProviderNotInstalled');
  });

  it('loads once and memoizes, including across concurrent callers', async () => {
    let loads = 0;
    const discover = createEvaluationDiscovery('p', async () => {
      loads += 1;
      return { evaluationModel: () => ({}) };
    });
    await Promise.all([discover(), discover(), discover()]);
    await discover();
    expect(loads).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/provider-runtime/evaluation-discovery/`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement discovery**

Create `evaluation-discovery.ts`:

```ts
import { createProviderV4Evaluate } from '@aio-proxy/core';
import { isRecord } from '@aio-proxy/shared';

import type { EvaluationTransport } from '../../runtime';

export type EvaluationDiscovery =
  | { readonly kind: 'supported'; readonly evaluate: EvaluationTransport }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly error: Error };

/**
 * Probe a lazily loaded AI SDK package for `evaluationModel`, once.
 *
 * A probe result describes the CONVERT transport only. It is never a verdict on the
 * candidate: a provider with a matching System One raw endpoint stays eligible whatever
 * this returns, and must not wait on it. See the admission table in the spec.
 */
export function createEvaluationDiscovery(
  providerId: string,
  loadProvider: () => Promise<unknown>,
): () => Promise<EvaluationDiscovery> {
  let pending: Promise<EvaluationDiscovery> | undefined;
  return () => {
    pending ??= (async (): Promise<EvaluationDiscovery> => {
      try {
        const provider = await loadProvider();
        if (!isRecord(provider) || typeof provider.evaluationModel !== 'function') {
          return { kind: 'unsupported' };
        }
        return { kind: 'supported', evaluate: createProviderV4Evaluate(providerId, provider) };
      } catch (error) {
        return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
      }
    })();
    return pending;
  };
}
```

- [ ] **Step 4: Attach the transport during materialization**

In `packages/server/src/runtime.ts`, add the optional capability to `RuntimeProviderInstance`:

```ts
  readonly evaluation?: EvaluationTransport;
```

In `packages/server/src/provider-runtime/materialize/`:

- For an `api` provider whose primary endpoint package exposes `evaluationModel`
  (`openai-response`, `anthropic`, `gemini`), attach the transport and pass
  `hasEvaluationTransport: true` into the capability index. `openai-compatible` never qualifies.
- For an `ai-sdk` provider, attach a discovery-backed transport built with
  `createEvaluationDiscovery`, and pass `hasEvaluationTransport: true` when the package
  classifier already pins it to `typesafe-systemone`; otherwise leave it unset and let the
  attempt layer await discovery.
- OAuth providers get no evaluation transport.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/server/src/provider-runtime/ && bun run lint:types 2>&1 | tail -20`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A packages/server/src/provider-runtime packages/server/src/runtime.ts
git commit -m "feat(server): discover evaluation transports lazily and memoize the probe"
```

---
### Task 10: Pipeline dispatch, admission, and credential stripping

The composed admission rule lives here. Two guarantees are easy to break and silent when broken: raw must not wait on convert discovery, and a prepared failure must keep its normal position in candidate order.

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:119-165`
- Create: `packages/server/src/routes/pipeline/attempt/evaluation.ts`
- Create: `packages/server/src/routes/pipeline/attempt/evaluation.test.ts`

**Interfaces:**
- Consumes: `supportsEvaluation` (Task 8), `EvaluationDiscovery` (Task 9), `isEvaluationProtocolAdapter` (Task 3), `EvaluationDistributionError` (Task 5).
- Produces: `attemptEvaluationCandidate(ctx, slot): Promise<AttemptStep>`.

- [ ] **Step 1: Add the capability-filter arm first**

`filterCandidatesByCapability` falls through to `supportsLanguage` for any capability without an explicit arm. Adding `'evaluation'` without touching this file compiles and then silently filters evaluation candidates by language support.

```ts
    if (capability === 'evaluation') {
      return supportsEvaluation(candidate.provider.capabilityIndex, candidate.modelId);
    }
```

- [ ] **Step 2: Write the failing test**

Create `evaluation.test.ts`. Use the existing embedding attempt tests as the harness template.

```ts
import { describe, expect, it } from 'bun:test';

describe('attemptEvaluationCandidate', () => {
  it('prefers raw when the candidate resolves a System One transport', async () => {
    // resolve() is called with capability 'evaluation' and protocol 'typesafe-systemone'
    // convert must never be invoked
  });

  it('serves raw without awaiting convert discovery', async () => {
    // Gate discovery on a deferred promise that is never resolved.
    // The raw response must still be produced. Never assert on elapsed time.
  });

  it('converts when there is no raw transport', async () => {});

  it('falls back when convert yields a choice answer with no probabilities', async () => {
    // EvaluationDistributionError from egress becomes a candidate failure, then the next
    // candidate runs. The adapter owns the refusal; this layer owns the fallback.
  });

  it('surfaces a failed discovery in the candidate position, then falls back', async () => {});

  it('does not let a backup whose discovery failed pre-empt a healthy primary', async () => {
    // Primary priority 10 healthy, backup priority 0 discovery fails first.
    // Assert the attempt sequence contains only the primary.
  });

  it('strips caller credentials on the raw upstream request', async () => {
    // Anonymous admission: no caller keys configured, request still carries credentials.
    // With a matched caller key the middleware already strips them, so that setup
    // would pass even if this code path did nothing.
    // Assert: provider key present, caller Authorization absent, configured headers win,
    // and a `?key=` query credential is removed.
  });
});
```

Fill each body using the embedding attempt test's fixtures. Every assertion above is required; the comments state what each one protects.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/server/src/routes/pipeline/attempt/evaluation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the attempt function**

Create `evaluation.ts`, shaped like `attemptEmbeddingCandidate`. Note it calls `startRawAttempt` / `completeRawAttempt` directly and does NOT go through `attemptRawCandidate`, so the credential stripping at `raw.ts:40` does not apply — it must be applied here.

```ts
import { withoutCallerCredentialsOnRequest } from '../../../server/api-key-auth';
import { completeRawAttempt, startRawAttempt } from './raw';

export async function attemptEvaluationCandidate<TRequest, TContext>(
  ctx: EvaluationAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request } = ctx;
  const { candidate } = slot;

  const raw = candidate.provider.raw?.resolve({
    protocol: adapter.protocol,
    modelId: candidate.modelId,
    capability: 'evaluation',
    ...requestPathProperty(rawRequest),
  });

  // Raw wins and is never gated on convert discovery.
  if (raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = adapter.protocol;
    const attemptSpan = startRawAttempt(ctx, slot);
    const rewritten = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
    const upstream = withoutCallerCredentialsOnRequest(rewritten);
    return await completeRawAttempt(ctx, slot, raw, upstream, attemptSpan);
  }

  const evaluation = candidate.provider.evaluation;
  if (evaluation === undefined) {
    slot.trace.transport = undefined;
    slot.trace.targetProtocol = undefined;
    return emitReject(ctx, slot, adapter.errors.unsupported('evaluation_convert'), 'unsupported_feature');
  }

  slot.trace.transport = 'ai_sdk';
  slot.trace.targetProtocol = undefined;
  const invocation = adapter.evaluationInvocation(request, context);
  const result = await evaluation.evaluate(invocation, {
    modelId: candidate.modelId,
    signal: rawRequest.signal,
  });
  // `evaluationJson` throws EvaluationDistributionError when a choice/score answer has no
  // distribution. Map it to unsupported here so the shared loop falls back.
  const body = adapter.evaluationJson(result, { responseModelId: ctx.requestedModelId });
  return emitEvaluationSuccess(ctx, slot, body, result);
}
```

Wrap the `evaluationJson` call so `EvaluationDistributionError` becomes `adapter.errors.unsupported('evaluation_distribution')` plus fallback, and any other throw follows existing provider error mapping.

- [ ] **Step 5: Add the dispatch arm**

In `attempt.ts`, add the union member, the `attemptDispatch` arm before the audio fallthrough, and the `dispatchCandidate` case. Audio must stay the fallthrough — its `capability` is a union and cannot be narrowed away.

```ts
  if (adapter.capability === 'evaluation') return { kind: 'evaluation', ctx: { ...ctx, adapter } };
```

```ts
    case 'evaluation':
      return await attemptEvaluationCandidate(dispatch.ctx, slot);
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/server/src/routes/pipeline/ 2>&1 | tail -20`
Expected: PASS, and no existing language/embedding/image/audio/video test changes behavior.

- [ ] **Step 7: Commit**

```bash
git add -A packages/server/src/routes/pipeline
git commit -m "feat(server): dispatch evaluation candidates with raw-first admission"
```

---
### Task 11: The route and the TypeSafe-shaped 401

**Files:**
- Create: `packages/server/src/routes/systemone.ts`
- Modify: the router index that mounts routes
- Modify: `packages/server/src/server/api-key-auth/api-key-auth.ts:157-165`
- Create: `packages/server/src/server/api-key-auth/systemone-auth-error.test.ts`

**Interfaces:**
- Consumes: `typeSafeSystemOneAdapter` (Task 5), the shared pipeline entry.
- Produces: `POST /v1/systemone`.

- [ ] **Step 1: Write the failing auth test**

Create `systemone-auth-error.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

describe('authenticationError for /v1/systemone', () => {
  it('returns the TypeSafe error shape, not the OpenAI default', async () => {
    // Configure one caller key, send a request with a wrong one.
    const response = await appFetch('/v1/systemone', { headers: { authorization: 'Bearer wrong' } });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('error_type');
    // The OpenAI default nests under `error`; System One must not.
    expect(body.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/server/api-key-auth/systemone-auth-error.test.ts`
Expected: FAIL — the body is the OpenAI-shaped `{ error: { message, type } }`.

- [ ] **Step 3: Add the branch**

In `api-key-auth.ts`, before the final return:

```ts
  if (context.req.path.startsWith('/v1/systemone')) {
    return context.json({ message: 'Invalid API key', error_type: 'authentication_error' }, 401);
  }
```

- [ ] **Step 4: Add the route**

Create `packages/server/src/routes/systemone.ts`. Keep it thin: no provider-kind branching, no fallback, no usage capture — the pipeline owns all of that. Follow `openai-embeddings.ts` exactly: a `create*Routes(source)` factory returning a Hono instance, and note the field is `rawRequest`, not `raw`.

```ts
import { typeSafeSystemOneAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';

export function createSystemOneRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1/systemone', (context) =>
    handleProtocolRequest({
      adapter: typeSafeSystemOneAdapter,
      context: {},
      rawRequest: context.req.raw,
      source,
    }),
  );
}
```

Mount it where the other `create*Routes` factories are mounted.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/server/src/server/api-key-auth/ packages/server/src/routes/ 2>&1 | tail -20`
Expected: PASS. Other protocols' 401 shapes are unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A packages/server/src/routes packages/server/src/server/api-key-auth
git commit -m "feat(server): serve POST /v1/systemone with TypeSafe-shaped auth errors"
```

---

### Task 12: Usage capture

**Files:**
- Create: `packages/server/src/usage-capture/evaluation-capture/evaluation-capture.ts`
- Create: `packages/server/src/usage-capture/evaluation-capture/index.ts`
- Create: `packages/server/src/usage-capture/evaluation-capture/evaluation-capture.test.ts`
- Modify: `packages/server/src/usage-capture/shared.ts` and `usage-capture.ts`
- Modify: `packages/server/src/passthrough-usage/` (replace the Task 2 placeholder arms)

**Interfaces:**
- Consumes: `EvaluationResult` (Task 3), `finalizeUsage` from `usage-validation.ts`.
- Produces: `usageCapture.evaluation(options): Promise<UsageCompletion>`.

- [ ] **Step 1: Write the failing test**

Create `evaluation-capture.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { evaluationCapture } from './evaluation-capture';

const base = { providerId: 'p', modelId: 'm' };

describe('evaluationCapture', () => {
  it('records input and output tokens and their total', async () => {
    const completion = await evaluationCapture(
      { ...base, usage: { inputTokens: 312, outputTokens: 48 } },
      undefined,
    );
    expect(completion.outcome).toBe('success');
    expect(completion.usage).toMatchObject({ inputTokens: 312, outputTokens: 48, totalTokens: 360 });
  });

  it('records a row without token fields when usage is unknown, never zeros', async () => {
    const completion = await evaluationCapture({ ...base }, undefined);
    expect(completion.outcome).toBe('success');
    expect(completion.usage?.inputTokens).toBeUndefined();
    expect(completion.usage?.outputTokens).toBeUndefined();
  });

  it('drops a non-integer or negative count rather than persisting it', async () => {
    const completion = await evaluationCapture(
      { ...base, usage: { inputTokens: -1, outputTokens: 1.5 } },
      undefined,
    );
    expect(completion.usage?.inputTokens).toBeUndefined();
    expect(completion.usage?.outputTokens).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/usage-capture/evaluation-capture/`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `evaluation-capture.ts`, modelled on `embedding-capture.ts`:

```ts
import { finalizeUsage } from '../usage-validation';

const validCount = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export async function evaluationCapture(
  { usage, providerId, modelId, requestedModelId, configPrice }: EvaluationUsageOptions,
  logger: ServerLogSink | undefined,
): Promise<UsageCompletion> {
  const inputTokens = validCount(usage?.inputTokens);
  const outputTokens = validCount(usage?.outputTokens);
  const totalTokens =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : validCount(inputTokens + outputTokens);
  const row = await finalizeUsage({
    usage: {
      providerId,
      modelId,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    },
    accounting: { source: 'ai-sdk' },
    providerId,
    modelId,
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    ...(configPrice === undefined ? {} : { configPrice }),
    ...(logger === undefined ? {} : { logger }),
  });
  return { outcome: 'success', ...usageProperty(row) };
}
```

Add `evaluation` to the `UsageCapture` type and to `createUsageCapture`, then call it from `attemptEvaluationCandidate`'s convert path.

- [ ] **Step 4: Fill in the passthrough extractor**

Replace the Task 2 placeholder arm so the raw path maps `usage.input_tokens` / `output_tokens` onto `inputTokens` / `outputTokens`. jev prices input tokens only; leave an unconfigured output price at zero rather than special-casing it.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/server/src/usage-capture/ packages/server/src/passthrough-usage/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/server/src/usage-capture packages/server/src/passthrough-usage
git commit -m "feat(server): record evaluation usage on raw and convert"
```

---
### Task 13: End-to-end config tests, surfaces, and the changeset

The dispatch tests use hand-built candidates. These use real config loading, which is the only way to catch a provider that is silently never selected.

**Files:**
- Create: `packages/server/src/routes/pipeline/evaluation-routing.test.ts`
- Modify: `packages/types` generated config JSON schema (regenerate)
- Modify: `packages/dashboard` protocol selector, `packages/i18n` messages
- Modify: `README.md`, `README.zh-Hans.md`
- Create: `.changeset/typesafe-systemone-evaluation.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new code interfaces.

- [ ] **Step 1: Write the config-level routing tests**

Create `evaluation-routing.test.ts`. Load each YAML through the real config parser — do not hand-build candidate arrays, or the missing-`models` failure these exist to catch will slip through.

```ts
import { describe, expect, it } from 'bun:test';

describe('evaluation routing from real config', () => {
  it('routes the documented direct-primary / Gateway-backup pair and fails over on 529', async () => {
    // providers:
    //   typesafe-direct: kind api, protocol typesafe-systemone, models [jev-latest], priority 10
    //   vercel-gateway:  kind ai-sdk, packageName @ai-sdk/gateway,
    //                    alias { jev-latest: typesafe-ai/jev }, priority 0
    // Direct returns 529; the Gateway candidate must convert and succeed.
    // This is the regression guard for granting capability from a discovered transport:
    // the Gateway package is deliberately unclassified, so a protocol-union rule
    // would filter it out and this fallback would silently never happen.
  });

  it('selects an api openai-response provider for an all-noul request', async () => {});

  it('501s and falls back when that same provider gets a choice question', async () => {});

  it('does not select openai-compatible with no extra endpoint', async () => {});

  it('selects openai-compatible with an extra typesafe-systemone endpoint, via raw', async () => {
    // Serves chat on its primary origin and System One on the extra origin.
  });

  it('keeps a slug served only by @ai-sdk/typesafe-ai out of the chat pool', async () => {});

  it('ignores session affinity and response ownership', async () => {
    // Send session-like and previous-response-like headers; routing stays priority/weight.
  });

  it('forwards a raw 200 whose choice answer has no probabilities, unchanged', async () => {
    // The convert-only invariant must not leak into raw.
  });

  it('forwards a raw HTML error body unchanged', async () => {});

  it('returns the upstream body byte-for-byte on raw', async () => {
    // Fixture: non-canonical indentation, non-alphabetical keys, an unknown sentinel field.
    // expect(await response.text()).toBe(exactUpstreamText)
    // A field-level assertion would pass against a parse-and-re-serialize implementation.
  });

  it('omits model on raw when the upstream omitted it', async () => {});

  it('echoes the requested public slug on convert under an alias', async () => {});

  it('selects a cold candidate on the first evaluation request of the process', async () => {
    // Nothing loaded yet. "Not yet probed" must not read as unsupported, or the very first
    // request after startup silently skips a healthy provider.
  });

  it('surfaces a load failure as a candidate failure, not a router miss', async () => {
    // A bad packageName must not report "unknown model" for a configured model,
    // and must not take the process down at startup.
  });
});

describe('evaluation traces', () => {
  it('records transport=raw and targetProtocol=typesafe-systemone on the raw path', async () => {});

  it('records transport=ai_sdk and no targetProtocol on the convert path', async () => {});

  it('records skip reason evaluation_convert for an unsupported candidate', async () => {});

  it('records exactly two attempts for a raw 529 followed by a successful convert', async () => {
    // No hidden third attempt: maxRetries is 0, so the SDK must not retry underneath.
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test packages/server/src/routes/pipeline/evaluation-routing.test.ts`
Expected: PASS. Any failure here is a real routing defect, not a fixture problem — fix the code.

- [ ] **Step 3: Regenerate the config JSON schema**

Run the repo's schema generation script so `protocol: typesafe-systemone` validates for users.
Expected: the generated schema diff shows only the new enum value.

- [ ] **Step 4: Dashboard and i18n**

Add `typesafe-systemone` to the dashboard protocol selector and add its label to every locale in `packages/i18n` (`en`, `ja`, `ko`, `zh-Hans`, `zh-Hant`). Follow `packages/dashboard/AGENTS.md`. Run `bun run i18n:compile` afterwards.

- [ ] **Step 5: README rows**

Add to the inbound tables in both `README.md` and `README.zh-Hans.md`:

```
| TypeSafe System One | `POST /v1/systemone` |
```

- [ ] **Step 6: Write the changeset**

Create `.changeset/typesafe-systemone-evaluation.md`. It MUST name `@aio-proxy/plugin-sdk` as a product package: this change edits the SDK's public `ProtocolId` and `RawResolver` types, and a `fixed`-group bump alone yields an empty CHANGELOG entry, so `scripts/release.ts` skips the Release and the note vanishes.

```markdown
---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
---

Add TypeSafe System One evaluation support. `POST /v1/systemone` accepts the System One
request format and routes it like any other model request, with priority and weight
failover, usage recording, and System One-shaped errors. Providers declaring the new
`typesafe-systemone` protocol are served by raw passthrough; providers whose AI SDK
package exposes an evaluation model are served by conversion.
```

Keep it to one paragraph and do not prefix it with an area label.

- [ ] **Step 7: Full differential gate**

Run the same gate Task 1 Step 5 defines, plus the dashboard and i18n packages you touched. Expected: `check` PASS, every touched package green, and the `lint:types` per-file table identical to `.superpowers/sdd/baseline-lint-types.txt`. Do NOT run `bun run preflight`.

Then push and let Linux CI run `check`, `test:unit`, and `test:e2e:api` — CI is the authority on the 21 `@aio-proxy/cli` failures that are macOS-only here.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): document and verify System One evaluation end to end"
```

---

## Done when

Every box above is checked and:

- `POST /v1/systemone` evaluates through an `api` provider declaring `typesafe-systemone`, via raw, including when it is an additional endpoint rather than the primary protocol.
- The same request converts through an `ai-sdk` provider exposing `evaluationModel`.
- An all-`noul` request is selected and converts through an `api` `openai-response` provider; the same request with a `choice` question 501s and falls back.
- `openai-compatible` with no extra endpoint is never selected; with an extra `typesafe-systemone` endpoint it is, via raw.
- No convert-generated body carries a choice or score answer missing `probabilities`; raw success bodies are forwarded unvalidated.
- Convert echoes the requested public slug in `model`; raw returns the upstream body unchanged.
- The documented direct-primary / Gateway-backup YAML fails over on 429 and 529, not on 401.
- Raw never forwards caller credentials, proven through the real evaluation raw path with an anonymously admitted request and a query credential.
- A proxy-level 401 on `/v1/systemone` is TypeSafe-shaped.
- A slug served only by `@ai-sdk/typesafe-ai` is not routable as a language model.
- Evaluation routing ignores session affinity and response ownership.
- Usage records tokens when reported and omits the fields when not.
- Every other inbound protocol behaves as it does today.
- The differential gate in `.superpowers/sdd/baseline.md` is clean: `check` PASS, touched packages green, no new `lint:types` entry, and Linux CI green.

## Deferred, with the reason

- **The Gateway language leak.** A multi-capability package cannot be pinned, so a Gateway provider aliasing an evaluation slug also exposes it as a language ID; a chat request naming it fails at invoke and falls back. Fixing it needs per-capability catalogs the Gateway does not publish. Task 13 asserts the current behavior so a future change to it is deliberate.
- **The version-locked distribution fixture.** That the OpenAI / Anthropic / Google adapters never return choice or score distributions is corroborated in tagged source but not executed here. Before relying on it beyond the 501 path, add a fixture driving the real adapter against a fake upstream. A mock configured to omit distributions would only assert the fixture author's belief.
