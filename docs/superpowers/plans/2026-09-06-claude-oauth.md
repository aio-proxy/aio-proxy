# Claude Pro/Max OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add built-in `@aio-proxy/plugin-anthropic-claude` so users can log in with a Claude Pro/Max subscription, discover account models, and invoke them through `@ai-sdk/anthropic` with OAuth Bearer tokens.

**Architecture:** A new `packages/plugins/anthropic-claude` workspace owns PKCE loopback login, JSON token/refresh, oh-my-pi identity bootstrap, TTL `/v1/models` discovery, ProviderV4 model-only runtime, and CPA `claude` import. Core only embeds the descriptor. Host loopback, credential port, catalog TTL, and the generation candidate loop stay unchanged.

**Tech Stack:** Bun, TypeScript, `@aio-proxy/plugin-sdk`, `@ai-sdk/anthropic` `catalog:` 4.0.3, `es-toolkit` `catalog:`, Rslib `defineLibraryConfig()`, Bun test.

**Spec:** [docs/superpowers/specs/2026-09-06-claude-oauth-design.md](../specs/2026-09-06-claude-oauth-design.md)

Do not implement until that spec is `已确认，进入实现`.

## Global Constraints

- Provider ID / Provider priority / Provider weight terminology and behavior stay unchanged.
- Public client ID is exactly `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (oh-my-pi base64 `OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`). Do not use the brief typo `88e4`.
- Authorize is exactly `https://claude.ai/oauth/authorize`. Token and refresh are exactly `https://api.anthropic.com/v1/oauth/token` JSON. Never `platform.claude.com`.
- Scopes are exactly `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`.
- Loopback is existing `context.authorization.loopback` with hostname `localhost`, port `54545` (never `'dynamic'`), path `/callback`, `allowManualCallbackUrl: true`. No new AuthorizationPort method. No device-code. Manual paste is a full callback URL only. The host does not rebind a busy 54545 to another port.
- Every plugin `bun test` command includes `--preload=packages/plugins/anthropic-claude/test/setup.ts`. `bun test path/to/file` without that preload throws `ReferenceError` on `__AIO_PROXY_CLAUDE_CLIENT_ID__`.
- Control-plane and inference fetch is `options.fetch ?? context.fetch ?? globalThis.fetch`. Do not call `globalThis.fetch` directly.
- Refresh never writes `organizationId` / `organizationName` from token JSON or bootstrap. Always keep the stored org fields.
- Catalog pages only when `has_more === true` and `last_id` is a non-empty string. Other 4xx are non-retryable. Successful discover overlays curated `displayName` only; it does not merge missing curated ids.
- CPA import maps `account.email_address` the same way login does, and also accepts flat CPA keys `account_uuid` / `organization_uuid` / `organization_name` when nested fields are absent. Ignore `expired` as a boolean, `claude_device_ids`, and `id_token`.
- Catalog / runtime tests import constants through `./oauth`, not `./oauth/constants`.
- New modules with a colocated test use a same-name directory (`oauth/index.ts`, `oauth/oauth.ts`, `oauth/oauth.test.ts`). Task snippets that say `src/oauth.ts` mean that directory.
- Merge order: this PR first, then OpenRouter, then Muse. Last task inserts the package name; do not paste a six-plugin snapshot or backfill missing xAI list entries.
- `expiresAt = now + expires_in * 1000 - 5 * 60_000`. `currentClaudeCredential` refreshes when `now() >= expiresAt` (skew is already stored).
- Fingerprint is `sha256:` + hex of `account:<uuid>` only. If `accountId` is missing after identity resolution, `claudeLoginResult` throws `ClaudeIdentityMissingError` even when email is present. Never fingerprint `email:` or `refresh:<token>`. Email is label-only. `suggestedKey` is `claude-` + first 12 hex chars. Never put raw tokens in Provider ID, labels, logs, or errors.
- Catalog `extra` is `{ protocol: 'anthropic' }`. Do not put `protocol` on `modelMetadata`.
- Runtime is ProviderV4 `languageModel` only. No raw, no quota, no API-key mode, no Foundry, no plugin-sdk AuthorizationPort changes.
- OAuth beta is only `oauth-2025-04-20`. Do not invent extra Claude Code betas.
- Control-plane fetches (token, refresh, identity, catalog) set `aioProxy: { traffic: 'control' }`. Inference fetch does not.
- Reuse installed catalog deps. Add no new utility dependency.
- Handwritten non-test files ≤500 lines; split before 400 if a file gains a second responsibility.
- Every non-trivial behavior is RED → verify failure → minimal GREEN → verify pass.
- One changeset targeting `@aio-proxy/plugin-anthropic-claude`, `@aio-proxy/core`, and `aio-proxy`, all `minor`.
- Shared host files (`builtins.ts`, changeset `fixed`, CLI built-in lists) land in the last task. OpenRouter/Muse PRs may touch the same files — rebase, do not invent a shared scaffolding PR.

---

## File Structure

- `packages/plugins/anthropic-claude/package.json`: private workspace package, rslib build, `test:unit` with preload, `test:artifact` `oauth.smoke.ts`.
- `packages/plugins/anthropic-claude/tsconfig.json`: extends `@aio-proxy/infra/tsconfig/base.json`.
- `packages/plugins/anthropic-claude/rslib.config.ts`: `defineLibraryConfig()` plus client-ID define.
- `packages/plugins/anthropic-claude/test/setup.ts`: injects decoded client ID for unit tests.
- `packages/plugins/anthropic-claude/oauth.smoke.ts`: artifact check that source stays free of plaintext client ID.
- `packages/plugins/anthropic-claude/src/schema/index.ts`, `schema/schema.ts`: `ClaudeCredential` Zod schema and type.
- `packages/plugins/anthropic-claude/src/pkce/index.ts`, `pkce/pkce.ts`, `pkce/pkce.test.ts`: S256 PKCE and state.
- `packages/plugins/anthropic-claude/src/oauth/index.ts`: export-only public oauth surface.
- `packages/plugins/anthropic-claude/src/oauth/oauth.ts`, `oauth/oauth.test.ts`: authorize URL, code exchange, login, `claudeLoginResult`.
- `packages/plugins/anthropic-claude/src/oauth/constants.ts`: URLs, scopes, beta, User-Agents, loopback, client-ID symbol.
- `packages/plugins/anthropic-claude/src/oauth/identity.ts`, `oauth/identity.test.ts`: token-field extract + claude_cli bootstrap. Abort during bootstrap is fatal.
- `packages/plugins/anthropic-claude/src/oauth/credential.ts`, `oauth/credential.test.ts`: refresh and `currentClaudeCredential`.
- `packages/plugins/anthropic-claude/src/oauth/types.ts`: shared option types for credential/login fetch (private to `oauth/`).
- `packages/plugins/anthropic-claude/src/catalog/index.ts`, `catalog/catalog.ts`, `catalog/catalog.test.ts`: TTL discover, pagination, filter, fallback.
- `packages/plugins/anthropic-claude/src/runtime/index.ts`, `runtime/runtime.ts`, `runtime/runtime.test.ts`: `@ai-sdk/anthropic` ProviderV4 + dynamic fetch.
- `packages/plugins/anthropic-claude/src/plugin/index.ts`, `plugin/plugin.ts`, `plugin/plugin.test.ts`: adapter, presentation, CPA `claude` import.
- `packages/plugins/anthropic-claude/src/index.ts`: version, factory, default descriptor.
- Host (last task only): `packages/core/src/plugins/builtins.ts`, `builtins.test.ts`, `packages/core/package.json`, `.changeset/config.json`, CLI built-in lists, one changeset.

Private modules under `src/oauth/` and `src/runtime/` are not exported from higher-level barrels except through `oauth.ts` / `runtime/index.ts` as the plan’s public plugin surfaces.

---

### Task 1: Package scaffold, credential schema, fingerprint

