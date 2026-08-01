# Cursor OAuth Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an independently mergeable Phase 1 of `@aio-proxy/plugin-cursor`: a new `authorize_url` login-presentation seam plus Cursor PKCE login, JWT-expiry parsing, refresh-token rotation, credential storage, and a minimal static model catalog, with the Phase 2 runtime explicitly stubbed to throw.

**Architecture:** A new `@aio-proxy/plugin-cursor` package owns every Cursor-specific concern behind the existing `OAuthAdapter` seam. Because Cursor login has no user code and no loopback callback, we add one thin `authorize_url` presentation state across `plugin-sdk`, `types`, `server`, `cli`, `dashboard`, plus the hidden `core` deadline wrapper. OAuth login, refresh, catalog, and plugin assembly mirror the xAI Grok and Kimi Code plugins; `createRuntime` throws a Phase-2 marker error so the adapter still registers in builtins.

**Tech Stack:** Bun (`Bun.CryptoHasher`, `crypto.subtle`, `bun test`), TypeScript, `@aio-proxy/plugin-sdk`, Zod (via `zod` re-export), Rslib, paraglide i18n, `@rstest/core` (dashboard), `es-toolkit`. No protobuf, no HTTP/2, no `@ai-sdk/*` in Phase 1.

## Global Constraints

- Endpoints are fixed: login `https://cursor.com/loginDeepControl`, poll `https://api2.cursor.sh/auth/poll`, refresh `https://api2.cursor.sh/auth/exchange_user_api_key`.
- Cursor is a pure PKCE public client: no `client_id`, no client secret, no `source.define`, no `oauth.smoke.ts`, no `test:artifact` script.
- PKCE: verifier = 96 random bytes base64url; challenge = base64url(SHA-256(verifier)).
- Poll: sleep at loop top; base delay 1000 ms, backoff x1.2, max 10000 ms, max 150 attempts; HTTP 404 = pending (reset consecutive errors); 2xx = parse `{accessToken, refreshToken}`; other = count consecutive errors, fail at 3; `context.signal` aborts during request and sleep and bypasses the error count by rethrowing `signal.reason`.
- Expiry: parse access-token JWT `exp`, `expiresAt = exp*1000 - 5*60_000`; fallback `now()+3600_000`. The 5-minute skew is applied ONCE here; the refresh threshold uses `expiresAt <= now()` with no second skew.
- Fingerprint: SHA-256 of JWT `sub` (identity `sub:<sub>`, else `email:<lowercased>`, else `refresh:<token>`); `fingerprint = 'sha256:'+hex`, `suggestedKey = 'cursor-'+hex.slice(0,12)`. Never derive the fingerprint from the refresh token (it rotates). Never put raw tokens in Provider ID, label, logs, or diagnostics.
- Refresh: `POST` with `Authorization: Bearer <refresh>`, `Content-Type: application/json`, body `{}`; keep old refresh token when the response omits one; 401/403/`invalid_grant` non-retryable, network/408/429/5xx retryable, malformed non-retryable.
- Catalog: Phase 1 `policy.kind = 'static'`; `discover` returns a curated snapshot; `initialFallback` returns the curated snapshot only for retryable errors. Model `metadata` must NOT claim a `ProtocolId` (Cursor is not in the enum `'openai-compatible' | 'openai-response' | 'anthropic' | 'gemini'`); omit `protocol`.
- `createRuntime` throws `Error('Cursor runtime is not implemented in Phase 1')`; Phase 2 replaces it.
- Every handwritten non-test file stays below 300 lines; tests are colocated in same-name directories (`foo/foo.ts` + `foo/foo.test.ts`) when a module needs private collaborators, otherwise a sibling `foo.ts` + `foo.test.ts` matching xai/kimi layout.
- Prefer `es-toolkit` and Bun APIs; narrow imports; no new utility dependency when the platform already covers it.
- i18n copy ships in both `en` and `zh-Hans`; run `paraglide-js compile` after editing message JSON so `m[...]` keys exist.
- Write each behavior test first, run it to observe the expected failure, then add only enough production code to pass. Do not add tests that merely restate constants or static arrays.
- Commit style `docs:`/`feat(scope):` with footer `Co-authored-by: Codex <noreply@openai.com>`. Commit per task only when the user asks; otherwise leave staged/working changes for review.
- Final verification: `bun run --filter @aio-proxy/plugin-cursor test:unit`, `bun run --filter @aio-proxy/plugin-cursor build`, then `bun run preflight`.

---

## File Structure

Create `packages/plugins/cursor/` (Phase 1 subset; `wire/`, `gen/`, `runtime/`, `store/`, `tool-names.ts` are Phase 2):

- `package.json`, `tsconfig.json`, `rslib.config.ts`: package shell mirroring xAI Grok (no secret, no smoke test).
- `src/pkce.ts` (+ `pkce.test.ts`): PKCE verifier/challenge generation.
- `src/jwt.ts` (+ `jwt.test.ts`): JWT claim reading, `exp` parsing with 5-minute skew and fallback, identity/fingerprint derivation.
- `src/schema.ts`: `CursorCredential` Zod schema.
- `src/oauth/constants.ts`: endpoint URLs and poll tuning constants.
- `src/oauth.ts` (+ `oauth.login.test.ts`): `loginCursor` (URL build, present, poll, backoff, abort, fingerprint).
- `src/oauth/credential.ts` (+ colocated tests via `oauth.refresh.test.ts`): `refreshCursorCredential` and `currentCursorCredential` refresh policy.
- `src/catalog.ts` (+ `catalog.test.ts`): `staticCursorCatalog`, `initialCursorCatalogFallback`, `CURSOR_CATALOG_TTL_MS`.
- `src/plugin.ts` (+ `plugin.test.ts`): adapter assembly, localized presentation injection, dependency wiring, Phase-2 `createRuntime` stub.
- `src/index.ts`: package exports, `CURSOR_PLUGIN_VERSION`, default descriptor.

Modify the shared `authorize_url` seam and built-in registration:

- `packages/plugin-sdk/src/oauth.ts`: add `presentAuthorizeUrl` to `AuthorizationPort`.
- `packages/types/src/dashboard-oauth.ts` (+ `dashboard-oauth.test.ts`): add `authorize_url` session variant.
- `packages/server/src/oauth-login-session/authorization.ts`: implement `presentAuthorizeUrl`.
- `packages/cli/src/plugin-commands/authorization.ts` (+ colocated `loopback` test-support/test): implement `presentAuthorizeUrl`.
- `packages/core/src/plugins/account-login/deadline.ts`: forward `presentAuthorizeUrl` through `protectedAuthorization`.
- `packages/core/src/plugins/account-login/test-support.ts` and every full `AuthorizationPort` mock literal: add `async presentAuthorizeUrl() {}`.
- `packages/dashboard/src/modules/providers/services/oauth-service.ts` (+ `.test.ts`): add `authorize_url` to the polling predicate.
- `packages/dashboard/src/modules/providers/components/oauth-authorization-panel.tsx` (+ `.test.tsx`): add `authorize_url` branch and cancel predicate.
- `packages/i18n/messages/en.json` and `zh-Hans.json`: add `dashboard.providers.oauth.authorize_url_title`.
- `packages/core/src/plugins/builtins.ts` (+ `builtins.test.ts`): register package, version, localized copy.
- `packages/core/package.json`: add `@aio-proxy/plugin-cursor` workspace dependency; `bun.lock` updates on install.
- `packages/cli/src/plugin-commands/plugin/add.test.ts`, `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`, `packages/cli/__tests__/binary-build.test.ts`: extend built-in provider assertions to include Cursor.

