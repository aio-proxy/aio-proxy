# Muse Code OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in Muse Code OAuth plugin that logs in with RFC 8628 on `auth.meta.com`, mints a durable Model API key once, discovers Meta models with that key, invokes them through OpenAI Responses on `api.meta.ai/v1`, and reads subscription usage without reminting.

**Architecture:** A new `packages/plugins/muse-code` workspace owns device login, one-shot key mint, catalog, Responses runtime, and read-only quota. The persisted credential holds both the non-refreshable Meta account token and the minted `apiKey`. Catalog and inference use only `apiKey`. Quota re-reads `POST /muse-code/key` with an empty body. Core only embeds the descriptor. No plugin-sdk changes.

**Tech Stack:** Bun, TypeScript, `@aio-proxy/plugin-sdk`, `@ai-sdk/openai` (catalog `4.0.4`), `es-toolkit` (catalog), Rslib, Bun test.

**Spec:** [docs/superpowers/specs/2026-09-06-muse-oauth-design.md](../specs/2026-09-06-muse-oauth-design.md)

Do not implement until that spec is `已确认，进入实现`.

## Global Constraints

- Package name is exactly `@aio-proxy/plugin-muse-code`; adapter id is exactly `default`; account options are an empty object.
- Device URL is exactly `https://auth.meta.com/oidc/device/authorization/`; token URL is exactly `https://auth.meta.com/oidc/device/token/`; client ID is exactly `1031625952748946`.
- Every Meta OIDC and key request sends `Accept: application/json` and `x-api-version: 1.0.0`, and sets `aioProxy: { traffic: 'control' }`.
- Device token is non-refreshable. Do **not** implement `refreshCredential`. Do **not** send `grant_type=refresh_token`.
- Mint with `{ onboard: true }` only once, immediately after a successful device token, with a 20s timeout. Persist `apiKey`. Never remint from catalog, runtime, or `currentMuseCodeCredential`.
- Inference base is exactly `https://api.meta.ai/v1`. Authorization on `/v1` is Bearer **apiKey**, never the oauth token.
- Language models use `@ai-sdk/openai` Responses (`openai.responses(modelId)`). Catalog `extra.protocol` is always `openai-response`.
- Quota is read-only. Re-read `POST https://api.meta.ai/muse-code/key` with `{}` (no `onboard`). Classify network / timeout / 408 / 429 / 5xx as retryable. Do not persist a key returned from quota. Zero or negative `window_duration_mins` is a rolling window, not `0 hours`.
- No CPA importer, no `MODEL_API_KEY` paste login, no Z.AI / Claude / OpenRouter, no plugin-sdk changes, no raw capability.
- Use Provider ID, Provider priority, and Provider weight terminology from `AGENTS.md`. Prefer `es-toolkit` (`isPlainObject`) and Bun APIs (`Bun.CryptoHasher`).
- Handwritten non-test files stay under 500 lines; split by responsibility before 400. New modules with a colocated test use a same-name directory (`oauth/index.ts`, `oauth/oauth.ts`, `oauth/oauth.test.ts`). Task Create / `bun test` / `git add` paths must use that layout. Do not create flat `src/oauth.ts` or `src/catalog.ts` files.
- Package version is `0.19.2`, never `0.0.0`.
- Fetch is `options.fetch ?? context.fetch ?? globalThis.fetch`.
- Every interactive `login()` sends `{ onboard: true }`. Catalog / runtime / quota never send `onboard`.
- Control-plane HTTP and `POST /muse-code/key` live in `src/control/` (`control/http.ts` and `control/key.ts` are private to that directory). Login, catalog, and quota import them from `../control`. Do not put those files under `oauth/`, do not deep-import `control/http` or `control/key`, and do not re-export `control` from `oauth/index.ts` or `src/index.ts`.
- v1 catalog is Spark language only. Drop `muse-image-`. `imageModel` always throws.
- Login errors must not include payment URLs, tokens, or upstream bodies. Host maps them to `AUTHORIZATION_FAILED`.
- Merge order: Claude, then OpenRouter, then this PR. Last task inserts the package name; do not paste a six-plugin snapshot or backfill missing xAI list entries.
- Every non-trivial behavior follows RED → verify failure → minimal GREEN → verify pass.
- Commits use `feat(muse-code): ...`. Author the changeset with `bun changeset`. Do not hand-write a fixed filename. Do not run `changeset version` / `publish`.

---

## File Structure