**Files:**
- Create: `packages/plugins/anthropic-claude/package.json`
- Create: `packages/plugins/anthropic-claude/tsconfig.json`
- Create: `packages/plugins/anthropic-claude/rslib.config.ts`
- Create: `packages/plugins/anthropic-claude/test/setup.ts`
- Create: `packages/plugins/anthropic-claude/src/schema.ts`
- Create: `packages/plugins/anthropic-claude/src/oauth/constants.ts`
- Create: `packages/plugins/anthropic-claude/src/oauth.ts`
- Test: `packages/plugins/anthropic-claude/src/oauth.test.ts`

**Interfaces:**
- Consumes: `zod` from `@aio-proxy/plugin-sdk`.
- Produces: `ClaudeCredential`, `credentialSchema`, `CLAUDE_CLIENT_ID`, `claudeLoginResult(credentials: ClaudeCredential)`, `ClaudeIdentityMissingError`, `normalizeClaudeEmail(value: string | undefined): string | undefined`.

- [ ] **Step 1: Write package metadata and the failing fingerprint test**

Create `packages/plugins/anthropic-claude/package.json`:

```json
{
  "name": "@aio-proxy/plugin-anthropic-claude",
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
    "test:unit": "bun test --preload=./test/setup.ts",
    "test:artifact": "bun test ./oauth.smoke.ts"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "catalog:",
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

Create `packages/plugins/anthropic-claude/tsconfig.json`:

```json
{
  "extends": "@aio-proxy/infra/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Create `packages/plugins/anthropic-claude/rslib.config.ts`:

```ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

const decode = (...parts: string[]) => atob(parts.join(''));
export const claudeClientId = decode('OWQxYzI1MGEtZTYxYi00NGQ5', 'LTg4ZWQtNTk0NGQxOTYyZjVl');

export default defineLibraryConfig({
  source: { define: { __AIO_PROXY_CLAUDE_CLIENT_ID__: JSON.stringify(claudeClientId) } },
});
```

Create `packages/plugins/anthropic-claude/test/setup.ts`:

```ts
import { claudeClientId } from '../rslib.config';

const fingerprint = new Bun.CryptoHasher('sha256').update(claudeClientId).digest('hex');
if (fingerprint !== '473668f2b13c71009d028ff0ef74c2cf76e71cbdd33b76e69fcc42d7e59aca4b') {
  throw new Error('Claude OAuth client ID fingerprint mismatch');
}

Object.assign(globalThis, {
  __AIO_PROXY_CLAUDE_CLIENT_ID__: claudeClientId,
});
```

Create `packages/plugins/anthropic-claude/src/oauth.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { ClaudeIdentityMissingError, claudeLoginResult, normalizeClaudeEmail } from './oauth';
import type { ClaudeCredential } from './schema';

describe('Claude login identity', () => {
  test('fingerprints account uuid ahead of email', () => {
    const credentials: ClaudeCredential = {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: 1_700_003_300_000,
      email: 'Person@Example.com',
      accountId: 'acct-uuid',
      organizationId: 'org-uuid',
      organizationName: 'Team',
    };
    const result = claudeLoginResult(credentials);
    const digest = new Bun.CryptoHasher('sha256').update('account:acct-uuid').digest('hex');
    expect(result.fingerprint).toBe(`sha256:${digest}`);
    expect(result.suggestedKey).toBe(`claude-${digest.slice(0, 12)}`);
    expect(result.accountLabel).toBe('person@example.com');
    expect(result.credentials.email).toBe('person@example.com');
    expect(result.expiresAt).toBe(1_700_003_300_000);
    expect(JSON.stringify(result)).not.toContain('access-secret');
    expect(result.fingerprint).not.toContain('refresh-secret');
  });

  test('rejects email-only credentials and keeps fingerprint when email or refresh later appear', () => {
    expect(normalizeClaudeEmail(' Person@Example.com ')).toBe('person@example.com');
    expect(normalizeClaudeEmail('   ')).toBeUndefined();
    expect(() =>
      claudeLoginResult({
        accessToken: 'a',
        refreshToken: 'refresh-secret',
        expiresAt: 1,
        email: 'Person@Example.com',
      }),
    ).toThrow(ClaudeIdentityMissingError);
    const accountOnly = claudeLoginResult({
      accessToken: 'a',
      refreshToken: 'refresh-secret',
      expiresAt: 1,
      accountId: 'acct-uuid',
    });
    const digest = new Bun.CryptoHasher('sha256').update('account:acct-uuid').digest('hex');
    expect(accountOnly.fingerprint).toBe(`sha256:${digest}`);
    const laterEmail = claudeLoginResult({
      accessToken: 'b',
      refreshToken: 'other-refresh',
      expiresAt: 2,
      accountId: 'acct-uuid',
      email: 'Person@Example.com',
    });
    expect(laterEmail.fingerprint).toBe(accountOnly.fingerprint);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: FAIL because `./oauth` / `claudeLoginResult` does not exist.

- [ ] **Step 3: Write the minimal schema, constants, and login-result implementation**

Create `packages/plugins/anthropic-claude/src/schema.ts`:

```ts
import { zod } from '@aio-proxy/plugin-sdk';

export const credentialSchema = zod.object({
  accessToken: zod.string().min(1),
  refreshToken: zod.string().min(1),
  expiresAt: zod.number(),
  email: zod.string().min(1).optional(),
  accountId: zod.string().min(1).optional(),
  organizationId: zod.string().min(1).optional(),
  organizationName: zod.string().min(1).optional(),
});

export type ClaudeCredential = zod.infer<typeof credentialSchema>;
```

Create `packages/plugins/anthropic-claude/src/oauth/constants.ts`:

```ts
declare const __AIO_PROXY_CLAUDE_CLIENT_ID__: string;

export const CLAUDE_CLIENT_ID = __AIO_PROXY_CLAUDE_CLIENT_ID__;
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const CLAUDE_BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
export const CLAUDE_API_BASE_URL = 'https://api.anthropic.com/v1';
export const CLAUDE_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_REFRESH_USER_AGENT = 'anthropic-sdk-typescript/0.112.1 userOAuthProvider';
export const CLAUDE_BOOTSTRAP_USER_AGENT = 'claude-code/2.1.246';
export const CLAUDE_BOOTSTRAP_MODEL = 'claude-opus-4-8';
export const CLAUDE_LOOPBACK = {
  hostname: 'localhost',
  port: 54545,
  path: '/callback',
} as const;
```

Create `packages/plugins/anthropic-claude/src/oauth.ts`:

```ts
import type { ClaudeCredential } from './schema';

export { CLAUDE_CLIENT_ID } from './oauth/constants';

export function normalizeClaudeEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export class ClaudeIdentityMissingError extends Error {
  override readonly name = 'ClaudeIdentityMissingError';
  constructor() {
    super('Claude login did not return a stable account identity');
  }
}

export function claudeLoginResult(credentials: ClaudeCredential) {
  const email = normalizeClaudeEmail(credentials.email);
  const accountId = credentials.accountId?.trim() || undefined;
  const organizationId = credentials.organizationId?.trim() || undefined;
  const organizationName = credentials.organizationName?.trim() || undefined;
  if (accountId === undefined) {
    throw new ClaudeIdentityMissingError();
  }
  const normalized: ClaudeCredential = {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(organizationName === undefined ? {} : { organizationName }),
  };
  const identity = `account:${normalized.accountId}`;
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `claude-${digest.slice(0, 12)}`,
    accountLabel: normalized.email ?? normalized.organizationName ?? 'Claude Pro/Max',
    credentials: normalized,
    expiresAt: normalized.expiresAt,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude
git commit -m "feat(anthropic-claude): add credential schema and account fingerprint"
```

---

### Task 2: PKCE and authorize URL

**Files:**
- Create: `packages/plugins/anthropic-claude/src/pkce.ts`
- Test: `packages/plugins/anthropic-claude/src/pkce.test.ts`
- Modify: `packages/plugins/anthropic-claude/src/oauth.ts`
- Test: `packages/plugins/anthropic-claude/src/oauth.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_AUTHORIZE_URL`, `CLAUDE_CLIENT_ID`, `CLAUDE_SCOPE` from `oauth/constants.ts`.
- Produces: `generateState(): string`, `generatePKCE(): Promise<{ challenge: string; verifier: string }>`, `buildClaudeAuthorizationUrl(input: { readonly challenge: string; readonly redirectUri: string; readonly state: string }): string`.

- [ ] **Step 1: Write the failing PKCE and authorize-URL tests**

Create `packages/plugins/anthropic-claude/src/pkce.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { generatePKCE, generateState } from './pkce';

test('generates unique S256 PKCE and unpadded state', async () => {
  const first = await generatePKCE();
  const second = await generatePKCE();
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.verifier).not.toBe(second.verifier);
  expect(first.challenge).not.toBe(second.challenge);
  const digest = new Bun.CryptoHasher('sha256').update(first.verifier).digest();
  const expected = Buffer.from(digest).toString('base64url');
  expect(first.challenge).toBe(expected);
  const state = generateState();
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(state).not.toBe(generateState());
});
```

Append to `packages/plugins/anthropic-claude/src/oauth.test.ts`:

```ts
import { CLAUDE_CLIENT_ID, CLAUDE_SCOPE } from './oauth/constants';
import { buildClaudeAuthorizationUrl } from './oauth';

test('builds the claude.ai authorize URL with PKCE and code=true', () => {
  const url = new URL(
    buildClaudeAuthorizationUrl({
      challenge: 'challenge-1',
      redirectUri: 'http://localhost:54545/callback',
      state: 'state-1',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
  expect(url.searchParams.get('client_id')).toBe(CLAUDE_CLIENT_ID);
  expect(url.searchParams.get('code')).toBe('true');
  expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('scope')).toBe(CLAUDE_SCOPE);
  expect(url.searchParams.get('state')).toBe('state-1');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/pkce.test.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: FAIL because `generatePKCE` / `buildClaudeAuthorizationUrl` are missing.

- [ ] **Step 3: Implement PKCE and the authorize URL builder**

Create `packages/plugins/anthropic-claude/src/pkce.ts`:

```ts
export type PKCE = {
  readonly challenge: string;
  readonly verifier: string;
};

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generatePKCE(): Promise<PKCE> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Bun.CryptoHasher('sha256').update(verifier).digest();
  return { challenge: base64url(digest), verifier };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
```

Add to `packages/plugins/anthropic-claude/src/oauth.ts`:

```ts
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_SCOPE } from './oauth/constants';

export function buildClaudeAuthorizationUrl(input: {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('code', 'true');
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', CLAUDE_SCOPE);
  url.searchParams.set('state', input.state);
  return url.toString();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/pkce.test.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/pkce.ts packages/plugins/anthropic-claude/src/pkce.test.ts packages/plugins/anthropic-claude/src/oauth.ts packages/plugins/anthropic-claude/src/oauth.test.ts
git commit -m "feat(anthropic-claude): build PKCE authorize URL with code=true"
```

---

### Task 3: Loopback login, JSON code exchange, identity

**Files:**
- Create: `packages/plugins/anthropic-claude/src/oauth/identity.ts`
- Test: `packages/plugins/anthropic-claude/src/oauth/identity.test.ts`
- Modify: `packages/plugins/anthropic-claude/src/oauth.ts`
- Test: `packages/plugins/anthropic-claude/src/oauth.test.ts`

**Interfaces:**
- Consumes: `LocalizedText`, `OAuthLoginContext`, `RuntimeFetch` from `@aio-proxy/plugin-sdk`; `isPlainObject` from `es-toolkit/predicate`; `generatePKCE`, `generateState`; `claudeLoginResult`; constants.
- Produces: `loginClaude(context: OAuthLoginContext, presentation: { readonly waiting: LocalizedText }, options?: ClaudeOAuthDependencies)`, `exchangeClaudeAuthorizationCode(...)`, `resolveClaudeIdentity(...)`, `ClaudeTokenExchangeError`, `ClaudeIdentityMissingError`, `ClaudeOAuthDependencies`.

- [ ] **Step 1: Write the failing login and identity tests**

Create `packages/plugins/anthropic-claude/src/oauth/identity.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_BOOTSTRAP_MODEL, CLAUDE_OAUTH_BETA } from './constants';
import { resolveClaudeIdentity } from './identity';

describe('Claude identity', () => {
  test('skips bootstrap when token already has account, email, and org', async () => {
    let calls = 0;
    const identity = await resolveClaudeIdentity(
      {
        access_token: 'access',
        account: { uuid: 'acct', email_address: 'Person@Example.com' },
        organization: { uuid: 'org', name: 'Team' },
      },
      {
        fetch: async () => {
          calls += 1;
          throw new Error('bootstrap must not run');
        },
        phase: 'login',
      },
    );
    expect(calls).toBe(0);
    expect(identity).toEqual({
      accountId: 'acct',
      email: 'person@example.com',
      organizationId: 'org',
      organizationName: 'Team',
    });
  });

  test('bootstraps missing login identity and ignores org on refresh', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const login = await resolveClaudeIdentity(
      { access_token: 'access' },
      {
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          inits.push(init);
          return Response.json({
            oauth_account: {
              account_uuid: 'boot-acct',
              account_email: 'boot@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          });
        },
        phase: 'login',
        signal: new AbortController().signal,
      },
    );
    expect(requests[0]?.url).toBe(
      `https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=${encodeURIComponent(CLAUDE_BOOTSTRAP_MODEL)}`,
    );
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access');
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(login).toEqual({
      accountId: 'boot-acct',
      email: 'boot@example.com',
      organizationId: 'boot-org',
      organizationName: 'Boot Team',
    });

    const refresh = await resolveClaudeIdentity(
      { access_token: 'access' },
      {
        fetch: async () =>
          Response.json({
            oauth_account: {
              account_uuid: 'boot-acct',
              account_email: 'boot@example.com',
              organization_uuid: 'boot-org',
              organization_name: 'Boot Team',
            },
          }),
        phase: 'refresh',
      },
    );
    expect(refresh.organizationId).toBeUndefined();
    expect(refresh.organizationName).toBeUndefined();
    expect(refresh.accountId).toBe('boot-acct');
  });

  test('keeps token fields when bootstrap fails', async () => {
    const identity = await resolveClaudeIdentity(
      { access_token: 'access', account: { uuid: 'acct' } },
      {
        fetch: async () => new Response('nope', { status: 500 }),
        phase: 'login',
      },
    );
    expect(identity).toEqual({ accountId: 'acct' });
  });

  test('rethrows abort when bootstrap is canceled', async () => {
    const reason = new DOMException('cancelled', 'AbortError');
    await expect(
      resolveClaudeIdentity({ access_token: 'access' }, {
        fetch: async (_input, init) => {
          throw reason;
        },
        phase: 'login',
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });
});
```

Append to `packages/plugins/anthropic-claude/src/oauth.test.ts`:

```ts
import type { OAuthLoginContext, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_CLIENT_ID, CLAUDE_LOOPBACK, CLAUDE_TOKEN_URL } from './oauth/constants';
import { ClaudeIdentityMissingError, ClaudeTokenExchangeError, loginClaude } from './oauth';

test('exchanges the loopback code as JSON without a beta header', async () => {
  const redirectUri = 'http://localhost:54545/callback';
  const requests: Request[] = [];
  const inits: Array<RuntimeRequestInit | undefined> = [];
  const signal = new AbortController().signal;
  const result = await loginClaude(
    loginContext({
      signal,
      loopback: async (request) => {
        expect(request.redirect).toEqual(CLAUDE_LOOPBACK);
        expect(request.allowManualCallbackUrl).toBe(true);
        const url = new URL(request.authorizationUrl({ redirectUri }));
        expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(url.searchParams.get('state')).toBe(request.state);
        expect(url.searchParams.get('code')).toBe('true');
        return { code: 'auth-code', redirectUri };
      },
    }),
    { waiting: 'Waiting for Claude authorization' },
    {
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        expect(init?.signal).toBe(signal);
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          account: { uuid: 'acct-1', email_address: 'Person@Example.com' },
          organization: { uuid: 'org-1', name: 'Team' },
        });
      },
    },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(CLAUDE_TOKEN_URL);
  expect(requests[0]?.headers.get('content-type')).toBe('application/json');
  expect(requests[0]?.headers.get('anthropic-beta')).toBeNull();
  expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
  expect(JSON.parse(await requests[0]!.text())).toEqual({
    grant_type: 'authorization_code',
    code: 'auth-code',
    redirect_uri: redirectUri,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: expect.any(String),
    state: expect.any(String),
  });
  expect(result.credentials).toEqual({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_700_003_300_000,
    email: 'person@example.com',
    accountId: 'acct-1',
    organizationId: 'org-1',
    organizationName: 'Team',
  });
  expect(result.expiresAt).toBe(1_700_003_300_000);
  expect(result.suggestedKey.startsWith('claude-')).toBe(true);
});

test('does not leak the authorization code when exchange fails', async () => {
  let error: unknown;
  try {
    await loginClaude(
      loginContext({
        loopback: async () => ({ code: 'secret-code', redirectUri: 'http://localhost:54545/callback' }),
      }),
      { waiting: 'Waiting for Claude authorization' },
      {
        fetch: async () =>
          Response.json({ error: 'invalid_grant', authorization_code: 'secret-code' }, { status: 400 }),
      },
    );
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(ClaudeTokenExchangeError);
  expect(error).toMatchObject({ status: 400 });
  expect(JSON.stringify(error)).not.toContain('secret-code');
});

test('fails login when token and bootstrap omit accountId', async () => {
  await expect(
    loginClaude(
      loginContext({
        loopback: async () => ({ code: 'code', redirectUri: 'http://localhost:54545/callback' }),
      }),
      { waiting: 'Waiting for Claude authorization' },
      {
        fetch: async (input) => {
          const url = String(input);
          if (url.includes('/oauth/token')) {
            return Response.json({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              account: { email_address: 'person@example.com' },
            });
          }
          return new Response('nope', { status: 500 });
        },
      },
    ),
  ).rejects.toBeInstanceOf(ClaudeIdentityMissingError);
});

function loginContext(
  overrides: Partial<OAuthLoginContext> & {
    loopback: OAuthLoginContext['authorization']['loopback'];
  },
): OAuthLoginContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    progress: overrides.progress ?? (() => {}),
    authorization: {
      presentDeviceCode: async () => {
        throw new Error('Claude login must not start device-code');
      },
      presentAuthorizeUrl: async () => {
        throw new Error('Claude login must use loopback rather than presentAuthorizeUrl');
      },
      loopback: overrides.loopback,
    },
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth/identity.test.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: FAIL because `loginClaude` / `resolveClaudeIdentity` are missing.

- [ ] **Step 3: Implement identity + login**

Create `packages/plugins/anthropic-claude/src/oauth/identity.ts` that:

- uses `isPlainObject` from `es-toolkit/predicate` on JSON;
- extracts token `account.uuid` / `account.email_address` / `organization.uuid` / `organization.name`;
- GETs bootstrap only when login is missing account+email+org, or refresh is missing account or email;
- on refresh, never returns org fields from bootstrap;
- swallows genuine bootstrap failures (network, non-2xx, invalid JSON) and returns whatever token fields already existed;
- rethrows `AbortError` / `signal.reason` when the caller canceled during bootstrap; do not continue to `claudeLoginResult` after cancel;
- sets `aioProxy: { traffic: 'control' }` and the spec bootstrap headers.

Extend `oauth.ts` with:

```ts
export type ClaudeOAuthDependencies = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
};

export class ClaudeTokenExchangeError extends Error {
  override readonly name = 'ClaudeTokenExchangeError';
  constructor(readonly status: number) {
    super(`Claude token exchange failed with status ${status}`);
  }
}

export async function loginClaude(
  context: OAuthLoginContext,
  presentation: { readonly waiting: LocalizedText },
  options: ClaudeOAuthDependencies = {},
) {
  const pkce = await generatePKCE();
  const state = generateState();
  context.progress(presentation.waiting);
  const { code, redirectUri } = await context.authorization.loopback({
    state,
    redirect: { ...CLAUDE_LOOPBACK },
    authorizationUrl: ({ redirectUri: selected }) =>
      buildClaudeAuthorizationUrl({ challenge: pkce.challenge, redirectUri: selected, state }),
    allowManualCallbackUrl: true,
  });
  const fetcher = options.fetch ?? context.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const token = await exchangeClaudeAuthorizationCode(code, pkce.verifier, redirectUri, state, {
    fetch: fetcher,
    signal: context.signal,
  });
  const identity = await resolveClaudeIdentity(token.raw, { fetch: fetcher, signal: context.signal, phase: 'login' });
  return claudeLoginResult({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now() + token.expiresIn * 1000 - 5 * 60_000,
    ...identity,
  });
}
```

`claudeLoginResult` throws `ClaudeIdentityMissingError` when the token body and bootstrap still omit `accountId`. Email alone is not a stable identity. That failure is fatal for login and import.

`exchangeClaudeAuthorizationCode` must POST JSON to `CLAUDE_TOKEN_URL` with keys in this insertion order: `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`. No `anthropic-beta`. Require non-empty access token, refresh token, and positive `expires_in`. On `!response.ok` throw `ClaudeTokenExchangeError` with status only.

Keep `oauth.ts` under 400 lines. If login + exchange + result exceed that, move exchange into `src/oauth/token.ts` in this same task (private to `oauth/`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth/identity.test.ts packages/plugins/anthropic-claude/src/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/oauth.ts packages/plugins/anthropic-claude/src/oauth.test.ts packages/plugins/anthropic-claude/src/oauth/identity.ts packages/plugins/anthropic-claude/src/oauth/identity.test.ts
git commit -m "feat(anthropic-claude): exchange loopback code and resolve account identity"
```

---

### Task 4: Refresh and current credential

**Files:**
- Create: `packages/plugins/anthropic-claude/src/oauth/credential.ts`
- Create: `packages/plugins/anthropic-claude/src/oauth/types.ts`
- Test: `packages/plugins/anthropic-claude/src/oauth/credential.test.ts`
- Modify: `packages/plugins/anthropic-claude/src/oauth.ts` (re-export)

**Interfaces:**
- Consumes: `CredentialPort`, `CredentialRefreshError`, `RuntimeFetch` from `@aio-proxy/plugin-sdk`; `resolveClaudeIdentity`; constants.
- Produces: `refreshClaudeCredential(current, options)`, `currentClaudeCredential(port, options)`.

- [ ] **Step 1: Write the failing refresh tests**

Create `packages/plugins/anthropic-claude/src/oauth/credential.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { CredentialRefreshError, type RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_CLIENT_ID, CLAUDE_OAUTH_BETA, CLAUDE_REFRESH_USER_AGENT, CLAUDE_TOKEN_URL } from './constants';
import { currentClaudeCredential, refreshClaudeCredential } from './credential';
import type { ClaudeCredential } from '../schema';

const stored: ClaudeCredential = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 0,
  email: 'person@example.com',
  accountId: 'acct-1',
  organizationId: 'org-1',
  organizationName: 'Team',
};

describe('Claude credential refresh', () => {
  test('posts JSON refresh with beta header and keeps an omitted refresh token', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const refreshed = await refreshClaudeCredential(stored, {
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        return Response.json({ access_token: 'new-access', expires_in: 3600 });
      },
    });
    expect(requests[0]?.url).toBe(CLAUDE_TOKEN_URL);
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(requests[0]?.headers.get('user-agent')).toBe(CLAUDE_REFRESH_USER_AGENT);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(JSON.parse(await requests[0]!.text())).toEqual({
      grant_type: 'refresh_token',
      client_id: CLAUDE_CLIENT_ID,
      refresh_token: 'old-refresh',
    });
    expect(refreshed).toEqual({
      ...stored,
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
      expiresAt: 1_700_003_300_000,
    });
  });

  test('classifies invalid_grant as non-retryable and 503 as retryable', async () => {
    const invalid = refreshClaudeCredential(stored, {
      fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    await expect(invalid).rejects.toBeInstanceOf(CredentialRefreshError);
    await expect(invalid).rejects.toMatchObject({ retryable: false, options: { reason: 'invalid_grant' } });

    const unavailable = refreshClaudeCredential(stored, {
      fetch: async () => new Response(null, { status: 503 }),
    });
    await expect(unavailable).rejects.toMatchObject({ retryable: true, options: { reason: 'upstream_5xx' } });
  });

  test('does not rewrite stored organization after refresh identity fill', async () => {
    const incomplete = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    const refreshed = await refreshClaudeCredential(incomplete, {
      now: () => 1_700_000_000_000,
      fetch: async (input) => {
        if (String(input).includes('/oauth/token')) {
          return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 60 });
        }
        return Response.json({
          oauth_account: {
            account_uuid: 'acct',
            account_email: 'boot@example.com',
            organization_uuid: 'should-not-store',
            organization_name: 'Nope',
          },
        });
      },
    });
    expect(refreshed.accountId).toBe('acct');
    expect(refreshed.email).toBe('boot@example.com');
    expect(refreshed.organizationId).toBeUndefined();
    expect(refreshed.refreshToken).toBe('rotated');
  });

  test('refreshes through the host port only when stored expiresAt has been reached', async () => {
    let exchanges = 0;
    const fresh = { ...stored, expiresAt: 1_700_000_000_001 };
    const kept = await currentClaudeCredential(
      {
        read: async () => ({ revision: 1, value: fresh }),
        refresh: async () => {
          throw new Error('unexpired credential must not refresh');
        },
      },
      { now: () => 1_700_000_000_000 },
    );
    expect(kept.accessToken).toBe('old-access');

    const expired = await currentClaudeCredential(
      {
        read: async () => ({ revision: 2, value: stored }),
        refresh: async (revision, exchange) => {
          const updated = await exchange({ revision, value: stored }, new AbortController().signal);
          exchanges += 1;
          return { status: 'updated', snapshot: { revision: revision + 1, value: updated.value } };
        },
      },
      {
        now: () => 1_700_000_000_000,
        fetch: async () => Response.json({ access_token: 'ported', expires_in: 60 }),
      },
    );
    expect(exchanges).toBe(1);
    expect(expired.accessToken).toBe('ported');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth/credential.test.ts`
Expected: FAIL because `./credential` does not exist.

- [ ] **Step 3: Implement refresh**

`refreshClaudeCredential` must:

- POST JSON `{ grant_type, client_id, refresh_token }` to `CLAUDE_TOKEN_URL`;
- send `anthropic-beta: oauth-2025-04-20` and `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`;
- set `aioProxy: { traffic: 'control' }`;
- keep the old refresh token when omitted;
- compute `expiresAt` with the 5-minute skew;
- preserve stored org fields;
- call `resolveClaudeIdentity(..., { phase: 'refresh' })` only when `accountId` or `email` is missing;
- throw `CredentialRefreshError` with the spec’s reason table;
- rethrow `AbortError`.

`currentClaudeCredential` must `port.read()`, return immediately when `value.expiresAt > now()`, otherwise `port.refresh` and return the snapshot value. If the caller passed `signal`, race it with `port.refresh()` using `Promise.race` + `abort` listener (copy `packages/plugins/kimi-code/src/oauth/credential.ts` `waitForCaller`; paste that helper into `oauth/credential.ts`, do not import across plugins). Put shared option types in `oauth/types.ts` so `credential.ts` does not import `ClaudeOAuthDependencies` from `../oauth`.

`refreshClaudeCredential` must keep stored `organizationId` / `organizationName` even when the token JSON contains a different `organization`. Add a test whose refresh body has `organization: { uuid: 'other', name: 'Other' }` and assert the stored org is unchanged.

Re-export both functions from `src/oauth.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/oauth/credential.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/oauth/credential.ts packages/plugins/anthropic-claude/src/oauth/credential.test.ts packages/plugins/anthropic-claude/src/oauth/types.ts packages/plugins/anthropic-claude/src/oauth.ts
git commit -m "feat(anthropic-claude): refresh OAuth tokens with inference-token endpoint"
```

---

### Task 5: TTL catalog and curated fallback

**Files:**
- Create: `packages/plugins/anthropic-claude/src/catalog.ts`
- Test: `packages/plugins/anthropic-claude/src/catalog.test.ts`

**Interfaces:**
- Consumes: `AccountContext`, `ModelCatalog` from `@aio-proxy/plugin-sdk`; `currentClaudeCredential`; constants.
- Produces: `CLAUDE_CATALOG_TTL_MS = 6 * 60 * 60_000`, `discoverClaudeModels(context, options)`, `initialClaudeCatalogFallback(error)`, `ClaudeCatalogError`.

- [ ] **Step 1: Write the failing catalog tests**

Create `packages/plugins/anthropic-claude/src/catalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CLAUDE_OAUTH_BETA } from './oauth/constants';
import type { ClaudeCredential } from './schema';
import { ClaudeCatalogError, discoverClaudeModels, initialClaudeCatalogFallback } from './catalog';

const extra = { protocol: 'anthropic' } as const;

describe('Claude model catalog', () => {
  test('pages official models and keeps only claude language ids', async () => {
    const requests: Request[] = [];
    const inits: Array<RuntimeRequestInit | undefined> = [];
    const catalog = await discoverClaudeModels(context(), {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        inits.push(init);
        const url = new URL(String(input));
        if (!url.searchParams.get('after_id')) {
          return Response.json({
            data: [
              { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model' },
              { id: 'not-claude', type: 'model' },
              { id: '  ', type: 'model' },
            ],
            has_more: true,
            last_id: 'claude-sonnet-5',
          });
        }
        return Response.json({
          data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model' }],
          has_more: false,
        });
      },
    });
    expect(requests[0]?.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access-token');
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(new URL(requests[1]!.url).searchParams.get('after_id')).toBe('claude-sonnet-5');
    expect(catalog.language).toEqual([
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', extra },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', extra },
    ]);
    expect(catalog.image).toEqual([]);
  });

  test('falls back only for retryable discovery failures', () => {
    expect(initialClaudeCatalogFallback(new ClaudeCatalogError('network', true))?.language).toEqual([
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', extra },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', extra },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', extra },
    ]);
    expect(initialClaudeCatalogFallback(new ClaudeCatalogError('unauthorized', false, 401))).toBeUndefined();
    expect(initialClaudeCatalogFallback(new DOMException('cancelled', 'AbortError'))).toBeUndefined();
  });

  test('treats a successful empty catalog as authoritative', async () => {
    const catalog = await discoverClaudeModels(context(), {
      fetch: async () => Response.json({ data: [], has_more: false }),
    });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<ClaudeCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: { accessToken: 'access-token', refreshToken: 'refresh', expiresAt: Number.MAX_SAFE_INTEGER },
    }),
    refresh: async () => {
      throw new Error('fresh credential must not refresh');
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/catalog.test.ts`
Expected: FAIL because `./catalog` does not exist.

- [ ] **Step 3: Implement discovery**

`discoverClaudeModels` must `currentClaudeCredential`, GET `https://api.anthropic.com/v1/models?limit=1000` with Bearer + `anthropic-version: 2023-06-01` + `oauth-2025-04-20` + `aioProxy: { traffic: 'control' }` and `options.fetch ?? context.fetch ?? globalThis.fetch`. Follow `after_id` only while `has_more === true` **and** `last_id` is a non-empty string (max 10 pages). `has_more` without `last_id` is invalid envelope (retryable). Keep `claude-` ids whose `type` is `'model'` or absent. `displayName` is official `display_name`, else curated overlay, else omit. Do not merge curated ids that the response omitted. Set `extra: { protocol: 'anthropic' }`. Throw `ClaudeCatalogError` with `retryable: true` for network / 408 / 429 / 5xx / invalid JSON / unfinished pagination, `retryable: false` for 401 / 403 / other 4xx. Re-throw abort. Empty filtered `data` is success.

`initialClaudeCatalogFallback` returns the three curated rows only when `error instanceof ClaudeCatalogError && error.retryable`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/catalog.ts packages/plugins/anthropic-claude/src/catalog.test.ts
git commit -m "feat(anthropic-claude): discover Anthropic models with curated fallback"
```

---

### Task 6: ProviderV4 runtime and dynamic fetch

**Files:**
- Create: `packages/plugins/anthropic-claude/src/runtime/runtime.ts`
- Create: `packages/plugins/anthropic-claude/src/runtime/index.ts`
- Test: `packages/plugins/anthropic-claude/src/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: `createAnthropic` from `@ai-sdk/anthropic`; `RuntimeContext`, `OAuthRuntimeResult`; `currentClaudeCredential`; `CLAUDE_API_BASE_URL`, `CLAUDE_OAUTH_BETA`.
- Produces: `createClaudeRuntime(context, options)`, `createClaudeDynamicFetch(credentials, options)`.

- [ ] **Step 1: Write the failing runtime tests**

Create `packages/plugins/anthropic-claude/src/runtime/runtime.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeContext } from '@aio-proxy/plugin-sdk';

import { CLAUDE_OAUTH_BETA } from '../oauth/constants';
import type { ClaudeCredential } from '../schema';
import { createClaudeRuntime } from './runtime';

const credential: ClaudeCredential = {
  accessToken: 'current-token',
  refreshToken: 'refresh',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

describe('Claude runtime', () => {
  test('is ProviderV4 language-model-only and sends OAuth inference headers', async () => {
    const calls: Request[] = [];
    const runtime = await createClaudeRuntime(context(), {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.raw).toBeUndefined();
    expect(runtime.tokenCount).toBeUndefined();
    expect(() => runtime.provider.embeddingModel('claude-sonnet-5')).toThrow('embedding');
    const controller = new AbortController();
    await runtime.provider.languageModel('claude-sonnet-5').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      abortSignal: controller.signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer current-token');
    expect(calls[0]?.headers.get('anthropic-beta')?.split(',').map((value) => value.trim())).toContain(CLAUDE_OAUTH_BETA);
    expect(calls[0]?.headers.get('x-api-key')).toBeNull();
    expect(calls[0]?.headers.get('anthropic-api-key')).toBeNull();
    expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
  });
});

function context(): RuntimeContext<ClaudeCredential, Record<string, never>> {
  const catalog: ModelCatalog = {
    language: [{ id: 'claude-sonnet-5', extra: { protocol: 'anthropic' } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
  const port: CredentialPort<ClaudeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
  return {
    credentials: port,
    options: {},
    catalog,
    fetch: globalThis.fetch,
  };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/runtime/runtime.test.ts`
Expected: FAIL because `./runtime` does not exist.

- [ ] **Step 3: Implement runtime**

```ts
const fetch = options.fetch ?? context.fetch ?? globalThis.fetch;
createAnthropic({
  name: 'anthropic-claude-oauth',
  baseURL: 'https://api.anthropic.com/v1',
  authToken: 'dynamic-credential',
  fetch: createClaudeDynamicFetch(context.credentials, { ...options, fetch }),
});
```

Discover, identity, refresh, and runtime all use that fetch chain. Dynamic fetch must call `currentClaudeCredential`, strip auth/API-key headers, set Bearer, ensure `anthropic-beta` contains `oauth-2025-04-20` (prepend if AI SDK already set other betas), set `anthropic-version: 2023-06-01` when absent, set the refresh User-Agent when absent, and preserve method/body/signal. Do not set `aioProxy.traffic` to `control`. Return `{ provider: { specificationVersion: 'v4', languageModel, embeddingModel: () => throw, imageModel: () => throw } }` with no `raw`. Copy Kimi `plugin.ts` injection so catalog / runtime / refreshCredential receive `context.fetch`.

`src/runtime/index.ts` is export-only: `export * from './runtime';`

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/runtime/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/runtime
git commit -m "feat(anthropic-claude): invoke Anthropic models with OAuth bearer fetch"
```

---

### Task 7: Plugin descriptor and CPA `claude` import

**Files:**
- Create: `packages/plugins/anthropic-claude/src/plugin.ts`
- Create: `packages/plugins/anthropic-claude/src/index.ts`
- Test: `packages/plugins/anthropic-claude/src/plugin.test.ts`

**Interfaces:**
- Consumes: `definePlugin`, `OAuthAdapter`, `ConfigSpec` from `@aio-proxy/plugin-sdk`; `loginClaude`, `refreshClaudeCredential`, `claudeLoginResult`, `discoverClaudeModels`, `initialClaudeCatalogFallback`, `createClaudeRuntime`, `credentialSchema`.
- Produces: `createAnthropicClaudePlugin(presentation?, dependencies?)`, `englishPresentationText`, `CLAUDE_PLUGIN_VERSION`, default descriptor.

- [ ] **Step 1: Write the failing plugin tests**

Create `packages/plugins/anthropic-claude/src/plugin.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { OAuthAdapter, OAuthLoginContext, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import claudePlugin, { CLAUDE_PLUGIN_VERSION, createAnthropicClaudePlugin } from '.';
import packageJson from '../package.json' with { type: 'json' };
import { CLAUDE_CATALOG_TTL_MS } from './catalog';
import { ClaudeIdentityMissingError, claudeLoginResult } from './oauth';
import type { ClaudeCredential } from './schema';

test('exports a versioned default descriptor with empty account options', async () => {
  const adapter = await adapterFrom(claudePlugin);
  expect(adapter.id).toBe('default');
  expect(claudePlugin.metadata.icon).toBe('anthropic');
  expect(adapter.account.options.form).toEqual([]);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: CLAUDE_CATALOG_TTL_MS });
  expect(adapter.quota).toBeUndefined();
  expect(CLAUDE_PLUGIN_VERSION).toBe(packageJson.version);
});

test('uses host loopback and localized adapter copy', async () => {
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(
      {
        adapterLabel: { default: 'Login with Claude', 'zh-Hans': '使用 Claude 登录' },
        waitingForAuthorization: { default: 'Waiting locally', 'zh-Hans': '正在本地等待' },
      },
      {
        now: () => 1_700_000_000_000,
        fetch: async () =>
          Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
            account: { uuid: 'acct', email_address: 'person@example.com' },
          }),
      },
    ),
  );
  const progress: unknown[] = [];
  const result = await adapter.login(
    {
      signal: new AbortController().signal,
      progress: (message) => progress.push(message),
      authorization: {
        presentDeviceCode: async () => {
          throw new Error('unexpected device-code');
        },
        presentAuthorizeUrl: async () => {
          throw new Error('unexpected presentAuthorizeUrl');
        },
        loopback: async (request) => {
          expect(request.redirect).toEqual({ hostname: 'localhost', port: 54545, path: '/callback' });
          expect(request.allowManualCallbackUrl).toBe(true);
          return { code: 'code', redirectUri: 'http://localhost:54545/callback' };
        },
      },
    } satisfies OAuthLoginContext,
    {},
  );
  expect(adapter.displayName).toEqual({ default: 'Login with Claude', 'zh-Hans': '使用 Claude 登录' });
  expect(progress).toEqual([{ default: 'Waiting locally', 'zh-Hans': '正在本地等待' }]);
  expect(result.credentials.accountId).toBe('acct');
});

