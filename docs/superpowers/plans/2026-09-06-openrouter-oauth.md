# OpenRouter OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in OpenRouter OAuth plugin that mints a durable user API key via PKCE, discovers models, invokes them through `createOpenRouter`, and reads a read-only credit remaining ratio.

**Architecture:** `packages/plugins/openrouter` owns PKCE login, catalog, runtime, quota, and the descriptor. Host loopback stays the only callback server. Because OpenRouter never echoes `state`, CLI and Dashboard callback parsers gain one behavior: a matching-origin URL (or a pasted non-URL code) may omit `state` when `code` is present. Core only embeds the descriptor. No plugin-sdk port change.

**Tech Stack:** Bun, TypeScript, `@aio-proxy/plugin-sdk`, `@openrouter/ai-sdk-provider@2.10.0`, Rslib, Bun test, Changesets.

**Spec:** [docs/superpowers/specs/2026-09-06-openrouter-oauth-design.md](../specs/2026-09-06-openrouter-oauth-design.md)

Do not implement until that spec is `已确认，进入实现`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-06-openrouter-oauth-design.md`. Do not invent a paste-key login, CPA importer, refresh, raw capability, native-scheme port, or plugin-sdk API.
- Domain language: **Provider ID**, **Provider priority**, **Provider weight**. Never provider name/key/order/rank.
- `es-toolkit` narrow imports. `isPlainObject` from `es-toolkit/predicate` for JSON/wire payloads. `isRecord` from `@aio-proxy/shared` only for structural class-instance contracts (not needed here).
- Colocate new tests in a same-name directory (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`). Do not add files under `_test/`.
- Handwritten non-test implementation files: hard limit 500 lines; split before adding more at 400.
- `foo/index.ts` is export-only. Private modules inside `foo/` are not imported from outside `foo/`.
- Catalog/auth/key probes use `aioProxy: { traffic: 'control' }`. Inference fetch does not. Discover / runtime / quota fetch is `options.fetch ?? context.fetch ?? globalThis.fetch`.
- New package starts at version `0.19.2` to match the current lockstep set.
- Changeset must list `@aio-proxy/plugin-openrouter`, `@aio-proxy/shared`, `@aio-proxy/core`, `@aio-proxy/cli`, `@aio-proxy/server`, and `aio-proxy`, all `minor`.
- Every non-trivial behavior is RED → verify failure → minimal GREEN → verify pass.
- Merge order: Claude first (no host parse), then this PR, then Muse. Last task **inserts** `@aio-proxy/plugin-openrouter` at the current sorted index. Do not paste a six-plugin snapshot over siblings. Do not backfill the missing `@aio-proxy/plugin-xai-grok` entries in `capability.resolution.test.ts` / `binary-build.test.ts`.
- Host parse is gated by the **opened authorize URL**: `stateRequired = new URL(authorizationUrl).searchParams.has('state')`. Missing state is accepted only when `stateRequired === false`. Do not relax state globally. Put the pure function in `@aio-proxy/shared`.

---

## File Structure

**Create:**

- `packages/plugins/openrouter/package.json` — workspace package metadata (copy `packages/plugins/xai-grok/`).
- `packages/plugins/openrouter/tsconfig.json` — extends infra base, `rootDir: src`.
- `packages/plugins/openrouter/rslib.config.ts` — `defineLibraryConfig()`.
- `packages/plugins/openrouter/oauth.smoke.ts` — built artifact exports the descriptor.
- `packages/plugins/openrouter/src/index.ts` — public exports and `OPENROUTER_PLUGIN_VERSION`.
- `packages/plugins/openrouter/src/schema/index.ts` — export-only.
- `packages/plugins/openrouter/src/schema/schema.ts` — `OpenRouterCredential` zod schema.
- `packages/plugins/openrouter/src/pkce/index.ts` — export-only.
- `packages/plugins/openrouter/src/pkce/pkce.ts` — S256 challenge/verifier.
- `packages/plugins/openrouter/src/pkce/pkce.test.ts` — challenge shape.
- `packages/plugins/openrouter/src/oauth/index.ts` — export-only.
- `packages/plugins/openrouter/src/oauth/oauth.ts` — loopback login, token exchange, identity.
- `packages/plugins/openrouter/src/oauth/oauth.test.ts` — authorize URL, exchange, fingerprint.
- `packages/plugins/openrouter/src/catalog/index.ts` — export-only.
- `packages/plugins/openrouter/src/catalog/catalog.ts` — TTL discover + curated fallback.
- `packages/plugins/openrouter/src/catalog/catalog.test.ts` — modality mapping and fallback gates.
- `packages/plugins/openrouter/src/runtime/index.ts` — export-only.
- `packages/plugins/openrouter/src/runtime/runtime.ts` — ProviderV4 wrapper + dynamic Bearer fetch.
- `packages/plugins/openrouter/src/runtime/runtime.test.ts` — v4 surface, Bearer injection, no raw.
- `packages/plugins/openrouter/src/quota/index.ts` — export-only.
- `packages/plugins/openrouter/src/quota/quota.ts` — `GET /api/v1/key` remaining ratio.
- `packages/plugins/openrouter/src/quota/quota.test.ts` — ratio, unlimited empty items, no reset.
- `packages/plugins/openrouter/src/plugin/index.ts` — export-only.
- `packages/plugins/openrouter/src/plugin/plugin.ts` — `createOpenRouterPlugin`.
- `packages/plugins/openrouter/src/plugin/plugin.test.ts` — descriptor, empty options, omitted refresh.
- `.changeset/openrouter-oauth.md` — product + internal minor notes.
- `packages/shared/src/oauth-loopback-callback.ts` — pure `resolveOAuthLoopbackCallback`.
- `packages/shared/src/oauth-loopback-callback.test.ts` — shared case table (stateRequired true/false).

**Modify:**

- `packages/cli/src/plugin-commands/loopback/callback.ts` — missing-state and loose-code parse.
- `packages/cli/src/plugin-commands/loopback/callback.test.ts` — manual paste cases.
- `packages/cli/src/plugin-commands/loopback/callback.automatic.test.ts` — browser callback without state.
- `packages/server/src/oauth-login-session/callback.ts` — same parse rules.
- `packages/server/src/oauth-login-session/callback.test.ts` — same parse rules.
- `packages/server/src/oauth-login-session/authorization.test.ts` — loopback HTTP without state.
- `packages/core/src/plugins/builtins.ts` — embed the plugin (Task 7).
- `packages/core/src/plugins/builtins.test.ts` — reserved identity + zh-Hans copy (Task 7).
- `packages/core/package.json` — workspace dependency (Task 7).
- `.changeset/config.json` — `fixed` group entry (Task 7).
- `packages/cli/src/plugin-commands/plugin/add.test.ts` — built-in package list (Task 7).
- `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts` — exact-package list (Task 7).
- `packages/cli/__tests__/binary-build.test.ts` — `plugin list` assertion (Task 7).
- `bun.lock` — workspace link (Task 7).

---

### Task 1: Host loopback accepts a missing OAuth state

**Files:**
- Modify: `packages/cli/src/plugin-commands/loopback/callback.ts`
- Modify: `packages/cli/src/plugin-commands/loopback/callback.test.ts`
- Modify: `packages/cli/src/plugin-commands/loopback/callback.automatic.test.ts`
- Modify: `packages/server/src/oauth-login-session/callback.ts`
- Modify: `packages/server/src/oauth-login-session/callback.test.ts`
- Modify: `packages/server/src/oauth-login-session/authorization.test.ts`

