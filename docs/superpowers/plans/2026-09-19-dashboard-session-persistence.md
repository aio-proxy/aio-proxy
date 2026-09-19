# Dashboard Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking Dashboard users to retype `server.password` on every new browser tab and every browser restart, and keep an active user logged in indefinitely.

**Architecture:** The server gains a `refresh(token)` method on `DashboardAuthentication` that re-signs a still-valid token older than one day, plus a postflight middleware that writes the new token to an `x-dashboard-session-refresh` response header on `/dashboard/api/*`. The Dashboard moves its token from `sessionStorage` to `localStorage`, writes back any renewed token it sees on a response, and propagates logout across tabs via the `storage` event. The token scheme stays stateless and signed with the password hash, so changing `server.password` still invalidates every session everywhere.

**Tech Stack:** Bun, Hono, TypeScript, Zod, React, TanStack Query, `bun test` (server), Rstest + happy-dom (dashboard), Changesets.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-19-dashboard-session-persistence-design.md`. Read it before Task 1.
- `SESSION_TTL_MS` keeps its current value of `7 * 24 * 60 * 60 * 1_000`. Only its *meaning* changes (absolute lifetime → inactivity window). Do not edit the literal.
- `REFRESH_AFTER_MS` is one day: `24 * 60 * 60 * 1_000`.
- Renewal header name is exactly `x-dashboard-session-refresh` (lowercase).
- `localStorage` key stays `aio-proxy.dashboard-session` — unchanged, so existing tabs are not orphaned mid-session.
- Renewed tokens keep the existing shape `v1.<expiresAt>.<uuid>.<signature>`, signed with the current password hash. No new token version, no new format.
- Changing `server.password` remains the ONLY revocation mechanism. Renewal must not defeat it.
- Do not add `Access-Control-Expose-Headers`; Dashboard and API are same-origin.
- Do not use non-null assertions (`!`) in test code — oxlint rejects them. Narrow with an explicit `if (x === undefined) throw new Error('...')`.
- Dashboard rules in `packages/dashboard/CLAUDE.md` apply: no direct `fetch` in components, no hardcoded user-facing copy, module directories limited to the six permitted names.
- Repo rules in `CLAUDE.md` apply: colocated tests in same-name directories, `es-toolkit` narrow imports over hand-written utilities, prefer Bun APIs, 500-line limit on handwritten non-test implementation files.
- Every task ends with a commit. Use Conventional Commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- `bun run preflight` must pass before the work is considered complete (Task 6).

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/server/src/dashboard-auth/dashboard-auth.ts` (modify) | Add `refresh` to `DashboardAuthentication`; extract a shared `mintToken` helper used by both `login` and `refresh`; add `REFRESH_AFTER_MS`. | 1 |
| `packages/server/src/dashboard-auth/test-support.ts` (modify) | Add `refresh: () => undefined` to `disabledDashboardAuthentication` so it still satisfies the widened type. | 1 |
| `packages/server/src/dashboard-auth/dashboard-auth.test.ts` (modify) | Four unit tests for `refresh` semantics, including the password-change revocation pin. | 1 |
| `packages/server/src/dashboard-auth/routes.ts` (modify) | Add the `attachDashboardSessionRefresh` postflight middleware. | 2 |
| `packages/server/src/dashboard-auth/index.ts` (modify) | Export `attachDashboardSessionRefresh`. | 2 |
| `packages/server/src/server/create-routes.ts` (modify) | Mount the middleware on `/dashboard/api/*` ahead of the authentication middleware. | 2 |
| `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.ts` (modify) | Switch the backend to `localStorage`; add `subscribeDashboardAuthTokenCleared`. | 3 |
| `packages/dashboard/src/lib/dashboard-auth-token/index.ts` (modify) | Export the new subscription. | 3 |
| `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.test.ts` (modify) | Test the cleared-key subscription. | 3 |
| `packages/dashboard/src/lib/dashboard-client/dashboard-client.ts` (modify) | Read the renewal header in `dashboardFetch` and write it back, guarded against the mid-flight logout race. | 4 |
| `packages/dashboard/src/lib/dashboard-client/dashboard-client.test.ts` (modify) | Two tests: renewal replaces the token; a renewal after clear does not resurrect it. | 4 |
| `packages/dashboard/src/modules/auth/services/auth-service/auth-service.ts` (modify) | Register cross-tab logout. | 5 |
| `packages/dashboard/src/modules/auth/services/auth-service/auth-service.test.ts` (modify) | Test that a sibling tab's clear moves this tab to `unauthenticated`. | 5 |
| `README.zh-Hans.md` (modify) | One line on how long a Dashboard login lasts. | 6 |
| `.changeset/dashboard-session-persistence.md` (create) | Release note. | 6 |