---
### Task 1: `authorize_url` dashboard session schema variant

**Files:**
- Modify: `packages/types/src/dashboard-oauth.ts` — add variant to `DashboardOAuthSessionSchema` discriminated union (after the `device_code` variant near L75-81).
- Test: `packages/types/src/dashboard-oauth.test.ts` (`bun:test`, `DashboardOAuthSessionSchema.parse`).

**Interfaces:**
- Produces: a new `status: 'authorize_url'` session shape `{ id, status: 'authorize_url', url: string, instructions?: DashboardLocalizedText }`, mirroring `device_code` but WITHOUT `userCode`.

- [ ] Add a failing test asserting the new variant parses and rejects bad input:
  ```ts
  test('accepts an authorize_url session without a user code', () => {
    const parsed = DashboardOAuthSessionSchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      status: 'authorize_url',
      url: 'https://cursor.com/loginDeepControl?challenge=c&uuid=u&mode=login&redirectTarget=cli',
    });
    expect(parsed.status).toBe('authorize_url');
  });

  test('rejects an authorize_url session with a non-URL', () => {
    expect(() =>
      DashboardOAuthSessionSchema.parse({
        id: '00000000-0000-4000-8000-000000000000',
        status: 'authorize_url',
        url: 'not-a-url',
      }),
    ).toThrow();
  });
  ```
- [ ] Run `cd packages/types && bun test src/dashboard-oauth.test.ts` and confirm it FAILS (variant not in union).
- [ ] Add the variant to `DashboardOAuthSessionSchema` immediately after the `device_code` object:
  ```ts
  z.strictObject({
    ...DashboardOAuthSessionCommonSchema.shape,
    status: z.literal('authorize_url'),
    url: z.url(),
    instructions: DashboardLocalizedTextSchema.optional(),
  }),
  ```
- [ ] Run the test again and confirm it PASSES.
- [ ] Run `cd packages/types && bun test` to confirm no regression, then `bun run check` at repo root.

