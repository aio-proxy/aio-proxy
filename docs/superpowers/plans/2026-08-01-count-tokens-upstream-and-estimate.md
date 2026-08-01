# Two-Tier count_tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Anthropic `/v1/messages/count_tokens` return real upstream counts when a same-protocol raw provider is available, and replace the dumb `bytes/64` fallback with a character-class-weighted estimator when none is.

**Architecture:** Two tiers inside the existing `handleTokenCount` candidate loop (`packages/server/src/routes/token-count.ts`). Tier 1 (main path): for each candidate, if it exposes a `raw` capability matching the inbound protocol, forward the count request upstream via `adapter.rawRequest()` + `raw.invoke()` and return the upstream body verbatim — this is the same "same-protocol raw wins" rule the generation pipeline already uses. Tier 2 (per-candidate): existing `provider.tokenCount` capability path, unchanged. Final fallback (no candidate served a count): a new dependency-free estimator that walks the parsed `invocation` text with per-protocol coefficients ported from new-api, replacing `Math.ceil(JSON.stringify(request).length / 64)`.

**Tech Stack:** TypeScript, Bun test runner, existing `ProtocolAdapter` / `RuntimeRawCapability` / `RawTransport` runtime types. No new dependencies.

## Global Constraints

- No new dependencies. The estimator is hand-written (AI SDK has no native token count — verified: `LanguageModelV4` at `@ai-sdk/provider/dist/index.d.ts:2668` exposes only `doGenerate`/`doStream`).
- Main path covers `api`-kind + `protocol: anthropic` providers ONLY. Cross-protocol (e.g. `openai-response` upstream) has no count endpoint and MUST fall through; `ai-sdk` providers are out of scope for the main path and fall through to the estimator.
- New non-test implementation files ≤300 lines. `token-count.ts` is currently 277 lines and MUST NOT grow materially — the estimator lives in its own file `token-count-estimate.ts`.
- Colocate tests next to source. `packages/server` `test:unit` runs `bun test` (scans all), so a colocated `*.test.ts` runs automatically.
- Changeset MUST target `aio-proxy` (product) alongside `@aio-proxy/server` (internal), summary prefixed `server:`.
- Run `bun run check` and the affected package tests; do NOT run project-wide preflight mid-task.

---

### Task 1: Character-class token estimator (fallback tier)

**Files:**
- Create: `packages/server/src/routes/token-count-estimate.ts`
- Test: `packages/server/src/routes/token-count-estimate.test.ts`

**Interfaces:**
- Consumes: `ModelInvocation` from `@aio-proxy/core` (fields `messages: readonly ModelMessage[]`, `tools?: ToolSet`); `ProtocolId` from `@aio-proxy/plugin-sdk` (`'openai-compatible' | 'openai-response' | 'anthropic' | 'gemini'`).
- Produces: `estimateInputTokens(protocol: ProtocolId, invocation: ModelInvocation): number` — returns an integer ≥ 1.

**Design notes (why, not restated in code):** The old `bytes/64` counted JSON field names, structural punctuation, and base64 image blobs, and used one flat ratio. This estimator walks only real content text from the parsed `invocation` and weights by character class with per-provider coefficients (Claude/OpenAI/Gemini) ported from `.reference/new-api/service/token_estimator.go`. Coefficients are empirical BPE averages; the estimate is inherently approximate because Claude's tokenizer is not public.

- [ ] **Step 1: Write the failing test**