Task order matters: Task 1 must land before Task 2 (the middleware calls `refresh`), and Task 3 before Tasks 4 and 5 (both import from the token module).

---

### Task 1: Server-side token renewal

**Files:**
- Modify: `packages/server/src/dashboard-auth/dashboard-auth.ts`
- Modify: `packages/server/src/dashboard-auth/test-support.ts`
- Test: `packages/server/src/dashboard-auth/dashboard-auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DashboardAuthentication.refresh: (token: string) => string | undefined`. Returns a freshly signed token when the argument passes every check `verify` applies AND is older than one day; `undefined` otherwise. Task 2's middleware is its only production caller.

**Background for the implementer:**

`createDashboardAuthentication` is a closure factory in `dashboard-auth.ts`. It takes `passwordHash: () => string | undefined`, `now: () => number`, and `available: () => boolean`, and returns an object of functions. The token format is `v1.<expiresAt>.<uuid>.<signature>` where `signature = sign(hash, 'v1.<expiresAt>.<uuid>')`. There is no server-side session store — validity is entirely derived from the token plus the current password hash. That is why a password change invalidates everything, and why renewal must re-sign under the *current* hash rather than copy the old signature.

Token age needs no stored state. `expiresAt` was set to `mintedAt + SESSION_TTL_MS`, so `age = SESSION_TTL_MS - (expiresAt - now())`.

- [ ] **Step 1: Write the four failing tests**

Append to `packages/server/src/dashboard-auth/dashboard-auth.test.ts`, inside the existing `describe('dashboard authentication', ...)` block, after the final `test(...)`:

```ts
  test('renews a session that has been used for a day without churning fresh tokens', async () => {
    const hash = await Bun.password.hash('renewable');
    const fresh = createDashboardAuthentication(() => hash);
    const freshLogin = await fresh.login('renewable', '127.0.0.1');
    if (freshLogin.status !== 'authenticated') throw new Error('expected an authenticated login');

    const aged = createDashboardAuthentication(() => hash, () => Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const agedLogin = await aged.login('renewable', '127.0.0.1');
    if (agedLogin.status !== 'authenticated') throw new Error('expected an authenticated login');
    const renewed = fresh.refresh(agedLogin.token);

    expect(fresh.refresh(freshLogin.token)).toBeUndefined();
    expect(renewed).toBeString();
    if (renewed === undefined) throw new Error('expected a renewed session');
    expect(fresh.verify(renewed)).toBe(true);
    expect(Number(renewed.split('.')[1])).toBeGreaterThan(Number(agedLogin.token.split('.')[1]));
  });

  test('does not renew expired or tampered tokens', async () => {
    const hash = await Bun.password.hash('not-renewable');
    const auth = createDashboardAuthentication(() => hash);
    const expiredAt = createDashboardAuthentication(() => hash, () => Date.now() - 8 * 24 * 60 * 60 * 1_000);
    const expiredLogin = await expiredAt.login('not-renewable', '127.0.0.1');
    if (expiredLogin.status !== 'authenticated') throw new Error('expected an authenticated login');

    const aged = createDashboardAuthentication(() => hash, () => Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const agedLogin = await aged.login('not-renewable', '127.0.0.1');
    if (agedLogin.status !== 'authenticated') throw new Error('expected an authenticated login');
    const parts = agedLogin.token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${'A'.repeat(String(parts[3]).length)}`;

    expect(auth.refresh(expiredLogin.token)).toBeUndefined();
    expect(auth.refresh(tampered)).toBeUndefined();
    expect(auth.refresh('not-a-token')).toBeUndefined();
  });

  test('does not renew a session minted under the previous password', async () => {
    const oldHash = await Bun.password.hash('old-password');
    const newHash = await Bun.password.hash('new-password');
    let hash = oldHash;
    const auth = createDashboardAuthentication(
      () => hash,
      () => Date.now() - 2 * 24 * 60 * 60 * 1_000,
    );
    const login = await auth.login('old-password', '127.0.0.1');
    if (login.status !== 'authenticated') throw new Error('expected an authenticated login');

    expect(auth.refresh(login.token)).toBeString();
    hash = newHash;

    expect(auth.refresh(login.token)).toBeUndefined();
  });
```

Add the import at the top of the file, after the existing `import { describe, expect, test } from 'bun:test';` line and its blank line:

```ts
import { createDashboardAuthentication } from './dashboard-auth';
```

Note on why this works: the scheme is stateless, and a signature depends only on the password hash and the payload. So a token minted by an *independently constructed* instance whose `now()` is two days in the past is byte-for-byte a token that the real instance minted two days ago. That is how an aged token is forged without sleeping or mocking a clock globally.

The third test flips `hash` between the two `refresh` calls, asserting the same token is renewable before the password change and not after. Per the spec this is the most important of the four: it pins the one revocation mechanism this design relies on, so a later refactor cannot silently defeat it.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/server`:

```bash
bun test --preload=./__tests__/setup.ts src/dashboard-auth/dashboard-auth.test.ts
```

Expected: the three new tests fail. Because `refresh` does not exist yet, the failure is a TypeScript/runtime error along the lines of `auth.refresh is not a function`. The pre-existing tests in the file must still pass.

- [ ] **Step 3: Extract the minting helper and add `refresh`**

In `packages/server/src/dashboard-auth/dashboard-auth.ts`, add the renewal threshold next to the existing constants at the top of the file:

```ts
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
```

Widen the exported type — add `refresh` after `verify`:

```ts
export type DashboardAuthentication = {
  readonly available: () => boolean;
  readonly enabled: () => boolean;
  readonly login: (password: string, clientId: string) => Promise<LoginResult>;
  readonly verify: (token: string | undefined) => boolean;
  readonly refresh: (token: string) => string | undefined;
};
```

Inside `createDashboardAuthentication`, add a `mint` helper above `login` so both minting paths share one definition of the token shape:

```ts
  function mint(hash: string): { readonly expiresAt: number; readonly token: string } {
    const expiresAt = now() + SESSION_TTL_MS;
    const payload = `v1.${expiresAt}.${crypto.randomUUID()}`;
    return { expiresAt, token: `${payload}.${sign(hash, payload)}` };
  }
```

Replace the last two statements of `login` (the `const expiresAt = ...` / `const payload = ...` / `return ...` trio) with:

```ts
    failures.delete(clientId);
    const { expiresAt, token } = mint(hash);
    return { status: 'authenticated', expiresAt, token };
```

Add `refresh` after `verify`:

```ts
  // `refresh` re-runs `verify` rather than trusting the caller, and re-signs under the hash read
  // now. A password change therefore still revokes every session: `prepareDashboardConfig` strips
  // `server.password` when the configured hash is unusable, so `passwordHash()` returns `undefined`
  // and both `verify` and `refresh` fail by construction rather than by an explicit check here.
  function refresh(token: string): string | undefined {
    const hash = passwordHash();
    if (hash === undefined || !verify(token)) return undefined;
    const expiresAt = Number(token.split('.')[1]);
    const age = SESSION_TTL_MS - (expiresAt - now());
    if (age < REFRESH_AFTER_MS) return undefined;
    return mint(hash).token;
  }
```

Widen the returned object:

```ts
  return { available, enabled, login, refresh, verify };
```

- [ ] **Step 4: Satisfy the widened type in the test double**

`disabledDashboardAuthentication` in `packages/server/src/dashboard-auth/test-support.ts` is typed `DashboardAuthentication`, so it no longer compiles. Add the missing member:

```ts
export const disabledDashboardAuthentication: DashboardAuthentication = {
  available: () => true,
  enabled: () => false,
  login: async () => ({ status: 'disabled' }),
  refresh: () => undefined,
  verify: () => false,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run from `packages/server`:

```bash
bun test --preload=./__tests__/setup.ts src/dashboard-auth/
```

Expected: PASS, all tests in the directory including `password.test.ts` and `password-integration.test.ts`.

Then from the repo root, confirm nothing else implements `DashboardAuthentication` structurally:

```bash
bun run lint:types
```

Expected: no errors. If a type error names another object literal assigned to `DashboardAuthentication`, add `refresh: () => undefined` to it the same way.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/dashboard-auth/dashboard-auth.ts packages/server/src/dashboard-auth/test-support.ts packages/server/src/dashboard-auth/dashboard-auth.test.ts
git commit -m "feat(server): renew aged Dashboard session tokens"
```

---

### Task 2: Renewal response header on `/dashboard/api/*`

**Files:**
- Modify: `packages/server/src/dashboard-auth/routes.ts`
- Modify: `packages/server/src/dashboard-auth/index.ts`
- Modify: `packages/server/src/server/create-routes.ts:261`
- Test: `packages/server/src/dashboard-auth/dashboard-auth.test.ts`

**Interfaces:**
- Consumes: `DashboardAuthentication.refresh` from Task 1; `dashboardSessionToken(context)` already exported from `routes.ts`.
- Produces: `attachDashboardSessionRefresh(auth: DashboardAuthentication): MiddlewareHandler`, exported from `packages/server/src/dashboard-auth`. Task 4's Dashboard code consumes the `x-dashboard-session-refresh` header it writes.

**Background for the implementer:**

