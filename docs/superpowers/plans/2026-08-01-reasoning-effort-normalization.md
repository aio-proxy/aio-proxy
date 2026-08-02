# Reasoning Effort Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept any reasoning-effort string at ingress and clamp it per candidate down to the highest effort level that candidate's upstream model advertises, fixing the 400 on Claude Code ultracode `output_config.effort: "xhigh"`.

**Architecture:** A protocol-agnostic `reasoning-effort` helper provides `normalizeEffort(effort, supported)` (clamp down an ordered ladder) and `modelEffortValues(model)` (read a model's advertised effort set). The `ProtocolAdapter` interface gains a `supportedEfforts: ReadonlySet<string>` parameter on `rawRequest` and `modelInvocationForTarget`; each adapter clamps effort in its own request shape on both dispatch paths. The server pipeline resolves the supported set per candidate via `getModels` and threads it in. `variant()` is untouched — it drives routing before candidates exist.

**Tech Stack:** TypeScript, Bun test runner, Zod v4, `@opencode-ai/models` (`getModels`), AI SDK bridge types.

## Global Constraints

- Bun workspace monorepo; run `bun run preflight` (oxlint + oxfmt check + all unit tests) before considering the change complete, or at minimum `bun run check` plus affected package tests.
- Colocated tests: `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`. `index.ts` contains only exports; business logic lives in named implementation files; private modules are not imported from outside their directory.
- Handwritten non-test implementation files must stay under 300 lines.
- Prefer `es-toolkit` (narrow imports) over hand-written generic utilities; keep trivial native JS when clearer. The effort ladder logic is business-specific and has no es-toolkit equivalent — hand-write it.
- Effort ladder (ascending): `none < minimal < low < medium < high < xhigh < max`.
- Effort aliases folded before clamping: `x-high`, `x_high`, `extrahigh` → `xhigh`.
- Empty supported set ⇒ pass the (alias-folded) effort through unchanged. Never fail a candidate because capability lookup failed.
- `variant()` keeps returning the client's raw effort — normalization must not touch routing/variant selection.
- Changeset targets `@aio-proxy/core` **and** `aio-proxy`, summary prefixed `core:`, bump levels matched.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- Create `packages/core/src/protocol/reasoning-effort/reasoning-effort.ts` — ladder, alias map, `normalizeEffort`, `modelEffortValues`.
- Create `packages/core/src/protocol/reasoning-effort/index.ts` — exports.
- Create `packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts` — unit tests.
- Modify `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts` — relax `OutputConfigSchema` effort.
- Modify `packages/core/src/protocol/anthropic-thinking.ts` — widen adaptive effort to `string`.
- Modify `packages/core/src/protocol/adapter.ts` — add `supportedEfforts` param to `rawRequest` and `modelInvocationForTarget`.
- Modify `packages/core/src/protocol/anthropic-messages/anthropic-messages.ts` (adapter) — clamp effort in `rawRequest` + add `modelInvocationForTarget`.
- Modify `packages/core/src/protocol/openai-responses.ts` — clamp effort in `rawRequest` + `modelInvocationForTarget`.
- Modify `packages/core/src/protocol/openai-completions.ts` — clamp effort in `rawRequest` + add `modelInvocationForTarget`.
- Modify `packages/core/src/protocol/gemini-generate-content.ts` — clamp effort in `rawRequest` (context moves to 5th slot) + add `modelInvocationForTarget`.
- Create `packages/server/src/routes/pipeline/attempt/effort-capability.ts` — `resolveSupportedEfforts(modelId)`.
- Modify `packages/server/src/routes/pipeline/attempt/raw.ts` — resolve + pass supported set.
- Modify `packages/server/src/routes/pipeline/attempt/model.ts` + `model-prepare.ts` — resolve + thread supported set into `modelInvocationForTarget`.
- Modify `packages/server/src/routes/token-count.ts` — pass `new Set()`.
- Update adapter tests that call `rawRequest`/`modelInvocationForTarget` (new signatures).
- Add a `.changeset/*.md`.

---

## Task 1: reasoning-effort helper

**Files:**
- Create: `packages/core/src/protocol/reasoning-effort/reasoning-effort.ts`
- Create: `packages/core/src/protocol/reasoning-effort/index.ts`
- Test: `packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeEffort(effort: string, supported: ReadonlySet<string>): string`
  - `modelEffortValues(model: unknown): ReadonlySet<string>`
  - `clampSdkReasoning(invocation: ModelInvocation, supported: ReadonlySet<string>): ModelInvocation` — clamps `settings.reasoning` (the AI-SDK effort field shared by OpenAI Responses/Completions and Gemini) via `normalizeEffort`; identity when reasoning is absent/non-string or already at a supported level.
  - All three re-exported from `reasoning-effort/index.ts`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { modelEffortValues, normalizeEffort } from './index';

describe('normalizeEffort', () => {
  test('passes effort through unchanged when supported set is empty', () => {
    expect(normalizeEffort('xhigh', new Set())).toBe('xhigh');
  });

  test('keeps the effort when it is supported', () => {
    expect(normalizeEffort('high', new Set(['low', 'medium', 'high']))).toBe('high');
  });

  test('clamps down to the nearest supported level below the request', () => {
    expect(normalizeEffort('xhigh', new Set(['low', 'medium', 'high']))).toBe('high');
    expect(normalizeEffort('max', new Set(['low', 'medium']))).toBe('medium');
  });

  test('clamps down to the lowest supported level when nothing below the request exists', () => {
    expect(normalizeEffort('none', new Set(['medium', 'high']))).toBe('medium');
  });

  test('folds aliases before clamping', () => {
    expect(normalizeEffort('x-high', new Set(['low', 'medium', 'high', 'xhigh']))).toBe('xhigh');
    expect(normalizeEffort('X_HIGH', new Set(['xhigh']))).toBe('xhigh');
    expect(normalizeEffort('extrahigh', new Set(['high']))).toBe('high');
  });

  test('passes an unknown (off-ladder) effort through when unsupported', () => {
    expect(normalizeEffort('ultra', new Set(['low', 'medium', 'high']))).toBe('high');
    expect(normalizeEffort('ultra', new Set())).toBe('ultra');
  });
});

describe('modelEffortValues', () => {
  test('reads the effort values from reasoning_options', () => {
    const model = { reasoning_options: [{ type: 'effort', values: ['low', 'high', 'xhigh'] }] };
    expect([...modelEffortValues(model)].sort()).toEqual(['high', 'low', 'xhigh']);
  });

  test('returns an empty set for a model without effort reasoning options', () => {
    expect(modelEffortValues({ reasoning_options: [{ type: 'other', values: ['x'] }] }).size).toBe(0);
    expect(modelEffortValues({}).size).toBe(0);
    expect(modelEffortValues(undefined).size).toBe(0);
    expect(modelEffortValues(null).size).toBe(0);
  });
});

describe('clampSdkReasoning', () => {
  test('clamps settings.reasoning down to a supported level', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    const result = clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']));
    expect(result.settings?.reasoning).toBe('high');
  });

  test('returns the same invocation when reasoning is absent', () => {
    const invocation = { messages: [], settings: {} };
    expect(clampSdkReasoning(invocation, new Set(['low']))).toBe(invocation);
  });

  test('returns the same invocation when reasoning already supported', () => {
    const invocation = { messages: [], settings: { reasoning: 'high' } };
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']))).toBe(invocation);
  });

  test('passes reasoning through when the supported set is empty', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    expect(clampSdkReasoning(invocation, new Set()).settings?.reasoning).toBe('xhigh');
  });
});
```

Update the import line at the top of the test to include the new export:

```typescript
import { clampSdkReasoning, modelEffortValues, normalizeEffort } from './index';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`
Expected: FAIL — module `./index` not found.

- [ ] **Step 3: Write the implementation**

`packages/core/src/protocol/reasoning-effort/reasoning-effort.ts`:

```typescript
// Ascending reasoning-effort ladder. Index = rank; higher index = more effort.
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Common spellings folded to the canonical ladder value before clamping.
const ALIASES: Readonly<Record<string, string>> = {
  'x-high': 'xhigh',
  x_high: 'xhigh',
  extrahigh: 'xhigh',
};