```typescript
import { anthropicMessagesAdapter } from '@aio-proxy/core';
import { expect, test } from 'bun:test';

import { estimateInputTokens } from './token-count-estimate';

// Builds a ModelInvocation the same way the route does, from a parsed request.
async function invocationFrom(body: Record<string, unknown>) {
  const request = new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 16, ...body }),
  });
  const parsed = await anthropicMessagesAdapter.parse(request, {});
  return anthropicMessagesAdapter.modelInvocation(parsed, {});
}

test('estimates at least one token for trivial input', async () => {
  const invocation = await invocationFrom({ messages: [{ role: 'user', content: 'hi' }] });
  expect(estimateInputTokens('anthropic', invocation)).toBeGreaterThanOrEqual(1);
});

test('CJK text estimates denser than the same character count of latin text', async () => {
  const cjk = await invocationFrom({ messages: [{ role: 'user', content: '你好世界一二三四五六七八' }] });
  const latin = await invocationFrom({ messages: [{ role: 'user', content: 'abcdefghijkl' }] });
  // 12 CJK chars ~ 12 * 1.21 tokens; 12 latin chars ~ 1-2 words. CJK must score higher.
  expect(estimateInputTokens('anthropic', cjk)).toBeGreaterThan(estimateInputTokens('anthropic', latin));
});

test('ignores base64 image parts instead of counting their bytes', async () => {
  const bigBase64 = 'A'.repeat(20_000);
  const withImage = await invocationFrom({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } },
        ],
      },
    ],
  });
  const textOnly = await invocationFrom({ messages: [{ role: 'user', content: 'describe this' }] });
  // The 20k base64 blob must not dominate the estimate the way bytes/64 (~310 tokens) would.
  expect(estimateInputTokens('anthropic', withImage)).toBeLessThan(50);
  expect(estimateInputTokens('anthropic', withImage)).toBe(estimateInputTokens('anthropic', textOnly));
});

test('counts tool schemas because they are sent to the model verbatim', async () => {
  const withTools = await invocationFrom({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search', description: 'search the web', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  });
  const noTools = await invocationFrom({ messages: [{ role: 'user', content: 'hi' }] });
  expect(estimateInputTokens('anthropic', withTools)).toBeGreaterThan(estimateInputTokens('anthropic', noTools));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test packages/server/src/routes/token-count-estimate.test.ts`
Expected: FAIL — `estimateInputTokens` not defined / module missing.

- [ ] **Step 3: Write the estimator**

```typescript
import type { ModelInvocation } from '@aio-proxy/core';
import type { ProtocolId } from '@aio-proxy/plugin-sdk';

// Per-provider character-class weights (tokens contributed by each class),
// ported from new-api's empirical BPE averages
// (.reference/new-api/service/token_estimator.go). The count endpoint's real
// tokenizer is not public, so this fallback only aims to beat a flat bytes/N
// ratio; it is intentionally approximate.
type Weights = {
  readonly word: number; // per latin word
  readonly number: number; // per contiguous digit run
  readonly cjk: number; // per CJK char
  readonly symbol: number; // per ordinary punctuation char
  readonly newline: number; // per \n or \t
  readonly space: number; // per space
};

const WEIGHTS: Record<'claude' | 'openai' | 'gemini', Weights> = {
  claude: { word: 1.13, number: 1.63, cjk: 1.21, symbol: 0.4, newline: 0.89, space: 0.39 },
  openai: { word: 1.02, number: 1.55, cjk: 0.85, symbol: 0.4, newline: 0.5, space: 0.42 },
  gemini: { word: 1.15, number: 2.8, cjk: 0.68, symbol: 0.38, newline: 1.15, space: 0.2 },
};

function weightsFor(protocol: ProtocolId): Weights {
  if (protocol === 'anthropic') return WEIGHTS.claude;
  if (protocol === 'gemini') return WEIGHTS.gemini;
  return WEIGHTS.openai;
}

// CJK ideographs, Hiragana/Katakana, Hangul.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

// Character-class state machine: latin/number runs collapse into one token each,
// CJK/space/newline/symbol score per character. Mirrors token_estimator.go's loop.
function estimateText(text: string, w: Weights): number {
  let count = 0;
  let run: 'none' | 'latin' | 'number' = 'none';
  for (const ch of text) {
    if (ch === '\n' || ch === '\t') {
      run = 'none';
      count += w.newline;
      continue;
    }
    if (ch === ' ' || /\s/u.test(ch)) {
      run = 'none';
      count += w.space;
      continue;
    }
    if (CJK.test(ch)) {
      run = 'none';
      count += w.cjk;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const next = /\p{N}/u.test(ch) ? 'number' : 'latin';
      if (run === 'none' || run !== next) {
        count += next === 'number' ? w.number : w.word;
        run = next;
      }
      continue;
    }
    run = 'none';
    count += w.symbol;
  }
  return count;
}

// Pull user-visible text from a message, ignoring binary parts (base64
// images/files) whose serialized size would inflate a byte count.
function messageText(content: ModelInvocation['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool-result') text += JSON.stringify(part.output);
  }
  return text;
}

export function estimateInputTokens(protocol: ProtocolId, invocation: ModelInvocation): number {
  const w = weightsFor(protocol);
  let total = 0;
  for (const message of invocation.messages) total += estimateText(messageText(message.content), w);
  // Tool schemas are serialized into the model prompt verbatim, so they count.
  if (invocation.tools !== undefined) total += estimateText(JSON.stringify(invocation.tools), w);
  return Math.max(1, Math.ceil(total));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk bun test packages/server/src/routes/token-count-estimate.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Verify the `tool-result` / `text` part discriminants compile**

Run: `rtk bun run check`
Expected: no type errors in `token-count-estimate.ts`. If `part.type` narrowing fails (AI SDK `ModelMessage` content union), adjust the guards to the actual `TextPart`/`ToolResultPart` shapes from `ai` (`TextPart` = `{ type: 'text'; text: string }`, `ToolResultPart` = `{ type: 'tool-result'; output: unknown }`) — do not add a dependency.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/token-count-estimate.ts packages/server/src/routes/token-count-estimate.test.ts
git commit -m "server: add character-class token-count estimator"
```