test('imports CPA claude credentials with the same fingerprint rules', async () => {
  const adapter = await adapterFrom(createAnthropicClaudePlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  expect(importer.types).toEqual(['claude']);
  const context = { progress: () => {}, signal: new AbortController().signal };
  const imported = await importer.import(
    context,
    {},
    {
      type: 'claude',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expired: '2026-08-24T12:00:00Z',
      email: 'Person@Example.com',
      account: { uuid: 'acct-1' },
      organization: { uuid: 'org-1', name: 'Team' },
      id_token: 'must-not-persist',
    },
  );
  const expected = claudeLoginResult({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.parse('2026-08-24T12:00:00Z'),
    email: 'Person@Example.com',
    accountId: 'acct-1',
    organizationId: 'org-1',
    organizationName: 'Team',
  });
  expect(imported).toEqual(expected);
  expect(Object.keys(imported.credentials).toSorted()).toEqual([
    'accessToken',
    'accountId',
    'email',
    'expiresAt',
    'organizationId',
    'organizationName',
    'refreshToken',
  ]);
  const invalidExpiry = await importer.import(context, {}, {
    type: 'claude',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expired: 'invalid',
    email: 'person@example.com',
    account_uuid: 'acct-1',
  });
  expect(invalidExpiry.expiresAt).toBe(0);
});

test('rejects CPA files that still have no accountId after bootstrap', async () => {
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(undefined, {
      fetch: async () => new Response('nope', { status: 500 }),
    }),
  );
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  await expect(
    importer.import(
      { progress: () => {}, signal: new AbortController().signal, fetch: async () => new Response('nope', { status: 500 }) },
      {},
      { type: 'claude', access_token: 'access-1', refresh_token: 'refresh-1', email: 'person@example.com' },
    ),
  ).rejects.toBeInstanceOf(ClaudeIdentityMissingError);
});