Hono middleware is an onion: everything before `await next()` runs on the way in, everything after runs on the way out. Registering this middleware *before* the authentication middleware means its post-`next()` body runs *after* authentication has resolved — which is what we want, because we only want to mint a renewal for a request that was actually authenticated.

`create-routes.ts` currently stacks three `app.use('/dashboard/api/*', ...)` calls at lines 261–280: loopback host, same-origin, then authentication. The new middleware goes after `requireLoopbackHost` and before the same-origin check — anywhere ahead of the authentication middleware is correct; this position keeps the auth-adjacent middlewares contiguous.

There is no explicit "was this authenticated?" flag to read. We do not need one: an unauthenticated request either carries no Bearer token (so `dashboardSessionToken` returns `undefined` and we bail) or carries an invalid one (so `refresh` returns `undefined`). Either way no header is written.

One route in this path needs a look but no special handling: the SSE events route at `/dashboard/api/events` (`packages/server/src/dashboard-routes/events/events.ts`) returns a raw `Response` wrapping a `ReadableStream`. The middleware does wrap it, and writing a header on that response is legal — Hono attaches it before the runtime serializes the response, and `x-dashboard-session-refresh` is not a forbidden response-header name, so nothing throws. It is simply inert: the Dashboard consumes that stream without inspecting response headers, so a renewal offered there is ignored and the session is instead renewed by ordinary requests on the same token. Do not add a path exclusion for it. Step 6's full server suite covers the events route; confirm those tests still pass rather than reasoning about it further.

`/admin/*` never participates because the middleware is mounted only on `/dashboard/api/*`. That is CLI-facing and is satisfied by construction, not by a check.

- [ ] **Step 1: Write the failing route tests**

Append to `packages/server/src/dashboard-auth/dashboard-auth.test.ts`, inside the existing `describe` block:

```ts
  test('hands an aged session a renewed token that authenticates the next request', async () => {
    const hash = await Bun.password.hash('renewing-route');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });
    const aged = createDashboardAuthentication(() => hash, () => Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const agedLogin = await aged.login('renewing-route', '127.0.0.1');
    if (agedLogin.status !== 'authenticated') throw new Error('expected an authenticated login');

    const response = await app.request(
      '/dashboard/api/config',
      { headers: { authorization: `Bearer ${agedLogin.token}` } },
      loopbackServer,
    );
    const renewed = response.headers.get('x-dashboard-session-refresh');

    expect(response.status).toBe(200);
    expect(renewed).toBeString();
    expect(
      (
        await app.request(
          '/dashboard/api/config',
          { headers: { authorization: `Bearer ${renewed ?? ''}` } },
          loopbackServer,
        )
      ).status,
    ).toBe(200);
  });

  test('omits the renewal header for fresh sessions and for rejected requests', async () => {
    const hash = await Bun.password.hash('no-renewal-header');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });
    const token = await tokenFrom(await login(app, 'no-renewal-header'));

    const freshResponse = await app.request(
      '/dashboard/api/config',
      { headers: { authorization: `Bearer ${token}` } },
      loopbackServer,
    );
    const rejected = await app.request(
      '/dashboard/api/config',
      { headers: { authorization: 'Bearer v1.9999999999999.nope.nope' } },
      loopbackServer,
    );

    expect(freshResponse.status).toBe(200);
    expect(freshResponse.headers.get('x-dashboard-session-refresh')).toBeNull();
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('x-dashboard-session-refresh')).toBeNull();
  });
```

These reuse the `createServer`, `login`, `tokenFrom`, and `loopbackServer` helpers already defined at the top of the file, plus the `createDashboardAuthentication` import added in Task 1.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/server`:

```bash
bun test --preload=./__tests__/setup.ts src/dashboard-auth/dashboard-auth.test.ts
```

Expected: both new tests fail — the first because `renewed` is `null` rather than a string, the second passing vacuously is NOT acceptable; confirm the first one fails for the stated reason before continuing.

- [ ] **Step 3: Add the middleware**

In `packages/server/src/dashboard-auth/routes.ts`, add after `requireDashboardAuthentication` (which ends at line 48):

```ts
// Registered ahead of the authentication middleware so Hono's onion runs this body on the way out,
// after authentication has resolved. A request that failed authentication either carries no token
// or carries one `refresh` rejects, so a rejected response never gains the header.
export const attachDashboardSessionRefresh =
  (auth: DashboardAuthentication): MiddlewareHandler =>
  async (context, next) => {
    await next();
    const token = dashboardSessionToken(context);
    if (token === undefined) return;
    const renewed = auth.refresh(token);
    if (renewed !== undefined) context.header('x-dashboard-session-refresh', renewed);
  };