---

### Task 2: Wire the estimator into the fallback

**Files:**
- Modify: `packages/server/src/routes/token-count.ts` (import + fallback at line ~248; `countCandidates` receives `invocation` and `adapter` already)

**Interfaces:**
- Consumes: `estimateInputTokens` from Task 1.
- Produces: no signature change to `handleTokenCount`; the fallback now returns a weighted estimate.

**Current fallback (verbatim, `token-count.ts:247-251`):**
```typescript
  throwIfCountAborted(session, rawRequest.signal);
  const estimate = Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
  const response = Response.json(format(estimate), { headers: { 'x-aio-proxy-token-count-estimated': 'true' } });
  session.finish({ outcome: 'success', finalHttpStatus: 200 });
  return response;
```
`invocation` (a `ModelInvocation`) and `adapter` (with `adapter.protocol`) are already destructured params of `countCandidates`. `request` is only used by this line.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/routes/token-count.test.ts` (uses existing `countFixture` / `provider` helpers from `token-count.test-support.ts`; a provider built with no `tokenCount` forces the fallback):

```typescript
test('fallback returns a character-class estimate, not bytes/64', async () => {
  const fixture = countFixture([provider({ id: 'no-count' })]); // provider() with no tokenCount => fallback
  const cjkBody = { model: requestedModel, max_tokens: 16, messages: [{ role: 'user', content: '你好世界一二三四五六七八' }] };
  const response = await fixture.anthropic(
    new Request('https://proxy.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cjkBody),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  const json = (await response.json()) as { input_tokens: number };
  // 12 CJK chars * 1.21 ~ 15 tokens. bytes/64 of this JSON would be ~2. Guard the density.
  expect(json.input_tokens).toBeGreaterThanOrEqual(10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test packages/server/src/routes/token-count.test.ts -t "character-class estimate"`
Expected: FAIL — old fallback yields a tiny bytes/64 value (< 10).

- [ ] **Step 3: Replace the fallback**

In `token-count.ts`, add the import after the existing `./token-count-estimate`-adjacent imports:
```typescript
import { estimateInputTokens } from './token-count-estimate';
```
Replace the fallback line:
```typescript
  const estimate = estimateInputTokens(adapter.protocol, invocation);
```
Then remove the now-unused `request` param from `countCandidates` (`CountCandidatesOptions.request` field, the destructure, and the `request,` argument at the call site) — `request` is otherwise unused in `countCandidates`. `adapter.protocol` is `ProviderProtocol`, which is assignable to `ProtocolId`; if TS complains, pass `adapter.protocol as ProtocolId` (both enums share the same string members).

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun test packages/server/src/routes/token-count.test.ts`
Expected: PASS (new test + existing suite).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/token-count.ts packages/server/src/routes/token-count.test.ts
git commit -m "server: use weighted estimator for count_tokens fallback"
```

---

### Task 3: Main path — same-protocol raw forward to upstream

**Files:**
- Modify: `packages/server/src/routes/token-count.ts` (add a raw-forward branch at the top of the per-candidate loop in `countCandidates`, before the `provider.tokenCount` check)
- Test: `packages/server/src/routes/token-count.test.ts`

**Interfaces:**
- Consumes: `RuntimeProviderInstance.raw?: RuntimeRawCapability` (`raw.resolve({ protocol, modelId }) => RawTransport | undefined`); `adapter.rawRequest(raw, request, resolvedModel, context) => Promise<Request>`; `RawTransport.invoke(request, context?, options?) => Promise<Response>`.
- Produces: when a candidate's `raw.resolve({ protocol: adapter.protocol, modelId: candidate.modelId })` returns a transport, forward the rewritten count request upstream and return the upstream `Response` verbatim (Anthropic count_tokens already returns `{ input_tokens }`).

**Design notes:** This mirrors `attemptRawCandidate` (`pipeline/attempt/raw.ts:25-28`). `api.ts`'s `raw.resolve` returns `undefined` when `protocol !== provider.protocol`, so only an `api`+`anthropic` provider matches an inbound anthropic count request; `super-relay` (openai-response) and `neeko` (ai-sdk, no `raw`) return `undefined` and fall through to `tokenCount`/estimator. `adapter.rawRequest` rewrites the request body's model field from the client alias to `candidate.modelId` (the wire model) and copies the pathname, so the upstream receives `POST {baseURL}/v1/messages/count_tokens` with the correct model. The count route must NOT capture usage (the `countFixture` usageCapture throws), so return the upstream response directly without `usageCapture.passthrough`.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/routes/token-count.test.ts`. Build an `api`+`anthropic` provider whose `raw.resolve` returns a transport that asserts the upstream URL/model and returns a canned count:

```typescript
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import type { RuntimeProviderInstance } from '../runtime';

function rawAnthropicProvider(id: string, seen: { url?: string; model?: string }): RuntimeProviderInstance {
  return {
    id,
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [requestedModel]: { model: `${id}-wire`, preserve: false } },
    raw: {
      resolve: ({ protocol, modelId }) =>
        protocol === ProviderProtocol.Anthropic
          ? {
              invoke: async (request: Request) => {
                seen.url = request.url;
                seen.model = ((await request.clone().json()) as { model: string }).model;
                void modelId;
                return Response.json({ input_tokens: 4242 });
              },
            }
          : undefined,
    },
  };
}

test('forwards count_tokens upstream when a same-protocol raw provider is available', async () => {
  const seen: { url?: string; model?: string } = {};
  const fixture = countFixture([rawAnthropicProvider('relay', seen)]);
  const response = await fixture.anthropic();

  expect(response.status).toBe(200);
  // Upstream value is returned verbatim; the estimate header must be absent.
  expect(await response.json()).toEqual({ input_tokens: 4242 });
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBeNull();
  // rawRequest rewrote the client alias to the wire model and kept the count path.
  expect(seen.model).toBe('relay-wire');
  expect(seen.url).toContain('/v1/messages/count_tokens');
});

test('falls through to estimator when raw provider protocol does not match inbound', async () => {
  const seen: { url?: string; model?: string } = {};
  const openaiRaw: RuntimeProviderInstance = {
    ...rawAnthropicProvider('openai', seen),
    raw: { resolve: ({ protocol }) => (protocol === ProviderProtocol.OpenAIResponse ? { invoke: async () => Response.json({}) } : undefined) },
  };
  const fixture = countFixture([openaiRaw]);
  const response = await fixture.anthropic();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  expect(seen.url).toBeUndefined(); // upstream never called
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test packages/server/src/routes/token-count.test.ts -t "forwards count_tokens upstream"`
Expected: FAIL — currently the raw provider has no `tokenCount`, so it falls to the estimator (returns `x-aio-proxy-token-count-estimated: true`, not `{ input_tokens: 4242 }`).

- [ ] **Step 3: Add the raw-forward branch**

In `countCandidates`, at the very top of the `for (const [attemptIndex, candidate] of candidates.entries())` loop body, before `const count = provider.tokenCount;`, insert:

```typescript
    const raw = candidate.provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
    if (raw !== undefined) {
      throwIfCountAborted(session, rawRequest.signal);
      const attempt: CountAttempt = {
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
        providerKind: candidate.provider.kind,
      };
      const attemptSpan = startAttemptSpan(session, attempt, attemptIndex);
      try {
        const upstream = await adapter.rawRequest(rawRequest.clone(), request, candidate.modelId, context);
        const response = await raw.invoke(upstream, context, { upstreamStream: false });
        if (!(response instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
        rawRequest.signal.throwIfAborted();
        attemptSpan.span.setAttribute(attributeName.httpStatusCode, response.status);
        if (response.status >= 200 && response.status < 400) {
          attemptSpan.end();
          session.finish({
            outcome: 'success',
            finalProviderId: candidate.provider.id,
            finalModelId: candidate.modelId,
            finalHttpStatus: response.status,
          });
          return response;
        }
        attemptSpan.end(failureTerminal(response.status));
        continue;
      } catch (error) {
        if ((rawRequest.signal.aborted && error === rawRequest.signal.reason) || isInboundAbort(error, rawRequest.signal)) {
          attemptSpan.end({ outcome: 'cancelled' });
          session.finish({ outcome: 'cancelled', finalProviderId: candidate.provider.id, finalModelId: candidate.modelId });
          throw rawRequest.signal.reason;
        }
        if (rawRequest.signal.aborted) {
          attemptSpan.end({ outcome: 'failure' });
          throw error;
        }
        const mapped = adapter.errors.provider(error);
        attemptSpan.end(failureTerminal(mapped?.status));
        if (mapped === undefined) throw error;
        continue;
      }
    }
```

Note: `countCandidates` must keep the `request` param for this task (Task 2 removed it — re-add it to `CountCandidatesOptions`, the destructure, and the call site, since `adapter.rawRequest` needs the parsed `request`). This is the one field Task 2 dropped; restoring it here is correct because the main path consumes it. `attributeName` is already imported; `failureTerminal` is already imported; `isInboundAbort` is already imported; `startAttemptSpan` and `CountAttempt` already exist in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun test packages/server/src/routes/token-count.test.ts`
Expected: PASS (both new tests + Task 2 test + existing suite). The `tokenCount`-capability tests still pass because a provider without `raw` skips the new branch.

- [ ] **Step 5: Verify no regression across server route tests**

Run: `rtk bun test packages/server/src/routes/token-count.test.ts packages/server/src/routes/token-count.lifecycle.test.ts packages/server/src/routes/token-count.body.test.ts packages/server/src/routes/token-count-target-materialization.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/token-count.ts packages/server/src/routes/token-count.test.ts
git commit -m "server: forward count_tokens to same-protocol raw upstream"
```

---

### Task 4: Manual smoke test against the live config

**Files:** none (verification only)

The user's config has `super-relay` (api+openai-response) and `neeko` (ai-sdk) serving `claude-opus-4-8` — neither matches the main path, so both use the estimator. To exercise the main path end to end, temporarily enable `cpa` (`api`, but currently `openai-response`) OR add a throwaway `api`+`anthropic` provider pointing at neeko's Anthropic-compatible baseURL.

- [ ] **Step 1: Add a temporary api+anthropic provider**

In `~/.aio-proxy/config.jsonc`, add (do not commit this):
```jsonc
"neeko-count": {
  "kind": "api",
  "name": "Neeko Count",
  "enabled": true,
  "weight": 100,
  "models": ["es1_orange_o48"],
  "alias": { "claude-opus-4-8": { "model": "es1_orange_o48", "preserve": false } },
  "protocol": "anthropic",
  "baseURL": "https://aidp.byteintl.net/api/modelhub/online/anthropic/v1",
  "apiKey": "VNyBvpwW0KytMOwfXUgpWIBiWzAI7aRH_GPT_AK"
}
```

- [ ] **Step 2: Start the proxy and issue a count request**

```bash
curl -s -X POST http://localhost:9317/v1/messages/count_tokens?beta=true \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"count these tokens please"}]}' -i
```
Expected: HTTP 200, body `{"input_tokens": N}` with a realistic N, and NO `x-aio-proxy-token-count-estimated` header (proves the upstream path fired). Disable a provider or point at a non-anthropic baseURL and confirm the header appears (estimator path).

- [ ] **Step 3: Remove the temporary provider**

Delete the `neeko-count` block from `~/.aio-proxy/config.jsonc`.

---

### Task 5: Changeset

**Files:**
- Create: `.changeset/count-tokens-upstream-and-estimate.md`

- [ ] **Step 1: Author the changeset**

```markdown
---
"aio-proxy": minor
"@aio-proxy/server": minor
---

server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/count-tokens-upstream-and-estimate.md
git commit -m "server: changeset for count_tokens upstream + estimator"
```

---

## Self-Review

**Spec coverage:**
- Main path (upstream, api+anthropic only) → Task 3. ✔
- Fallback estimator replacing bytes/64 → Tasks 1+2. ✔
- No new dependency → estimator hand-written (Task 1). ✔
- No trace/protocol changes → out of scope, not touched. ✔

**Type consistency:** `estimateInputTokens(protocol: ProtocolId, invocation: ModelInvocation)` defined in Task 1, consumed identically in Task 2. `adapter.rawRequest` / `raw.resolve` / `raw.invoke` signatures match `adapter.ts:49` and `runtime.ts:18-31`. `request` param removed in Task 2 Step 3 and re-added in Task 3 Step 3 — flagged explicitly in both tasks.

**Placeholder scan:** No TBD/TODO; all code blocks are complete.

**Known risk:** Task 2 removes `request` then Task 3 restores it. If executing both in one pass, skip the removal in Task 2 Step 3 (leave `request` in place) — it becomes used again in Task 3. The removal is only correct if Task 3 is not done; since both are planned, keeping `request` throughout is simpler. Executor: keep `request`.