**Interfaces:**
- Consumes: the built authorize URL plus existing `parseCallback` / `parseOAuthCallback` call sites in CLI `run.ts` and Dashboard loopback.
- Produces: `@aio-proxy/shared` `resolveOAuthLoopbackCallback(raw, expectedRedirectUri, expectedState, { stateRequired })`. Host wrappers keep their error classes. `stateRequired` is `new URL(authorizationUrl).searchParams.has('state')` after `buildAuthorizationUrl`. Signatures of the host wrappers may add that options object; `LoopbackRequest` does not change.

Locked order: URL or (only if `stateRequired === false`) loose-code → origin (URL only) → state gate → `error` → `code`. `error` stays after the state gate.

- `stateRequired === true` (ChatGPT / Antigravity / Claude): missing state is still `STATE_MISMATCH` and must **not** settle. Loose-code is `INVALID`.
- `stateRequired === false` (OpenRouter authorize URL has no `state` query): missing state + `code` accepts; missing state + `error` denies; present-but-wrong state still mismatches.
- Existing `request()` helper in `packages/cli/src/plugin-commands/loopback/test-support.ts` must put `state=` on the authorize URL so current tests keep the CSRF-required path.

OpenRouter never echoes `state`. Inspected today: both parsers use `searchParams.get('state') !== expectedState`, so `null !== 'uuid'` rejects the real callback. Plugin-sdk `LoopbackRequest.state` stays required. Do not add a field to the SDK. Do **not** implement the old “any missing state + code is OK” rule — that is a CSRF/DoS hole on Antigravity (`localhost:51121`, no PKCE) and a DoS hole on ChatGPT/Claude fixed ports.

- [ ] **Step 1: Write the failing CLI parse / loopback tests**

In `packages/cli/src/plugin-commands/loopback/callback.test.ts`, add these cases inside the existing `describe('loopback manual callback handling')` (keep the current matching-state success and mismatch table):

```ts
  test('accepts a manually pasted loopback URL that has a code and no state', async () => {
    setInteractive(true);
    let redirectUri = '';
    const { deps } = createDeps({
      readManualCallbackUrl: async () => `${redirectUri}?code=openrouter-code`,
    });
    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: (input) => {
            redirectUri = input.redirectUri;
            return 'https://openrouter.ai/auth';
          },
        }),
        deps,
      ),
    ).resolves.toEqual({ code: 'openrouter-code', redirectUri: expect.any(String) });
  });

  test('accepts a pasted raw authorization code when the input is not a URL', async () => {
    setInteractive(true);
    const { deps } = createDeps({
      readManualCallbackUrl: async () => 'auth_code_abc123',
    });
    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: () => 'https://openrouter.ai/auth',
        }),
        deps,
      ),
    ).resolves.toEqual({ code: 'auth_code_abc123', redirectUri: expect.any(String) });
  });
```

In `packages/cli/src/plugin-commands/loopback/callback.automatic.test.ts`, add:

```ts
  test('accepts an automatic callback that has a code and no state', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://openrouter.ai/auth';
        },
      }),
      deps,
    );
    expect((await fetch(`${redirectUri}?code=openrouter-code`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: 'openrouter-code' });
  });

  test('denies an automatic callback that has error and no state', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://openrouter.ai/auth';
        },
      }),
      deps,
    );
    const settled = flow.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((await fetch(`${redirectUri}?error=access_denied`)).status).toBe(400);
    expect(await settled).toBeInstanceOf(LoopbackOAuthError);
  });
```

Also add a ChatGPT/Antigravity guard (authorize URL **includes** `state`, missing callback state must not settle):

