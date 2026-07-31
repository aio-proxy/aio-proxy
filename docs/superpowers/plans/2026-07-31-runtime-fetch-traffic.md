# Runtime Fetch Traffic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OAuth runtime's sibling `fetch`/`modelFetch` fields with one standard-fetch-compatible `context.fetch` whose namespaced request option routes explicit control traffic while defaulting ordinary calls to the model pipeline.

**Architecture:** `@aio-proxy/plugin-sdk` defines `RuntimeFetch`, a standard fetch supertype accepting `aioProxy.traffic`. The server composes its existing control and transformed/observed model fetches behind one `createRuntimeFetch` classifier. OAuth helpers mark token refresh and auxiliary repair requests as `control`; model transports call the same fetch without annotation and therefore use the model path.

**Tech Stack:** Bun 1.3.x, TypeScript 6, Bun Test, `@aio-proxy/plugin-sdk`, AI SDK v7, server AsyncLocalStorage request-attempt context.

## Global Constraints

- `context.fetch(input, init)` defaults to `aioProxy.traffic = 'model'`.
- `aioProxy: { traffic: 'control' }` bypasses provider request transforms and model-request observation.
- The host removes `aioProxy` before invoking either downstream fetch and never mutates the caller's init object.
- Runtime values other than `model`, `control`, or `undefined` throw `TypeError` before network dispatch.
- `RuntimeContext.fetch` is required; `RuntimeContext.modelFetch` is removed.
- Plugin descriptors generate and accept only `apiVersion: 1`; no compatibility path for version 2 is required.
- Login/catalog/quota callbacks do not receive `RuntimeContext.fetch` and keep their existing external dependency behavior.
- All repository shell commands use `rtk`.
- Production changes follow RED/GREEN TDD; observe the specified failure before implementation.
- Every commit includes `Co-authored-by: Codex <noreply@openai.com>`.
- Do not reply to or resolve GitHub review threads without explicit user authorization.

---

## File Structure

### Plugin SDK

- `packages/plugin-sdk/src/oauth.ts`: owns `RuntimeFetchTraffic`, `RuntimeRequestInit`, `RuntimeFetch`, and the final single-fetch `RuntimeContext` contract.
- `packages/plugin-sdk/src/oauth.types.ts`: compile-time contract tests for standard-fetch assignability and the namespaced request option.
- `packages/plugin-sdk/src/plugin/plugin.ts`: emits and validates plugin descriptor API version 1.
- `packages/plugin-sdk/src/plugin/plugin.test.ts`: unit coverage for descriptor version 1.

### Server

- `packages/server/src/plugin-runtime/runtime-fetch/index.ts`: export-only entry point.
- `packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.ts`: traffic classifier and metadata stripping.
- `packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.test.ts`: isolated classifier behavior.
- `packages/server/src/plugin-runtime/index.ts`: exports `createRuntimeFetch`.
- `packages/server/src/plugin-runtime/types.ts`: removes `runtimeModelFetch` after cutover.
- `packages/server/src/plugin-runtime/materialize.ts`: always supplies one runtime fetch to `createRuntime`.
- `packages/server/src/plugin-runtime/host-fetch-context.test.ts`: integration coverage for model/control behavior through one captured fetch.
- `packages/server/src/server-state/snapshot.ts`: composes provider-specific model and control fetches.

### Built-in OAuth plugins

- GitHub Copilot: `packages/plugins/github-copilot/src/github-api/{credential,http}.ts`, `packages/plugins/github-copilot/src/runtime/runtime.ts`, and their colocated tests.
- Kimi Code: `packages/plugins/kimi-code/src/oauth.ts`, `packages/plugins/kimi-code/src/oauth/credential.ts`, `packages/plugins/kimi-code/src/runtime/runtime.ts`, and their tests.
- OpenAI ChatGPT: `packages/plugins/openai-chatgpt/src/oauth-flow.ts`, `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`, and their tests.
- xAI Grok: `packages/plugins/xai-grok/src/oauth.ts`, `packages/plugins/xai-grok/src/oauth/http.ts`, `packages/plugins/xai-grok/src/runtime/runtime.ts`, and their tests.
- Google Antigravity: `packages/plugins/google-antigravity/src/oauth/{flow,refresh}.ts`, `packages/plugins/google-antigravity/src/protocol/grounding-urls.ts`, `packages/plugins/google-antigravity/src/runtime/provider.ts`, and their tests.

---