test('imports flat CPA claude files using account_uuid aliases', async () => {
  const adapter = await adapterFrom(createAnthropicClaudePlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const imported = await importer.import(
    { progress: () => {}, signal: new AbortController().signal },
    {},
    {
      type: 'claude',
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expired: '2026-08-24T12:00:00Z',
      email: 'Person@Example.com',
      account_uuid: 'acct-2',
      organization_uuid: 'org-2',
      organization_name: 'Team',
      claude_device_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      id_token: 'must-not-persist',
    },
  );
  expect(imported).toEqual(
    claudeLoginResult({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: Date.parse('2026-08-24T12:00:00Z'),
      email: 'Person@Example.com',
      accountId: 'acct-2',
      organizationId: 'org-2',
      organizationName: 'Team',
    }),
  );
  expect(Object.keys(imported.credentials).toSorted()).toEqual([
    'accessToken',
    'accountId',
    'email',
    'expiresAt',
    'organizationId',
    'organizationName',
    'refreshToken',
  ]);
});

test('refreshCredential exchanges an unexpired credential instead of returning it unchanged', async () => {
  let exchanges = 0;
  const adapter = await adapterFrom(
    createAnthropicClaudePlugin(undefined, {
      now: () => 1_000,
      fetch: async () => {
        exchanges += 1;
        return Response.json({ access_token: 'new-access', expires_in: 60 });
      },
    }),
  );
  const credential: ClaudeCredential = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: 'person@example.com',
    accountId: 'acct',
  };
  const result = await adapter.refreshCredential!({
    credential,
    options: {},
    signal: new AbortController().signal,
  });
  expect(exchanges).toBe(1);
  expect(result.value.accessToken).toBe('new-access');
  expect(result.value.refreshToken).toBe('old-refresh');
  expect(result.value.expiresAt).toBe(1_000 + 60_000 - 5 * 60_000);
  expect(result.metadata).toEqual({ expiresAt: result.value.expiresAt, accountLabel: 'person@example.com' });
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, ClaudeCredential>> {
  let registered: OAuthAdapter<Record<string, never>, ClaudeCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<Record<string, never>, ClaudeCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('Claude OAuth adapter was not registered');
  return registered;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/plugin.test.ts`
Expected: FAIL because `src/index.ts` / `createAnthropicClaudePlugin` do not exist.

- [ ] **Step 3: Implement the plugin**

`createAnthropicClaudePlugin` must:

- register adapter `id: 'default'`;
- use empty `zod.object({})` account options;
- `credentials: credentialSchema`;
- `icon: 'anthropic'`;
- `login` parse options then `loginClaude(context, { waiting: presentationText.waitingForAuthorization }, deps)` (inject `context.fetch` when the factory did not);
- `credentialImports.cpa.types = ['claude']` with a `.loose()` Zod object requiring `type: 'claude'`, `access_token`, `refresh_token`; map `expired` with `Date.parse` (invalid → `0`); map identity as `email` / `account.email_address` (same normalize as login), then `account.uuid` / `account_id` / `account_uuid`, then `organization.uuid` / `organization_uuid` and `organization.name` / `organization_name` (nested wins); ignore `id_token`, `claude_device_ids`, `last_refresh`; if `accountId` is still missing and import `context.fetch` exists, run non-fatal `resolveClaudeIdentity` with `phase: 'login'` and merge; then call `claudeLoginResult`, which throws `ClaudeIdentityMissingError` when `accountId` is still missing;
- catalog TTL + `discoverClaudeModels` + `initialClaudeCatalogFallback`;
- `createRuntime: createClaudeRuntime`;
- `refreshCredential` always calls `refreshClaudeCredential` (no expiry short-circuit);
- no `quota`.

`src/index.ts`:

```ts
import packageJson from '../package.json' with { type: 'json' };
import { createAnthropicClaudePlugin, englishPresentationText } from './plugin';

export * from './catalog';
export * from './oauth';
export { createAnthropicClaudePlugin, englishPresentationText, type ClaudePresentationText } from './plugin';
export * from './runtime/index';
export * from './schema';

export const CLAUDE_PLUGIN_VERSION = packageJson.version;

export default createAnthropicClaudePlugin(englishPresentationText);
```

English defaults: pluginLabel `Claude Pro/Max`, pluginDescription `Use a Claude Pro or Max account to access models`, adapterLabel `Login with Claude`, waitingForAuthorization `Waiting for Claude authorization`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --preload=packages/plugins/anthropic-claude/test/setup.ts packages/plugins/anthropic-claude/src/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/src/plugin.ts packages/plugins/anthropic-claude/src/plugin.test.ts packages/plugins/anthropic-claude/src/index.ts
git commit -m "feat(anthropic-claude): register OAuth adapter and CPA claude import"
```

---

### Task 8: Artifact smoke for the embedded client ID

**Files:**
- Create: `packages/plugins/anthropic-claude/oauth.smoke.ts`

**Interfaces:**
- Consumes: `claudeClientId` from `rslib.config.ts` and the built `dist/` files.
- Produces: artifact test that the client ID is defined into JS without source plaintext.

- [ ] **Step 1: Write the failing smoke test**

Create `packages/plugins/anthropic-claude/oauth.smoke.ts`:

```ts
import { expect, test } from 'bun:test';

import { claudeClientId } from './rslib.config';

test('build embeds the Claude OAuth client ID without leaving source plaintext', async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file('./src/oauth/constants.ts').text(),
    Bun.file('./rslib.config.ts').text(),
    Bun.file('./test/setup.ts').text(),
    Bun.file('./dist/oauth/constants.js').text(),
  ]);
  const encodedClientId = btoa(claudeClientId);

  expect(new Bun.CryptoHasher('sha256').update(claudeClientId).digest('hex')).toBe(
    '473668f2b13c71009d028ff0ef74c2cf76e71cbdd33b76e69fcc42d7e59aca4b',
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(claudeClientId)).toBe(false);
    expect(text.includes(encodedClientId)).toBe(false);
  }
  expect(artifact.includes(claudeClientId)).toBe(true);
  expect(artifact.includes('__AIO_PROXY_CLAUDE_CLIENT_ID__')).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});
```

- [ ] **Step 2: Run the smoke test before building to verify it fails**

Run: `bun test ./oauth.smoke.ts`
Working directory: `packages/plugins/anthropic-claude`
Expected: FAIL because `dist/oauth/constants.js` does not exist or does not embed the ID.

- [ ] **Step 3: Build the package**

Run: `bun run --filter @aio-proxy/plugin-anthropic-claude build`
Expected: `dist/` contains ESM + dts. If workspace resolution fails, run `bun install` at the repo root first (do not hand-edit `bun.lock` except via install).

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `bun test ./oauth.smoke.ts`
Working directory: `packages/plugins/anthropic-claude`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/anthropic-claude/oauth.smoke.ts
git commit -m "feat(anthropic-claude): hide OAuth client ID from source and verify artifact embed"
```

---

### Task 9: Built-in registration, CLI lists, changeset

**Warning:** `packages/core/src/plugins/builtins.ts`, `builtins.test.ts`, `packages/core/package.json`, `.changeset/config.json`, and the CLI built-in enumerations are shared with in-flight OpenRouter / Muse (and any other new built-in) PRs. Rebase onto the latest target branch and insert `@aio-proxy/plugin-anthropic-claude` in the current sorted position. Do not invent a shared scaffolding PR. Do not rewrite unrelated plugin entries.

**Files:**
- Modify: `packages/core/src/plugins/builtins.ts`
- Modify: `packages/core/src/plugins/builtins.test.ts`
- Modify: `packages/core/package.json`
- Modify: `.changeset/config.json`
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`
- Modify: `packages/cli/__tests__/binary-build.test.ts`
- Create: `.changeset/anthropic-claude-oauth.md`

**Interfaces:**
- Consumes: `createAnthropicClaudePlugin`, `CLAUDE_PLUGIN_VERSION` from `@aio-proxy/plugin-anthropic-claude`.
- Produces: embedded built-in `@aio-proxy/plugin-anthropic-claude` with adapter `default`.

- [ ] **Step 1: Write the failing host registration assertions**

In `packages/core/src/plugins/builtins.ts`, `BUILT_IN_PLUGIN_PACKAGE_NAMES` is currently:

```ts
export const BUILT_IN_PLUGIN_PACKAGE_NAMES = [
  '@aio-proxy/plugin-cursor',
  '@aio-proxy/plugin-github-copilot',
  '@aio-proxy/plugin-google-antigravity',
  '@aio-proxy/plugin-kimi-code',
  '@aio-proxy/plugin-openai-chatgpt',
  '@aio-proxy/plugin-xai-grok',
] as const;
```

Insert `@aio-proxy/plugin-anthropic-claude` first (sorted). Update `packages/core/src/plugins/builtins.test.ts` `expectedBuiltIns` to the same array. Extend the “true, true, …” length to match. Add a Chinese-copy assertion:

```ts
const claude = snapshot.registry.resolveOAuth('@aio-proxy/plugin-anthropic-claude', 'default');
const claudePlugin = snapshot.plugins.get('@aio-proxy/plugin-anthropic-claude');
expect(resolveLocalizedText(claudePlugin?.displayName ?? '', 'zh-Hans')).toBe('Claude Pro/Max');
expect(resolveLocalizedText(claudePlugin?.description ?? '', 'zh-Hans')).toBe(
  '使用 Claude Pro 或 Max 账号访问模型',
);
expect(resolveLocalizedText(claude?.displayName ?? '', 'zh-Hans')).toBe('使用 Claude 登录');
```

In `packages/cli/src/plugin-commands/plugin/add.test.ts`, the sorted expected list must include `@aio-proxy/plugin-anthropic-claude` first.

In `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`, add `'@aio-proxy/plugin-anthropic-claude'` to the `builtIns` array used by `test.each`.

In `packages/cli/__tests__/binary-build.test.ts`, add `expect(stdout).toContain('@aio-proxy/plugin-anthropic-claude');`.

Run: `bun test packages/core/src/plugins/builtins.test.ts`
Expected: FAIL because the package is not embedded yet.

- [ ] **Step 2: Register the plugin in core and lockfile**

Add to `packages/core/package.json` dependencies (alphabetically among `@aio-proxy/plugin-*`):

```json
"@aio-proxy/plugin-anthropic-claude": "workspace:*"
```

In `packages/core/src/plugins/builtins.ts`:

```ts
import { CLAUDE_PLUGIN_VERSION, createAnthropicClaudePlugin } from '@aio-proxy/plugin-anthropic-claude';
```

Insert the package name first in `BUILT_IN_PLUGIN_PACKAGE_NAMES`. Insert this embedded definition first in `createEmbeddedBuiltIns()`:

```ts
{
  packageName: '@aio-proxy/plugin-anthropic-claude',
  version: CLAUDE_PLUGIN_VERSION,
  descriptor: createAnthropicClaudePlugin({
    pluginLabel: localized('Claude Pro/Max', 'Claude Pro/Max'),
    pluginDescription: localized(
      'Use a Claude Pro or Max account to access models',
      '使用 Claude Pro 或 Max 账号访问模型',
    ),
    adapterLabel: localized('Login with Claude', '使用 Claude 登录'),
    waitingForAuthorization: localized('Waiting for Claude authorization', '正在等待 Claude 授权'),
  }) as unknown as PluginDescriptor<unknown>,
},
```

Add `"@aio-proxy/plugin-anthropic-claude"` to `.changeset/config.json` `fixed[0]`, immediately before `"@aio-proxy/plugin-cursor"`.

Run `bun install` at the repo root so `bun.lock` records the new workspace dependency.

- [ ] **Step 3: Add the changeset**

Create `.changeset/anthropic-claude-oauth.md`:

```md
---
'@aio-proxy/plugin-anthropic-claude': minor
'@aio-proxy/core': minor
'aio-proxy': minor
---

anthropic-claude: add Claude Pro/Max subscription OAuth login, model discovery, and Anthropic runtime
```

Do not target only `@aio-proxy/core`. Do not run `changeset version`.

- [ ] **Step 4: Run the host tests to verify they pass**

Run:

```bash
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts
bun test packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
```

Expected: PASS. `binary-build.test.ts` is an artifact test; run it only if a CLI binary is already built in this workspace. Do not fail the task solely because the binary artifact job was not executed here — the assertion must still be present.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/builtins.ts packages/core/src/plugins/builtins.test.ts packages/core/package.json bun.lock .changeset/config.json .changeset/anthropic-claude-oauth.md packages/cli/src/plugin-commands/plugin/add.test.ts packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts packages/cli/__tests__/binary-build.test.ts
git commit -m "feat(anthropic-claude): embed Claude Pro/Max OAuth as a built-in plugin"
```

---

## Final verification

Run in this order:

```bash
bun run --filter @aio-proxy/plugin-anthropic-claude test:unit
bun run --filter @aio-proxy/plugin-anthropic-claude build
bun run --filter @aio-proxy/plugin-anthropic-claude test:artifact
bun run check
bun test packages/core/src/plugins/builtins.test.ts
bun test packages/cli/src/plugin-commands/plugin/add.test.ts
bun test packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts
```

Completion gate: `bun run preflight` (oxlint type-aware + oxfmt check + all unit/artifact tests). Fix any failure in the package or host files this plan touched before declaring done.

---

## Self-review (spec coverage)

| Spec section | Task |
| --- | --- |
| Credential + fingerprint | Task 1 |
| PKCE + authorize `code=true` | Task 2 |
| Loopback login + JSON exchange + identity | Task 3 |
| Refresh skew, beta header, current port | Task 4 |
| Catalog TTL, pagination, fallback IDs | Task 5 |
| Model-only `@ai-sdk/anthropic` runtime | Task 6 |
| Descriptor, icon, empty options, CPA `claude` | Task 7 |
| Client-ID embed smoke | Task 8 |
| Built-ins, changeset `fixed`, CLI lists | Task 9 |
| No quota / no raw / no AuthorizationPort change | Tasks 6–7 (explicit absences) |