```

`MiddlewareHandler` and `DashboardAuthentication` are already imported at the top of the file; `dashboardSessionToken` is declared below in the same module.

- [ ] **Step 4: Export it**

In `packages/server/src/dashboard-auth/index.ts`, add `attachDashboardSessionRefresh` to the `./routes` export list, keeping the list alphabetical-ish as written:

```ts
export {
  attachDashboardSessionRefresh,
  createDashboardAuthRoutes,
  dashboardSessionToken,
  requireDashboardAuthentication,
  requireDashboardLoopback,
  isDashboardLoopbackRequest,
} from './routes';
```

- [ ] **Step 5: Mount it**

In `packages/server/src/server/create-routes.ts`, add `attachDashboardSessionRefresh` to the existing import from `'../dashboard-auth'` (the import block spanning lines 18–21), then register the middleware immediately after the `requireLoopbackHost` line at 261:

```ts
  app.use('/dashboard/api/*', requireLoopbackHost);
  app.use('/dashboard/api/*', attachDashboardSessionRefresh(dashboardAuth));
```

Leave the two `app.use('/dashboard/api/*', ...)` blocks that follow exactly as they are.

- [ ] **Step 6: Run the tests to verify they pass**

Run from `packages/server`:

```bash
bun test --preload=./__tests__/setup.ts src/dashboard-auth/
```

Expected: PASS, including both new route tests.

Then run the full server suite, because the middleware now sits on every Dashboard API request:

```bash
bun test --preload=./__tests__/setup.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/dashboard-auth/routes.ts packages/server/src/dashboard-auth/index.ts packages/server/src/server/create-routes.ts packages/server/src/dashboard-auth/dashboard-auth.test.ts
git commit -m "feat(server): return renewed Dashboard sessions in a response header"
```

---

### Task 3: Persist the token and publish a cleared-token signal

**Files:**
- Modify: `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.ts`
- Modify: `packages/dashboard/src/lib/dashboard-auth-token/index.ts`
- Test: `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `subscribeDashboardAuthTokenCleared(handler: () => void): void`, exported from `@/lib/dashboard-auth-token`. Task 5 is its only caller. The existing `readDashboardAuthToken`, `writeDashboardAuthToken`, and `clearDashboardAuthToken` signatures are unchanged.

**Background for the implementer:**

The module is a three-function wrapper around a single storage key. Every access is wrapped in `try/catch` because storage throws in private-browsing modes and when a quota is exceeded; keep that pattern.

Switching `sessionStorage` to `localStorage` is a three-word change. The new subscription is what makes it safe: with `localStorage`, tabs share state, so a tab must learn when a sibling clears the key. The browser's `storage` event fires on *other* documents sharing the origin — never on the document that made the change — which is exactly the cross-tab signal we want.

The subscription lives here rather than in the auth module so the storage key stays private to this file. Nothing outside this directory should know the string `aio-proxy.dashboard-session`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.test.ts`:

```ts
test('notifies subscribers when another tab clears the session token', () => {
  writeDashboardAuthToken('cross-tab-token');
  let cleared = 0;
  subscribeDashboardAuthTokenCleared(() => {
    cleared += 1;
  });

  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: null, storageArea: localStorage }),
  );
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: 'renewed', storageArea: localStorage }),
  );
  globalThis.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: null, storageArea: localStorage }));

  expect(cleared).toBe(1);
});
```

Extend the existing import at the top of the file to include `subscribeDashboardAuthTokenCleared` alongside whatever it already imports.

Two notes on why the test is shaped this way. First, it dispatches a synthetic `StorageEvent` rather than calling `clearDashboardAuthToken()` from a second context: happy-dom, like a real browser, does not fire `storage` for a change made in the same document, so a same-document `removeItem` would produce no event at all. Second, the two extra dispatches are the discriminating assertions — a subscriber that fires on a *renewal* write or on an *unrelated* key would log out a healthy session, which is the bug this test exists to prevent.

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/dashboard`:

```bash
bun run test:unit src/lib/dashboard-auth-token
```

Expected: FAIL with an error naming `subscribeDashboardAuthTokenCleared` as not exported / not a function.

- [ ] **Step 3: Switch storage and add the subscription**

Rewrite `packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.ts` as:

```ts
const storageKey = 'aio-proxy.dashboard-session';

export function readDashboardAuthToken(): string | undefined {
  try {
    const token = globalThis.localStorage.getItem(storageKey);
    return token === null || token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

export function writeDashboardAuthToken(token: string): void {
  try {
    globalThis.localStorage.setItem(storageKey, token);
  } catch {}
}

export function clearDashboardAuthToken(): void {
  try {
    globalThis.localStorage.removeItem(storageKey);
  } catch {}
}

/**
 * Fires when another tab removes the session token. `storage` never fires on the document that made
 * the change, so this is purely a cross-tab signal. Subscribers must not react to a `newValue` —
 * that is a renewal written by a sibling tab, not a logout.
 */
export function subscribeDashboardAuthTokenCleared(handler: () => void): void {
  globalThis.addEventListener('storage', (event) => {
    if (event.key === storageKey && event.newValue === null) handler();
  });
}
```