### Task 1: Define the Runtime Fetch Type Contract

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.types.ts`
- Modify: `packages/plugin-sdk/src/oauth.ts`

**Interfaces:**
- Produces: `RuntimeFetchTraffic = 'model' | 'control'`.
- Produces: `RuntimeRequestInit = RequestInit & { readonly aioProxy?: { readonly traffic?: RuntimeFetchTraffic } }`.
- Produces: `RuntimeFetch`, assignable to `typeof globalThis.fetch` and directly callable with `RuntimeRequestInit`.
- Does not yet remove the old `RuntimeContext` fields; the atomic cutover happens in Task 9.

- [ ] **Step 1: Write failing compile-time contract tests**

Extend `packages/plugin-sdk/src/oauth.types.ts` imports and add:

```ts
import type {
  OAuthAdapter,
  OAuthQuotaItem,
  PluginApi,
  RuntimeFetch,
  RuntimeRequestInit,
} from '.';

declare const runtimeFetch: RuntimeFetch;

const standardFetch: typeof globalThis.fetch = runtimeFetch;
const runtimeFetchFromStandard: RuntimeFetch = globalThis.fetch;
const controlInit: RuntimeRequestInit = { aioProxy: { traffic: 'control' } };
void standardFetch;
void runtimeFetchFromStandard;
void runtimeFetch('https://provider.example/model');
void runtimeFetch('https://provider.example/token', controlInit);
void runtimeFetch('https://provider.example/model', { aioProxy: { traffic: 'model' } });

// @ts-expect-error runtime traffic is a closed union
void runtimeFetch('https://provider.example/model', { aioProxy: { traffic: 'background' } });
```

- [ ] **Step 2: Run the type test and observe RED**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: FAIL because `RuntimeFetch` and `RuntimeRequestInit` are not exported.

- [ ] **Step 3: Add the minimal public types**

Add above `RuntimeContext` in `packages/plugin-sdk/src/oauth.ts`:

```ts
export type RuntimeFetchTraffic = 'model' | 'control';

export type RuntimeRequestInit = RequestInit & {
  readonly aioProxy?: {
    readonly traffic?: RuntimeFetchTraffic;
  };
};

export type RuntimeFetch = typeof globalThis.fetch & {
  (input: RequestInfo | URL, init?: RuntimeRequestInit): Promise<Response>;
};
```

If Bun's declaration shape rejects the intersection, use an equivalent callable type that remains assignable to `typeof globalThis.fetch`; do not add helper methods or a second fetch field.

- [ ] **Step 4: Run the SDK contract tests and observe GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun run --filter @aio-proxy/plugin-sdk test:unit
```

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugin-sdk/src/oauth.ts packages/plugin-sdk/src/oauth.types.ts
rtk git commit -m "feat(plugin-sdk): define runtime fetch traffic" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Restore the Single Plugin API Version

**Files:**
- Modify: `packages/plugin-sdk/src/plugin/plugin.test.ts`
- Modify: `packages/core/src/plugins/loader/descriptor/descriptor.test.ts`
- Modify: `packages/core/src/plugins/loader/logger.test.ts`
- Modify: `packages/plugins/openai-chatgpt/__tests__/adapter.test.ts`
- Modify: `packages/plugins/xai-grok/oauth.smoke.ts`
- Modify: `packages/plugin-sdk/src/plugin/plugin.ts`

**Interfaces:**
- Produces: `PLUGIN_API_VERSION = 1`.
- Produces: `PLUGIN_API_VERSIONS_SUPPORTED = [1]`.
- Rejects: numeric descriptor API version 2 and every other unsupported value.

- [ ] **Step 1: Change descriptor tests to require version 1 only**

In `packages/plugin-sdk/src/plugin/plugin.test.ts`:

```ts
test('brands an apiVersion 1 descriptor', () => {
  const descriptor = definePlugin(() => {});
  expect(descriptor.apiVersion).toBe(1);
  expect(descriptor[PLUGIN_DESCRIPTOR_BRAND]).toBe(true);
  expect(isPluginDescriptor(descriptor)).toBe(true);
});

test('rejects branded apiVersion 2 descriptors', () => {
  expect(
    isPluginDescriptor({
      [PLUGIN_DESCRIPTOR_BRAND]: true,
      apiVersion: 2,
      metadata: {},
      setup() {},
    }),
  ).toBe(false);
});
```

Update the unbranded lookalike test to use `apiVersion: 1` and remove the old “version 1 compatibility” wording.

In `packages/core/src/plugins/loader/descriptor/descriptor.test.ts`, keep a positive version-1 test and replace the positive version-2 case with:

```ts
test('apiVersion 2 fails with incompatibility', () => {
  const descriptor = { ...definePlugin(() => {}), apiVersion: 2 };
  expect(() => validateDescriptor(descriptor)).toThrow(
    expect.objectContaining({ code: 'PLUGIN_API_INCOMPATIBLE' }),
  );
});
```

In `packages/core/src/plugins/loader/logger.test.ts`, narrow `CompatibleTestDescriptor['apiVersion']` to `1` and replace both `[1, 2]` loops with `[1]`. Update the test names so they no longer claim multi-version coverage.

Update the built-in plugin assertions:

```ts
expect(openAIChatGPTPlugin.apiVersion).toBe(1);
expect(plugin.apiVersion).toBe(1);
```

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
rtk bun test packages/plugin-sdk/src/plugin/plugin.test.ts packages/core/src/plugins/loader/descriptor/descriptor.test.ts packages/core/src/plugins/loader/logger.test.ts packages/plugins/openai-chatgpt/__tests__/adapter.test.ts packages/plugins/xai-grok/oauth.smoke.ts
```

Expected: FAIL because `definePlugin` still emits version 2 and validation still accepts it.

- [ ] **Step 3: Collapse the constants and validator to version 1**

In `packages/plugin-sdk/src/plugin/plugin.ts`:

```ts
export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_API_VERSIONS_SUPPORTED = [1] as const;
```

Change the `isPluginDescriptor` condition from `(apiVersion === 1 || apiVersion === 2)` to `apiVersion === 1`.

- [ ] **Step 4: Run focused and loader tests and observe GREEN**

Run:

```bash
rtk bun test packages/plugin-sdk/src/plugin/plugin.test.ts packages/core/src/plugins/loader/descriptor/descriptor.test.ts packages/core/src/plugins/loader/logger.test.ts packages/plugins/openai-chatgpt/__tests__/adapter.test.ts packages/plugins/xai-grok/oauth.smoke.ts
rtk bun run --filter @aio-proxy/plugin-sdk test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugin-sdk/src/plugin/plugin.ts packages/plugin-sdk/src/plugin/plugin.test.ts packages/core/src/plugins/loader/descriptor/descriptor.test.ts packages/core/src/plugins/loader/logger.test.ts packages/plugins/openai-chatgpt/__tests__/adapter.test.ts packages/plugins/xai-grok/oauth.smoke.ts
rtk git commit -m "fix(plugin-sdk): restore plugin api version one" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Add the Server Runtime Fetch Classifier

**Files:**
- Create: `packages/server/src/plugin-runtime/runtime-fetch/index.ts`
- Create: `packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.ts`
- Create: `packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.test.ts`
- Modify: `packages/server/src/plugin-runtime/index.ts`

**Interfaces:**
- Consumes: `RuntimeFetch` and `RuntimeRequestInit` from Task 1.
- Produces: `createRuntimeFetch(input: { readonly control: typeof globalThis.fetch; readonly model: typeof globalThis.fetch }): RuntimeFetch`.

An omitted, `undefined`, or `null` runtime traffic value defaults to `model`. Values other than `model`, `control`, `undefined`, and `null` throw `TypeError` before dispatch.

- [ ] **Step 1: Write classifier tests**

Create `runtime-fetch.test.ts` with behavior-level tests equivalent to:

```ts
import { expect, test } from 'bun:test';
import type { RuntimeRequestInit } from '@aio-proxy/plugin-sdk';
import { createRuntimeFetch } from '.';

test('defaults to model traffic and routes explicit control traffic', async () => {
  const model: Array<RequestInit | undefined> = [];
  const control: Array<RequestInit | undefined> = [];
  const fetch = createRuntimeFetch({
    model: (async (_input, init) => {
      model.push(init);
      return new Response('model');
    }) as typeof globalThis.fetch,
    control: (async (_input, init) => {
      control.push(init);
      return new Response('control');
    }) as typeof globalThis.fetch,
  });

  await fetch('https://example.test/default');
  await fetch('https://example.test/model', { aioProxy: { traffic: 'model' } });
  const init = {
    method: 'POST',
    aioProxy: { traffic: 'control' },
    decompress: false,
  } as RuntimeRequestInit & { readonly decompress: boolean };
  await fetch('https://example.test/control', init);

  expect(model).toHaveLength(2);
  expect(control).toHaveLength(1);
  expect(control[0]).toMatchObject({ method: 'POST', decompress: false });
  expect(Reflect.has(control[0] as object, 'aioProxy')).toBe(false);
  expect(init.aioProxy).toEqual({ traffic: 'control' });
});

test('defaults explicit null runtime traffic to model', async () => {
  let modelCalls = 0;
  let controlCalls = 0;
  const fetch = createRuntimeFetch({
    model: (async () => {
      modelCalls++;
      return new Response('model');
    }) as typeof globalThis.fetch,
    control: (async () => {
      controlCalls++;
      return new Response('control');
    }) as typeof globalThis.fetch,
  });

  await fetch('https://example.test/null', {
    aioProxy: { traffic: null },
  } as unknown as RuntimeRequestInit);

  expect(modelCalls).toBe(1);
  expect(controlCalls).toBe(0);
});

test('rejects invalid runtime traffic before dispatch', async () => {
  let calls = 0;
  const downstream = (async () => {
    calls++;
    return new Response();
  }) as typeof globalThis.fetch;
  const fetch = createRuntimeFetch({ control: downstream, model: downstream });

  await expect(
    fetch('https://example.test', {
      aioProxy: { traffic: 'invalid' },
    } as unknown as RuntimeRequestInit),
  ).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run the new test and observe RED**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts ./packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.test.ts
```

Expected: FAIL because the module and `createRuntimeFetch` do not exist.

- [ ] **Step 3: Implement the minimal classifier**

Create `runtime-fetch.ts` with this control flow:

```ts
import type { RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export type RuntimeFetchInput = {
  readonly control: typeof globalThis.fetch;
  readonly model: typeof globalThis.fetch;
};

export function createRuntimeFetch(input: RuntimeFetchInput): RuntimeFetch {
  const fetch = async (request: RequestInfo | URL, init?: RuntimeRequestInit): Promise<Response> => {
    const traffic = init?.aioProxy?.traffic ?? 'model';
    if (traffic !== 'model' && traffic !== 'control') throw new TypeError('Invalid aio-proxy fetch traffic');
    const forwarded = stripAioProxy(init);
    return await (traffic === 'control' ? input.control : input.model)(request, forwarded);
  };
  return Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }) as RuntimeFetch;
}

function stripAioProxy(init: RuntimeRequestInit | undefined): RequestInit | undefined {
  if (init === undefined) return undefined;
  const { aioProxy: _aioProxy, ...forwarded } = init;
  return forwarded;
}
```

If the repository's Bun typings require a narrow local type to retain `decompress`, use a local intersection/cast; do not enumerate and rebuild individual RequestInit fields.

Create export-only `runtime-fetch/index.ts` and export `createRuntimeFetch` from `plugin-runtime/index.ts`.

- [ ] **Step 4: Run focused and plugin-runtime tests and observe GREEN**

Run:

```bash
rtk bun test --preload=./packages/server/__tests__/setup.ts ./packages/server/src/plugin-runtime/runtime-fetch/runtime-fetch.test.ts
rtk bun test --preload=./packages/server/__tests__/setup.ts ./packages/server/src/plugin-runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/plugin-runtime/index.ts packages/server/src/plugin-runtime/runtime-fetch
rtk git commit -m "feat(server): classify plugin runtime fetch traffic" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Mark GitHub Copilot Credential Traffic as Control

**Files:**
- Modify: `packages/plugins/github-copilot/src/github-api/credential.test.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/credential.ts`
- Modify: `packages/plugins/github-copilot/src/github-api/http.ts`

**Interfaces:**
- Consumes: `RuntimeFetch` and `RuntimeRequestInit`.
- Produces: every Copilot token request carries `aioProxy.traffic = 'control'`.

- [ ] **Step 1: Add a failing control-traffic assertion**

In the existing `fetchCopilotToken` test, capture the init and assert:

```ts
expect((capturedInit as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
```

Keep the existing URL, authorization, response parsing, and secret-safety assertions.

- [ ] **Step 2: Run the credential test and observe RED**

Run:

```bash
rtk bun test --preload=./packages/plugins/github-copilot/test/setup.ts ./packages/plugins/github-copilot/src/github-api/credential.test.ts
```

Expected: FAIL because the token request has no `aioProxy` metadata.

- [ ] **Step 3: Annotate the token request**

Change the relevant fetch types in `credential.ts` and `http.ts` to `RuntimeFetch`/`RuntimeRequestInit`, then add:

```ts
const body = await fetchJson(
  `${apiBase}/copilot_internal/v2/token`,
  {
    headers: authHeaders(githubToken),
    signal,
    aioProxy: { traffic: 'control' },
  },
  copilotTokenResponseSchema,
  fetcher,
);
```

Do not annotate final inference calls in `runtime.ts`.

- [ ] **Step 4: Run GitHub Copilot tests and observe GREEN**

Run:

```bash
rtk bun test --preload=./packages/plugins/github-copilot/test/setup.ts ./packages/plugins/github-copilot/src/github-api/credential.test.ts ./packages/plugins/github-copilot/src/runtime/host-fetch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/github-copilot/src/github-api/credential.ts packages/plugins/github-copilot/src/github-api/http.ts packages/plugins/github-copilot/src/github-api/credential.test.ts
rtk git commit -m "fix(github-copilot): mark credential traffic as control" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Mark Kimi Credential Traffic as Control

**Files:**
- Modify: `packages/plugins/kimi-code/src/oauth.test.ts`
- Modify: `packages/plugins/kimi-code/src/oauth.ts`
- Modify: `packages/plugins/kimi-code/src/oauth/credential.ts`

**Interfaces:**
- Consumes: `RuntimeFetch` and `RuntimeRequestInit`.
- Produces: Kimi device-flow and refresh-token HTTP calls carry `aioProxy.traffic = 'control'`.

- [ ] **Step 1: Make OAuth tests assert control metadata**

Change the test `FetchCall.init` type to `RuntimeRequestInit | undefined`. Add an assertion for login calls:

```ts
expect(calls.every(({ init }) => init?.aioProxy?.traffic === 'control')).toBe(true);
```

In the credential refresh test, assert:

```ts
expect(firstCall(calls).init?.aioProxy).toEqual({ traffic: 'control' });
```

- [ ] **Step 2: Run the OAuth test and observe RED**

Run:

```bash
rtk bun test --preload=./packages/plugins/kimi-code/test/setup.ts ./packages/plugins/kimi-code/src/oauth.test.ts
```

Expected: FAIL because login and refresh calls are unannotated.

- [ ] **Step 3: Annotate Kimi OAuth calls**

Change `KimiOAuthDependencies.fetch` and internal OAuth fetcher parameters to `RuntimeFetch`. Add the control option in both `postForm` and `refreshKimiCredential`:

```ts
aioProxy: { traffic: 'control' },
```

Keep model traffic in `runtime.ts` unannotated.

- [ ] **Step 4: Run Kimi OAuth and runtime tests and observe GREEN**

Run:

```bash
rtk bun test --preload=./packages/plugins/kimi-code/test/setup.ts ./packages/plugins/kimi-code/src/oauth.test.ts ./packages/plugins/kimi-code/src/oauth-resilience.test.ts ./packages/plugins/kimi-code/src/runtime/host-fetch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/kimi-code/src/oauth.ts packages/plugins/kimi-code/src/oauth/credential.ts packages/plugins/kimi-code/src/oauth.test.ts
rtk git commit -m "fix(kimi-code): mark oauth traffic as control" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Mark ChatGPT Token Traffic as Control

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/oauth-flow.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/oauth-flow.ts`

**Interfaces:**
- Consumes: `RuntimeFetch` and `RuntimeRequestInit`.
- Produces: authorization-code exchange and refresh-token calls carry `aioProxy.traffic = 'control'`.

- [ ] **Step 1: Add the control assertion to the token fetch mock**

Change `TokenFetch` to `RuntimeFetch`, and in `createTokenFetchMock` assert:

```ts
expect((init as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
```

Also assert the same field in the abort-signal test's inline fetch so both helper paths are covered.

- [ ] **Step 2: Run the OAuth flow tests and observe RED**

Run:

```bash
rtk bun test --preload=./packages/plugins/openai-chatgpt/test/setup.ts ./packages/plugins/openai-chatgpt/src/oauth-flow.test.ts
```

Expected: FAIL because `postTokenRequest` does not mark control traffic.

- [ ] **Step 3: Annotate token requests**

Replace the local callable alias with the SDK's `RuntimeFetch` type and add to `postTokenRequest`:

```ts
aioProxy: { traffic: 'control' },
```

Do not change the token payload or error handling.

- [ ] **Step 4: Run ChatGPT OAuth and runtime tests and observe GREEN**

Run:

```bash
rtk bun test --preload=./packages/plugins/openai-chatgpt/test/setup.ts ./packages/plugins/openai-chatgpt/src/oauth-flow.test.ts ./packages/plugins/openai-chatgpt/src/runtime/host-fetch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/openai-chatgpt/src/oauth-flow.ts packages/plugins/openai-chatgpt/src/oauth-flow.test.ts
rtk git commit -m "fix(openai-chatgpt): mark token traffic as control" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Mark xAI OAuth Traffic as Control

**Files:**
- Modify: `packages/plugins/xai-grok/src/oauth.test-support.ts`
- Modify: `packages/plugins/xai-grok/src/oauth.ts`
- Modify: `packages/plugins/xai-grok/src/oauth/http.ts`

**Interfaces:**
- Consumes: `RuntimeFetch` and `RuntimeRequestInit`.
- Produces: xAI discovery, device authorization, polling, and refresh calls carry `aioProxy.traffic = 'control'`.

- [ ] **Step 1: Make the shared OAuth fetch fixture require control traffic**

Change `sequenceFetch` to return `RuntimeFetch` and assert before constructing the captured Request:

```ts
expect((init as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
```

Import `expect`, `RuntimeFetch`, and `RuntimeRequestInit` in the test-support file.

- [ ] **Step 2: Run xAI OAuth tests and observe RED**

Run:

```bash
rtk bun test ./packages/plugins/xai-grok/src/oauth.test.ts ./packages/plugins/xai-grok/src/oauth.refresh.test.ts ./packages/plugins/xai-grok/src/oauth-review.test.ts
```

Expected: FAIL because `oauth/http.ts` forwards plain RequestInit.

- [ ] **Step 3: Annotate the shared xAI OAuth request function**

Make `XAIGrokFetch` an alias of `RuntimeFetch`. In `oauth/http.ts`, call the fetcher with a copied init:

```ts
return await fetcher(input, {
  ...init,
  aioProxy: { traffic: 'control' },
});
```

Keep abort classification based on the original `init.signal`.

- [ ] **Step 4: Run xAI OAuth and runtime tests and observe GREEN**

Run:

```bash
rtk bun test ./packages/plugins/xai-grok/src/oauth.test.ts ./packages/plugins/xai-grok/src/oauth.refresh.test.ts ./packages/plugins/xai-grok/src/oauth-review.test.ts ./packages/plugins/xai-grok/src/runtime/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/xai-grok/src/oauth.ts packages/plugins/xai-grok/src/oauth/http.ts packages/plugins/xai-grok/src/oauth.test-support.ts
rtk git commit -m "fix(xai-grok): mark oauth traffic as control" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Cover and Correct Google Antigravity Traffic Classification

**Files:**
- Modify: `packages/plugins/google-antigravity/src/runtime/host-fetch.test.ts`
- Modify: `packages/plugins/google-antigravity/src/oauth/refresh.test.ts`
- Modify: `packages/plugins/google-antigravity/src/protocol/grounding-urls.test.ts`
- Modify: `packages/plugins/google-antigravity/src/oauth/flow.ts`
- Modify: `packages/plugins/google-antigravity/src/oauth/refresh.ts`
- Modify: `packages/plugins/google-antigravity/src/protocol/grounding-urls.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/credential.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/provider.ts`

**Interfaces:**
- Consumes: one `RuntimeFetch` for both Antigravity model and control calls.
- Produces: inference/raw/token-count calls default to model; token refresh and grounding redirect resolution explicitly use control.

- [ ] **Step 1: Add the Antigravity regression tests**

Extend `runtime/host-fetch.test.ts` with an expired credential fixture whose `refresh` method executes the supplied exchange. Supply one runtime fetch that records:

```ts
const traffic = (init as RuntimeRequestInit | undefined)?.aioProxy?.traffic ?? 'model';
calls.push({ traffic, request: new Request(input, init) });
```

Return a refreshed token response for `https://oauth2.googleapis.com/token` and a CCA response for the inference endpoint. Assert call order:

```ts
expect(calls.map(({ traffic }) => traffic)).toEqual(['control', 'model']);
```

In `oauth/refresh.test.ts`, assert token refresh carries `control`. In `protocol/grounding-urls.test.ts`, assert the HEAD redirect lookup carries `control`.

- [ ] **Step 2: Run focused Antigravity tests and observe RED**

Run:

```bash
rtk bun test --preload=./packages/plugins/google-antigravity/test/setup.ts ./packages/plugins/google-antigravity/src/runtime/host-fetch.test.ts ./packages/plugins/google-antigravity/src/oauth/refresh.test.ts ./packages/plugins/google-antigravity/src/protocol/grounding-urls.test.ts
```

Expected: FAIL because refresh and grounding calls are currently unannotated.

- [ ] **Step 3: Mark Antigravity control calls**

Use `RuntimeFetch` in `GoogleAntigravityRuntimeDependencies`, `OAuthHttpOptions`, credential dependencies, transport dependencies, and grounding dependencies. Add:

```ts
aioProxy: { traffic: 'control' },
```

to token endpoint requests in `flow.ts` and `refresh.ts`, and to the HEAD request in `resolveGroundingUrl`.

Keep `AntigravityTransport` requests unannotated. Keep `provider.ts` on one selected fetch:

```ts
const fetcher = dependencies.fetch ?? context.fetch;
```

The same fetch is passed to credential source, transport, and grounding repair; call-site annotations provide the separation.

- [ ] **Step 4: Run the full Antigravity unit suite and observe GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/plugins/google-antigravity/src/oauth packages/plugins/google-antigravity/src/protocol/grounding-urls.ts packages/plugins/google-antigravity/src/protocol/grounding-urls.test.ts packages/plugins/google-antigravity/src/runtime/credential.ts packages/plugins/google-antigravity/src/runtime/provider.ts packages/plugins/google-antigravity/src/runtime/host-fetch.test.ts
rtk git commit -m "fix(google-antigravity): classify runtime fetch traffic" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Cut Over RuntimeContext and Built-in Runtimes to One Fetch

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.types.ts`
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Modify: `packages/server/src/plugin-runtime/types.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/plugin-runtime/host-fetch-context.test.ts`
- Modify: `packages/server/src/server-state/snapshot.ts`
- Modify: `packages/plugins/github-copilot/src/runtime/{runtime,host-fetch.test}.ts`
- Modify: `packages/plugins/kimi-code/src/runtime/{runtime,host-fetch.test}.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/{runtime,host-fetch.test}.ts`
- Modify: `packages/plugins/xai-grok/src/runtime/runtime.ts`
- Modify: `packages/plugins/xai-grok/src/runtime/runtime.test.ts`
- Modify: `packages/plugins/google-antigravity/src/runtime/provider.ts`

**Interfaces:**
- Consumes: `createRuntimeFetch` from Task 3 and control annotations from Tasks 4–8.
- Produces: final required `RuntimeContext.fetch: RuntimeFetch` with no `modelFetch`.
- Produces: `MaterializePluginProviderOptions.runtimeFetch` as the only runtime fetch option.

- [ ] **Step 1: Write the failing final SDK contract**

Add to `oauth.types.ts`:

```ts
import type { RuntimeContext } from '.';

declare const runtimeContext: RuntimeContext<MyCredential, MyOptions>;
const requiredRuntimeFetch: RuntimeFetch = runtimeContext.fetch;
void requiredRuntimeFetch;

// @ts-expect-error RuntimeContext exposes one fetch only
void runtimeContext.modelFetch;
```

- [ ] **Step 2: Run the type test and observe RED**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
```

Expected: FAIL because `fetch` is optional and `modelFetch` still exists, making the `@ts-expect-error` unused.

- [ ] **Step 3: Apply the public type cutover**

Change `RuntimeContext` to:

```ts
export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
  readonly fetch: RuntimeFetch;
};
```

- [ ] **Step 4: Run the workspace build and record consumer failures**

Run:

```bash
rtk bun run build
```

Expected: FAIL only at server/plugin fixtures that omit the now-required fetch and built-in runtimes/tests that still reference `modelFetch` or optional fallbacks. Treat any unrelated failure as a separate issue before proceeding.

- [ ] **Step 5: Wire one fetch through the server**

In `snapshot.ts`, replace the sibling fetch construction with:

```ts
const controlFetch = globalThis.fetch;
const observedModelFetch = createObservedFetch(controlFetch);

runtimeFetch: createRuntimeFetch({
  control: controlFetch,
  model: createProviderRequestTransformFetch(provider, observedModelFetch),
}),
```

Remove `runtimeModelFetch` from `MaterializePluginProviderOptions`. In `materialize.ts`, always pass:

```ts
fetch: options.runtimeFetch ?? globalThis.fetch,
```

The optional internal fallback may remain for existing server test helpers; the public `RuntimeContext.fetch` is still required.

Rewrite `host-fetch-context.test.ts` to capture one fetch, invoke one explicit control request and one default model request inside the same attempt, and retain these assertions:

```ts
expect(baseFetchBodies).toEqual(['refresh-token-secret', '{"route":"oauth"}']);
expect(baseFetchCalls[1]?.headers.get('x-provider-route')).toBe('oauth');
expect(reconstructed(logs, 'upstream_request')).toBe('{"route":"oauth"}');
expect(JSON.stringify(logs)).not.toContain('refresh-token-secret');
```

- [ ] **Step 6: Simplify every built-in runtime to the single fetch**

Apply these exact shapes:

GitHub Copilot:

```ts
const dynamicFetch = createDynamicFetch(context.credentials, context.fetch);
// currentGitHubCopilotCredential(..., context.fetch) marks its own control call
// fetchWithCredential(..., context.fetch) leaves model traffic unannotated
```

Kimi Code:

```ts
const fetch = dependencies.fetch ?? context.fetch;
const dynamicFetch = createKimiDynamicFetch(context.credentials, { ...dependencies, fetch });
```

Remove `credentialFetch` from `createKimiDynamicFetch`; `currentKimiCredential` and the final upstream call receive the same fetch, with only the refresh helper adding control metadata.

OpenAI ChatGPT:

```ts
const dynamicFetch = createOpenAIChatGPTDynamicFetch(context.credentials, context.fetch);
```

Remove the separate `credentialFetcher` parameter; `refreshAccessToken` marks control.

xAI Grok:

```ts
const fetch = options.fetch ?? context.fetch;
fetch: createXAIGrokDynamicFetch(context.credentials, { ...options, fetch }),
```

Remove the separate `credentialFetch` parameter; `oauth/http.ts` marks control.

Google Antigravity:

```ts
const fetch = dependencies.fetch ?? context.fetch;
```

Pass it directly to credential source, transport, and grounding repair without optional spreads.

Update all host-fetch tests to supply one `fetch`. Their mock routes calls by `init.aioProxy?.traffic ?? 'model'` and asserts credential/control calls separately from final model calls.

- [ ] **Step 7: Run focused SDK, server, and plugin tests and observe GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test
rtk bun test --preload=./packages/server/__tests__/setup.ts ./packages/server/src/plugin-runtime
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
rtk bun run --filter @aio-proxy/plugin-kimi-code test:unit
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
rtk bun run --filter @aio-proxy/plugin-google-antigravity test:unit
rtk bun run build
```

Expected: all commands PASS; `rtk rg -n "context\\.modelFetch|runtimeModelFetch|readonly modelFetch" packages` returns no references to the removed contract.

- [ ] **Step 8: Commit the atomic cutover**

```bash
rtk git add packages/plugin-sdk/src/oauth.ts packages/plugin-sdk/src/oauth.types.ts packages/server/src/plugin-runtime packages/server/src/server-state/snapshot.ts packages/plugins/github-copilot/src/runtime packages/plugins/kimi-code/src/runtime packages/plugins/openai-chatgpt/src/runtime packages/plugins/xai-grok/src/runtime packages/plugins/google-antigravity/src/runtime/provider.ts
rtk git commit -m "refactor: unify plugin runtime fetch traffic" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 10: Final Verification and PR Update

**Files:**
- Verify: all files changed by Tasks 1–9.
- Do not modify GitHub review threads.

**Interfaces:**
- Verifies the design in `docs/superpowers/specs/2026-07-31-runtime-fetch-traffic-design.md` end to end.

- [ ] **Step 1: Confirm no stale dual-fetch or API-v2 references remain**

Run:

```bash
rtk rg -n "context\\.modelFetch|runtimeModelFetch|readonly modelFetch|apiVersion 2|apiVersion: 2|PLUGIN_API_VERSION = 2" packages docs/superpowers/specs/2026-07-31-runtime-fetch-traffic-design.md
```

Expected: only historical explanatory references in the approved design, with no production or test references that preserve the old contract.

- [ ] **Step 2: Run formatting, lint, and type checks**

Run:

```bash
rtk bun run check
```

Expected: exit 0. Existing allowed max-lines warnings may remain, but no new errors or format drift.

- [ ] **Step 3: Run the full repository preflight**

Run:

```bash
rtk env TURBO_CONCURRENCY=1 bun run preflight
```

Expected: all tasks succeed with zero test failures.

- [ ] **Step 4: Inspect the final diff and worktree**

Run:

```bash
rtk git diff origin/main...HEAD --stat
rtk git status --short --branch
```

Expected: only intended PR changes; worktree clean; branch ahead of its remote by the new commits.

- [ ] **Step 5: Push the branch and monitor CI**

Run:

```bash
rtk git push
```

Monitor PR #102 checks until the affected unit suites and API e2e checks complete. Rerun only a clearly unrelated known flaky check. Do not reply to or resolve `discussion_r3689303525` without explicit user authorization.