function canonical(effort: string): string {
  const lower = effort.toLowerCase();
  return ALIASES[lower] ?? lower;
}

// Clamp the requested effort down to the highest supported level at or below it.
// Empty support => pass through (no capability info; do not mangle). An effort
// not on the ladder clamps to the highest supported level, or passes through
// when nothing is supported.
export function normalizeEffort(effort: string, supported: ReadonlySet<string>): string {
  const wanted = canonical(effort);
  if (supported.size === 0) return wanted;
  if (supported.has(wanted)) return wanted;

  const supportedRanks = LADDER.map((level, rank) => ({ level, rank })).filter((entry) =>
    supported.has(entry.level),
  );
  if (supportedRanks.length === 0) return wanted;

  const wantedRank = LADDER.indexOf(wanted as (typeof LADDER)[number]);
  // Off-ladder or above everything: take the highest supported level.
  if (wantedRank === -1) return supportedRanks[supportedRanks.length - 1]!.level;

  const atOrBelow = supportedRanks.filter((entry) => entry.rank <= wantedRank);
  if (atOrBelow.length > 0) return atOrBelow[atOrBelow.length - 1]!.level;
  // Nothing supported at or below the request: clamp up to the lowest supported.
  return supportedRanks[0]!.level;
}

type EffortReasoningOption = { readonly type?: unknown; readonly values?: unknown };