The token now survives a browser restart. That is the point of the change, and per the spec it does not widen the authority the server already granted with a seven-day signed token.

- [ ] **Step 4: Export it**

In `packages/dashboard/src/lib/dashboard-auth-token/index.ts`:

```ts
export {
  clearDashboardAuthToken,
  readDashboardAuthToken,
  subscribeDashboardAuthTokenCleared,
  writeDashboardAuthToken,
} from './dashboard-auth-token';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run from `packages/dashboard`:

```bash
bun run test:unit
```

Expected: PASS. The whole package suite is run, not just this file, because other tests call `clearDashboardAuthToken` in `beforeEach`/`afterEach` and would notice if the storage backend and the cleanup disagreed.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/lib/dashboard-auth-token/
git commit -m "feat(dashboard): persist the session token across tabs and restarts"
```

---

### Task 4: Store renewed tokens from responses

**Files:**
- Modify: `packages/dashboard/src/lib/dashboard-client/dashboard-client.ts:23-27`
- Test: `packages/dashboard/src/lib/dashboard-client/dashboard-client.test.ts`

**Interfaces:**
- Consumes: `readDashboardAuthToken` (already imported in this file) and `writeDashboardAuthToken` (new import) from `@/lib/dashboard-auth-token`; the `x-dashboard-session-refresh` header from Task 2.
- Produces: nothing new. `dashboardFetch` keeps its `typeof fetch` signature.

**Background for the implementer:**

`dashboardFetch` is the single choke point for every Dashboard API call — the typed Hono client is constructed with it, and `packages/dashboard/CLAUDE.md` forbids components from calling `fetch` directly. So handling the renewal here covers every request in the app with no per-call opt-in.

The guard in this task is not defensive padding; it closes a real race. Sequence: the user clicks logout while a slow request is in flight. `logoutDashboard()` runs `clearDashboardAuthToken()`. Then the in-flight response lands carrying a renewal header minted before the logout. Without the guard, `writeDashboardAuthToken(renewed)` puts a valid token back into storage and the session resurrects. Reading the token again *after* the await and requiring it to still be present is what makes the write conditional on "we are still logged in".

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/src/lib/dashboard-client/dashboard-client.test.ts`:

```ts
test('replaces the stored session token when a response carries a renewal', async () => {
  writeDashboardAuthToken('aged-token');
  rs.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { headers: { 'x-dashboard-session-refresh': 'renewed-token' } }),
  );

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBe('renewed-token');
});

test('a renewal arriving after logout does not resurrect the session', async () => {
  writeDashboardAuthToken('aged-token');
  rs.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    clearDashboardAuthToken();
    return new Response('{}', { headers: { 'x-dashboard-session-refresh': 'renewed-token' } });
  });

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBeUndefined();
});
```

Extend the file's existing import from `@/lib/dashboard-auth-token` to add `readDashboardAuthToken` (it already imports `clearDashboardAuthToken` and `writeDashboardAuthToken`).

Match the file's established conventions, which these tests already follow: each test creates its own spy with `rs.spyOn(globalThis, 'fetch')` — there is no shared `fetchSpy` binding — and requests go through `.dashboard.api.providers.$get()`. The existing `beforeEach`/`afterEach` pair already clears the token and calls `rs.restoreAllMocks()`, so add no new lifecycle hooks.

The second test clears the token from *inside* the mocked `fetch`, which is precisely the mid-flight logout: storage is emptied between the request starting and the response being inspected.

While you are in this file, note the duplicated `test.each(['authenticated', 'disabled'])` block — it appears verbatim at lines 20–33 and again at 47–60. It is pre-existing and unrelated to this change. Leave it alone; do not fold a cleanup into this commit.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/dashboard`:

```bash
bun run test:unit src/lib/dashboard-client
```

Expected: the first new test FAILS with `expected 'renewed-token', received 'aged-token'`. The second test passes at this point (nothing writes the token back yet) — that is expected; it is a regression guard for Step 3, and Step 4 re-runs it to confirm it still holds once the write exists.

- [ ] **Step 3: Read the header and write the token back**

In `packages/dashboard/src/lib/dashboard-client/dashboard-client.ts`, extend the existing import:

```ts
import { readDashboardAuthToken, writeDashboardAuthToken } from '@/lib/dashboard-auth-token';
```

Then insert the renewal handling into `dashboardFetch`, between the `await fetch(...)` call and the `401` check:

```ts
  const response = await fetch(input, { ...init, headers });
  const renewed = response.headers.get('x-dashboard-session-refresh');
  // Re-read rather than reuse `token`: a logout during this request already cleared storage, and
  // writing here would resurrect the session the user just ended.
  if (renewed !== null && renewed !== '' && readDashboardAuthToken() !== undefined) {
    writeDashboardAuthToken(renewed);
  }
  if (response.status === 401) handleDashboardUnauthorized();
```

Leave the rest of the function — the `isDashboardUnavailable` check and the `return response` — unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/dashboard`:

```bash
bun run test:unit src/lib/dashboard-client
```

Expected: PASS, both new tests plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/lib/dashboard-client/
git commit -m "feat(dashboard): store renewed session tokens from API responses"
```

---

### Task 5: Log out every tab together

**Files:**
- Modify: `packages/dashboard/src/modules/auth/services/auth-service/auth-service.ts`
- Test: `packages/dashboard/src/modules/auth/services/auth-service/auth-service.test.ts`

**Interfaces:**
- Consumes: `subscribeDashboardAuthTokenCleared` from Task 3; the module's own `logoutDashboard`.
- Produces: nothing new.

**Background for the implementer:**

This repairs a defect that Task 3 introduces rather than adding a feature. Under `sessionStorage` tabs were isolated, so a logout in one tab could not affect another. Under `localStorage` they share the key: without this wiring, a tab whose sibling logged out keeps rendering the authenticated UI while every request it makes returns 401.

Route through `logoutDashboard()`, not `markDashboardSessionExpired()`. The latter renders a "session expired" notice, which is the wrong message for a deliberate logout the user just performed in another tab.

`logoutDashboard()` calls `clearDashboardAuthToken()` itself. That is harmless and correct: the key is already gone, `removeItem` on a missing key is a no-op, and `storage` does not fire for a same-document change, so there is no event loop between tabs.

The two `set*Handler` calls at the top of the module are the established pattern for module-load-time registration in this file; the new subscription joins them.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/src/modules/auth/services/auth-service/auth-service.test.ts`:

```ts
test('a sibling tab clearing the token logs this tab out without an expiry notice', async () => {
  mocks.login.mockResolvedValue(
    Response.json({ ok: true, token: 'dashboard-session-token', expiresAt: '2026-08-18T00:00:00.000Z' }),
  );
  await loginDashboard('password');

  clearDashboardAuthToken();
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: null, storageArea: localStorage }),
  );
  await Promise.resolve();

  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unauthenticated' });
});
```

The existing imports already cover `clearDashboardAuthToken`, `loginDashboard`, and `queryClient`. The `await Promise.resolve()` lets the `void logoutDashboard()` microtask settle before the assertion reads the cache.

Asserting `unauthenticated` rather than an expired marker is the discriminating part: if the implementation wired `markDashboardSessionExpired` instead, the cached status would differ and this test would fail. That is the behavior difference worth protecting — the user sees a clean logged-out screen, not a scary "your session expired" notice for something they did on purpose.

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/dashboard`:

```bash
bun run test:unit src/modules/auth
```

Expected: FAIL. The cached status is still `{ status: 'authenticated' }` because nothing listens for the cleared key yet.

- [ ] **Step 3: Register cross-tab logout**

In `packages/dashboard/src/modules/auth/services/auth-service/auth-service.ts`, extend the token import:

```ts
import {
  clearDashboardAuthToken,
  subscribeDashboardAuthTokenCleared,
  writeDashboardAuthToken,
} from '@/lib/dashboard-auth-token';
```

Then add the subscription next to the two existing handler registrations, replacing those two lines with three:

```ts
setDashboardUnauthorizedHandler(markDashboardSessionExpired);
setDashboardUnavailableHandler(markDashboardUnavailable);
// `localStorage` is shared, so a sibling tab's logout must take this tab down too — otherwise it
// keeps rendering the authenticated UI while every request 401s. Not `markDashboardSessionExpired`:
// this was a deliberate logout, and an "expired" notice would be the wrong message.
subscribeDashboardAuthTokenCleared(() => void logoutDashboard());
```

`logoutDashboard` is declared later in the same module. That is fine — function declarations hoist, and the subscription's callback only runs after a user gesture in another tab, long after module evaluation.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/dashboard`:

```bash
bun run test:unit
```