### Task 2: SDK `presentAuthorizeUrl` port, deadline wrapper, and mock ports

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts` — extend `AuthorizationPort` (L57-60).
- Modify: `packages/core/src/plugins/account-login/deadline.ts` — forward through `protectedAuthorization` (L31-48).
- Modify: `packages/core/src/plugins/account-login/test-support.ts` (L133 port literal).
- Modify every full `AuthorizationPort` mock literal so TS still compiles: `packages/cli/src/plugin-commands/provider-login/test-support.ts`, `packages/cli/src/plugin-commands/provider-login/presentation.boundary.test.ts`, `packages/core/src/plugins/account-login/authorization-failure.test.ts` (two literals, at the passing and failing cases), `packages/plugins/google-antigravity/src/plugin.test.ts` (two literals), `packages/plugins/kimi-code/src/oauth.test.ts` and `plugin.test.ts`, `packages/plugins/openai-chatgpt/__tests__/adapter.test.ts`, `packages/plugins/xai-grok/src/oauth.test-support.ts` and `oauth-review.test.ts`, and `packages/plugins/github-copilot/__tests__/test-support.ts` (its `loginContext` helper returns a full `authorization: { presentDeviceCode, loopback }` literal). The server login-session test `packages/server/src/dashboard-routes/oauth-login.test.ts` only *consumes* the injected production port inside `login({ authorization })`, so it has no literal to edit (Task 3 covers the server production port).
- Test: covered by the existing `core` login/authorization tests plus Task 3 (server) and Task 4 (cli).

**Interfaces:**
- Produces on `AuthorizationPort`:
  ```ts
  readonly presentAuthorizeUrl: (input: {
    readonly url: string;
    readonly instructions?: LocalizedText;
  }) => Promise<void>;
  ```
- Consumes: `LocalizedText` (already imported at L4 of `oauth.ts`).

- [ ] Add a failing test in `packages/core/src/plugins/account-login/authorization-failure.test.ts` asserting `protectedAuthorization` forwards `presentAuthorizeUrl` and wraps its host error:
  ```ts
  test('protectedAuthorization forwards presentAuthorizeUrl and protects host failures', async () => {
    const calls: Array<{ url: string }> = [];
    const port = protectedAuthorization({
      async presentDeviceCode() {},
      async presentAuthorizeUrl(input) {
        calls.push({ url: input.url });
      },
      async loopback() {
        throw new Error('unused');
      },
    });
    await port.presentAuthorizeUrl({ url: 'https://cursor.com/loginDeepControl' });
    expect(calls).toEqual([{ url: 'https://cursor.com/loginDeepControl' }]);

    const failing = protectedAuthorization({
      async presentDeviceCode() {},
      async presentAuthorizeUrl() {
        throw new Error('host exploded');
      },
      async loopback() {
        throw new Error('unused');
      },
    });
    await expect(failing.presentAuthorizeUrl({ url: 'https://cursor.com/x' })).rejects.toThrow(
      'HOST_AUTHORIZATION_FAILED',
    );
  });
  ```
- [ ] Run `cd packages/core && bun test src/plugins/account-login/authorization-failure.test.ts` and confirm it FAILS to type-check / run (method missing on the port type and on `protectedAuthorization`).
- [ ] Add `presentAuthorizeUrl` to `AuthorizationPort` in `packages/plugin-sdk/src/oauth.ts`:
  ```ts
  export type AuthorizationPort = {
    readonly presentDeviceCode: (input: DeviceCodePresentation) => Promise<void>;
    readonly presentAuthorizeUrl: (input: {
      readonly url: string;
      readonly instructions?: LocalizedText;
    }) => Promise<void>;
    readonly loopback: (input: LoopbackRequest) => Promise<{ readonly code: string; readonly redirectUri: string }>;
  };
  ```
- [ ] Forward it in `protectedAuthorization` (`deadline.ts`), between `presentDeviceCode` and `loopback`:
  ```ts
  async presentAuthorizeUrl(input) {
    try {
      await authorization.presentAuthorizeUrl(input);
    } catch (error) {
      throw protectHostAuthorizationError(error);
    }
  },
  ```
- [ ] Add `async presentAuthorizeUrl() {}` to `packages/core/src/plugins/account-login/test-support.ts` and to every full-port mock literal listed above.
- [ ] Run `cd packages/core && bun test` and confirm the new test PASSES and no other core test regresses.
- [ ] Run `bun run check` at repo root to confirm all packages still type-check.

### Task 3: Server `presentAuthorizeUrl` publisher

**Files:**
- Modify: `packages/server/src/oauth-login-session/authorization.ts` — add `presentAuthorizeUrl` to the returned `port` (near `presentDeviceCode` L116-124).
- Test: `packages/server/src/dashboard-routes/oauth-login.test.ts` (existing) plus a focused publish assertion; server tests run with `bun test --preload=./__tests__/setup.ts`.

**Interfaces:**
- Consumes: `requireHttpUrl` (from `./callback`), `options.publish`, `options.sessionId`.
- Produces: a published `{ id, status: 'authorize_url', url, instructions? }` `DashboardOAuthSession`.

- [ ] Add a failing test that a login using `presentAuthorizeUrl` publishes an `authorize_url` session (mirror the existing `presentDeviceCode` publish test in `oauth-login.test.ts`):
  ```ts
  test('publishes an authorize_url session when the adapter presents a URL', async () => {
    const published: DashboardOAuthSession[] = [];
    const auth = createDashboardAuthorization({
      sessionId: '00000000-0000-4000-8000-000000000000',
      signal: new AbortController().signal,
      publish: (session) => published.push(session),
    });
    await auth.port.presentAuthorizeUrl({ url: 'https://cursor.com/loginDeepControl?challenge=c' });
    expect(published.at(-1)).toMatchObject({ status: 'authorize_url', url: expect.stringContaining('cursor.com') });
  });
  ```
- [ ] Run `cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/oauth-login.test.ts` and confirm it FAILS.
- [ ] Implement `presentAuthorizeUrl` in the returned `port` object:
  ```ts
  async presentAuthorizeUrl(input) {
    options.publish({
      id: options.sessionId,
      status: 'authorize_url',
      url: requireHttpUrl(input.url).href,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    });
  },
  ```
- [ ] Run the test again and confirm it PASSES.
- [ ] Run `cd packages/server && bun test --preload=./__tests__/setup.ts` for the login-session area and `bun run check`.

### Task 4: CLI `presentAuthorizeUrl` presentation (no user code)

**Files:**
- Modify: `packages/cli/src/plugin-commands/authorization.ts` — add `presentAuthorizeUrl` to `createCliAuthorizationPort` (alongside `presentDeviceCode` L52-84). Reuse `requireHttpUrl` (L38-49) and `deps.copy.openedAuthorizationPage` (already present).
- Test: `packages/cli/src/plugin-commands/loopback/authorize-url.test.ts` using `createDeps` from `loopback/test-support.ts`; CLI tests run with `bun test --preload=./__tests__/setup.ts --timeout 20000`.

**Interfaces:**
- Consumes: `deps.openBrowser`, `deps.print`, `deps.copy.openedAuthorizationPage`, `deps.locale`, `LocalizedTextSchema`, `resolveLocalizedText`, `getLocale`.
- Produces: opens the browser when possible, always prints the URL, prints resolved instructions when valid; never prints or copies a user code.

- [ ] Add a failing test:
  ```ts
  import { describe, expect, test } from 'bun:test';
  import { createCliAuthorizationPort } from '../authorization';
  import { createDeps } from './test-support';

  describe('authorize-url presentation', () => {
    test('opens and always prints the URL without a user code', async () => {
      const { deps, opened, printed } = createDeps();
      await createCliAuthorizationPort(deps).presentAuthorizeUrl({
        url: 'https://cursor.com/loginDeepControl?challenge=c',
      });
      expect(opened).toEqual(['https://cursor.com/loginDeepControl?challenge=c']);
      expect(printed).toEqual(['Opened authorization page.', 'https://cursor.com/loginDeepControl?challenge=c']);
    });

    test('prints only the URL when the browser cannot open and resolves localized instructions', async () => {
      const { deps, printed } = createDeps({ openBrowser: () => false });
      await createCliAuthorizationPort({ ...deps, locale: 'zh-Hans' }).presentAuthorizeUrl({
        url: 'https://cursor.com/loginDeepControl',
        instructions: { default: 'Finish in browser', 'zh-Hans': '请在浏览器中完成' },
      });
      expect(printed).toEqual(['https://cursor.com/loginDeepControl', '请在浏览器中完成']);
    });

    test('rejects a non-http URL', async () => {
      const { deps } = createDeps();
      await expect(
        createCliAuthorizationPort(deps).presentAuthorizeUrl({ url: 'javascript:alert(1)' }),
      ).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    });
  });
  ```
  (Import `AuthorizationUrlInvalidError` from `./index` as `device-code.test.ts` does.)
- [ ] Run `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/plugin-commands/loopback/authorize-url.test.ts` and confirm it FAILS.
- [ ] Implement `presentAuthorizeUrl` in `createCliAuthorizationPort` (add before `loopback`):
  ```ts
  async presentAuthorizeUrl(input) {
    const url = requireHttpUrl(input.url);
    let opened = false;
    try {
      opened = deps.openBrowser(url.href);
    } catch {
      opened = false;
    }
    if (opened) deps.print(deps.copy.openedAuthorizationPage);
    deps.print(url.href);
    if (input.instructions !== undefined) {
      const instructions = LocalizedTextSchema.safeParse(input.instructions);
      if (instructions.success) {
        deps.print(resolveLocalizedText(instructions.data, deps.locale ?? getLocale()));
      }
    }
  },
  ```
- [ ] Run the test again and confirm it PASSES.
- [ ] Run `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/plugin-commands/loopback` and `bun run check`.

### Task 5: Dashboard `authorize_url` polling, panel branch, and i18n

**Files:**
- Modify: `packages/dashboard/src/modules/providers/services/oauth-service.ts` — add `authorize_url` to the `refetchInterval` continue-polling predicate (L36-40). This is a FUNCTIONAL fix: without it, polling stops during authorization and the session never reaches `succeeded`.
- Modify: `packages/dashboard/src/modules/providers/components/oauth-authorization-panel.tsx` — add an `authorize_url` render branch (mirror `loopback` L47-53 but no callback form) and add `'authorize_url'` to the cancel-button predicate (L95-99).
- Modify: `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json` — add `dashboard.providers.oauth.authorize_url_title`; then recompile paraglide.
- Test: `packages/dashboard/src/modules/providers/services/oauth-service.test.ts` and `components/oauth-authorization-panel.test.tsx` (`@rstest/core`); run with `rstest run`.

**Interfaces:**
- Consumes: `DashboardOAuthSession` (now including the `authorize_url` variant from Task 1), `m['dashboard.providers.oauth.authorize_url_title']`, `m['dashboard.providers.oauth.open_authorization']`, `m['dashboard.providers.oauth.cancel']`.
- Produces: continued 500 ms polling for `authorize_url`; an open-link button; a cancel button.

- [ ] Add a failing test in `oauth-service.test.ts` asserting the predicate keeps polling for `authorize_url`:
  ```ts
  test('keeps polling while awaiting browser authorization', () => {
    const options = oauthSessionQueryOptions('session-1');
    const query = {
      state: { status: 'success', data: { session: { id: 'session-1', status: 'authorize_url', url: 'https://cursor.com/x' } } },
    } as never;
    expect(options.refetchInterval?.(query)).toBe(500);
  });
  ```
- [ ] Add a failing test in `oauth-authorization-panel.test.tsx` asserting the branch renders the title, the open link, and a cancel button, with no textbox:
  ```ts
  test('renders the authorize_url branch with an open link and cancel, without a callback field', () => {
    render(
      <OAuthAuthorizationPanel
        session={{ id: 'id', status: 'authorize_url', url: 'https://cursor.com/loginDeepControl' }}
        onSubmitCallback={() => {}}
        onCancel={() => {}}
        isPending={false}
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://cursor.com/loginDeepControl');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });
  ```
- [ ] Run `cd packages/dashboard && rstest run src/modules/providers/services/oauth-service.test.ts src/modules/providers/components/oauth-authorization-panel.test.tsx` and confirm both FAIL.
- [ ] Update the `refetchInterval` predicate to include `authorize_url`:
  ```ts
  return status === undefined ||
    status === 'preparing' ||
    status === 'device_code' ||
    status === 'authorize_url' ||
    status === 'loopback' ||
    status === 'discovering'
    ? 500
    : false;
  ```
- [ ] Add the panel branch (after the `device_code` block) and extend the cancel predicate:
  ```tsx
  {session.status === 'authorize_url' ? (
    <div className="space-y-3">
      <h2 className="font-semibold">{m['dashboard.providers.oauth.authorize_url_title']()}</h2>
      <Button nativeButton={false} render={<a href={session.url} target="_blank" rel="noreferrer" />}>
        {m['dashboard.providers.oauth.open_authorization']()}
      </Button>
    </div>
  ) : null}
  ```
  ```tsx
  {session.status === 'preparing' ||
  session.status === 'device_code' ||
  session.status === 'authorize_url' ||
  session.status === 'loopback' ||
  session.status === 'discovering' ? (
    <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
      {m['dashboard.providers.oauth.cancel']()}
    </Button>
  ) : null}
  ```
- [ ] Add the i18n key under `dashboard.providers.oauth` in both message files: en `"authorize_url_title": "Authorize in your browser"`, zh-Hans `"authorize_url_title": "在浏览器中完成授权"`.
- [ ] Recompile messages: `cd packages/i18n && bun run build` (runs `paraglide-js compile`).
- [ ] Re-run the two dashboard tests and confirm they PASS; then `cd packages/dashboard && rstest run` for the providers module and `bun run check`.

### Task 6: `@aio-proxy/plugin-cursor` package shell

**Files:**
- Create: `packages/plugins/cursor/package.json`
- Create: `packages/plugins/cursor/tsconfig.json`
- Create: `packages/plugins/cursor/rslib.config.ts`

**Interfaces:**
- Produces: a buildable empty library package named `@aio-proxy/plugin-cursor`, mirroring xAI Grok (public PKCE client, so no `source.define`, no smoke test).

- [ ] Create `package.json` (no `@ai-sdk/*` in Phase 1):
  ```json
  {
    "name": "@aio-proxy/plugin-cursor",
    "version": "0.0.1",
    "private": true,
    "files": ["dist"],
    "type": "module",
    "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
    "scripts": {
      "build": "rslib",
      "test": "bun run test:unit",
      "test:unit": "bun test"
    },
    "dependencies": { "@aio-proxy/plugin-sdk": "workspace:*" },
    "devDependencies": {
      "@aio-proxy/infra": "workspace:*",
      "@rslib/core": "catalog:",
      "@types/bun": "catalog:",
      "typescript": "catalog:"
    }
  }
  ```
- [ ] Create `tsconfig.json` identical to xAI Grok:
  ```json
  {
    "extends": "@aio-proxy/infra/tsconfig/base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["bun"] },
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts", "src/**/*.test-support.ts"]
  }
  ```
- [ ] Create `rslib.config.ts`:
  ```ts
  import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

  export default defineLibraryConfig();
  ```
- [ ] Run `bun install` at repo root so the workspace resolves the new package.
- [ ] Confirm `bun run --filter @aio-proxy/plugin-cursor build` fails only because `src/index.ts` does not exist yet (expected until Task 12).

### Task 7: PKCE verifier and challenge

**Files:**
- Create: `packages/plugins/cursor/src/pkce.ts`
- Create: `packages/plugins/cursor/src/pkce.test.ts`

**Interfaces:**
- Produces: `generateCursorPkce(): Promise<{ verifier: string; challenge: string }>`.

- [ ] Write a failing test asserting the verifier is base64url, the challenge equals base64url(SHA-256(verifier)), and two calls differ:
  ```ts
  import { expect, test } from 'bun:test';
  import { generateCursorPkce } from './pkce';

  const BASE64URL = /^[A-Za-z0-9_-]+$/;

  test('produces a base64url verifier and a matching S256 challenge', async () => {
    const { verifier, challenge } = await generateCursorPkce();
    expect(verifier).toMatch(BASE64URL);
    expect(challenge).toMatch(BASE64URL);
    const expected = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ).toString('base64url');
    expect(challenge).toBe(expected);
  });

  test('produces unique verifiers', async () => {
    const [a, b] = await Promise.all([generateCursorPkce(), generateCursorPkce()]);
    expect(a.verifier).not.toBe(b.verifier);
  });
  ```
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL (module missing).
- [ ] Implement `pkce.ts` (mirror OMP `pkce.ts`, 96-byte verifier):
  ```ts
  export async function generateCursorPkce(): Promise<{ readonly verifier: string; readonly challenge: string }> {
    const verifierBytes = new Uint8Array(96);
    crypto.getRandomValues(verifierBytes);
    const verifier = Buffer.from(verifierBytes).toString('base64url');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: Buffer.from(digest).toString('base64url') };
  }
  ```
- [ ] Run the test again and confirm PASS.

### Task 8: JWT expiry parsing and identity fingerprint

**Files:**
- Create: `packages/plugins/cursor/src/jwt.ts`
- Create: `packages/plugins/cursor/src/jwt.test.ts`

**Interfaces:**
- Produces:
  - `readCursorClaims(token: string): Record<string, unknown>`
  - `cursorTokenExpiry(token: string, now: number): number` — `exp*1000 - 5*60_000`, fallback `now + 3600_000`. Skew applied ONCE here.
  - `cursorIdentity(input: { accessToken: string; refreshToken: string }): { fingerprint: string; suggestedKey: string; label: string; subject?: string; email?: string }` using JWT `sub` (then lowercased `email`, then `refresh:`).

**Global constraints:** the 5-minute skew lives only in `cursorTokenExpiry`; fingerprint derives from `sub`, never the refresh token.

- [ ] Write failing tests (build JWTs like `['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.')`):
  ```ts
  import { expect, test } from 'bun:test';
  import { cursorIdentity, cursorTokenExpiry, readCursorClaims } from './jwt';

  const jwt = (payload: object) =>
    ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

  test('applies a single 5-minute skew to the JWT exp', () => {
    const exp = 2_000_000; // seconds
    expect(cursorTokenExpiry(jwt({ exp }), 0)).toBe(exp * 1000 - 5 * 60_000);
  });

  test('falls back to now + 1 hour when exp is unparseable', () => {
    expect(cursorTokenExpiry('not.a.jwt', 1_000)).toBe(1_000 + 3_600_000);
    expect(cursorTokenExpiry(jwt({}), 1_000)).toBe(1_000 + 3_600_000);
  });

  test('derives a stable sub-based fingerprint independent of the refresh token', () => {
    const a = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }), refreshToken: 'r1' });
    const b = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }), refreshToken: 'r2-rotated' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint.startsWith('sha256:')).toBe(true);
    expect(a.suggestedKey).toBe(`cursor-${a.fingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}`);
    expect(a.email).toBe('a@b.com');
  });

  test('falls back to the refresh token only when no sub or email exists', () => {
    const id = cursorIdentity({ accessToken: jwt({}), refreshToken: 'only-refresh' });
    const expected = new Bun.CryptoHasher('sha256').update('refresh:only-refresh').digest('hex');
    expect(id.fingerprint).toBe(`sha256:${expected}`);
    expect(id.label).toBe('Cursor');
  });
  ```
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL.
- [ ] Implement `jwt.ts` (mirror xAI `readClaims`/`readClaim` + identity; label is always `Cursor`):
  ```ts
  export function readCursorClaims(token: string): Record<string, unknown> {
    try {
      const payload = token.split('.')[1];
      const value: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  function readClaim(claims: Record<string, unknown>, key: string): string | undefined {
    const value = claims[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  export function cursorTokenExpiry(token: string, now: number): number {
    const exp = readCursorClaims(token).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 - 5 * 60_000 : now + 3_600_000;
  }

  export function cursorIdentity(input: { readonly accessToken: string; readonly refreshToken: string }): {
    readonly fingerprint: string;
    readonly suggestedKey: string;
    readonly label: string;
    readonly subject?: string;
    readonly email?: string;
  } {
    const claims = readCursorClaims(input.accessToken);
    const subject = readClaim(claims, 'sub');
    const email = readClaim(claims, 'email')?.toLowerCase();
    const identity =
      subject !== undefined ? `sub:${subject}` : email !== undefined ? `email:${email}` : `refresh:${input.refreshToken}`;
    const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
    return {
      fingerprint: `sha256:${digest}`,
      suggestedKey: `cursor-${digest.slice(0, 12)}`,
      label: 'Cursor',
      ...(subject === undefined ? {} : { subject }),
      ...(email === undefined ? {} : { email }),
    };
  }
  ```
- [ ] Run the test again and confirm PASS.

### Task 9: Credential schema and refresh policy

**Files:**
- Create: `packages/plugins/cursor/src/schema.ts`
- Create: `packages/plugins/cursor/src/oauth/constants.ts`
- Create: `packages/plugins/cursor/src/oauth/credential.ts`
- Create: `packages/plugins/cursor/src/oauth.refresh.test.ts`

**Interfaces:**
- Produces:
  - `credentialSchema` / `CursorCredential = { accessToken; refreshToken; expiresAt; email?; subject? }`.
  - `refreshCursorCredential(current, options?): Promise<CursorCredential>` — POST refresh, keep old refresh when omitted, classify errors.
  - `currentCursorCredential(port, options?): Promise<CursorCredential>` — return current when `expiresAt > now()`, else `port.refresh`.
- Consumes: `CredentialPort`, `CredentialRefreshError`, `cursorTokenExpiry` (Task 8), constants.

**Global constraints:** refresh threshold uses `expiresAt > now()` with NO extra skew (skew already baked into `expiresAt`); `data.refreshToken || current.refreshToken`.

- [ ] Create `oauth/constants.ts`:
  ```ts
  export const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl';
  export const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll';
  export const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';
  export const CURSOR_POLL_MAX_ATTEMPTS = 150;
  export const CURSOR_POLL_BASE_DELAY_MS = 1_000;
  export const CURSOR_POLL_MAX_DELAY_MS = 10_000;
  export const CURSOR_POLL_BACKOFF = 1.2;
  ```
- [ ] Create `schema.ts`:
  ```ts
  import { zod } from '@aio-proxy/plugin-sdk';

  export const credentialSchema = zod.object({
    accessToken: zod.string().min(1),
    refreshToken: zod.string().min(1),
    expiresAt: zod.number(),
    email: zod.string().min(1).optional(),
    subject: zod.string().min(1).optional(),
  });

  export type CursorCredential = zod.infer<typeof credentialSchema>;
  ```
- [ ] Write failing tests in `oauth.refresh.test.ts` for: refresh keeps the old refresh token when the response omits one; rotates it when present; recomputes `expiresAt` from the new access token; classifies 401/`invalid_grant` non-retryable and 500 retryable; and `currentCursorCredential` returns the current value when not expired and refreshes when `expiresAt <= now()`. Use a fake `fetch`, `now`, and a fake `CredentialPort` whose `refresh` invokes the exchange callback.
  ```ts
  import { expect, test } from 'bun:test';
  import { CredentialRefreshError } from '@aio-proxy/plugin-sdk';
  import { currentCursorCredential, refreshCursorCredential } from './oauth/credential';

  const jwt = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');
  const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  test('keeps the old refresh token when the refresh response omits one', async () => {
    const next = await refreshCursorCredential(
      { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0 },
      { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000 }) }) },
    );
    expect(next.refreshToken).toBe('keep-me');
    expect(next.expiresAt).toBe(4_000 * 1000 - 5 * 60_000);
  });

  test('rotates the refresh token when the response returns one', async () => {
    const next = await refreshCursorCredential(
      { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 },
      { now: () => 0, fetch: async () => okResponse({ accessToken: jwt({ exp: 4_000 }), refreshToken: 'new-refresh' }) },
    );
    expect(next.refreshToken).toBe('new-refresh');
  });

  test('classifies auth failures as non-retryable and 5xx as retryable', async () => {
    await expect(
      refreshCursorCredential(
        { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
        { now: () => 0, fetch: async () => new Response('{}', { status: 401 }) },
      ),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      refreshCursorCredential(
        { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
        { now: () => 0, fetch: async () => new Response('{}', { status: 500 }) },
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  test('currentCursorCredential refreshes only when expiresAt <= now', async () => {
    const fresh = { accessToken: 'a', refreshToken: 'r', expiresAt: 10_000 };
    const port = {
      read: async () => ({ value: fresh, revision: 1 }),
      refresh: async () => {
        throw new Error('must not refresh a fresh credential');
      },
    };
    expect(await currentCursorCredential(port, { now: () => 5_000 })).toBe(fresh);
  });
  ```
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL.
- [ ] Implement `oauth/credential.ts` (mirror kimi credential.ts but with JSON body `{}`, `Authorization: Bearer <refresh>`, expiry from `cursorTokenExpiry`, threshold `expiresAt > now()`):
  ```ts
  import { type CredentialPort, CredentialRefreshError } from '@aio-proxy/plugin-sdk';

  import { cursorTokenExpiry } from '../jwt';
  import type { CursorCredential } from '../schema';
  import { CURSOR_REFRESH_URL } from './constants';

  export type CursorOAuthDependencies = {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly uuid?: () => string;
    readonly signal?: AbortSignal;
  };

  const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

  export async function refreshCursorCredential(
    current: CursorCredential,
    options: CursorOAuthDependencies = {},
  ): Promise<CursorCredential> {
    const fetcher = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    let response: Response;
    try {
      response = await fetcher(CURSOR_REFRESH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${current.refreshToken}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: options.signal ?? null,
      });
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      throw refreshError(true, 'network');
    }
    if (!response.ok) {
      const oauthError = await readOAuthError(response);
      const invalidGrant = oauthError === 'invalid_grant';
      throw refreshError(
        !invalidGrant && isRetryableStatus(response.status),
        invalidGrant ? 'invalid_grant' : response.status === 401 || response.status === 403 ? 'rejected' : 'http',
        response.status,
      );
    }
    const token = await parseToken(response);
    return {
      ...current,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? current.refreshToken,
      expiresAt: cursorTokenExpiry(token.accessToken, now()),
    };
  }

  export async function currentCursorCredential(
    port: CredentialPort<CursorCredential>,
    options: CursorOAuthDependencies = {},
  ): Promise<CursorCredential> {
    options.signal?.throwIfAborted();
    const current = await waitForCaller(port.read(), options.signal);
    options.signal?.throwIfAborted();
    if (current.value.expiresAt > (options.now ?? Date.now)()) return current.value;
    const refreshing = port.refresh(current.revision, async ({ value }, signal) => {
      const refreshed = await refreshCursorCredential(value, { ...options, signal });
      return { value: refreshed, metadata: { expiresAt: refreshed.expiresAt } };
    });
    return (await waitForCaller(refreshing, options.signal)).snapshot.value;
  }
  ```
  Add the private `parseToken` (accessToken required, optional refreshToken), `readOAuthError`, `refreshError` (`new CredentialRefreshError('Cursor credential refresh failed', { retryable, reason, ...status })`), and `waitForCaller` helpers copied from the kimi credential module. If `credential.ts` approaches 300 lines, keep helpers in the same file; it stays well under.
- [ ] Run the test again and confirm PASS.

### Task 10: Cursor login (present URL, poll with backoff, abort)

**Files:**
- Create: `packages/plugins/cursor/src/oauth.ts`
- Create: `packages/plugins/cursor/src/oauth.login.test.ts`

**Interfaces:**
- Produces: `loginCursor(context, presentation, dependencies?): Promise<OAuthLoginResult<CursorCredential>>`, and re-exports `currentCursorCredential`/`refreshCursorCredential`/`CursorOAuthDependencies`.
  - `CursorLoginPresentation = { waiting: LocalizedText }`.
- Consumes: `OAuthLoginContext`, `generateCursorPkce`, `cursorTokenExpiry`, `cursorIdentity`, constants, `context.authorization.presentAuthorizeUrl`, `context.signal`.

**Global constraints:** sleep at loop top; 404 = pending + reset consecutive errors + backoff; 2xx = parse `{accessToken, refreshToken}`; other = consecutive errors, fail at 3; abort during request/sleep rethrows `signal.reason` and bypasses the error count; timeout after 150 attempts.

- [ ] Write failing tests using a scripted `fetch`, injected `now`, and an injected `sleep` that resolves immediately (or rejects on an aborted signal). Cover: URL is built with `challenge`, `uuid`, `mode=login`, `redirectTarget=cli` and passed to `presentAuthorizeUrl`; 404 then 200 yields credentials with `expiresAt` from the JWT and a `sub`-based fingerprint; three consecutive non-404 errors throw; an aborted signal rejects with the abort reason without consuming the error budget:
  ```ts
  import { expect, test } from 'bun:test';
  import type { OAuthLoginContext } from '@aio-proxy/plugin-sdk';
  import { loginCursor } from './oauth';

  const jwt = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

  const context = (over: Partial<OAuthLoginContext> = {}): { ctx: OAuthLoginContext; urls: string[] } => {
    const urls: string[] = [];
    return {
      urls,
      ctx: {
        authorization: {
          async presentDeviceCode() {},
          async presentAuthorizeUrl(input) {
            urls.push(input.url);
          },
          async loopback() {
            throw new Error('unused');
          },
        },
        progress: () => {},
        signal: new AbortController().signal,
        ...over,
      },
    };
  };

  test('presents the login URL then returns credentials after a 404 then 200', async () => {
    const { ctx, urls } = context();
    const responses = [
      new Response('', { status: 404 }),
      new Response(JSON.stringify({ accessToken: jwt({ sub: 'u1', exp: 4_000 }), refreshToken: 'r1' }), { status: 200 }),
    ];
    const result = await loginCursor(
      ctx,
      { waiting: 'Waiting' },
      { now: () => 0, sleep: async () => {}, uuid: () => 'uuid-1', fetch: async () => responses.shift()! },
    );
    expect(urls[0]).toContain('https://cursor.com/loginDeepControl?');
    expect(urls[0]).toContain('mode=login');
    expect(urls[0]).toContain('redirectTarget=cli');
    expect(result.credentials.refreshToken).toBe('r1');
    expect(result.suggestedKey.startsWith('cursor-')).toBe(true);
  });

  test('fails after three consecutive poll errors', async () => {
    const { ctx } = context();
    await expect(
      loginCursor(
        ctx,
        { waiting: 'Waiting' },
        { now: () => 0, sleep: async () => {}, uuid: () => 'u', fetch: async () => new Response('x', { status: 500 }) },
      ),
    ).rejects.toThrow();
  });

  test('abort during sleep rejects with the abort reason', async () => {
    const controller = new AbortController();
    const { ctx } = context({ signal: controller.signal });
    const reason = new Error('aborted');
    await expect(
      loginCursor(
        ctx,
        { waiting: 'Waiting' },
        {
          now: () => 0,
          uuid: () => 'u',
          fetch: async () => new Response('', { status: 404 }),
          sleep: async () => {
            controller.abort(reason);
            throw reason;
          },
        },
      ),
    ).rejects.toBe(reason);
  });
  ```
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL.
- [ ] Implement `oauth.ts`. Use `URLSearchParams`, an `abortableSleep` fallback (copied from kimi), and poll at loop top:
  ```ts
  import type { LocalizedText, OAuthLoginContext } from '@aio-proxy/plugin-sdk';

  import { cursorIdentity } from './jwt';
  import {
    CURSOR_LOGIN_URL,
    CURSOR_POLL_BACKOFF,
    CURSOR_POLL_BASE_DELAY_MS,
    CURSOR_POLL_MAX_ATTEMPTS,
    CURSOR_POLL_MAX_DELAY_MS,
    CURSOR_POLL_URL,
  } from './oauth/constants';
  import { type CursorOAuthDependencies, refreshCursorCredential } from './oauth/credential';
  import { cursorTokenExpiry } from './jwt';
  import type { CursorCredential } from './schema';

  export { currentCursorCredential, refreshCursorCredential, type CursorOAuthDependencies } from './oauth/credential';

  export type CursorLoginPresentation = { readonly waiting: LocalizedText };

  export async function loginCursor(
    context: OAuthLoginContext,
    presentation: CursorLoginPresentation,
    dependencies: CursorOAuthDependencies = {},
  ) {
    const fetcher = dependencies.fetch ?? globalThis.fetch;
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? abortableSleep;
    const { generateCursorPkce } = await import('./pkce');
    const { verifier, challenge } = await generateCursorPkce();
    const uuid = dependencies.uuid?.() ?? crypto.randomUUID();
    const params = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' });
    await context.authorization.presentAuthorizeUrl({ url: `${CURSOR_LOGIN_URL}?${params.toString()}` });

    let delay = CURSOR_POLL_BASE_DELAY_MS;
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < CURSOR_POLL_MAX_ATTEMPTS; attempt++) {
      context.signal.throwIfAborted();
      await sleep(delay, context.signal);
      let response: Response;
      try {
        response = await fetcher(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, { signal: context.signal });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (++consecutiveErrors >= 3) throw new Error('Cursor authentication polling failed');
        context.progress(presentation.waiting);
        continue;
      }
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * CURSOR_POLL_BACKOFF, CURSOR_POLL_MAX_DELAY_MS);
        context.progress(presentation.waiting);
        continue;
      }
      if (response.ok) return completeLogin(await response.json(), now());
      if (++consecutiveErrors >= 3) throw new Error(`Cursor authentication polling failed: ${response.status}`);
      context.progress(presentation.waiting);
    }
    throw new Error('Cursor authentication polling timed out');
  }
  ```
  Add private `completeLogin(payload, now)` that validates non-empty `accessToken`/`refreshToken`, computes `expiresAt = cursorTokenExpiry(accessToken, now)`, derives `cursorIdentity`, and returns `{ fingerprint, suggestedKey, label, credentials: { accessToken, refreshToken, expiresAt, ...email, ...subject }, expiresAt }`; and the kimi `abortableSleep(ms, signal)` helper. If the file nears 300 lines, move `completeLogin` and `abortableSleep` into `oauth/login.ts` and re-export from `oauth.ts`.
- [ ] Run the tests again and confirm PASS.

### Task 11: Static model catalog with curated fallback

**Files:**
- Create: `packages/plugins/cursor/src/catalog.ts`
- Create: `packages/plugins/cursor/src/catalog.test.ts`

**Interfaces:**
- Produces: `CURSOR_CATALOG_TTL_MS`, `staticCursorCatalog(): ModelCatalog`, `initialCursorCatalogFallback(error): ModelCatalog | undefined`.
- Consumes: `ModelCatalog`, `ModelDescriptor`.

**Global constraints:** Phase 1 catalog is static; model `metadata` must NOT set `protocol` (Cursor is not a `ProtocolId`). Curated ids are real Cursor model ids from OMP `models.json`.

- [ ] Write a failing behavior test asserting the curated catalog exposes known Cursor language model ids, leaves other capabilities empty, and never claims a protocol:
  ```ts
  import { expect, test } from 'bun:test';
  import { initialCursorCatalogFallback, staticCursorCatalog } from './catalog';

  test('exposes curated Cursor language models and no other capabilities', () => {
    const catalog = staticCursorCatalog();
    const ids = catalog.language.map((model) => model.id);
    expect(ids).toContain('claude-4.5-sonnet');
    expect(ids).toContain('gpt-5.2-codex');
    expect(catalog.image).toEqual([]);
    expect(catalog.embedding).toEqual([]);
    for (const model of catalog.language) {
      expect((model.metadata as { protocol?: unknown } | undefined)?.protocol).toBeUndefined();
    }
  });

  test('falls back to the curated catalog only for the initial retryable failure', () => {
    expect(initialCursorCatalogFallback(new Error('boom'))).toBeUndefined();
  });
  ```
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL.
- [ ] Implement `catalog.ts` (curated subset with real ids; no `protocol` in metadata). Because Phase 1 uses static policy and cannot authenticate a discovery call, `initialCursorCatalogFallback` returns `undefined` for a plain `Error` (Phase 2 introduces a typed retryable `CursorCatalogError`):
  ```ts
  import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

  export const CURSOR_CATALOG_TTL_MS = 6 * 60 * 60_000;

  const CURATED: ReadonlyArray<readonly [string, string]> = [
    ['claude-4.5-sonnet', 'Claude 4.5 Sonnet'],
    ['gpt-5.2-codex', 'GPT-5.2 Codex'],
    ['composer-1', 'Composer 1'],
    ['grok-code-fast-1', 'Grok Code Fast 1'],
    ['gemini-3-pro', 'Gemini 3 Pro'],
  ];

  const emptyCatalog = (language: readonly ModelDescriptor[]): ModelCatalog => ({
    language,
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  });

  export function staticCursorCatalog(): ModelCatalog {
    return emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName })));
  }

  export function initialCursorCatalogFallback(_error: unknown): ModelCatalog | undefined {
    return undefined;
  }
  ```
- [ ] Run the test again and confirm PASS.

### Task 12: Adapter assembly, Phase-2 runtime stub, and exports

**Files:**
- Create: `packages/plugins/cursor/src/plugin.ts`
- Create: `packages/plugins/cursor/src/plugin.test.ts`
- Create: `packages/plugins/cursor/src/index.ts`

**Interfaces:**
- Produces:
  - `CursorPresentationText = { pluginLabel?; pluginDescription?; adapterLabel; waitingForAuthorization }`.
  - `englishPresentationText: CursorPresentationText`.
  - `createCursorPlugin(presentationText?, dependencies?): PluginDescriptor<undefined>`.
  - `index.ts`: re-exports, `CURSOR_PLUGIN_VERSION`, default `createCursorPlugin(englishPresentationText)`.
- Consumes: `definePlugin`, `OAuthAdapter`, `ConfigSpec`, `zod`, `loginCursor`, `staticCursorCatalog`, `initialCursorCatalogFallback`, `CURSOR_CATALOG_TTL_MS`, `credentialSchema`.

**Global constraints:** `icon: 'cursor'` (valid `LobeIconKey`); no account options; `createRuntime` throws the Phase-2 marker.

- [ ] Write failing tests: the adapter registers with id `default`, `icon: 'cursor'`, uses static catalog policy, `login` presents an `authorize_url` (via a stub port) and returns a `cursor-` key, and `createRuntime` throws the Phase-2 error:
  ```ts
  import { expect, test } from 'bun:test';
  import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';
  import cursorPlugin, { createCursorPlugin } from '.';
  import type { CursorCredential } from './schema';

  async function adapterFrom(
    descriptor: PluginDescriptor<undefined>,
  ): Promise<OAuthAdapter<Record<string, never>, CursorCredential>> {
    let registered: OAuthAdapter<Record<string, never>, CursorCredential> | undefined;
    await descriptor.setup(
      {
        oauth: {
          register(adapter) {
            registered = adapter as unknown as OAuthAdapter<Record<string, never>, CursorCredential>;
          },
        },
      } as never,
      undefined,
    );
    if (registered === undefined) throw new Error('Cursor OAuth adapter was not registered');
    return registered;
  }

  test('registers a default Cursor adapter with a static catalog and cursor icon', async () => {
    const adapter = await adapterFrom(cursorPlugin);
    expect(adapter.id).toBe('default');
    expect(adapter.icon).toBe('cursor');
    expect(adapter.account.options.form).toEqual([]);
    expect(adapter.catalog.policy).toEqual({ kind: 'static' });
    await expect(
      adapter.catalog.discover({ credentials: {} as never, options: {}, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ language: expect.any(Array) });
  });

  test('createRuntime throws until Phase 2 implements the runtime', async () => {
    const adapter = await adapterFrom(createCursorPlugin());
    await expect(
      adapter.createRuntime({ credentials: {} as never, options: {}, catalog: adapter.catalog as never }),
    ).rejects.toThrow(/not implemented in Phase 1/);
  });
  ```
  (`adapterFrom` mirrors `packages/plugins/xai-grok/src/plugin.test.ts`: `descriptor.setup` is async and takes `(api, options)`.)
- [ ] Run `bun run --filter @aio-proxy/plugin-cursor test:unit` and confirm FAIL.
- [ ] Implement `plugin.ts` (mirror xAI `createXAIGrokPlugin`, static catalog, throwing runtime):
  ```ts
  import {
    type ConfigSpec,
    definePlugin,
    type LocalizedText,
    type OAuthAdapter,
    type PluginDescriptor,
    zod,
  } from '@aio-proxy/plugin-sdk';

  import { CURSOR_CATALOG_TTL_MS, initialCursorCatalogFallback, staticCursorCatalog } from './catalog';
  import { type CursorOAuthDependencies, loginCursor } from './oauth';
  import { credentialSchema, type CursorCredential } from './schema';

  export type CursorPresentationText = {
    readonly pluginLabel?: LocalizedText;
    readonly pluginDescription?: LocalizedText;
    readonly adapterLabel: LocalizedText;
    readonly waitingForAuthorization: LocalizedText;
  };

  export const englishPresentationText: CursorPresentationText = {
    pluginLabel: 'Cursor',
    pluginDescription: 'Use a Cursor account to access models',
    adapterLabel: 'Login with Cursor',
    waitingForAuthorization: 'Waiting for Cursor authorization',
  };

  export function createCursorPlugin(
    presentationText: CursorPresentationText = englishPresentationText,
    dependencies: CursorOAuthDependencies = {},
  ): PluginDescriptor<undefined> {
    const accountOptions = { schema: zod.object({}), form: [] } as const satisfies ConfigSpec<Record<string, never>>;
    const adapter: OAuthAdapter<Record<string, never>, CursorCredential> = {
      id: 'default',
      label: presentationText.adapterLabel,
      icon: 'cursor',
      account: { options: accountOptions },
      credentials: credentialSchema,
      login: async (context, options) => {
        await accountOptions.schema.parseAsync(options);
        return await loginCursor(context, { waiting: presentationText.waitingForAuthorization }, dependencies);
      },
      catalog: {
        policy: { kind: 'static' },
        discover: () => Promise.resolve(staticCursorCatalog()),
        initialFallback: initialCursorCatalogFallback,
      },
      createRuntime: () => {
        throw new Error('Cursor runtime is not implemented in Phase 1');
      },
    };
    return definePlugin((api) => api.oauth.register(adapter), {
      label: presentationText.pluginLabel ?? 'Cursor',
      description: presentationText.pluginDescription ?? 'Use a Cursor account to access models',
    });
  }
  ```
- [ ] Implement `index.ts`:
  ```ts
  import packageJson from '../package.json' with { type: 'json' };
  import { createCursorPlugin, englishPresentationText } from './plugin';

  export * from './catalog';
  export * from './jwt';
  export * from './oauth';
  export { createCursorPlugin, englishPresentationText, type CursorPresentationText } from './plugin';
  export * from './schema';

  export const CURSOR_PLUGIN_VERSION = packageJson.version;

  export default createCursorPlugin(englishPresentationText);
  ```
- [ ] Run the tests again and confirm PASS, then `bun run --filter @aio-proxy/plugin-cursor build` to confirm the package compiles.

### Task 13: Register Cursor as a built-in provider

**Files:**
- Modify: `packages/core/src/plugins/builtins.ts` — import `createCursorPlugin`/`CURSOR_PLUGIN_VERSION`, add to `BUILT_IN_PLUGIN_PACKAGE_NAMES`, add a `createEmbeddedBuiltIns` entry.
- Modify: `packages/core/src/plugins/builtins.test.ts` — extend `expectedBuiltIns`, the `builtIn` boolean array, `resolveOAuth`, and localized-copy assertions.
- Modify: `packages/core/package.json` — add `"@aio-proxy/plugin-cursor": "workspace:*"`.
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts`, `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`, `packages/cli/__tests__/binary-build.test.ts` — include Cursor in built-in provider expectations.

**Interfaces:**
- Consumes: `createCursorPlugin`, `CURSOR_PLUGIN_VERSION`, `localized`.
- Produces: a sixth embedded built-in whose descriptor resolves `resolveOAuth('@aio-proxy/plugin-cursor','default')`.

- [ ] Update `builtins.test.ts` first (failing): add `'@aio-proxy/plugin-cursor'` to `expectedBuiltIns`, extend the `builtIn` array to six `true`s, add `expect(snapshot.registry.resolveOAuth('@aio-proxy/plugin-cursor', 'default')).toBeDefined();`, and add localized assertions:
  ```ts
  const cursor = snapshot.registry.resolveOAuth('@aio-proxy/plugin-cursor', 'default');
  const cursorPlugin = snapshot.plugins.get('@aio-proxy/plugin-cursor');
  expect(resolveLocalizedText(cursorPlugin?.label ?? '', 'zh-Hans')).toBe('Cursor');
  expect(resolveLocalizedText(cursorPlugin?.description ?? '', 'zh-Hans')).toBe('使用 Cursor 账号访问模型');
  expect(resolveLocalizedText(cursor?.label ?? '', 'zh-Hans')).toBe('使用 Cursor 登录');
  ```
- [ ] Run `cd packages/core && bun test src/plugins/builtins.test.ts` and confirm FAIL.
- [ ] Add the workspace dependency to `packages/core/package.json`, then `bun install` at repo root to update `bun.lock`.
- [ ] Update `builtins.ts`: add the import, append the package name to `BUILT_IN_PLUGIN_PACKAGE_NAMES`, and append the embedded entry:
  ```ts
  {
    packageName: '@aio-proxy/plugin-cursor',
    version: CURSOR_PLUGIN_VERSION,
    descriptor: createCursorPlugin({
      pluginLabel: localized('Cursor', 'Cursor'),
      pluginDescription: localized('Use a Cursor account to access models', '使用 Cursor 账号访问模型'),
      adapterLabel: localized('Login with Cursor', '使用 Cursor 登录'),
      waitingForAuthorization: localized('Waiting for Cursor authorization', '正在等待 Cursor 授权'),
    }) as unknown as PluginDescriptor<unknown>,
  },
  ```
- [ ] Update the three CLI tests to include `@aio-proxy/plugin-cursor` wherever they assert the built-in provider set (match each file's existing xai/kimi assertion shape).
- [ ] Run `cd packages/core && bun test src/plugins/builtins.test.ts` and confirm PASS.
- [ ] Run `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/plugin-commands/plugin/add.test.ts src/plugin-commands/provider-login/capability.resolution.test.ts` and confirm PASS. (`__tests__/binary-build.test.ts` may require a built binary; run it if the environment supports it, otherwise note it for CI.)

---

## Final Verification

- [ ] `bun run --filter @aio-proxy/plugin-cursor test:unit`
- [ ] `bun run --filter @aio-proxy/plugin-cursor build`
- [ ] `bun run preflight` (oxlint + oxfmt check + all unit tests) at repo root.
- [ ] `bun run check` if any type-only edits landed after the last preflight.

## Self-Review Checklist

- [ ] Spec coverage: `authorize_url` seam (6 touchpoints incl. hidden `deadline.ts`), PKCE, poll/backoff/abort, JWT `exp` single skew, `sub` fingerprint, refresh rotation + error classes, static curated catalog, Phase-2 runtime stub, builtins registration — all present.
- [ ] No placeholders: every task has real code; no "similar to Task N", no TBD.
- [ ] Type-name consistency across tasks: `presentAuthorizeUrl`, `generateCursorPkce`, `cursorTokenExpiry`, `cursorIdentity`, `refreshCursorCredential`, `currentCursorCredential`, `staticCursorCatalog`, `initialCursorCatalogFallback`, `loginCursor`, `createCursorPlugin`, `CURSOR_PLUGIN_VERSION`.
- [ ] No Phase 2 leakage: no protobuf/HTTP2/`@ai-sdk/*` deps, no `tool-names`/`wire`/`gen`/`runtime`/`store`, no `conversationState`/`lru-cache`, no `x-cursor-checksum`.
- [ ] Constraints honored: model metadata omits `protocol`; refresh threshold has no second skew; tokens never logged; files < 300 lines; tests colocated; i18n en+zh recompiled.