Create `packages/plugins/muse-code/` with same-name directories (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`):

- `src/schema/index.ts`, `schema/schema.ts`: persisted `MuseCodeCredential` Zod schema and type.
- `src/oauth/index.ts`, `oauth/oauth.ts`, `oauth/oauth.test.ts`: device authorization, polling, login, `museLoginResult`, `currentMuseCodeCredential`.
- `src/control/index.ts`, `control/http.ts`, `control/key.ts`: control-traffic fetch and `POST /muse-code/key` (used by login, catalog, and quota).
- `src/catalog/index.ts`, `catalog/catalog.ts`, `catalog/catalog.test.ts`: `GET /v1/models`, Spark-only classification, curated fallback.
- `src/quota/index.ts`, `quota/quota.ts`, `quota/quota.test.ts`: empty-body key read → `OAuthQuotaSnapshot` (no remint, no reset).
- `src/runtime/index.ts`, `runtime/runtime.ts`, `runtime/runtime.test.ts`: Responses ProviderV4 and apiKey dynamic fetch.
- `src/plugin/index.ts`, `plugin/plugin.ts`, `plugin/plugin.test.ts`: OAuth adapter assembly; **omit** `refreshCredential` and `credentialImports`.
- `src/index.ts`: package exports, version, default descriptor. Does not re-export `control`.
- Package config: `package.json`, `tsconfig.json`, `rslib.config.ts`, `oauth.smoke.ts`.

Modify host files only where built-in identity is enumerated (last task):

- `packages/core/src/plugins/builtins.ts`
- `packages/core/src/plugins/builtins.test.ts`
- `packages/core/package.json`
- `.changeset/config.json`
- `packages/cli/src/plugin-commands/plugin/add.test.ts`
- `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`
- `packages/cli/__tests__/binary-build.test.ts`
- `bun.lock`
- `.changeset/*.md` (generated)

---

### Task 1: Package shell, credential schema, and stable identity

**Files:**
- Create: `packages/plugins/muse-code/package.json`
- Create: `packages/plugins/muse-code/tsconfig.json`
- Create: `packages/plugins/muse-code/rslib.config.ts`
- Create: `packages/plugins/muse-code/src/schema/schema.ts`
- Create: `packages/plugins/muse-code/src/schema/index.ts`
- Create: `packages/plugins/muse-code/src/oauth/oauth.ts`
- Create: `packages/plugins/muse-code/src/oauth/index.ts`
- Test: `packages/plugins/muse-code/src/oauth/oauth.test.ts`

**Interfaces:**
- Consumes: `zod` from `@aio-proxy/plugin-sdk`.
- Produces: `MuseCodeCredential`, `credentialSchema`, `museLoginResult(credential)`, `currentMuseCodeCredential(port, options?)`.

- [ ] **Step 1: Write the failing identity tests**

Create `packages/plugins/muse-code/package.json`:

```json
{
  "name": "@aio-proxy/plugin-muse-code",
  "version": "0.19.2",
  "private": true,
  "type": "module",
  "files": ["dist"],
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
    "@ai-sdk/openai": "catalog:",
    "@aio-proxy/plugin-sdk": "workspace:*",
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

Create `packages/plugins/muse-code/tsconfig.json`:

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

Create `packages/plugins/muse-code/rslib.config.ts`:

```ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig();
```

Create `packages/plugins/muse-code/src/oauth/oauth.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { currentMuseCodeCredential, museLoginResult } from './oauth';
import type { MuseCodeCredential } from '../schema';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'muse-key-secret',
  email: '  Person@Example.com ',
  accountId: 'user-1',
};

describe('museLoginResult', () => {
  test('fingerprints account id first and normalizes the email label', () => {
    const digest = new Bun.CryptoHasher('sha256').update('account:user-1').digest('hex');
    expect(museLoginResult(credential)).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `muse-${digest.slice(0, 12)}`,
      accountLabel: 'person@example.com',
      credentials: {
        oauthAccessToken: 'oauth-secret',
        apiKey: 'muse-key-secret',
        email: 'person@example.com',
        accountId: 'user-1',
      },
    });
  });

  test('falls back to normalized email identity when account id is missing', () => {
    const digest = new Bun.CryptoHasher('sha256').update('email:person@example.com').digest('hex');
    const result = museLoginResult({
      oauthAccessToken: 'oauth-secret',
      apiKey: 'muse-key-secret',
      email: 'Person@Example.com',
    });
    expect(result.fingerprint).toBe(`sha256:${digest}`);
    expect(result.suggestedKey).toBe(`muse-${digest.slice(0, 12)}`);
    expect(result.accountLabel).toBe('person@example.com');
  });

  test('does not hash tokens when identity is missing', () => {
    expect(() =>
      museLoginResult({ oauthAccessToken: 'oauth-secret', apiKey: 'muse-key-secret' }),
    ).toThrow('stable account identity');
  });
});

describe('currentMuseCodeCredential', () => {
  test('returns the stored credential without refreshing or reminting', async () => {
    let refreshes = 0;
    const port: CredentialPort<MuseCodeCredential> = {
      read: async () => ({ revision: 1, value: credential }),
      refresh: async () => {
        refreshes += 1;
        throw new Error('Muse Code must not refresh');
      },
    };
    await expect(currentMuseCodeCredential(port)).resolves.toEqual(credential);
    expect(refreshes).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test packages/plugins/muse-code/src/oauth/oauth.test.ts`

Expected: FAIL because `./oauth` and `../schema` do not exist.

- [ ] **Step 3: Implement schema, identity, and read-only current credential**

Create `packages/plugins/muse-code/src/schema/schema.ts`:

```ts
import { zod } from '@aio-proxy/plugin-sdk';

export const credentialSchema = zod.object({
  oauthAccessToken: zod.string().min(1),
  apiKey: zod.string().min(1),
  email: zod.string().min(1).optional(),
  accountId: zod.string().min(1).optional(),
});

export type MuseCodeCredential = zod.infer<typeof credentialSchema>;
```

Create `packages/plugins/muse-code/src/oauth/oauth.ts` with only the identity + current-credential surface (login lands in Task 2):

```ts
import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';

export type MuseCodeOAuthOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
};

export function normalizeMuseEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function museLoginResult(credential: MuseCodeCredential) {
  const email = normalizeMuseEmail(credential.email);
  const accountId = credential.accountId?.trim() || undefined;
  const normalized: MuseCodeCredential = {
    oauthAccessToken: credential.oauthAccessToken,
    apiKey: credential.apiKey,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
  };
  let identity: string | undefined;
  if (accountId !== undefined) identity = `account:${accountId}`;
  else if (email !== undefined) identity = `email:${email}`;
  if (identity === undefined) throw new Error('Muse Code key response is missing a stable account identity');
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `muse-${digest.slice(0, 12)}`,
    accountLabel: email ?? accountId ?? 'Muse Code',
    credentials: normalized,
  };
}

export async function currentMuseCodeCredential(
  port: CredentialPort<MuseCodeCredential>,
  options: MuseCodeOAuthOptions = {},
): Promise<MuseCodeCredential> {
  options.signal?.throwIfAborted();
  const current = await port.read();
  options.signal?.throwIfAborted();
  return current.value;
}
```

Create `packages/plugins/muse-code/src/schema/index.ts`:

```ts
export { credentialSchema, type MuseCodeCredential } from './schema';
```

Create `packages/plugins/muse-code/src/oauth/index.ts`:

```ts
export { currentMuseCodeCredential, museLoginResult, normalizeMuseEmail } from './oauth';
export type { MuseCodeOAuthOptions } from './oauth';
```

- [ ] **Step 4: Verify GREEN and refresh the lockfile**

Run: `bun test packages/plugins/muse-code/src/oauth/oauth.test.ts`

Expected: PASS.

Run: `bun install --lockfile-only`

Expected: `bun.lock` lists `@aio-proxy/plugin-muse-code` with workspace / catalog dependencies only.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code bun.lock
git commit -m "feat(muse-code): add plugin package and account identity"
```

---

### Task 2: Device-code login and one-shot key mint

**Files:**
- Create: `packages/plugins/muse-code/src/control/http.ts`
- Create: `packages/plugins/muse-code/src/control/key.ts`
- Create: `packages/plugins/muse-code/src/control/index.ts`
- Create: `packages/plugins/muse-code/src/oauth/oauth.test-support.ts`
- Modify: `packages/plugins/muse-code/src/oauth/oauth.ts`
- Test: `packages/plugins/muse-code/src/oauth/oauth.login.test.ts`

**Interfaces:**
- Consumes: `OAuthLoginContext`, `museLoginResult`, `MuseCodeOAuthOptions`.
- Produces: `loginMuseCode(context, options)`, `requestMuseCodeKey(accessToken, options)`, `MUSE_CLIENT_ID`, key/device URL constants.

- [ ] **Step 1: Write the failing login + mint tests**

Create `packages/plugins/muse-code/src/oauth/oauth.test-support.ts`:

```ts
import { expect } from 'bun:test';

import type { OAuthLoginContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export const DEVICE = 'https://auth.meta.com/oidc/device/authorization/';
export const TOKEN = 'https://auth.meta.com/oidc/device/token/';
export const KEY = 'https://api.meta.ai/muse-code/key';

export function loginContext(
  presented: unknown[],
  progress: unknown[] = [],
  signal: AbortSignal = new AbortController().signal,
): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      presentAuthorizeUrl: async () => {},
      loopback: async () => {
        throw new Error('Muse Code must not use loopback');
      },
    },
    progress: (message) => progress.push(message),
    signal,
  };
}

export function sequenceFetch(requests: Request[], responses: Response[]): RuntimeFetch {
  return async (input, init) => {
    expect((init as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (response === undefined) throw new Error('unexpected request');
    return response;
  };
}
```

Create `packages/plugins/muse-code/src/oauth/oauth.login.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { loginMuseCode } from './oauth';
import { DEVICE, KEY, TOKEN, loginContext, sequenceFetch } from './oauth.test-support';

describe('Muse Code device login', () => {
  test('polls pending and slow_down then mints a key with onboard true', async () => {
    const requests: Request[] = [];
    const presented: unknown[] = [];
    const progress: unknown[] = [];
    const sleeps: number[] = [];
    const result = await loginMuseCode(loginContext(presented, progress), {
      fetch: sequenceFetch(requests, [
        Response.json({
          device_code: 'device-1',
          user_code: 'CODE-1',
          verification_uri: 'https://auth.meta.com/activate',
          verification_uri_complete: 'https://auth.meta.com/activate?user_code=CODE-1',
          expires_in: 600,
          interval: 1,
        }),
        Response.json({ error: 'authorization_pending' }, { status: 400 }),
        Response.json({ error: 'slow_down' }, { status: 400 }),
        Response.json({ access_token: 'oauth-access' }),
        Response.json({
          api_key: 'minted-key',
          user_email: 'Person@Example.com',
          user_id: 'user-1',
          is_subs_active: true,
        }),
      ]),
      now: () => 1_700_000_000_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      deviceInstructions: 'Enter code',
      waitingForAuthorization: 'Waiting for Muse authorization',
    });

    expect(requests.map((request) => request.url)).toEqual([DEVICE, TOKEN, TOKEN, TOKEN, KEY]);
    expect(requests[0]?.headers.get('accept')).toBe('application/json');
    expect(requests[0]?.headers.get('x-api-version')).toBe('1.0.0');
    expect(Object.fromEntries(await requests[0]!.formData())).toEqual({ client_id: '1031625952748946' });
    expect(Object.fromEntries(await requests[1]!.formData())).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: '1031625952748946',
      device_code: 'device-1',
    });
    expect(await requests[4]!.json()).toEqual({ onboard: true });
    expect(requests[4]?.headers.get('authorization')).toBe('Bearer oauth-access');
    expect(presented).toEqual([
      {
        url: 'https://auth.meta.com/activate?user_code=CODE-1',
        userCode: 'CODE-1',
        instructions: 'Enter code\n\nCODE-1',
      },
    ]);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(progress).toEqual(['Waiting for Muse authorization']);
    const digest = new Bun.CryptoHasher('sha256').update('account:user-1').digest('hex');
    expect(result).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `muse-${digest.slice(0, 12)}`,
      accountLabel: 'person@example.com',
      credentials: {
        oauthAccessToken: 'oauth-access',
        apiKey: 'minted-key',
        email: 'person@example.com',
        accountId: 'user-1',
      },
    });
    expect(result).not.toHaveProperty('expiresAt');
  });

  test('fails login when the subscription is inactive or api_key is missing', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ access_token: 'oauth-access' }),
            Response.json({ is_subs_active: false, api_key: 'ignored' }),
          ],
        ),
        sleep: async () => {},
      }),
    ).rejects.toThrow('inactive');

    let paymentError: unknown;
    try {
      await loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ access_token: 'oauth-access' }),
            Response.json({
              require_payment: true,
              action_url: 'https://meta.ai/pay',
            }),
          ],
        ),
        sleep: async () => {},
      });
    } catch (cause) {
      paymentError = cause;
    }
    expect(paymentError).toBeInstanceOf(Error);
    expect(String(paymentError)).toMatch(/payment_required/);
    expect(String(paymentError)).not.toContain('https://meta.ai/pay');
    expect(String(paymentError)).not.toContain('oauth-access');
  });

  test('classifies denied, expired, timeout, and abort', async () => {
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ error: 'access_denied' }),
          ],
        ),
      }),
    ).rejects.toThrow('denied');

    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 600,
              interval: 1,
            }),
            Response.json({ error: 'expired_token' }),
          ],
        ),
      }),
    ).rejects.toThrow('expired');

    let now = 0;
    await expect(
      loginMuseCode(loginContext([]), {
        fetch: sequenceFetch(
          [],
          [
            Response.json({
              device_code: 'device-1',
              user_code: 'CODE-1',
              verification_uri: 'https://auth.meta.com/activate',
              expires_in: 1,
              interval: 1,
            }),
            Response.json({ error: 'authorization_pending' }, { status: 400 }),
          ],
        ),
        now: () => {
          now += 1_000;
          return now;
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow('timed out');

    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(
      loginMuseCode(
        { ...loginContext([]), signal: controller.signal },
        {
          fetch: async (_input, init) => {
            init?.signal?.throwIfAborted();
            throw new Error('aborted request must not return');
          },
        },
      ),
    ).rejects.toBe(reason);
  });
});
```

- [ ] **Step 2: Run the login tests and verify RED**

Run: `bun test packages/plugins/muse-code/src/oauth/oauth.login.test.ts`

Expected: FAIL because `loginMuseCode` is not exported.

- [ ] **Step 3: Implement control HTTP, key mint, and device login**

Create `packages/plugins/muse-code/src/control/http.ts`:

```ts
import type { RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export const MUSE_API_VERSION = '1.0.0';

export class MuseCodeHttpError extends Error {
  override readonly name = 'MuseCodeHttpError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function museControlHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  headers.set('x-api-version', MUSE_API_VERSION);
  return headers;
}

export async function museControlFetch(
  fetcher: RuntimeFetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, { ...init, aioProxy: { traffic: 'control' } } as RuntimeRequestInit);
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new MuseCodeHttpError('Muse Code request failed', true);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
```

Create `packages/plugins/muse-code/src/control/key.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { MuseCodeHttpError, museControlFetch, museControlHeaders } from './http';

export const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';
export const MUSE_KEY_TIMEOUT_MS = 20_000;

export type MuseCodeKeyResponse = {
  readonly api_key?: string;
  readonly user_email?: string;
  readonly user_id?: string;
  readonly is_subs_active?: boolean;
  readonly subs_tier_id?: string;
  readonly subs_tier_name?: string;
  readonly require_payment?: boolean;
  readonly require_payment_action_url?: string;
  readonly action_url?: string | null;
  readonly subs_usage?: {
    readonly window?: MuseCodeUsageWindow | null;
    readonly weekly?: MuseCodeUsageWindow | null;
  } | null;
};

export type MuseCodeUsageWindow = {
  readonly used_percent?: number;
  readonly resets_at?: string | number;
  readonly window_duration_mins?: number;
};

export async function requestMuseCodeKey(
  accessToken: string,
  options: { readonly fetch?: RuntimeFetch; readonly signal?: AbortSignal; readonly onboard?: boolean },
): Promise<MuseCodeKeyResponse> {
  const timeout = AbortSignal.timeout(MUSE_KEY_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await museControlFetch(options.fetch ?? globalThis.fetch, MUSE_KEY_URL, {
    method: 'POST',
    headers: museControlHeaders({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(options.onboard === true ? { onboard: true } : {}),
    redirect: 'error',
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new MuseCodeHttpError('Muse Code key exchange failed', [408, 429].includes(response.status) || response.status >= 500, response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Muse Code key exchange returned invalid JSON');
  }
  if (!isPlainObject(payload)) throw new Error('Muse Code key exchange returned invalid JSON');
  return payload as MuseCodeKeyResponse;
}

export function paymentActionUrl(payload: MuseCodeKeyResponse): string | undefined {
  const action = payload.action_url?.trim() || payload.require_payment_action_url?.trim();
  return action === '' ? undefined : action;
}
```

Do not put `paymentActionUrl` on thrown errors or `progress()`. Quota maps `MuseCodeHttpError` with `status: 429` to `MuseCodeQuotaError` `{ retryable: true, status: 429 }`.

Create `packages/plugins/muse-code/src/control/index.ts`:

```ts
export {
  MuseCodeHttpError,
  isRetryableStatus,
  museControlFetch,
  museControlHeaders,
  MUSE_API_VERSION,
} from './http';
export {
  MUSE_KEY_TIMEOUT_MS,
  MUSE_KEY_URL,
  paymentActionUrl,
  requestMuseCodeKey,
  type MuseCodeKeyResponse,
  type MuseCodeUsageWindow,
} from './key';
```

Extend `packages/plugins/muse-code/src/oauth/oauth.ts` with `loginMuseCode` (keep Task 1 exports). Import `museControlFetch`, `museControlHeaders`, and `requestMuseCodeKey` from `../control`. Re-export `loginMuseCode` from `src/oauth/index.ts`. Do not re-export control helpers from `oauth/index.ts`. The login function must:

1. POST form `{ client_id }` to `DEVICE` via `museControlFetch` + `museControlHeaders` + `Content-Type: application/x-www-form-urlencoded`.
2. Require `device_code`, `user_code`, and `verification_uri` or `verification_uri_complete`.
3. Default `expires_in` to 900 and `interval` to 5; poll with `max(interval, 5)` seconds.
4. Call `presentDeviceCode` with Kimi-style `\n\n${userCode}` instruction append for string and localized-object copy.
5. Poll immediately, then handle `authorization_pending`, `slow_down` (+5s or larger response interval), `access_denied`, `expired_token`, retryable HTTP as pending, deadline timeout, and `context.signal`.
6. Accept a token JSON that has `access_token` even when `expires_in` / `refresh_token` are absent; ignore those fields.
7. Call `requestMuseCodeKey(accessToken, { onboard: true, fetch, signal })`.
8. Fail when `is_subs_active === false`, when `api_key` is blank, or when `require_payment === true`. Throw `payment_required` **without** embedding `action_url`. Host login maps every adapter error to `AUTHORIZATION_FAILED`.
9. Fail when both `user_id` and normalized email are missing. `login()` cannot see the stored credential (`OAuthLoginContext` has no prior account). Do not invent sticky `accountId` reuse. If a later mint omits `user_id` after a previous `account:` fingerprint, host re-login fails; that is accepted v1.
10. Return `museLoginResult(...)` only after a non-blank `api_key` and identity exist. Throw before return on any mint failure. The plugin never writes the vault; host persist runs only after `login()` resolves. Omit `expiresAt`.
11. After a successful device authorization, treat token-poll 408 / 429 / 5xx and retryable network errors as pending (Kimi/xAI). Device-authorization 5xx still fails immediately. Add those tests in Task 2.

Private helpers must not embed tokens or response bodies in thrown errors. Localized instruction append:

```ts
function appendCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === 'string') return `${text}\n\n${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value}\n\n${code}`]),
  ) as LocalizedText;
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/plugins/muse-code/src/oauth/oauth.test.ts packages/plugins/muse-code/src/oauth/oauth.login.test.ts`

Expected: PASS. No real network. `onboard: true` appears only on the key request in the success test.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code
git commit -m "feat(muse-code): implement device login and key mint"
```

---

### Task 3: TTL catalog with Spark snapshot fallback

**Files:**
- Create: `packages/plugins/muse-code/src/catalog/catalog.ts`
- Create: `packages/plugins/muse-code/src/catalog/index.ts`
- Test: `packages/plugins/muse-code/src/catalog/catalog.test.ts`

**Interfaces:**
- Consumes: `currentMuseCodeCredential` from `../oauth`; `museControlFetch` and `museControlHeaders` from `../control`.
- Produces: `MUSE_CODE_CATALOG_TTL_MS`, `discoverMuseCodeModels(context, options?)`, `initialMuseCodeCatalogFallback(error)`.

- [ ] **Step 1: Write the failing catalog tests**

Create `packages/plugins/muse-code/src/catalog/catalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { discoverMuseCodeModels, initialMuseCodeCatalogFallback, MuseCodeCatalogError } from './catalog';
import type { MuseCodeCredential } from '../schema';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
  accountId: 'user-1',
};

describe('Muse Code catalog', () => {
  test('lists Spark language models with the minted key and drops image/voice ids', async () => {
    let request: Request | undefined;
    let traffic: unknown;
    const catalog = await discoverMuseCodeModels(context(), {
      fetch: async (input, init) => {
        traffic = (init as RuntimeRequestInit | undefined)?.aioProxy;
        request = new Request(input, init);
        return Response.json({
          data: [
            { id: 'muse-spark-1.3', name: 'ignored' },
            { id: 'muse-image-1.0' },
            { id: 'muse-voice-transcribe-1.0' },
            { id: '  ' },
            { id: 'other-model' },
          ],
        });
      },
    });
    expect(request?.url).toBe('https://api.meta.ai/v1/models');
    expect(request?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(request?.headers.get('x-api-version')).toBe('1.0.0');
    expect(traffic).toEqual({ traffic: 'control' });
    expect(catalog.language).toEqual([
      { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', extra: { protocol: 'openai-response' } },
    ]);
    expect(catalog.image).toEqual([]);
    expect(catalog.embedding).toEqual([]);
    expect(catalog.speech).toEqual([]);
    expect(catalog.transcription).toEqual([]);
  });

  test('falls back only for retryable discovery failures', () => {
    const fallback = initialMuseCodeCatalogFallback(new MuseCodeCatalogError('network', true));
    expect(fallback?.language.map((model) => model.id)).toEqual([
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ]);
    expect(fallback?.language.every((model) => model.extra)).toEqual(true);
    expect(initialMuseCodeCatalogFallback(new MuseCodeCatalogError('unauthorized', false, 401))).toBeUndefined();
    expect(initialMuseCodeCatalogFallback(new DOMException('cancelled', 'AbortError'))).toBeUndefined();
  });

  test('treats a successful empty catalog as authoritative', async () => {
    const catalog = await discoverMuseCodeModels(context(), {
      fetch: async () => Response.json({ data: [] }),
    });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  const port: CredentialPort<MuseCodeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('catalog must not refresh');
    },
  };
  return { credentials: port, options: {}, signal: new AbortController().signal };
}
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run: `bun test packages/plugins/muse-code/src/catalog/catalog.test.ts`

Expected: FAIL because `./catalog` does not exist.

- [ ] **Step 3: Implement discovery**

`catalog.ts` imports `currentMuseCodeCredential` from `../oauth` and `museControlFetch` / `museControlHeaders` from `../control`. Do not import `../oauth/http` or `../control/http`.

`discoverMuseCodeModels` must `currentMuseCodeCredential`, then `GET https://api.meta.ai/v1/models` with Bearer **apiKey**, `Accept: application/json`, `x-api-version: 1.0.0`, control traffic, and `context.signal`. Classify `muse-spark-` → language. Drop `muse-image-` and every other prefix. Overlay curated display names. `MuseCodeCatalogError` carries `retryable` (network / invalid JSON / 408 / 429 / 5xx = true; 401 / 403 = false). `initialMuseCodeCatalogFallback` returns the five Spark rows only when the error is a retryable `MuseCodeCatalogError`, and returns `undefined` for `AbortError` and non-retryable errors.

```ts
export const MUSE_CODE_CATALOG_TTL_MS = 6 * 60 * 60_000;
```

Create `packages/plugins/muse-code/src/catalog/index.ts`:

```ts
export {
  discoverMuseCodeModels,
  initialMuseCodeCatalogFallback,
  MuseCodeCatalogError,
  MUSE_CODE_CATALOG_TTL_MS,
} from './catalog';
```

Curated rows (language only, all `extra: { protocol: 'openai-response' }`):

- `muse-spark-1.3` / Muse Spark 1.3
- `muse-spark-1.3-contributor` / Muse Spark 1.3 (Contributor)
- `muse-spark-1.2` / Muse Spark 1.2
- `muse-spark-1.2-contributor` / Muse Spark 1.2 (Contributor)
- `muse-spark-1.1` / Muse Spark 1.1

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/plugins/muse-code/src/catalog/catalog.test.ts packages/plugins/muse-code/src/oauth/oauth.test.ts`

Expected: PASS. Catalog tests never call `/muse-code/key`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code/src/catalog
git commit -m "feat(muse-code): discover Meta models with minted key"
```

---

### Task 4: Responses runtime with minted key

**Files:**
- Create: `packages/plugins/muse-code/src/runtime/runtime.ts`
- Create: `packages/plugins/muse-code/src/runtime/index.ts`
- Test: `packages/plugins/muse-code/src/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: `createOpenAI` from `@ai-sdk/openai`, `currentMuseCodeCredential`.
- Produces: `createMuseCodeRuntime(context, options?)`, `createMuseCodeDynamicFetch(port, options?)`.

- [ ] **Step 1: Write the failing runtime tests**

```ts
import { describe, expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';
import { createMuseCodeDynamicFetch, createMuseCodeRuntime } from './runtime';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
};

describe('Muse Code runtime', () => {
  test('sends Responses traffic with the minted key and version header', async () => {
    const modelRequests: Request[] = [];
    const runtime = await createMuseCodeRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        expect(init?.aioProxy?.traffic ?? 'model').toBe('model');
        modelRequests.push(new Request(input, init));
        return Response.json({
          id: 'resp_1',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        });
      }) as RuntimeFetch,
    });

    await runtime.provider.languageModel('muse-spark-1.3').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(runtime.raw).toBeUndefined();
    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.url).toBe('https://api.meta.ai/v1/responses');
    expect(modelRequests[0]?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(modelRequests[0]?.headers.get('x-api-version')).toBe('1.0.0');
    expect(modelRequests[0]?.headers.get('authorization')).not.toContain('oauth-secret');
  });

  test('rejects image and embedding when the catalog has none', async () => {
    const runtime = await createMuseCodeRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: globalThis.fetch,
    });
    expect(() => runtime.provider.imageModel('muse-image-1.0')).toThrow('image');
    expect(() => runtime.provider.embeddingModel('embed')).toThrow('embedding');
  });

  test('dynamic fetch does not remint or send the oauth token', async () => {
    let captured: Request | undefined;
    const dynamicFetch = createMuseCodeDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
    });
    await dynamicFetch('https://api.meta.ai/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer dynamic-credential' },
      body: '{}',
    });
    expect(captured?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(captured?.headers.get('x-api-version')).toBe('1.0.0');
  });
});

function port(): CredentialPort<MuseCodeCredential> {
  return {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('runtime must not refresh');
    },
  };
}

function emptyCatalog(): ModelCatalog {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
```

If `doGenerate` shape drifts from the installed `@ai-sdk/openai` / `ai` 7 types, keep the URL/header assertions and use the same prompt object xAI’s `runtime.test.ts` uses in this repo.

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `bun test packages/plugins/muse-code/src/runtime/runtime.test.ts`

Expected: FAIL because `./runtime` does not exist.

- [ ] **Step 3: Implement the Responses provider**

```ts
import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

import { currentMuseCodeCredential, type MuseCodeOAuthOptions } from '../oauth';
import type { MuseCodeCredential } from '../schema';

export async function createMuseCodeRuntime(
  context: RuntimeContext<MuseCodeCredential, Record<string, never>>,
  options: MuseCodeOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const openai = createOpenAI({
    name: 'muse-code-oauth',
    baseURL: 'https://api.meta.ai/v1',
    apiKey: 'dynamic-credential',
    headers: { 'x-api-version': '1.0.0' },
    fetch: createMuseCodeDynamicFetch(context.credentials, { ...options, fetch: options.fetch ?? context.fetch }),
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openai.responses(modelId),
      embeddingModel: () => unsupported('embedding'),
      imageModel: () => unsupported('image'),
    },
  };
}
```

Dynamic fetch: `currentMuseCodeCredential` → clone request → set `Authorization: Bearer ${apiKey}` and `x-api-version: 1.0.0` → delete `content-length` → forward method/body/signal/redirect through `options.fetch ?? globalThis.fetch`. Do **not** set `aioProxy.traffic` on this hop. Do **not** call the key endpoint. Do **not** rewrite `/responses` JSON.

`src/runtime/index.ts` re-exports `createMuseCodeRuntime` and `createMuseCodeDynamicFetch`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/plugins/muse-code/src/runtime/runtime.test.ts`

Expected: PASS. Authorization header is the minted key.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code/src/runtime
git commit -m "feat(muse-code): route inference through Responses with minted key"
```

---

### Task 5: Read-only quota from the key endpoint

**Files:**
- Create: `packages/plugins/muse-code/src/quota/quota.ts`
- Create: `packages/plugins/muse-code/src/quota/index.ts`
- Test: `packages/plugins/muse-code/src/quota/quota.test.ts`

**Interfaces:**
- Consumes: `currentMuseCodeCredential` from `../oauth`; `requestMuseCodeKey` and `MuseCodeHttpError` from `../control` (onboard omitted).
- Produces: `readMuseCodeQuota(context, options?)`, `MuseCodeQuotaError`.

- [ ] **Step 1: Write the failing quota tests**

Create `packages/plugins/muse-code/src/quota/quota.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { MuseCodeQuotaError, readMuseCodeQuota } from './quota';
import type { MuseCodeCredential } from '../schema';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
  accountId: 'user-1',
};

test('maps window and weekly usage without reminting or persisting api_key', async () => {
  let body: unknown;
  let traffic: unknown;
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async (input, init) => {
      traffic = (init as RuntimeRequestInit | undefined)?.aioProxy;
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.meta.ai/muse-code/key');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe('Bearer oauth-secret');
      expect(request.headers.get('x-api-version')).toBe('1.0.0');
      body = await request.json();
      return Response.json({
        api_key: 'must-not-be-used',
        is_subs_active: true,
        subs_tier_name: 'Pro',
        subs_usage: {
          window: { used_percent: 25, resets_at: '2027-01-15T00:00:00Z', window_duration_mins: 60 },
          weekly: { used_percent: 'nope', resets_at: 1_767_972_193 },
        },
      });
    },
  });
  expect(body).toEqual({});
  expect(traffic).toEqual({ traffic: 'control' });
  expect(snapshot).toEqual({
    plan: 'Pro',
    items: [
      {
        id: '60m',
        displayName: { default: '1 hour', 'zh-Hans': '1 小时' },
        remainingRatio: 0.75,
        resetsAt: Date.parse('2027-01-15T00:00:00Z'),
      },
    ],
  });
});

test('accepts weekly percent and unix-second resets', async () => {
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { weekly: { used_percent: 10, resets_at: 1_767_972_193 } },
      }),
  });
  expect(snapshot.items).toEqual([
    {
      id: 'weekly',
      displayName: { default: 'Weekly quota', 'zh-Hans': '周配额' },
      remainingRatio: 0.9,
      resetsAt: 1_767_972_193_000,
    },
  ]);
});

test('treats a negative used_percent as an invalid window', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () =>
        Response.json({
          is_subs_active: true,
          subs_usage: { window: { used_percent: -1 } },
        }),
    }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: false });
});

test('classifies 429 as retryable and inactive subscription as permanent', async () => {
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response(null, { status: 429 }) }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: true, status: 429 });
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => Response.json({ is_subs_active: false }),
    }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: false });
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => Response.json({ is_subs_active: true, subs_usage: {} }),
    }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: false });
});

test('classifies timeout and 5xx as retryable quota failures', async () => {
  await expect(
    readMuseCodeQuota(context(), {
      fetch: async () => {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      },
    }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: true });
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response(null, { status: 503 }) }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: true, status: 503 });
  await expect(
    readMuseCodeQuota(context(), { fetch: async () => new Response('not-json', { status: 200 }) }),
  ).rejects.toMatchObject({ name: 'MuseCodeQuotaError', retryable: false });
});

test('formats every window of at least 60 minutes in hours', async () => {
  const snapshot = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: 90 } },
      }),
  });
  expect(snapshot.items).toEqual([
    {
      id: '90m',
      displayName: { default: '1.5 hours', 'zh-Hans': '1.5 小时' },
      remainingRatio: 0.75,
    },
  ]);
});

test('treats nonpositive window_duration_mins as a rolling window', async () => {
  const zero = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: 0 } },
      }),
  });
  expect(zero.items).toEqual([
    {
      id: 'window',
      displayName: { default: 'Rolling window', 'zh-Hans': '滚动窗口' },
      remainingRatio: 0.75,
    },
  ]);
  const negative = await readMuseCodeQuota(context(), {
    fetch: async () =>
      Response.json({
        is_subs_active: true,
        subs_usage: { window: { used_percent: 25, window_duration_mins: -60 } },
      }),
  });
  expect(negative.items[0]).toMatchObject({
    id: 'window',
    displayName: { default: 'Rolling window', 'zh-Hans': '滚动窗口' },
  });
});

function context() {
  const port: CredentialPort<MuseCodeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('quota must not refresh');
    },
  };
  return { credentials: port, options: {}, signal: new AbortController().signal };
}
```

Window labels are locked: `1 hour` / `1 小时` for 60 minutes; `1.5 hours` / `1.5 小时` for 90 minutes. Do not use `Nh` / `Nm`. Keep the ids `60m` / `90m` and `remainingRatio` 0.75. Branch on `minutes >= 60`, not `minutes % 60 === 0`.

- [ ] **Step 2: Run the quota test and verify RED**

Run: `bun test packages/plugins/muse-code/src/quota/quota.test.ts`

Expected: FAIL because `./quota` does not exist.

- [ ] **Step 3: Implement quota mapping**

`quota.ts` imports `currentMuseCodeCredential` from `../oauth` and `requestMuseCodeKey` / `MuseCodeHttpError` from `../control`. Do not import `../oauth/key` or `../control/key`.

`readMuseCodeQuota` calls `currentMuseCodeCredential` then `requestMuseCodeKey(oauthAccessToken, { onboard: false / omitted })` with `JSON.stringify({})`. Ignore `api_key` in the response. Throw `MuseCodeQuotaError` `{ retryable: false }` when `is_subs_active === false` or when neither window produces an item (`subs_usage` missing or both percents invalid). Map every `MuseCodeHttpError` onto `MuseCodeQuotaError` with the same `retryable` and `status` (408 / 429 / 5xx stay retryable). Map timeout and genuine network failures to `{ retryable: true }`. Map invalid JSON to `{ retryable: false }`. Rethrow `AbortError` / `signal.reason` from the caller cancel; do not classify cancel as a quota miss. A window is valid only when `used_percent` is a finite number `>= 0`; negative and non-finite values produce no item. Then `remainingRatio = 1 - Math.min(percent, 100) / 100`. Parse `resets_at` as ISO or unix seconds/ms. `plan` from `subs_tier_name` then `subs_tier_id`. Do not register reset. Do not write credentials.

Window display names and ids (`window_duration_mins` must be a finite **positive** number before formatting):

- `minutes >= 60` → id `${Math.round(minutes)}m`, `hours = minutes / 60`, `{default: "${hours} hour(s)", 'zh-Hans': "${hours} 小时"}` (singular hour when `hours === 1`)
- `0 < minutes < 60` → id `${Math.round(minutes)}m`, `{default: "${minutes} minute(s)", 'zh-Hans': "${minutes} 分钟"}` (singular minute when `minutes === 1`)
- missing, zero, or negative duration → id `window`, `{default: 'Rolling window', 'zh-Hans': '滚动窗口'}`

Create `packages/plugins/muse-code/src/quota/index.ts`:

```ts
export { MuseCodeQuotaError, readMuseCodeQuota } from './quota';
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/plugins/muse-code/src/quota/quota.test.ts`

Expected: PASS. Body is `{}`. Returned `api_key` is unused.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code/src/quota
git commit -m "feat(muse-code): read subscription quota without reminting"
```

---

### Task 6: Plugin descriptor without refresh or CPA

**Files:**
- Create: `packages/plugins/muse-code/src/plugin/plugin.ts`
- Create: `packages/plugins/muse-code/src/plugin/index.ts`
- Create: `packages/plugins/muse-code/src/index.ts`
- Create: `packages/plugins/muse-code/oauth.smoke.ts`
- Test: `packages/plugins/muse-code/src/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: `loginMuseCode`, `discoverMuseCodeModels`, `initialMuseCodeCatalogFallback`, `createMuseCodeRuntime`, `readMuseCodeQuota`, `credentialSchema`.
- Produces: `createMuseCodePlugin(presentation?, dependencies?)`, `englishPresentationText`, `MUSE_CODE_PLUGIN_VERSION`, default export.

- [ ] **Step 1: Write the failing plugin tests**

Create `packages/plugins/muse-code/src/plugin/plugin.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import museCodePlugin, { createMuseCodePlugin, MUSE_CODE_PLUGIN_VERSION } from '..';
import packageJson from '../../package.json' with { type: 'json' };
import type { MuseCodeCredential } from '../schema';

test('exports a versioned Muse Code OAuth descriptor', async () => {
  const adapter = await adapterFrom(museCodePlugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with Muse Code');
  expect(museCodePlugin.metadata.icon).toBe('meta');
  expect(adapter.account.options.form).toEqual([]);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: 6 * 60 * 60_000 });
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(adapter.refreshCredential).toBeUndefined();
  expect(adapter.credentialImports).toBeUndefined();
  expect(MUSE_CODE_PLUGIN_VERSION).toBe(packageJson.version);
});

test('accepts localized copy without adding account options', async () => {
  const adapter = await adapterFrom(
    createMuseCodePlugin({
      pluginLabel: 'Muse Code',
      pluginDescription: 'Compte Muse',
      adapterLabel: 'Connexion Muse',
      deviceInstructions: 'Saisissez le code',
      waitingForAuthorization: 'Autorisation Muse en attente',
    }),
  );
  expect(adapter.displayName).toBe('Connexion Muse');
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, MuseCodeCredential>> {
  let registered: OAuthAdapter<Record<string, never>, MuseCodeCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<Record<string, never>, MuseCodeCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('Muse Code OAuth adapter was not registered');
  return registered;
}
```

Create `packages/plugins/muse-code/oauth.smoke.ts`:

```ts
import { expect, test } from 'bun:test';

import plugin, { MUSE_CODE_PLUGIN_VERSION } from './dist/index.js';
import packageJson from './package.json' with { type: 'json' };

test('built artifact exports the Muse Code descriptor', () => {
  expect(plugin.apiVersion).toBe(1);
  expect(MUSE_CODE_PLUGIN_VERSION).toBe(packageJson.version);
});
```

- [ ] **Step 2: Run the plugin test and verify RED**

Run: `bun test packages/plugins/muse-code/src/plugin/plugin.test.ts`

Expected: FAIL because `./plugin` / index exports do not exist.

- [ ] **Step 3: Assemble the adapter**

`createMuseCodePlugin` mirrors xAI/Kimi: empty `zod.object({})` account options, `id: 'default'`, injectable presentation + fetch/now/sleep, `login` → `loginMuseCode`, TTL catalog + `initialFallback`, `quota.read` → `readMuseCodeQuota`, `createRuntime` → `createMuseCodeRuntime`. **Do not** set `refreshCredential` or `credentialImports`. Icon is `'meta'`. `@lobehub/icons-static-svg@1.93.0` already has `icons/meta.svg`. Do not fall back to `meta-color` / `meta-brand`.

English defaults:

```ts
export const englishPresentationText = {
  pluginLabel: 'Muse Code',
  pluginDescription: 'Use a Muse Code subscription to access Meta models',
  adapterLabel: 'Login with Muse Code',
  deviceInstructions: 'Enter code',
  waitingForAuthorization: 'Waiting for Muse authorization',
};
```

Create `packages/plugins/muse-code/src/plugin/index.ts`:

```ts
export { createMuseCodePlugin, englishPresentationText } from './plugin';
```

`src/index.ts` exports catalog/oauth/plugin/quota/runtime/schema plus `MUSE_CODE_PLUGIN_VERSION` from `package.json` and `export default createMuseCodePlugin(englishPresentationText)`. Do not `export * from './control'`. Sibling modules keep importing the internal `../control` facade.

- [ ] **Step 4: Verify GREEN, build, and smoke**

Run:

```bash
bun test packages/plugins/muse-code/src
bun run --filter @aio-proxy/plugin-muse-code build
bun run --filter @aio-proxy/plugin-muse-code test:artifact
```

Expected: unit tests pass, `dist/` exists, smoke test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/muse-code
git commit -m "feat(muse-code): assemble OAuth adapter without refresh"
```

---

### Task 7: Host built-in registration

**Files:**
- Modify: `packages/core/src/plugins/builtins.ts`
- Modify: `packages/core/src/plugins/builtins.test.ts`
- Modify: `packages/core/package.json`
- Modify: `.changeset/config.json`
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`
- Modify: `packages/cli/__tests__/binary-build.test.ts`
- Create: `.changeset/<generated-by-bun-changeset>.md`

**Interfaces:**
- Consumes: `createMuseCodePlugin`, `MUSE_CODE_PLUGIN_VERSION`.
- Produces: Muse Code listed in `BUILT_IN_PLUGIN_PACKAGE_NAMES` and `createEmbeddedBuiltIns()`.

> **Rebase warning:** Claude and OpenRouter built-in PRs also touch `builtins.ts`, `builtins.test.ts`, `core/package.json`, `.changeset/config.json`, and the three CLI list tests. **Rebase onto the latest target branch before editing these files.** Insert `@aio-proxy/plugin-muse-code` in package-name alphabetical order among current built-ins (today: after `plugin-kimi-code`, before `plugin-openai-chatgpt`). Do not drop siblings that landed while this branch was open.

- [ ] **Step 1: Write the failing host-list assertions**

In `packages/core/src/plugins/builtins.test.ts`, add `@aio-proxy/plugin-muse-code` to `expectedBuiltIns` in alphabetical order, extend the embedded `builtIn` all-true array length, and add:

```ts
expect(snapshot.registry.resolveOAuth('@aio-proxy/plugin-muse-code', 'default')).toBeDefined();

const muse = snapshot.registry.resolveOAuth('@aio-proxy/plugin-muse-code', 'default');
const musePlugin = snapshot.plugins.get('@aio-proxy/plugin-muse-code');
expect(resolveLocalizedText(musePlugin?.displayName ?? '', 'zh-Hans')).toBe('Muse Code');
expect(resolveLocalizedText(musePlugin?.description ?? '', 'zh-Hans')).toBe(
  '使用 Muse Code 订阅访问 Meta 模型',
);
expect(resolveLocalizedText(muse?.displayName ?? '', 'zh-Hans')).toBe('使用 Muse Code 登录');
expect(muse?.refreshCredential).toBeUndefined();
```

In `packages/cli/src/plugin-commands/plugin/add.test.ts`, insert `'@aio-proxy/plugin-muse-code'` into the sorted built-in list expectation.

In `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`, add `'@aio-proxy/plugin-muse-code'` to the `builtIns` array used by `test.each`.

In `packages/cli/__tests__/binary-build.test.ts`, add:

```ts
expect(stdout).toContain('@aio-proxy/plugin-muse-code');
```

- [ ] **Step 2: Run the host tests and verify RED**

Run:

```bash
bun test packages/core/src/plugins/builtins.test.ts packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
```

Expected: FAIL because Muse Code is not registered / not in the lists.

- [ ] **Step 3: Register the built-in and author the changeset**

`packages/core/package.json` dependencies, alphabetical:

```json
"@aio-proxy/plugin-muse-code": "workspace:*"
```

`.changeset/config.json` `fixed` group: add `"@aio-proxy/plugin-muse-code"` next to the other `@aio-proxy/plugin-*` names (after kimi-code, before openai-chatgpt unless rebase changed neighbors).

`packages/core/src/plugins/builtins.ts`:

```ts
import { createMuseCodePlugin, MUSE_CODE_PLUGIN_VERSION } from '@aio-proxy/plugin-muse-code';
```

Add `'@aio-proxy/plugin-muse-code'` to `BUILT_IN_PLUGIN_PACKAGE_NAMES`. In `createEmbeddedBuiltIns()`, insert:

```ts
{
  packageName: '@aio-proxy/plugin-muse-code',
  version: MUSE_CODE_PLUGIN_VERSION,
  descriptor: createMuseCodePlugin({
    pluginLabel: localized('Muse Code', 'Muse Code'),
    pluginDescription: localized(
      'Use a Muse Code subscription to access Meta models',
      '使用 Muse Code 订阅访问 Meta 模型',
    ),
    adapterLabel: localized('Login with Muse Code', '使用 Muse Code 登录'),
    deviceInstructions: localized('Enter code', '输入代码'),
    waitingForAuthorization: localized('Waiting for Muse authorization', '正在等待 Muse 授权'),
  }) as unknown as PluginDescriptor<unknown>,
},
```

Run `bun changeset`. Select **minor** for `@aio-proxy/plugin-muse-code`, `@aio-proxy/core`, and `aio-proxy`. Use this note:

```md
Add a built-in Muse Code OAuth plugin that logs in with a Meta device code, mints a Model API key, and routes Meta models through the OpenAI Responses API.
```

If the session cannot drive the interactive prompt, run `bunx changeset add --empty` and replace the generated file's frontmatter and body with those same package selections (all `minor`) and note. Commit the generated `.changeset/<adjective>-<noun>-<verb>.md`. Do not invent a filename such as `muse-code-oauth.md`. Do not target only the plugin package. Do not run `changeset version` / `publish`.

- [ ] **Step 4: Verify GREEN on package tests, build, and check**

Run:

```bash
bun install --lockfile-only
bun test packages/plugins/muse-code/src packages/core/src/plugins/builtins.test.ts packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
bun run --filter @aio-proxy/plugin-muse-code build
bun run --filter @aio-proxy/plugin-muse-code test:artifact
bun run check
```

Expected: tests pass, build succeeds, `bun run check` (oxlint + oxfmt check) is clean.

`packages/cli/__tests__/binary-build.test.ts` is a compiled-binary smoke (≈120s). Run it when the registration lists are stable, or rely on CI if this environment cannot rebuild the platform package. Do not skip the assertion in source.

Final gate before merge: `bun run preflight` (type-aware lint + format check + all unit tests). Task-local `check` is the minimum; preflight is the repo completion bar.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/builtins.ts packages/core/src/plugins/builtins.test.ts packages/core/package.json .changeset packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts packages/cli/__tests__/binary-build.test.ts bun.lock
git commit -m "feat(muse-code): register built-in OAuth plugin"
```

---

## Self-review

**Spec coverage**

| Spec section              | Task |
| ------------------------- | ---- |
| Credential + fingerprint  | 1    |
| Device poll + mint        | 2    |
| No refresh / read-only current credential | 1–2, 6 |
| Catalog + Spark fallback  | 3    |
| Responses runtime         | 4    |
| Quota without remint      | 5    |
| Descriptor / copy / icon  | 6    |
| Host registration + changeset | 7 |

Deferred items (encrypted-reasoning include, effort remapping, custom-tool fallback, Chat Completions, CPA, pay-as-you-go paste) have no implementation task by design.

**Placeholder scan:** no TBD / “implement later” / “similar to Task N” without code.

**Type consistency:** `MuseCodeCredential`, `museLoginResult`, `currentMuseCodeCredential`, `loginMuseCode`, `requestMuseCodeKey`, `discoverMuseCodeModels`, `createMuseCodeRuntime`, `readMuseCodeQuota`, `createMuseCodePlugin`, `MUSE_CODE_PLUGIN_VERSION` keep the same names across tasks.