Expected: PASS, the whole package suite.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/auth/services/auth-service/
git commit -m "fix(dashboard): log out sibling tabs when a session is cleared"
```

---

### Task 6: Document the login lifetime and release it

**Files:**
- Modify: `README.zh-Hans.md:350`
- Create: `.changeset/dashboard-session-persistence.md`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–5.
- Produces: nothing code-facing.

**Background for the implementer:**

The Chinese README is the user-facing reference. Line 350 currently reads:

```text
可以通过 `server.password` 设置 Dashboard 密码。该密码只保护 Dashboard，不保护模型 API。
```

It says nothing about how long a login lasts, which is exactly the question this change answers.

On the changeset: per `CLAUDE.md`, a note that affects users MUST target the product package `aio-proxy`, never only internal packages — a changeset targeting only `@aio-proxy/server` produces an empty `aio-proxy` CHANGELOG entry and `scripts/release.ts` silently skips its GitHub Release, so the note vanishes. All workspace packages share one lockstep version, and the product bump must equal the internal bump. This change is `minor` across all three. The body is one paragraph, at most 5 lines, with no `type(scope):` prefix and no area label — the frontmatter already names the packages.

- [ ] **Step 1: Document the login lifetime**

Replace line 350 of `README.zh-Hans.md` with:

```text
可以通过 `server.password` 设置 Dashboard 密码。该密码只保护 Dashboard，不保护模型 API。登录状态会保存在浏览器中，新标签页和重启浏览器都无需重新输入密码；只要每 7 天内至少访问一次，登录就会自动续期。修改 `server.password` 会立即让所有设备上的登录失效。
```

Three facts, in the order a user asks about them: it persists, it renews while you stay active, and here is how you revoke it.

- [ ] **Step 2: Check for stale pending notes**

Per `CLAUDE.md`, an unreleased note describes the shipped state, so a prior pending note claiming the opposite behavior must be corrected or deleted in this same commit:

```bash
grep -ril "sessionStorage\|会话\|session" .changeset/
```

Expected: no hit that promises a per-tab or non-persistent Dashboard session. If one exists, rewrite that note to describe the shipped behavior instead of adding a second note about the same feature.

- [ ] **Step 3: Write the changeset**

Create `.changeset/dashboard-session-persistence.md`:

```markdown
---
'aio-proxy': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
---

Dashboard 登录现在会保存在浏览器中，打开新标签页或重启浏览器都不需要重新输入密码，并且在持续使用期间自动续期，活跃用户不会再被登出。在一个标签页登出会同时登出其他标签页，修改 `server.password` 仍然会立即让所有设备上的登录失效。
```

Match the language of the existing notes in `.changeset/` — if they are written in English, write this one in English with the same content.

- [ ] **Step 4: Run the full preflight**

From the repo root:

```bash
bun run preflight
```

Expected: PASS. This runs `lint:types`, `format:check`, and every package's unit tests. If `format:check` complains, run `bun run format` and amend.

- [ ] **Step 5: Manual smoke check**

Automated tests cannot cover the actual browser behavior this change exists to deliver. Start the server with a Dashboard password configured, then:

1. Log in, open `/dashboard` in a second tab — it must render authenticated, with no password prompt.
2. Quit and reopen the browser, visit `/dashboard` — still authenticated.
3. Log out in one tab — the other tab must drop to the login screen, showing the plain login form and NOT a "session expired" notice.
4. Change `server.password` in Settings — every tab must require the new password.

Step 4 is the one worth being careful about: it is the only revocation mechanism this design has.

- [ ] **Step 6: Commit**

```bash
git add README.zh-Hans.md .changeset/dashboard-session-persistence.md
git commit -m "docs: describe Dashboard login persistence"
```

---

## Verification Summary

What the automated suites cover, mapped to the spec's Verification section:

| Behavior | Where |
| --- | --- |
| A fresh token is not renewed (no churn per request) | Task 1, test 1 |
| An aged token yields a token that verifies with a later `expiresAt` | Task 1, test 1 |
| Expired and tampered tokens are not renewed | Task 1, test 2 |
| A token minted under the previous password is not renewed | Task 1, test 3 |
| An aged request gets the header and the new token works | Task 2, test 1 |
| A fresh request and a 401 carry no header | Task 2, test 2 |
| The cleared-key subscription fires only on removal, not renewal | Task 3 |
| `dashboardFetch` replaces the stored token on renewal | Task 4, test 1 |
| A renewal after logout does not resurrect the session | Task 4, test 2 |
| A sibling tab's clear logs out without the expired notice | Task 5 |

Deliberately untested, per the repository's testing rules: the identity of the storage backend (`localStorage` vs anything else) and the numeric values of `SESSION_TTL_MS` and `REFRESH_AFTER_MS`. Both are implementation literals, and the existing read/write/clear contract tests already cover the storage surface. A test asserting `REFRESH_AFTER_MS === 86_400_000` would restate a constant rather than protect a user-visible outcome; the age-threshold *behavior* is covered by the fresh-vs-aged pair in Task 1.