```ts
  test('rejects a missing-state callback when the authorize URL sent state', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return `https://identity.example/authorize?state=expected-state`;
        },
      }),
      deps,
    );
    const missing = await fetch(`${redirectUri}?code=stolen`);
    expect(missing.status).toBe(400);
    expect((await fetch(`${redirectUri}?code=valid&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: 'valid' });
  });
```

Keep the existing test that a **wrong** `state` on `error=access_denied` does not settle the flow.

Update `packages/cli/src/plugin-commands/loopback/test-support.ts` `request()` so the default authorize URL includes `state=expected-state`. Otherwise existing fixtures would silently take the OpenRouter (`stateRequired === false`) path.

- [ ] **Step 2: Run the new CLI tests and confirm they fail**

Run: `bun test packages/cli/src/plugin-commands/loopback/callback.test.ts packages/cli/src/plugin-commands/loopback/callback.automatic.test.ts`

Expected: FAIL. The no-state URL cases throw `LoopbackStateMismatchError`. The raw-code case throws `LoopbackCallbackInvalidError`.

- [ ] **Step 3: Write the failing Dashboard parse tests**

Replace `packages/server/src/oauth-login-session/callback.test.ts` with:

```ts
import { expect, test } from 'bun:test';

import { OAuthCallbackError, parseOAuthCallback } from './callback';

const expected = 'http://127.0.0.1:1455/auth/callback';

test('manual OAuth callback validates redirect and state without exposing the raw callback', () => {
  expect(parseOAuthCallback(`${expected}?code=accepted&state=expected`, expected, 'expected')).toEqual({
    code: 'accepted',
  });

  for (const raw of [
    `${expected}?code=secret-code&state=wrong`,
    'http://127.0.0.1:9999/auth/callback?code=secret-code&state=expected',
  ]) {
    try {
      parseOAuthCallback(raw, expected, 'expected');
      throw new Error('expected callback rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect(String(error)).not.toContain('secret-code');
    }
  }
});

test('accepts a matching callback URL that has a code and no state', () => {
  expect(parseOAuthCallback(`${expected}?code=openrouter-code`, expected, 'host-only-state')).toEqual({
    code: 'openrouter-code',
  });
});

test('accepts a pasted raw authorization code when the input is not a URL', () => {
  expect(parseOAuthCallback('auth_code_abc123', expected, 'host-only-state')).toEqual({
    code: 'auth_code_abc123',
  });
  expect(parseOAuthCallback('code=auth_code_from_query', expected, 'host-only-state')).toEqual({
    code: 'auth_code_from_query',
  });
});

test('rejects a missing-state callback that also has no code', () => {
  expect(() => parseOAuthCallback(expected, expected, 'host-only-state')).toThrow(OAuthCallbackError);
});
```

In `packages/server/src/oauth-login-session/authorization.test.ts`, add after the existing loopback test:

```ts
test('accepts a loopback callback that has a code and no state', async () => {
  const published: DashboardOAuthSession[] = [];
  const auth = createDashboardAuthorization({
    sessionId: '00000000-0000-4000-8000-000000000001',
    signal: new AbortController().signal,
    publish: (session) => published.push(session),
    completeUrl: 'http://localhost:3000/dashboard/oauth/complete',
  });
  const loopback = auth.port.loopback({
    state: 'host-only-state',
    redirect: { hostname: '127.0.0.1', port: 'dynamic', path: '/callback' },
    authorizationUrl: ({ redirectUri }) => {
      const url = new URL('https://openrouter.ai/auth');
      url.searchParams.set('callback_url', redirectUri);
      return url.href;
    },
    allowManualCallbackUrl: true,
  });
  await Bun.sleep(10);
  const session = published.find((item) => item.status === 'loopback');
  if (session === undefined || session.status !== 'loopback') throw new Error('expected loopback session');
  const redirectUri = new URL(session.authorizationUrl).searchParams.get('callback_url');
  if (redirectUri === null) throw new Error('expected callback_url');
  const response = await fetch(`${redirectUri}?code=openrouter-code`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  await expect(loopback).resolves.toEqual({ code: 'openrouter-code', redirectUri });
  auth.close();
});
```

- [ ] **Step 4: Run the new server tests and confirm they fail**

Run: `bun test packages/server/src/oauth-login-session/callback.test.ts packages/server/src/oauth-login-session/authorization.test.ts`

Expected: FAIL on the no-state and raw-code cases (`CALLBACK_STATE_MISMATCH` / `CALLBACK_INVALID`).

- [ ] **Step 5: Implement the shared parse helper and both host wrappers**

Add `packages/shared/src/oauth-loopback-callback.ts` as a pure function. It must take `{ stateRequired }` and implement the locked order. Do not throw host error classes from `shared`.

Then wrap it in both hosts. In CLI `run.ts` / Dashboard loopback, after `buildAuthorizationUrl`:

```ts
const stateRequired = new URL(authorizationUrl).searchParams.has('state');
const { code } = parseCallback(raw, expectedRedirectUri, request.state, { stateRequired });
```

Loose-code and missing-state acceptance run **only** when `stateRequired === false`.

The following snippet is the OpenRouter (`stateRequired === false`) branch only. The ChatGPT/Antigravity branch must keep today’s “missing state is mismatch” behavior.

In `packages/cli/src/plugin-commands/loopback/callback.ts`, replace `parseCallback` with a wrapper around the shared helper. Reference shape:

```ts
function looseAuthorizationCode(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.includes('code=')) {
    const code = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed).get('code');
    return code !== null && code !== '' ? code : undefined;
  }
  if (!trimmed.includes('://') && !/\s/u.test(trimmed)) return trimmed;
  return undefined;
}

export function parseCallback(
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
): { readonly code: string } {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    const code = looseAuthorizationCode(raw);
    if (code === undefined) throw new LoopbackCallbackInvalidError();
    return { code };
  }
  const expected = new URL(expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    throw new LoopbackCallbackMismatchError();
  }
  const actualState = callback.searchParams.get('state');
  if (actualState !== null && actualState !== expectedState) throw new LoopbackStateMismatchError();
  if (callback.searchParams.get('error') !== null) throw new LoopbackOAuthError();
  const code = callback.searchParams.get('code');
  if (code === null || code.length === 0) throw new LoopbackCodeMissingError();
  return { code };
}
```

In `packages/server/src/oauth-login-session/callback.ts`, replace `parseOAuthCallback` with the same rules (`OAuthCallbackError` codes unchanged: `CALLBACK_INVALID`, `CALLBACK_MISMATCH`, `CALLBACK_STATE_MISMATCH`, `AUTHORIZATION_DENIED`, `CALLBACK_CODE_MISSING`):

```ts
function looseAuthorizationCode(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.includes('code=')) {
    const code = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed).get('code');
    return code !== null && code !== '' ? code : undefined;
  }
  if (!trimmed.includes('://') && !/\s/u.test(trimmed)) return trimmed;
  return undefined;
}

export const parseOAuthCallback = (
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
): { readonly code: string } => {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    const code = looseAuthorizationCode(raw);
    if (code === undefined) throw new OAuthCallbackError('CALLBACK_INVALID');
    return { code };
  }
  const expected = new URL(expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    throw new OAuthCallbackError('CALLBACK_MISMATCH');
  }
  const actualState = callback.searchParams.get('state');
  if (actualState !== null && actualState !== expectedState) throw new OAuthCallbackError('CALLBACK_STATE_MISMATCH');
  if (callback.searchParams.get('error') !== null) throw new OAuthCallbackError('AUTHORIZATION_DENIED');
  const code = callback.searchParams.get('code');
  if (code === null || code === '') throw new OAuthCallbackError('CALLBACK_CODE_MISSING');
  return { code };
};
```

Do **not** ship those two snippets as-is. They are the `stateRequired === false` branch only. The real implementation is one shared helper plus host wrappers that pass `{ stateRequired }`. Default `stateRequired` for existing unit tests that call `parseCallback` / `parseOAuthCallback` directly without an authorize URL must be `true` (today’s CSRF). OpenRouter loopback / Dashboard tests pass `stateRequired: false` or go through `runLoopbackAuthorization` so the host derives it from the authorize URL.

Dashboard `parseOAuthCallback` tests that accept missing state or raw codes must pass `{ stateRequired: false }`. Add a Dashboard case: authorize-equivalent `{ stateRequired: true }` + missing state + `error=access_denied` does not accept.

- [ ] **Step 6: Run CLI and server loopback tests and confirm they pass**

Run:

```bash
bun test packages/cli/src/plugin-commands/loopback
bun test packages/server/src/oauth-login-session
```

Expected: PASS, including the original wrong-state and wrong-origin cases.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/cli/src/plugin-commands/loopback/callback.ts \
  packages/cli/src/plugin-commands/loopback/callback.test.ts \
  packages/cli/src/plugin-commands/loopback/callback.automatic.test.ts \
  packages/server/src/oauth-login-session/callback.ts \
  packages/server/src/oauth-login-session/callback.test.ts \
  packages/server/src/oauth-login-session/authorization.test.ts
git commit -m "feat(openrouter): accept loopback callbacks that omit OAuth state"
```

---

### Task 2: PKCE login that mints a durable API key

**Files:**
- Create: `packages/plugins/openrouter/package.json`
- Create: `packages/plugins/openrouter/tsconfig.json`
- Create: `packages/plugins/openrouter/rslib.config.ts`
- Create: `packages/plugins/openrouter/src/schema/schema.ts`
- Create: `packages/plugins/openrouter/src/schema/index.ts`
- Create: `packages/plugins/openrouter/src/pkce/pkce.ts`
- Create: `packages/plugins/openrouter/src/pkce/pkce.test.ts`
- Create: `packages/plugins/openrouter/src/pkce/index.ts`
- Create: `packages/plugins/openrouter/src/oauth/oauth.ts`
- Create: `packages/plugins/openrouter/src/oauth/oauth.test.ts`
- Create: `packages/plugins/openrouter/src/oauth/index.ts`

**Interfaces:**
- Consumes: `OAuthLoginContext`, `LoopbackRequest`, `RuntimeFetch` from `@aio-proxy/plugin-sdk`.
- Produces: `OpenRouterCredential`, `generatePKCE()`, `loginOpenRouter(context, options?)`, `openRouterLoginResult(apiKey)`.

- [ ] **Step 1: Create the package shell and failing tests**

Create `packages/plugins/openrouter/package.json`:

```json
{
  "name": "@aio-proxy/plugin-openrouter",
  "version": "0.19.2",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "rslib",
    "test": "bun run test:unit",
    "test:unit": "bun test",
    "test:artifact": "bun test ./oauth.smoke.ts"
  },
  "dependencies": {
    "@aio-proxy/plugin-sdk": "workspace:*",
    "@openrouter/ai-sdk-provider": "catalog:",
    "es-toolkit": "catalog:"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Create `packages/plugins/openrouter/tsconfig.json`:

```json
{
  "extends": "@aio-proxy/infra/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-support.ts"]
}
```

Create `packages/plugins/openrouter/rslib.config.ts`:

```ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig();
```

Create `packages/plugins/openrouter/src/schema/schema.ts`:

```ts
import { zod } from '@aio-proxy/plugin-sdk';

export const credentialSchema = zod.object({
  apiKey: zod.string().min(1),
});

export type OpenRouterCredential = zod.infer<typeof credentialSchema>;
```

Create `packages/plugins/openrouter/src/schema/index.ts`:

```ts
export { credentialSchema, type OpenRouterCredential } from './schema';
```

Create `packages/plugins/openrouter/src/pkce/pkce.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { generatePKCE } from './pkce';

test('generates an S256 verifier and challenge pair', async () => {
  const first = await generatePKCE();
  const second = await generatePKCE();
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.verifier).not.toBe(first.challenge);
  expect(first.verifier).not.toBe(second.verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(first.verifier));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  expect(first.challenge).toBe(encoded);
});
```

Create `packages/plugins/openrouter/src/oauth/oauth.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { LoopbackRequest, OAuthLoginContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { loginOpenRouter, openRouterLoginResult } from './oauth';

const AUTHORIZE = 'https://openrouter.ai/auth';
const TOKEN = 'https://openrouter.ai/api/v1/auth/keys';
const REDIRECT = 'http://127.0.0.1:43123/callback';

describe('OpenRouter OAuth', () => {
  test('exchanges a loopback code for a durable key and a stable private identity', async () => {
    let loopback: LoopbackRequest | undefined;
    const requests: Request[] = [];
    const inits: RuntimeRequestInit[] = [];
    const result = await loginOpenRouter(loginContext({
      loopback: async (input) => {
        loopback = input;
        const authorize = new URL(input.authorizationUrl({ redirectUri: REDIRECT }));
        expect(authorize.origin + authorize.pathname).toBe(AUTHORIZE);
        expect(authorize.searchParams.get('callback_url')).toBe(REDIRECT);
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(authorize.searchParams.has('state')).toBe(false);
        expect(authorize.searchParams.has('redirect_uri')).toBe(false);
        expect(authorize.searchParams.has('client_id')).toBe(false);
        return { code: 'auth-code', redirectUri: REDIRECT };
      },
    }), {
      fetch: async (input, init) => {
        inits.push(init ?? {});
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ key: 'sk-or-v1-test-key', user_id: 'user_example' });
      },
    });

    expect(loopback?.redirect).toEqual({ hostname: '127.0.0.1', port: 'dynamic', path: '/callback' });
    expect(loopback?.allowManualCallbackUrl).toBe(true);
    expect(loopback?.state).toMatch(/\S/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TOKEN);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(await requests[0]!.json()).toEqual({
      code: 'auth-code',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      code_challenge_method: 'S256',
    });
    const digest = new Bun.CryptoHasher('sha256').update('key:sk-or-v1-test-key').digest('hex');
    expect(result).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `openrouter-${digest.slice(0, 12)}`,
      accountLabel: 'OpenRouter',
      credentials: { apiKey: 'sk-or-v1-test-key' },
    });
    expect(result).not.toHaveProperty('expiresAt');
    expect(Object.keys(result.credentials)).toEqual(['apiKey']);
  });

  test('fails closed when the key exchange omits key', async () => {
    await expect(
      loginOpenRouter(loginContext({
        loopback: async () => ({ code: 'auth-code', redirectUri: REDIRECT }),
      }), {
        fetch: async () => Response.json({ user_id: 'user_example' }),
      }),
    ).rejects.toThrow(/key/i);
  });

  test('propagates cancellation into the key exchange', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(
      loginOpenRouter({ ...loginContext({
        loopback: async () => ({ code: 'auth-code', redirectUri: REDIRECT }),
      }), signal: controller.signal }, {
        fetch: async (_input, init) => {
          init?.signal?.throwIfAborted();
          return Response.json({ key: 'sk-or-v1-test-key' });
        },
      }),
    ).rejects.toBe(reason);
  });

  test('builds the same identity for a stored key', () => {
    const digest = new Bun.CryptoHasher('sha256').update('key:sk-or-v1-test-key').digest('hex');
    expect(openRouterLoginResult('sk-or-v1-test-key')).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `openrouter-${digest.slice(0, 12)}`,
      accountLabel: 'OpenRouter',
      credentials: { apiKey: 'sk-or-v1-test-key' },
    });
  });
});

function loginContext(overrides: {
  readonly loopback: OAuthLoginContext['authorization']['loopback'];
}): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async () => {
        throw new Error('OpenRouter must not use device code');
      },
      presentAuthorizeUrl: async () => {
        throw new Error('OpenRouter must use loopback, not presentAuthorizeUrl');
      },
      loopback: async (input) => {
        const response = await overrides.loopback(input);
        return response;
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/plugins/openrouter/src/pkce packages/plugins/openrouter/src/oauth`

Expected: FAIL because `./pkce` and `./oauth` do not exist.

- [ ] **Step 3: Implement PKCE and login**

Create `packages/plugins/openrouter/src/pkce/pkce.ts`:

```ts
export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export async function generatePKCE(): Promise<PKCE> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { challenge: base64url(new Uint8Array(digest)), verifier };
}

function base64url(bytes: Uint8Array): string {
  const encoded = btoa(String.fromCharCode(...bytes));
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
```

Create `packages/plugins/openrouter/src/pkce/index.ts`:

```ts
export { generatePKCE, type PKCE } from './pkce';
```

Create `packages/plugins/openrouter/src/oauth/oauth.ts`:

```ts
import type { OAuthLoginContext, OAuthLoginResult, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { generatePKCE } from '../pkce/index';
import type { OpenRouterCredential } from '../schema/index';

const AUTHORIZE_URL = 'https://openrouter.ai/auth';
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';

export type OpenRouterOAuthOptions = {
  readonly fetch?: RuntimeFetch;
};

export function openRouterLoginResult(apiKey: string): OAuthLoginResult<OpenRouterCredential> {
  const digest = new Bun.CryptoHasher('sha256').update(`key:${apiKey}`).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `openrouter-${digest.slice(0, 12)}`,
    accountLabel: 'OpenRouter',
    credentials: { apiKey },
  };
}

export async function loginOpenRouter(
  context: OAuthLoginContext,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthLoginResult<OpenRouterCredential>> {
  const pkce = await generatePKCE();
  const state = crypto.randomUUID();
  const { code } = await context.authorization.loopback({
    state,
    redirect: { hostname: '127.0.0.1', port: 'dynamic', path: '/callback' },
    allowManualCallbackUrl: true,
    authorizationUrl: ({ redirectUri }) => {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('callback_url', redirectUri);
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.href;
    },
  });
  if (code.trim() === '') throw new Error('OpenRouter authorization code is missing');
  const apiKey = await exchangeAuthorizationCode(code, pkce.verifier, {
    fetch: options.fetch ?? context.fetch ?? globalThis.fetch,
    signal: context.signal,
  });
  return openRouterLoginResult(apiKey);
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  options: { readonly fetch: RuntimeFetch; readonly signal: AbortSignal },
): Promise<string> {
  options.signal.throwIfAborted();
  let response: Response;
  try {
    response = await options.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
      signal: options.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    throw error;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('OpenRouter OAuth returned invalid JSON');
  }
  if (!response.ok) {
    throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})`);
  }
  if (!isPlainObject(body) || typeof body.key !== 'string' || body.key.trim() === '') {
    throw new Error('OpenRouter OAuth response carries no key');
  }
  return body.key.trim();
}
```

Create `packages/plugins/openrouter/src/oauth/index.ts`:

```ts
export { loginOpenRouter, openRouterLoginResult, type OpenRouterOAuthOptions } from './oauth';
```

Fix the login test so it records `init` instead of reading `aioProxy` off `Request`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test packages/plugins/openrouter/src/pkce packages/plugins/openrouter/src/oauth`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openrouter
git commit -m "feat(openrouter): add pkce login that mints a durable api key"
```

---

### Task 3: Discover models from the OpenRouter catalog

**Files:**
- Create: `packages/plugins/openrouter/src/catalog/catalog.ts`
- Create: `packages/plugins/openrouter/src/catalog/catalog.test.ts`
- Create: `packages/plugins/openrouter/src/catalog/index.ts`

**Interfaces:**
- Consumes: `AccountContext<OpenRouterCredential, Record<string, never>>`, `OpenRouterOAuthOptions`.
- Produces: `OPENROUTER_CATALOG_TTL_MS`, `discoverOpenRouterModels(context, options?)`, `initialOpenRouterCatalogFallback(error)`.

- [ ] **Step 1: Write the failing catalog tests**

Create `packages/plugins/openrouter/src/catalog/catalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import {
  discoverOpenRouterModels,
  initialOpenRouterCatalogFallback,
  OpenRouterCatalogError,
} from './catalog';
import type { OpenRouterCredential } from '../schema/index';

const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text,embeddings,image';

describe('OpenRouter model catalog', () => {
  test('classifies language, embedding, and image models and defaults protocol', async () => {
    const inits: RuntimeRequestInit[] = [];
    let url = '';
    const catalog = await discoverOpenRouterModels(context(), {
      fetch: async (input, init) => {
        url = String(input);
        inits.push(init ?? {});
        return Response.json({
          data: [
            { id: 'openai/gpt-5.6-luna', name: 'OpenAI: GPT-5.6 Luna' },
            {
              id: 'google/gemini-embed',
              name: 'Gemini Embed',
              architecture: { output_modalities: ['embeddings'] },
            },
            {
              id: 'black-forest/flux',
              name: 'Flux',
              architecture: { output_modalities: ['image'] },
            },
            { id: '   ' },
            { name: 'missing-id' },
          ],
        });
      },
    });
    expect(url).toBe(MODELS_URL);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(catalog.language).toEqual([
      {
        id: 'openai/gpt-5.6-luna',
        displayName: 'OpenAI: GPT-5.6 Luna',
        extra: { protocol: 'openai-compatible' },
      },
    ]);
    expect(catalog.embedding).toEqual([{ id: 'google/gemini-embed', displayName: 'Gemini Embed' }]);
    expect(catalog.image).toEqual([{ id: 'black-forest/flux', displayName: 'Flux' }]);
  });

  test('falls back only for retryable discovery failures', () => {
    const fallback = initialOpenRouterCatalogFallback(new OpenRouterCatalogError('network', true));
    expect(fallback?.language).toContainEqual({
      id: 'anthropic/claude-sonnet-5',
      displayName: 'Anthropic: Claude Sonnet 5',
      extra: { protocol: 'openai-compatible' },
    });
    expect(initialOpenRouterCatalogFallback(new OpenRouterCatalogError('unauthorized', false, 401))).toBeUndefined();
  });

  test('treats a successful empty language catalog as authoritative', async () => {
    const catalog = await discoverOpenRouterModels(context(), {
      fetch: async () => Response.json({ data: [] }),
    });
    expect(catalog.language).toEqual([]);
    expect(initialOpenRouterCatalogFallback(new OpenRouterCatalogError('empty', false))).toBeUndefined();
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<OpenRouterCredential> {
  return {
    read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
    refresh: async () => {
      throw new Error('durable OpenRouter keys must not refresh');
    },
  };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/plugins/openrouter/src/catalog`

Expected: FAIL because `./catalog` does not exist.

- [ ] **Step 3: Implement discovery**

Create `packages/plugins/openrouter/src/catalog/catalog.ts`:

```ts
import type { AccountContext, ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

export const OPENROUTER_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text,embeddings,image';
const LANGUAGE_PROTOCOL = { protocol: 'openai-compatible' } as const;

// Frozen 2026-09-06 snapshot. Re-fetch GET /api/v1/models?sort=most-popular
// before landing; replace 404/renamed ids only. Do not invent later.
const CURATED = [
  ['openai/gpt-5.6-luna', 'OpenAI: GPT-5.6 Luna'],
  ['google/gemini-3.7-flash', 'Google: Gemini 3.7 Flash'],
  ['anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5'],
  ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ['deepseek/deepseek-v4-pro', 'DeepSeek: DeepSeek V4 Pro 0423'],
  ['deepseek/deepseek-v4-flash', 'DeepSeek: DeepSeek V4 Flash 0423'],
  ['moonshotai/kimi-k3', 'MoonshotAI: Kimi K3'],
  ['minimax/minimax-m3', 'MiniMax: MiniMax M3'],
] as const;

export class OpenRouterCatalogError extends Error {
  override readonly name = 'OpenRouterCatalogError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverOpenRouterModels(
  context: AccountContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<ModelCatalog> {
  const { value } = await context.credentials.read();
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(MODELS_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${value.apiKey}` },
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new OpenRouterCatalogError('OpenRouter model discovery network failure', true);
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) throw new OpenRouterCatalogError('OpenRouter model discovery rejected', retryable, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterCatalogError('OpenRouter model discovery returned invalid JSON', true);
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new OpenRouterCatalogError('OpenRouter model discovery returned invalid data', true);
  }

  const language: ModelDescriptor[] = [];
  const embedding: ModelDescriptor[] = [];
  const image: ModelDescriptor[] = [];
  const seen = { language: new Set<string>(), embedding: new Set<string>(), image: new Set<string>() };
  for (const entry of payload.data) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (id === '') continue;
    const displayName = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined;
    const descriptor: ModelDescriptor = { id, ...(displayName === undefined ? {} : { displayName }) };
    const outputs = outputModalities(entry);
    if (outputs.includes('text')) pushUnique(language, seen.language, { ...descriptor, extra: LANGUAGE_PROTOCOL });
    if (outputs.includes('embeddings')) pushUnique(embedding, seen.embedding, descriptor);
    if (outputs.includes('image')) pushUnique(image, seen.image, descriptor);
  }
  return emptyCatalog(language, embedding, image);
}

export function initialOpenRouterCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof OpenRouterCatalogError && error.retryable
    ? emptyCatalog(
        CURATED.map(([id, displayName]) => ({ id, displayName, extra: LANGUAGE_PROTOCOL })),
        [],
        [],
      )
    : undefined;
}

function outputModalities(entry: { readonly architecture?: unknown }): readonly string[] {
  if (!isPlainObject(entry.architecture) || !Array.isArray(entry.architecture.output_modalities)) return ['text'];
  const outputs = entry.architecture.output_modalities.filter((item): item is string => typeof item === 'string');
  return outputs.length === 0 ? ['text'] : outputs;
}

function pushUnique(list: ModelDescriptor[], seen: Set<string>, descriptor: ModelDescriptor): void {
  if (seen.has(descriptor.id)) return;
  seen.add(descriptor.id);
  list.push(descriptor);
}

function emptyCatalog(
  language: ModelCatalog['language'],
  embedding: ModelCatalog['embedding'],
  image: ModelCatalog['image'],
): ModelCatalog {
  return { language, image, embedding, speech: [], transcription: [], reranking: [] };
}
```

Create `packages/plugins/openrouter/src/catalog/index.ts`:

```ts
export {
  discoverOpenRouterModels,
  initialOpenRouterCatalogFallback,
  OPENROUTER_CATALOG_TTL_MS,
  OpenRouterCatalogError,
} from './catalog';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/plugins/openrouter/src/catalog`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openrouter/src/catalog
git commit -m "feat(openrouter): discover models from the openrouter catalog"
```

---

### Task 4: Invoke models through createOpenRouter

**Files:**
- Create: `packages/plugins/openrouter/src/runtime/runtime.ts`
- Create: `packages/plugins/openrouter/src/runtime/runtime.test.ts`
- Create: `packages/plugins/openrouter/src/runtime/index.ts`

**Interfaces:**
- Consumes: `RuntimeContext<OpenRouterCredential, Record<string, never>>`, `createOpenRouter` from `@openrouter/ai-sdk-provider`.
- Produces: `createOpenRouterRuntime(context, options?)`, `createOpenRouterDynamicFetch(credentials, options?)`.

- [ ] **Step 1: Write the failing runtime test**

Create `packages/plugins/openrouter/src/runtime/runtime.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { CredentialPort, RuntimeContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { createOpenRouterDynamicFetch, createOpenRouterRuntime } from './runtime';
import type { OpenRouterCredential } from '../schema/index';

test('exposes a ProviderV4 language surface and no raw resolver', async () => {
  const runtime = await createOpenRouterRuntime(runtimeContext());
  expect(runtime.provider.specificationVersion).toBe('v4');
  expect(runtime.provider.languageModel('openai/gpt-5.6-luna')).toBeDefined();
  expect(runtime.raw).toBeUndefined();
});

test('injects the durable Bearer key and preserves the abort signal', async () => {
  const inits: RuntimeRequestInit[] = [];
  const controller = new AbortController();
  const fetch = createOpenRouterDynamicFetch(staticPort(), {
    fetch: async (_input, init) => {
      inits.push(init ?? {});
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer dynamic-credential', 'content-type': 'application/json' },
    body: '{"model":"openai/gpt-5.6-luna"}',
    signal: controller.signal,
  });
  expect(new Headers(inits[0]?.headers).get('authorization')).toBe('Bearer sk-or-v1-test-key');
  expect(inits[0]?.signal).toBe(controller.signal);
  expect(inits[0]?.aioProxy?.traffic).not.toBe('control');
});

function runtimeContext(): RuntimeContext<OpenRouterCredential, Record<string, never>> {
  return {
    credentials: staticPort(),
    options: {},
    catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
    fetch: globalThis.fetch,
  };
}

function staticPort(): CredentialPort<OpenRouterCredential> {
  return {
    read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
    refresh: async () => {
      throw new Error('durable OpenRouter keys must not refresh');
    },
  };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/plugins/openrouter/src/runtime`

Expected: FAIL because `./runtime` does not exist.

- [ ] **Step 3: Implement the ProviderV4 wrapper**

Create `packages/plugins/openrouter/src/runtime/runtime.ts`:

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

const PLACEHOLDER_CREDENTIAL = 'dynamic-credential';

export async function createOpenRouterRuntime(
  context: RuntimeContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const fetch = options.fetch ?? context.fetch;
  const openrouter = createOpenRouter({
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: createOpenRouterDynamicFetch(context.credentials, { ...options, fetch }),
    compatibility: 'strict',
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openrouter.chat(modelId),
      embeddingModel: (modelId) => openrouter.textEmbeddingModel(modelId),
      imageModel: (modelId) => openrouter.imageModel(modelId),
    },
  };
}

export function createOpenRouterDynamicFetch(
  credentials: CredentialPort<OpenRouterCredential>,
  options: OpenRouterOAuthOptions & { readonly fetch?: RuntimeFetch } = {},
): RuntimeFetch {
  const fetch = options.fetch ?? globalThis.fetch;
  const dynamicFetch: RuntimeFetch = async (input, init) => {
    const { value } = await credentials.read();
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${value.apiKey}`);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : request.signal);
    return await fetch(request.url, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: request.redirect,
    });
  };
  return dynamicFetch;
}
```

If TypeScript rejects LanguageModelV3 in the ProviderV4 slots, use a single `as ProviderV4['languageModel']` (and the embedding/image equivalents). Do not switch packages.

Create `packages/plugins/openrouter/src/runtime/index.ts`:

```ts
export { createOpenRouterDynamicFetch, createOpenRouterRuntime } from './runtime';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/plugins/openrouter/src/runtime`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openrouter/src/runtime
git commit -m "feat(openrouter): invoke language models through createOpenRouter"
```

---

### Task 5: Read-only key credit remaining ratio

**Files:**
- Create: `packages/plugins/openrouter/src/quota/quota.ts`
- Create: `packages/plugins/openrouter/src/quota/quota.test.ts`
- Create: `packages/plugins/openrouter/src/quota/index.ts`

**Interfaces:**
- Consumes: `AccountContext<OpenRouterCredential, Record<string, never>>`.
- Produces: `readOpenRouterQuota(context, options?)`.

- [ ] **Step 1: Write the failing quota tests**

Create `packages/plugins/openrouter/src/quota/quota.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { readOpenRouterQuota } from './quota';
import type { OpenRouterCredential } from '../schema/index';

test('maps a finite key limit to a remaining credit ratio', async () => {
  const inits: RuntimeRequestInit[] = [];
  let url = '';
  const snapshot = await readOpenRouterQuota(context(), {
    fetch: async (input, init) => {
      url = String(input);
      inits.push(init ?? {});
      return Response.json({
        data: { label: 'sk-or-v1-au7...890', limit: 100, limit_remaining: 74.5, usage: 25.5, limit_reset: 'monthly' },
      });
    },
  });
  expect(url).toBe('https://openrouter.ai/api/v1/key');
  expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
  expect(snapshot).toEqual({
    items: [{ id: 'credits', displayName: { default: 'Credits', 'zh-Hans': '额度' }, remainingRatio: 0.745 }],
  });
  expect(snapshot.items[0]).not.toHaveProperty('resetsAt');
});

test('returns no items when the key has no spending cap', async () => {
  const snapshot = await readOpenRouterQuota(context(), {
    fetch: async () => Response.json({ data: { label: 'sk-or-v1-x', limit: null, limit_remaining: null, usage: 1 } }),
  });
  expect(snapshot).toEqual({ items: [] });
});

test('fails closed on a non-2xx key probe', async () => {
  await expect(
    readOpenRouterQuota(context(), { fetch: async () => new Response('nope', { status: 401 }) }),
  ).rejects.toThrow(/key/i);
});

function context() {
  return {
    credentials: {
      read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
      refresh: async () => {
        throw new Error('durable OpenRouter keys must not refresh');
      },
    } satisfies CredentialPort<OpenRouterCredential>,
    options: {},
    signal: new AbortController().signal,
  };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/plugins/openrouter/src/quota`

Expected: FAIL because `./quota` does not exist.

- [ ] **Step 3: Implement quota read**

Create `packages/plugins/openrouter/src/quota/quota.ts`:

```ts
import type { AccountContext, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_LABEL = { default: 'Credits', 'zh-Hans': '额度' } as const;

export async function readOpenRouterQuota(
  context: AccountContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const { value } = await context.credentials.read();
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(KEY_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${value.apiKey}` },
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new Error('OpenRouter key probe network failure');
  }
  if (!response.ok) throw new Error(`OpenRouter key probe failed (HTTP ${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('OpenRouter key probe returned invalid JSON');
  }
  if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
    throw new Error('OpenRouter key probe returned invalid data');
  }
  const limit = payload.data.limit;
  const remaining = payload.data.limit_remaining;
  if (limit === null) return { items: [] };
  if (typeof limit !== 'number' || !Number.isFinite(limit) || typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    throw new Error('OpenRouter key probe returned invalid data');
  }
  const remainingRatio = limit <= 0 ? 0 : Math.min(1, Math.max(0, remaining / limit));
  return {
    items: [{ id: 'credits', displayName: CREDITS_LABEL, remainingRatio }],
  };
}
```

Do not call `/api/v1/credits` or `/api/v1/auth/key`. Do not set `resetsAt` from `limit_reset`.

Create `packages/plugins/openrouter/src/quota/index.ts`:

```ts
export { readOpenRouterQuota } from './quota';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/plugins/openrouter/src/quota`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openrouter/src/quota
git commit -m "feat(openrouter): expose read-only key credit remaining ratio"
```

---

### Task 6: Register the OAuth adapter descriptor

**Files:**
- Create: `packages/plugins/openrouter/src/plugin/plugin.ts`
- Create: `packages/plugins/openrouter/src/plugin/plugin.test.ts`
- Create: `packages/plugins/openrouter/src/plugin/index.ts`
- Create: `packages/plugins/openrouter/src/index.ts`
- Create: `packages/plugins/openrouter/oauth.smoke.ts`

**Interfaces:**
- Consumes: `loginOpenRouter`, `discoverOpenRouterModels`, `createOpenRouterRuntime`, `readOpenRouterQuota`, `credentialSchema`.
- Produces: `createOpenRouterPlugin(presentationText?)`, `englishPresentationText`, `OPENROUTER_PLUGIN_VERSION`.

- [ ] **Step 1: Write the failing descriptor test**

Create `packages/plugins/openrouter/src/plugin/plugin.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import packageJson from '../../package.json' with { type: 'json' };
import { OPENROUTER_PLUGIN_VERSION } from '../index';
import { createOpenRouterPlugin, englishPresentationText } from './plugin';
import type { OpenRouterCredential } from '../schema/index';

test('exports a versioned OpenRouter OAuth descriptor', async () => {
  const plugin = createOpenRouterPlugin();
  const adapter = await adapterFrom(plugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with OpenRouter');
  expect(plugin.metadata.icon).toBe('openrouter');
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: 6 * 60 * 60_000 });
  expect(adapter.refreshCredential).toBeUndefined();
  expect(adapter.credentialImports).toBeUndefined();
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(OPENROUTER_PLUGIN_VERSION).toBe(packageJson.version);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
});

test('accepts localized copy without adding account options', async () => {
  const adapter = await adapterFrom(
    createOpenRouterPlugin({
      ...englishPresentationText,
      pluginLabel: 'OpenRouter',
      pluginDescription: 'Connexion OpenRouter',
      adapterLabel: 'Connexion OpenRouter',
    }),
  );
  expect(adapter.displayName).toBe('Connexion OpenRouter');
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, OpenRouterCredential>> {
  let registered: OAuthAdapter<Record<string, never>, OpenRouterCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, OpenRouterCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('OpenRouter OAuth adapter was not registered');
  return registered;
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/plugins/openrouter/src/plugin`

Expected: FAIL because `./plugin` does not exist.

- [ ] **Step 3: Implement the descriptor and package entry**

Create `packages/plugins/openrouter/src/plugin/plugin.ts`:

```ts
import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import {
  discoverOpenRouterModels,
  initialOpenRouterCatalogFallback,
  OPENROUTER_CATALOG_TTL_MS,
} from '../catalog/index';
import { loginOpenRouter, type OpenRouterOAuthOptions } from '../oauth/index';
import { readOpenRouterQuota } from '../quota/index';
import { createOpenRouterRuntime } from '../runtime/index';
import { credentialSchema, type OpenRouterCredential } from '../schema/index';

export type OpenRouterPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
};

export const englishPresentationText: OpenRouterPresentationText = {
  pluginLabel: 'OpenRouter',
  pluginDescription: 'Sign in with OpenRouter to mint an API key',
  adapterLabel: 'Login with OpenRouter',
  waitingForAuthorization: 'Waiting for OpenRouter authorization',
};

export function createOpenRouterPlugin(
  presentationText: OpenRouterPresentationText = englishPresentationText,
  dependencies: OpenRouterOAuthOptions = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, OpenRouterCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      if (presentationText.waitingForAuthorization !== undefined) {
        context.progress(presentationText.waitingForAuthorization);
      }
      return await loginOpenRouter(context, {
        ...dependencies,
        ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
      });
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: OPENROUTER_CATALOG_TTL_MS },
      discover: (context) =>
        discoverOpenRouterModels(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
      initialFallback: initialOpenRouterCatalogFallback,
    },
    quota: {
      read: (context) =>
        readOpenRouterQuota(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
    },
    createRuntime: (context) => createOpenRouterRuntime(context, dependencies),
  };
  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'OpenRouter',
      description:
        presentationText.pluginDescription ?? 'Sign in with OpenRouter to mint an API key',
      icon: 'openrouter',
    },
  );
}
```

Create `packages/plugins/openrouter/src/plugin/index.ts`:

```ts
export {
  createOpenRouterPlugin,
  englishPresentationText,
  type OpenRouterPresentationText,
} from './plugin';
```

Create `packages/plugins/openrouter/src/index.ts`:

```ts
import packageJson from '../package.json' with { type: 'json' };
import { createOpenRouterPlugin, englishPresentationText } from './plugin/index';

export * from './catalog/index';
export * from './oauth/index';
export { createOpenRouterPlugin, englishPresentationText, type OpenRouterPresentationText } from './plugin/index';
export * from './quota/index';
export * from './runtime/index';
export * from './schema/index';

export const OPENROUTER_PLUGIN_VERSION = packageJson.version;

export default createOpenRouterPlugin(englishPresentationText);
```

Create `packages/plugins/openrouter/oauth.smoke.ts`:

```ts
import { expect, test } from 'bun:test';

import plugin, { OPENROUTER_PLUGIN_VERSION } from './dist/index.js';
import packageJson from './package.json' with { type: 'json' };

test('built artifact exports the OpenRouter descriptor', () => {
  expect(plugin.apiVersion).toBe(1);
  expect(OPENROUTER_PLUGIN_VERSION).toBe(packageJson.version);
});
```

- [ ] **Step 4: Run plugin tests and confirm they pass**

Run: `bun test packages/plugins/openrouter/src`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openrouter/src/plugin packages/plugins/openrouter/src/index.ts packages/plugins/openrouter/oauth.smoke.ts
git commit -m "feat(openrouter): register the oauth adapter descriptor"
```

---

### Task 7: Embed the built-in plugin and add the changeset

**Files:**
- Modify: `packages/core/src/plugins/builtins.ts`
- Modify: `packages/core/src/plugins/builtins.test.ts`
- Modify: `packages/core/package.json`
- Modify: `.changeset/config.json`
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`
- Modify: `packages/cli/__tests__/binary-build.test.ts`
- Create: `.changeset/openrouter-oauth.md`
- Modify: `bun.lock` via `bun install`

**Interfaces:**
- Consumes: `createOpenRouterPlugin`, `OPENROUTER_PLUGIN_VERSION`.
- Produces: `@aio-proxy/plugin-openrouter` in `BUILT_IN_PLUGIN_PACKAGE_NAMES` and `createEmbeddedBuiltIns()`, listed alphabetically between `@aio-proxy/plugin-openai-chatgpt` and `@aio-proxy/plugin-xai-grok`.

These host files are the same ones Claude/Muse (and any other in-flight OAuth plugin) PRs edit. Rebase before merging; do not force-push.

- [ ] **Step 1: Write the failing built-in and CLI enumeration updates**

In `packages/core/src/plugins/builtins.test.ts`, insert `'@aio-proxy/plugin-openrouter'` into `expectedBuiltIns` between chatgpt and xai-grok. Update the `builtIn` all-true array length (today `6` trues → `7`). Add `resolveOAuth('@aio-proxy/plugin-openrouter', 'default')` next to the other `toBeDefined()` checks. In the zh-Hans copy test, add:

```ts
  const openrouter = snapshot.registry.resolveOAuth('@aio-proxy/plugin-openrouter', 'default');
  const openrouterPlugin = snapshot.plugins.get('@aio-proxy/plugin-openrouter');
  expect(resolveLocalizedText(openrouterPlugin?.displayName ?? '', 'zh-Hans')).toBe('OpenRouter');
  expect(resolveLocalizedText(openrouterPlugin?.description ?? '', 'zh-Hans')).toBe(
    '使用 OpenRouter 登录并签发 API key',
  );
  expect(resolveLocalizedText(openrouter?.displayName ?? '', 'zh-Hans')).toBe('使用 OpenRouter 登录');
```

In `packages/cli/src/plugin-commands/plugin/add.test.ts`, add `'@aio-proxy/plugin-openrouter'` to the sorted `toEqual` list (between chatgpt and xai-grok).

In `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`, add `'@aio-proxy/plugin-openrouter'` to the `builtIns` array.

In `packages/cli/__tests__/binary-build.test.ts`, add `expect(stdout).toContain('@aio-proxy/plugin-openrouter');` next to the other plugin list assertions.

- [ ] **Step 2: Run the focused host tests and confirm they fail**

Run:

```bash
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts
bun test packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
```

Expected: FAIL because the package is not embedded and the lists do not contain `@aio-proxy/plugin-openrouter`.

Do not run `packages/cli/__tests__/binary-build.test.ts` until the plugin is registered and the package builds; that test compiles the standalone binary.

- [ ] **Step 3: Register the plugin and lockfile**

In `packages/core/src/plugins/builtins.ts`:

1. Import:

```ts
import { createOpenRouterPlugin, OPENROUTER_PLUGIN_VERSION } from '@aio-proxy/plugin-openrouter';
```

2. Insert `'@aio-proxy/plugin-openrouter'` in `BUILT_IN_PLUGIN_PACKAGE_NAMES` between chatgpt and xai-grok.

3. Insert this entry in `createEmbeddedBuiltIns()` in the same order:

```ts
    {
      packageName: '@aio-proxy/plugin-openrouter',
      version: OPENROUTER_PLUGIN_VERSION,
      descriptor: createOpenRouterPlugin({
        pluginLabel: 'OpenRouter',
        pluginDescription: localized(
          'Sign in with OpenRouter to mint an API key',
          '使用 OpenRouter 登录并签发 API key',
        ),
        adapterLabel: localized('Login with OpenRouter', '使用 OpenRouter 登录'),
        waitingForAuthorization: localized(
          'Waiting for OpenRouter authorization',
          '正在等待 OpenRouter 授权',
        ),
      }) as unknown as PluginDescriptor<unknown>,
    },
```

In `packages/core/package.json` dependencies, add in alphabetical position:

```json
    "@aio-proxy/plugin-openrouter": "workspace:*",
```

In `.changeset/config.json` `fixed[0]`, add `"@aio-proxy/plugin-openrouter"` in alphabetical position (after `@aio-proxy/plugin-openai-chatgpt`, before `@aio-proxy/plugin-sdk`).

Create `.changeset/openrouter-oauth.md`:

```md
---
"@aio-proxy/plugin-openrouter": minor
"@aio-proxy/shared": minor
"@aio-proxy/core": minor
"@aio-proxy/cli": minor
"@aio-proxy/server": minor
"aio-proxy": minor
---

Add a built-in OpenRouter OAuth plugin that signs in with PKCE, mints a durable user-controlled API key, discovers models, and reads remaining key credits. Loopback parse now requires callback `state` only when the opened authorize URL sent `state`, so OpenRouter (no state echo) can finish without weakening ChatGPT or Antigravity CSRF.
```

Run: `bun install`

Expected: `bun.lock` updates and `@aio-proxy/plugin-openrouter` links.

- [ ] **Step 4: Run package tests, build, and check**

```bash
bun test packages/plugins/openrouter/src
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/loopback
bun test packages/server/src/oauth-login-session
bun test packages/cli/src/plugin-commands/plugin/add.test.ts
bun test packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
bun run --cwd packages/plugins/openrouter build
bun run --cwd packages/plugins/openrouter test:artifact
bun run check
```

Expected: all listed tests PASS, Rslib emits `dist/`, oxlint + oxfmt check are clean.

Final gate (do not skip before calling the work done):

```bash
bun run preflight
```

Expected: type-aware lint, format check, and the full unit-test graph pass. `preflight` is `lint:types` + `format:check` + `test` (which includes `test:unit` and `test:artifact` via turbo).

`packages/cli/__tests__/binary-build.test.ts` runs as part of CLI artifact/unit coverage. If it is not in the commands above and `preflight` does not execute it, run it once after `bun run --cwd packages/plugins/openrouter build`.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/core/src/plugins/builtins.ts \
  packages/core/src/plugins/builtins.test.ts \
  packages/core/package.json \
  .changeset/config.json \
  .changeset/openrouter-oauth.md \
  packages/cli/src/plugin-commands/plugin/add.test.ts \
  packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts \
  packages/cli/__tests__/binary-build.test.ts \
  bun.lock \
  packages/plugins/openrouter
git commit -m "feat(openrouter): embed the built-in plugin and add the changeset"
```

---

## Completion Check

- Seven `feat(openrouter):` commits exist: host parse, login, catalog, runtime, quota, descriptor, builtins.
- `git grep -n "plugin-openrouter" packages/core/src/plugins/builtins.ts packages/cli .changeset/config.json` shows the new package.
- `refreshCredential` is absent from the adapter. `expiresAt` is absent from the login result.
- No `OPENROUTER_API_KEY` paste path. No CPA importer. No `/api/v1/credits` call. No plugin-sdk file changes.
- Handwritten non-test files in `packages/plugins/openrouter/src` are each ≤500 lines.
- `bun run check` passed. `bun run preflight` is the full repo gate.