// Narrow an unknown model object to its advertised effort levels, mirroring
// server/model-capabilities: reasoning_options[type==='effort'].values.
export function modelEffortValues(model: unknown): ReadonlySet<string> {
  if (typeof model !== 'object' || model === null) return new Set();
  const options = (model as { readonly reasoning_options?: unknown }).reasoning_options;
  if (!Array.isArray(options)) return new Set();
  const effort = options.find(
    (option): option is EffortReasoningOption =>
      typeof option === 'object' && option !== null && (option as EffortReasoningOption).type === 'effort',
  );
  const values = effort?.values;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is string => typeof value === 'string'));
}

// Clamp the AI-SDK reasoning effort (settings.reasoning) shared by the
// OpenAI Responses/Completions and Gemini model paths. Identity when reasoning
// is absent, non-string, or already at a supported level.
export function clampSdkReasoning(
  invocation: ModelInvocation,
  supported: ReadonlySet<string>,
): ModelInvocation {
  const reasoning = invocation.settings?.reasoning;
  if (typeof reasoning !== 'string') return invocation;
  const next = normalizeEffort(reasoning, supported);
  if (next === reasoning) return invocation;
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  return { ...invocation, settings: { ...settings, reasoning: next as typeof settings.reasoning } };
}
```

Add the import at the top of `reasoning-effort.ts`:

```typescript
import type { ModelInvocation } from '../adapter';
```

`packages/core/src/protocol/reasoning-effort/index.ts`:

```typescript
export { clampSdkReasoning, modelEffortValues, normalizeEffort } from './reasoning-effort';
```

Note: `reasoning-effort.ts` importing a type from `../adapter` is a type-only import (erased at build), so it introduces no runtime dependency cycle. `adapter.ts` does not import from `reasoning-effort`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/protocol/reasoning-effort/reasoning-effort.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/reasoning-effort/
git commit -m "core: add reasoning-effort normalization helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Relax ingress + widen adaptive-effort type

**Files:**
- Modify: `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts:182`
- Modify: `packages/core/src/protocol/anthropic-thinking.ts:7`
- Test: `packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts` (add a case if the file exists; otherwise the routing test in Task 8 covers it — check first with `ls`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AnthropicThinkingOption` adaptive variant is now `{ mode: 'adaptive'; effort: string }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts` (locate the existing `describe` for request parsing; if no such test file, skip to Step 3 and rely on Task 8's regression test):

```typescript
test('accepts an arbitrary effort string in output_config', () => {
  const parsed = parseAnthropicMessages({
    model: 'claude-3-5-sonnet',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  });
  expect(parsed.output_config?.effort).toBe('xhigh');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts`
Expected: FAIL — Zod rejects `'xhigh'` at `output_config.effort` (enum).

- [ ] **Step 3: Relax the schema**

In `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`, change line 182:

```typescript
const OutputConfigSchema = z.object({ effort: z.string().optional() }).loose();
```

- [ ] **Step 4: Widen the adaptive-effort type**

In `packages/core/src/protocol/anthropic-thinking.ts`, change the adaptive variant on line 7 from:

```typescript
  | { readonly mode: 'adaptive'; readonly effort: 'low' | 'medium' | 'high' | 'max' };
```

to:

```typescript
  | { readonly mode: 'adaptive'; readonly effort: string };
```

Leave the validation body unchanged — it only checks `effort !== undefined`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/src/ingress/anthropic-messages/ && bun run check`
Expected: PASS; type check clean (the widening removes no narrowing that other code depends on — `to-model.ts` only spreads `thinking` into provider options).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ingress/anthropic-messages/anthropic-messages.ts packages/core/src/protocol/anthropic-thinking.ts packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts
git commit -m "core: accept any Anthropic output_config.effort string

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Extend the adapter interface with supportedEfforts

**Files:**
- Modify: `packages/core/src/protocol/adapter.ts:49,51-54`

**Interfaces:**
- Consumes: nothing new.
- Produces the new adapter method signatures (every adapter and every test call site must match these):
  - `rawRequest: (raw: Request, request: TRequest, resolvedModel: string, supportedEfforts: ReadonlySet<string>, context: TContext) => Promise<Request>`
  - `modelInvocationForTarget: (invocation: ModelInvocation, targetProtocol: ProviderProtocol | undefined, supportedEfforts: ReadonlySet<string>) => ModelInvocation`

- [ ] **Step 1: Update the interface**

In `packages/core/src/protocol/adapter.ts`, change the `rawRequest` line (49):

```typescript
  rawRequest: (
    raw: Request,
    request: TRequest,
    resolvedModel: string,
    supportedEfforts: ReadonlySet<string>,
    context: TContext,
  ) => Promise<Request>;
```

and `modelInvocationForTarget` (51-54):

```typescript
  modelInvocationForTarget: (
    invocation: ModelInvocation,
    targetProtocol: ProviderProtocol | undefined,
    supportedEfforts: ReadonlySet<string>,
  ) => ModelInvocation;
```

Update `sameModelInvocation` (the default) to accept and ignore the new argument — its current single-parameter form is still assignable, so no change is strictly required, but confirm the type checks.

- [ ] **Step 2: Run type check to see the full breakage list**

Run: `bun run check`
Expected: FAIL — every adapter's `rawRequest`, the `openai-responses` `modelInvocationForTarget` override, and all call sites/tests now mismatch. This is the worklist for Tasks 4–8. Do not fix them here.

- [ ] **Step 3: Commit the interface change alone**

Commit only `adapter.ts` so the next tasks have a clean base. The type errors are expected and resolved by Tasks 4–8; note this in the commit body.

```bash
git add packages/core/src/protocol/adapter.ts
git commit -m "core: thread supportedEfforts into adapter dispatch methods

Adds a ReadonlySet<string> capability arg to rawRequest and
modelInvocationForTarget. Adapters and call sites are updated in
follow-up commits; the tree does not type-check until then.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Anthropic adapter — clamp effort on both paths

**Files:**
- Create: `packages/core/src/protocol/anthropic-messages/effort.ts`
- Modify: `packages/core/src/protocol/anthropic-messages/anthropic-messages.ts` (adapter `rawRequest`, add `modelInvocationForTarget`)
- Test: `packages/core/src/protocol/anthropic-messages/anthropic-messages.test.ts` (update existing `rawRequest` calls to new arity; add clamp cases)

**Interfaces:**
- Consumes: `normalizeEffort` from `../reasoning-effort/index`; adapter signatures from Task 3.
- Produces (in `effort.ts`):
  - `rewriteAnthropicRawEffort(raw: Request, resolvedModel: string, supportedEfforts: ReadonlySet<string>): Promise<Request>`
  - `normalizeAnthropicInvocationEffort(invocation: ModelInvocation, supportedEfforts: ReadonlySet<string>): ModelInvocation`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/protocol/anthropic-messages/anthropic-messages.test.ts`:

```typescript
test('clamps output_config.effort to the highest supported level in the raw body', async () => {
  const body = {
    model: 'src',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  };
  const raw = new Request('https://x/v1/messages', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseAnthropicMessages(structuredClone(body));
  const forwarded = await anthropicMessagesAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', output_config: { effort: 'high' } });
});

test('leaves effort untouched in the raw body when the supported set is empty', async () => {
  const body = {
    model: 'upstream',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  };
  const raw = new Request('https://x/v1/messages', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseAnthropicMessages(structuredClone(body));
  const forwarded = await anthropicMessagesAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {});
  expect(await forwarded.json()).toMatchObject({ output_config: { effort: 'xhigh' } });
});

test('clamps the adaptive thinking effort in the model invocation', () => {
  const parsed = parseAnthropicMessages({
    model: 'm',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  });
  const invocation = anthropicMessagesAdapter.modelInvocation(parsed, {});
  const clamped = anthropicMessagesAdapter.modelInvocationForTarget(
    invocation,
    undefined,
    new Set(['low', 'medium', 'high']),
  );
  const thinking = (clamped.settings?.providerOptions as { aioProxy?: { thinking?: { effort?: string } } })?.aioProxy
    ?.thinking;
  expect(thinking?.effort).toBe('high');
});
```

Also update the **existing** `rawRequest` calls in this file (e.g. line 106) to the new 5-arg form: `rawRequest(raw, parsed, 'upstream', new Set(), {})`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/anthropic-messages/anthropic-messages.test.ts`
Expected: FAIL — new-arity calls don't clamp yet / `modelInvocationForTarget` uses the identity default.

- [ ] **Step 3: Write `effort.ts`**

`packages/core/src/protocol/anthropic-messages/effort.ts`:

```typescript
import { z } from 'zod';

import type { ModelInvocation } from '../adapter';
import { readJsonRequest } from '../request';
import { normalizeEffort } from '../reasoning-effort/index';

const bodySchema = z.object({}).catchall(z.unknown());

// Rewrite the raw Anthropic body: substitute the resolved model, and clamp
// output_config.effort against the candidate model's supported set. Rebuilds the
// request (decoded) so a downstream re-read sees the normalized JSON.
export async function rewriteAnthropicRawEffort(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  const body = bodySchema.parse(await readJsonRequest(raw));
  const outputConfig = body['output_config'];
  const nextOutputConfig =
    typeof outputConfig === 'object' && outputConfig !== null && typeof (outputConfig as { effort?: unknown }).effort === 'string'
      ? { ...outputConfig, effort: normalizeEffort((outputConfig as { effort: string }).effort, supportedEfforts) }
      : outputConfig;

  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({
      ...body,
      model: resolvedModel,
      ...(nextOutputConfig === undefined ? {} : { output_config: nextOutputConfig }),
    }),
    headers,
  });
}

type ThinkingProviderOptions = {
  readonly aioProxy?: { readonly thinking?: { readonly mode?: string; readonly effort?: string } };
};

// Clamp the adaptive thinking effort baked into settings.providerOptions.aioProxy.
export function normalizeAnthropicInvocationEffort(
  invocation: ModelInvocation,
  supportedEfforts: ReadonlySet<string>,
): ModelInvocation {
  const providerOptions = invocation.settings?.providerOptions as ThinkingProviderOptions | undefined;
  const thinking = providerOptions?.aioProxy?.thinking;
  if (thinking?.effort === undefined) return invocation;
  const effort = normalizeEffort(thinking.effort, supportedEfforts);
  if (effort === thinking.effort) return invocation;
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  return {
    ...invocation,
    settings: {
      ...settings,
      providerOptions: {
        ...settings.providerOptions,
        aioProxy: { ...providerOptions!.aioProxy, thinking: { ...thinking, effort } },
      },
    },
  };
}
```

- [ ] **Step 4: Wire the adapter**

In `packages/core/src/protocol/anthropic-messages/anthropic-messages.ts`:

Add import: `import { normalizeAnthropicInvocationEffort, rewriteAnthropicRawEffort } from './effort';`

Replace `rawRequest`:

```typescript
  rawRequest(raw, _request, resolvedModel, supportedEfforts) {
    return rewriteAnthropicRawEffort(raw, resolvedModel, supportedEfforts);
  },
```

Add a `modelInvocationForTarget` (before `modelJson`):

```typescript
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return normalizeAnthropicInvocationEffort(invocation, supportedEfforts);
  },
```

Note: the previous `rawRequest` short-circuited to `raw.clone()` when `request.model === resolvedModel`. Now it always rewrites (to also clamp effort). That is fine — the body is re-serialized either way; `rewriteAnthropicRawEffort` decodes and re-encodes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/src/protocol/anthropic-messages/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol/anthropic-messages/
git commit -m "core: clamp Anthropic reasoning effort per candidate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: OpenAI Responses adapter — clamp effort on both paths

**Files:**
- Modify: `packages/core/src/protocol/openai-responses.ts` (`rawRequest`, `modelInvocationForTarget`)
- Test: `packages/core/src/protocol/openai-responses.test.ts`, `packages/core/src/protocol/openai-responses-basic.test.ts`, `packages/core/src/transform/openai-responses/sdk-wire.test.ts`

**Interfaces:**
- Consumes: `normalizeEffort`; adapter signatures from Task 3. `reasoningSetting(effort)` and `AI_SDK_REASONING` already exist in this file.
- Produces: no new exports.

- [ ] **Step 1: Read the current `rawRequest` and `modelInvocationForTarget`**

Confirm current bodies (openai-responses.ts:37-52). `rawRequest` rewrites the model; `reasoning.effort` lives in the raw body. `modelInvocationForTarget` currently specializes the invocation for the target protocol (existing behavior — preserve it).

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/protocol/openai-responses-basic.test.ts`:

```typescript
test('clamps reasoning.effort in the raw body against the supported set', async () => {
  const body = { model: 'src', input: 'hi', reasoning: { effort: 'xhigh' } };
  const raw = new Request('https://x/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseOpenAIResponses(structuredClone(body));
  const forwarded = await openAIResponsesAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', reasoning: { effort: 'high' } });
});
```

(Match the actual `parseOpenAIResponses` import already used in that test file; adjust the request field names to the real OpenAI Responses shape if the test file uses a helper.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/openai-responses-basic.test.ts`
Expected: FAIL — arity mismatch / no effort clamp.

- [ ] **Step 4: Implement**

In `openai-responses.ts`, add import: `import { normalizeEffort } from './reasoning-effort/index';`

Rewrite `rawRequest` to clamp `reasoning.effort` in the body in addition to the model. Read the body with the module's existing JSON read helper (mirror `rewriteJsonRequestModel` from `./request` but also clamp `reasoning.effort` when present). If the file already delegates to `rewriteJsonRequestModel`, add a local body rewrite:

```typescript
  async rawRequest(raw, request, resolvedModel, supportedEfforts) {
    const body = (await readJsonRequest(raw)) as Record<string, unknown>;
    const reasoning = body['reasoning'];
    const nextReasoning =
      typeof reasoning === 'object' && reasoning !== null && typeof (reasoning as { effort?: unknown }).effort === 'string'
        ? { ...reasoning, effort: normalizeEffort((reasoning as { effort: string }).effort, supportedEfforts) }
        : reasoning;
    const headers = new Headers(raw.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Request(raw, {
      method: raw.method,
      body: JSON.stringify({ ...body, model: resolvedModel, ...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }) }),
      headers,
    });
  },
```

Add imports for `readJsonRequest` from `./request`.

In `modelInvocationForTarget`, clamp `settings.reasoning` on **both** return paths (the current early `return invocation` for non-OpenAIResponse targets, and the specialized object) using the shared `clampSdkReasoning` helper from Task 1:

```typescript
  modelInvocationForTarget(invocation, targetProtocol, supportedEfforts) {
    const clamped = clampSdkReasoning(invocation, supportedEfforts);
    if (targetProtocol !== ProviderProtocol.OpenAIResponse) return clamped;
    const tools = responsesToolSet(clamped.tools);
    return {
      ...clamped,
      messages: openAIResponsesMessages(clamped.messages),
      ...(tools === undefined ? {} : { tools }),
    };
  },
```

Import: `import { clampSdkReasoning, normalizeEffort } from './reasoning-effort/index';`

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/transform/openai-responses/sdk-wire.test.ts`
Update existing `rawRequest`/`modelInvocationForTarget` calls in those files to the new arity (`new Set()` where clamping isn't under test).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol/openai-responses.ts packages/core/src/protocol/openai-responses.test.ts packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/transform/openai-responses/sdk-wire.test.ts
git commit -m "core: clamp OpenAI Responses reasoning effort per candidate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: OpenAI Completions adapter — clamp effort on both paths

**Files:**
- Modify: `packages/core/src/protocol/openai-completions.ts` (`rawRequest`, add `modelInvocationForTarget`)
- Test: `packages/core/src/protocol/openai-completions.test.ts`

**Interfaces:**
- Consumes: `normalizeEffort`; adapter signatures from Task 3. Raw effort field is `reasoning_effort`; model-path effort is `settings.reasoning`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/protocol/openai-completions.test.ts`:

```typescript
test('clamps reasoning_effort in the raw body against the supported set', async () => {
  const body = { model: 'src', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' };
  const raw = new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseOpenAICompletions(structuredClone(body));
  const forwarded = await openAICompletionsAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', reasoning_effort: 'high' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/openai-completions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add import: `import { normalizeEffort } from './reasoning-effort/index';` and `import { readJsonRequest } from './request';`

Rewrite `rawRequest` to clamp `reasoning_effort` (top-level string) in addition to the model, mirroring Task 5's body-rewrite pattern but on the `reasoning_effort` field.

Add `modelInvocationForTarget` that clamps `settings.reasoning` via the shared helper (completions has no target-protocol specialization):

```typescript
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return clampSdkReasoning(invocation, supportedEfforts);
  },
```

Import: `import { clampSdkReasoning, normalizeEffort } from './reasoning-effort/index';`. The invocation's `settings.reasoning` comes from `openAICompletionsToModelMessages`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/protocol/openai-completions.test.ts`
Update any existing `rawRequest` calls to new arity.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/openai-completions.ts packages/core/src/protocol/openai-completions.test.ts
git commit -m "core: clamp OpenAI Completions reasoning effort per candidate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Gemini adapter — clamp effort, fix param order

**Files:**
- Modify: `packages/core/src/protocol/gemini-generate-content.ts` (`rawRequest` signature + body, add `modelInvocationForTarget`)
- Test: `packages/core/src/protocol/gemini-generate-content.test.ts`

**Interfaces:**
- Consumes: `normalizeEffort`; adapter signatures from Task 3. Raw effort field is `generationConfig.thinkingConfig.thinkingLevel`; model-path effort is `settings.reasoning` (via `geminiReasoning`).
- Produces: no new exports.

**CRITICAL:** Gemini's `rawRequest` currently has `context` in the 4th slot: `async rawRequest(raw, _request, resolvedModel, context)`. Inserting `supportedEfforts` before `context` makes `context` the **5th** parameter. Update the signature deliberately — a silent argument-order bug here (context landing in the supportedEfforts slot) is exactly the failure this task guards against.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/protocol/gemini-generate-content.test.ts`:

```typescript
test('clamps thinkingLevel in the raw body against the supported set', async () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'xhigh' } },
  };
  const raw = new Request('https://x/v1beta/models/src:generateContent', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const parsed = parseGeminiGenerateContent(structuredClone(body));
  const forwarded = await geminiGenerateContentAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    { model: 'src', stream: false },
  );
  expect(await forwarded.json()).toMatchObject({
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
  });
  expect(new URL(forwarded.url).pathname).toContain('upstream');
});
```

(Match the real `parseGeminiGenerateContent` import and context shape used elsewhere in this test file; the existing `rawRequest` test at line ~64 shows the exact context object.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/gemini-generate-content.test.ts`
Expected: FAIL — arity/param-order mismatch, no clamp.

- [ ] **Step 3: Implement**

Change the signature to `async rawRequest(raw, _request, resolvedModel, supportedEfforts, context)`. Keep the existing URL-rewrite logic (using `context.model`, `context.stream`). Additionally, when the body carries `generationConfig.thinkingConfig.thinkingLevel` as a string, clamp it with `normalizeEffort(level, supportedEfforts)` and rebuild the body. Because the current code returns `new Request(url, raw.clone())` for the model-rewrite case and `raw.clone()` for the same-model case, restructure to always read+rewrite the body when a `thinkingLevel` is present, and otherwise keep the existing clone/URL behavior.

Add `modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts)` that clamps `settings.reasoning` via the shared helper (Gemini's model path lands effort in `settings.reasoning` via `geminiReasoning`):

```typescript
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return clampSdkReasoning(invocation, supportedEfforts);
  },
```

Add imports: `import { clampSdkReasoning, normalizeEffort } from './reasoning-effort/index';` and `readJsonRequest` from `./request` for the raw body rewrite.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/protocol/gemini-generate-content.test.ts`
Update the existing `rawRequest` test call(s) to the new 5-arg order.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/gemini-generate-content.ts packages/core/src/protocol/gemini-generate-content.test.ts
git commit -m "core: clamp Gemini reasoning effort per candidate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Server pipeline — resolve capability set and thread it in

**Files:**
- Create: `packages/server/src/routes/pipeline/attempt/effort-capability.ts`
- Create: `packages/server/src/routes/pipeline/attempt/effort-capability.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts:25`
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts:22-23`
- Modify: `packages/server/src/routes/pipeline/attempt/model-prepare.ts` (`resolveInvocation` gains a `supportedEfforts` param)
- Modify: `packages/server/src/routes/token-count.ts:188`
- Modify: any pipeline test-support adapter stub with a `rawRequest`/`modelInvocationForTarget` (`packages/server/src/routes/pipeline/test-support.ts`, `oauth.test-support.ts`) to new arity
- Test: an inbound-Anthropic regression test (locate the existing pipeline/adapter integration test; e.g. `anthropic-messages-routing.test.ts`)

**Interfaces:**
- Consumes: `modelEffortValues` from `@aio-proxy/core` (export it from the core barrel if not already — check `packages/core/src/index.ts`), `getModels` from `@aio-proxy/core`, adapter signatures from Task 3.
- Produces: `resolveSupportedEfforts(modelId: string): Promise<ReadonlySet<string>>`.

- [ ] **Step 1: Ensure `modelEffortValues` is exported from core**

Check `packages/core/src/index.ts` (or the protocol barrel) exports `modelEffortValues`. If the pipeline imports from `@aio-proxy/core`, add `export { modelEffortValues, normalizeEffort } from './protocol/reasoning-effort/index';` to the appropriate barrel. Run `bun run check` in core to confirm.

- [ ] **Step 2: Write the failing test for `resolveSupportedEfforts`**

`packages/server/src/routes/pipeline/attempt/effort-capability.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { resolveSupportedEfforts } from './effort-capability';

describe('resolveSupportedEfforts', () => {
  test('returns an empty set for an unknown model (no throw)', async () => {
    const result = await resolveSupportedEfforts('definitely-not-a-real-model-xyz');
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/server/src/routes/pipeline/attempt/effort-capability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `resolveSupportedEfforts`**

`packages/server/src/routes/pipeline/attempt/effort-capability.ts`:

```typescript
import { getModels, modelEffortValues } from '@aio-proxy/core';

// Resolve the effort levels a candidate model advertises. Any lookup failure or
// missing model yields an empty set, which normalizeEffort treats as pass-through
// — a models.dev outage never fails the request.
export async function resolveSupportedEfforts(modelId: string): Promise<ReadonlySet<string>> {
  try {
    const models = await getModels([modelId]);
    return modelEffortValues(models[modelId]);
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/server/src/routes/pipeline/attempt/effort-capability.test.ts`
Expected: PASS.

- [ ] **Step 6: Thread into the raw path**

In `raw.ts`, before line 25, resolve the set and pass it (context stays last):

```typescript
  const supportedEfforts = await resolveSupportedEfforts(candidate.modelId);
  const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, supportedEfforts, context);
```

Add `import { resolveSupportedEfforts } from './effort-capability';`

- [ ] **Step 7: Thread into the model path**

In `model.ts`, `attemptModelCandidate` is already `async`. Before calling `resolveInvocation` (line 23), resolve the set and pass it:

```typescript
  const supportedEfforts = await resolveSupportedEfforts(candidate.modelId);
  const prepared = resolveInvocation(ctx, slot, holder, slot.trace.targetProtocol, supportedEfforts);
```

Add the import. In `model-prepare.ts`, extend `resolveInvocation`'s signature with `supportedEfforts: ReadonlySet<string>` and pass it to `modelInvocationForTarget`:

```typescript
    candidateInvocation: adapter.modelInvocationForTarget(holder.invocation, targetProtocol, supportedEfforts),
```

- [ ] **Step 8: Thread into token-count (empty set)**

In `token-count.ts:188`:

```typescript
    const candidateInvocation = adapter.modelInvocationForTarget(invocation, targetProtocol, new Set());
```

- [ ] **Step 9: Fix pipeline test-support stubs**

Update `rawRequest`/`modelInvocationForTarget` in `packages/server/src/routes/pipeline/test-support.ts` and `oauth.test-support.ts` (and any other adapter stub) to the new signatures. For stubs, add the ignored param: `rawRequest(raw, _request, _model, _supportedEfforts, _context) {...}`.

- [ ] **Step 10: Write the inbound regression test**

Add to the existing routing test (`packages/core/src/protocol/anthropic-messages/anthropic-messages-routing.test.ts` or the server pipeline integration test — pick the one that already drives a full inbound request) a case: an Anthropic request with `thinking:{type:'adaptive'}` + `output_config:{effort:'xhigh'}` resolves without a 400 and, given a candidate model supporting `{low,medium,high}`, forwards `effort:'high'`. Reuse that file's existing harness rather than inventing a new one.

- [ ] **Step 11: Run the full affected suites**

Run: `bun test packages/server packages/core`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/server/src/routes/pipeline/attempt/effort-capability.ts packages/server/src/routes/pipeline/attempt/effort-capability.test.ts packages/server/src/routes/pipeline/attempt/raw.ts packages/server/src/routes/pipeline/attempt/model.ts packages/server/src/routes/pipeline/attempt/model-prepare.ts packages/server/src/routes/token-count.ts packages/server/src/routes/pipeline/test-support.ts packages/server/src/routes/pipeline/oauth.test-support.ts packages/core/src/index.ts packages/core/src/protocol/anthropic-messages/anthropic-messages-routing.test.ts
git commit -m "core: resolve per-candidate effort capability in the pipeline

Fixes 400 on Claude Code ultracode output_config.effort=xhigh; each candidate
downgrades effort to its model's advertised set on both dispatch paths.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Preflight + changeset

**Files:**
- Create: `.changeset/<generated>.md`

- [ ] **Step 1: Run preflight**

Run: `bun run preflight`
Expected: oxlint clean, oxfmt clean, all unit tests pass. Fix any lint/format issues (`bun run format`), re-run.

- [ ] **Step 2: Author the changeset**

Run: `bun changeset`
Select **both** `@aio-proxy/core` and `aio-proxy`, matched bump levels (`minor` — new user-visible capability). Summary:

```
core: normalize reasoning effort per candidate

Accept any output_config.effort / reasoning.effort / thinkingLevel value at
ingress and clamp it down to each upstream model's advertised effort levels.
Fixes a 400 when Claude Code ultracode sends output_config.effort="xhigh".
```

- [ ] **Step 3: Verify the changeset targets a product package**

Confirm the generated `.changeset/*.md` frontmatter lists `aio-proxy` (not only `@aio-proxy/core`). A changeset targeting only the internal package would produce an empty Release note.

- [ ] **Step 4: Commit**

```bash
git add .changeset/
git commit -m "chore: changeset for reasoning effort normalization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-implementation note (not a task)

`~/.aio-proxy/config.jsonc` was modified during earlier debugging to add logging (backup at `config.jsonc.bak`) and contains sensitive API keys. It must be restored to its non-debug state and must never be committed. Confirm restoration with the user after implementation; it is outside this worktree and this plan.
