# Dashboard Bearer Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate password-enabled Dashboard API requests with signed Bearer sessions stored in browser `sessionStorage`, while preserving passwordless loopback access and securing its Origin boundary.

**Architecture:** Login keeps validating `server.password` and minting its signed session, but returns the token in JSON rather than an HTTP-only Cookie. Hono Bearer middleware validates that opaque token on Dashboard API requests. A browser token store and shared Dashboard client attach it. Passwordless loopback and CLI-only `/admin/reload` remain separate, with an explicit loopback-Origin CSRF check.

**Tech Stack:** Bun, TypeScript, Hono 4.12 `bearerAuth`, React, TanStack Query, `sessionStorage`, Bun test, Rstest.

## Global Constraints

- `server.apiKeys` protect model callers only; never grant Dashboard or Admin authority.
- Keep `server.password` as the sole Dashboard credential; do not persist its plaintext in browser storage.
- Store only the signed Dashboard session token in `sessionStorage`.
- Password-enabled Dashboard requests use Bearer authentication and no Cookie or Origin-based CSRF middleware.
- Passwordless Dashboard remains loopback-only and its unsafe methods accept only loopback Origins.
- `/admin/reload` remains loopback-only and unauthenticated for `aio-proxy reload`.
- Add no dependency: Hono is already a direct workspace dependency.

---

### Task 1: Server control-plane authentication and Gemini coverage

**Files:**

- Modify: `packages/server/src/dashboard-auth/routes.ts`
- Modify: `packages/server/src/dashboard-auth/dashboard-auth.test.ts`
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/admin-reload.test.ts`
- Modify: `packages/server/src/server/api-key-auth.test.ts`

**Interfaces:**

- Consumes: `DashboardAuthentication.login(password, clientId)` yielding `{ status: 'authenticated'; token: string; expiresAt: number }` and `DashboardAuthentication.verify(token)`.
- Produces: login response `{ ok: true, token: string, expiresAt: string }`; password-enabled Dashboard Bearer authentication; `/v1beta/*` caller-key protection.

- [ ] **Step 1: Write failing route tests**

Add a Dashboard login test for `remote-password`: assert its JSON has a nonempty `token`, `set-cookie` is absent, its Cookie is rejected by `/dashboard/api/config`, and `Authorization: Bearer <token>` succeeds. Add a Gemini route test with `server.apiKeys: [{ key: 'caller-secret' }]`: unauthenticated `/v1beta/models/gemini-2.5-flash:generateContent` returns 401, while the caller Bearer key reaches its configured provider. Add Admin tests which keep loopback no-Origin CLI success, reject `Origin: https://evil.example`, and reject matching `Host: attacker.example` / `Origin: http://attacker.example`.

- [ ] **Step 2: Verify RED**

Run: `bun test packages/server/src/dashboard-auth/dashboard-auth.test.ts packages/server/src/server/admin-reload.test.ts packages/server/src/server/api-key-auth.test.ts`

Expected: Bearer and Gemini assertions fail because login sets a Cookie, `/v1beta/*` is unprotected, and the Host-derived Origin comparison accepts the rebinding fixture.

- [ ] **Step 3: Implement the minimal server behavior**

In `routes.ts`, return `result.token` in login JSON, remove Cookie reads/writes, read the session token from the Bearer header, and make logout return `{ ok: true }` without server mutation. Preserve password failure, disabled, unavailable, and rate-limit responses.

In `server.ts`, import `bearerAuth` from `hono/bearer-auth`, create one middleware using `verifyToken: (token) => dashboardAuth.verify(token)`, and apply it to non-auth `/dashboard/api/*` requests only when `dashboardAuth.enabled()` is true. Return the existing unavailable 503 before authentication. Preserve `requireDashboardAuthentication` for passwordless loopback.

Replace Host-derived Origin comparison with `hasLoopbackOrigin(origin)`: parse the value, require HTTP(S), and permit only `localhost`, `::1`, or IPv4 `127.*`. Use it for unsafe passwordless Dashboard requests and browser-originated Admin requests. Keep Admin's no-Origin loopback CLI exception and Fetch Metadata rejection. Register existing `requireApiKey` on `/v1beta/*` as well as `/v1/*`.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command again. Expected: a Dashboard Cookie is ignored, signed Bearer succeeds, Gemini requires the caller key, and attacker-host Origin is forbidden.

- [ ] **Step 5: Commit**

`git add packages/server/src/dashboard-auth/routes.ts packages/server/src/dashboard-auth/dashboard-auth.test.ts packages/server/src/server/server.ts packages/server/src/server/admin-reload.test.ts packages/server/src/server/api-key-auth.test.ts && git commit -m "fix(server): protect control and Gemini routes" -m "Co-authored-by: Codex <noreply@openai.com>"`

### Task 2: Persist and send the browser session token

**Files:**

- Create: `packages/dashboard/src/modules/auth/services/dashboard-auth-token.ts`
- Create: `packages/dashboard/src/modules/auth/services/dashboard-auth-token.test.ts`
- Modify: `packages/dashboard/src/lib/dashboard-client/dashboard-client.ts`
- Modify: `packages/dashboard/src/lib/dashboard-client/dashboard-client.test.ts`
- Modify: `packages/dashboard/src/modules/auth/services/auth-service/auth-service.ts`
- Modify: `packages/dashboard/src/modules/auth/services/auth-service/auth-service.test.ts`
- Modify: `packages/dashboard/src/modules/auth/services/auth-session-store.ts`

**Interfaces:**

- Consumes: login response `{ ok: true, token: string, expiresAt: string }`.
- Produces: `readDashboardAuthToken(): string | undefined`, `writeDashboardAuthToken(token: string): void`, and `clearDashboardAuthToken(): void`; shared Dashboard fetch sends Bearer for Dashboard APIs except login.

- [ ] **Step 1: Write failing frontend tests**

Create token-store tests with real `sessionStorage`: write/read returns the literal token, clear returns `undefined`, and unavailable storage does not throw. Extend `dashboard-client.test.ts` to prefill the store, call `dashboard.api.providers.$get()`, and assert mocked fetch receives `Authorization: Bearer dashboard-session-token`; call login and assert that header is absent. Extend `auth-service.test.ts` so a successful response `{ ok: true, token: 'dashboard-session-token', expiresAt: '2026-08-18T00:00:00.000Z' }` stores its token and publishes authenticated state; logout and `markDashboardSessionExpired()` clear it.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- dashboard-client auth-service dashboard-auth-token`

Expected: failures because no token store exists and shared fetch forwards requests unchanged.

- [ ] **Step 3: Implement the minimal frontend behavior**

Create `dashboard-auth-token.ts` with one private key and three functions, each accessing `globalThis.sessionStorage` inside `try/catch`; unavailable or malformed values are absent. In `dashboard-client.ts`, clone incoming headers and set Bearer only for Dashboard API paths other than login when a token exists. Preserve non-Dashboard requests and caller headers.

In `auth-service.ts`, parse a successful login body, treat a missing token as `unknown`, write the token before publishing authenticated state, and make logout clear it locally. In `auth-session-store.ts`, clear the stored token when an authenticated session becomes expired or unavailable.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command again. Expected: all pass, including exact Bearer attachment and local token removal.

- [ ] **Step 5: Commit**

`git add packages/dashboard/src/lib/dashboard-client/dashboard-client.ts packages/dashboard/src/lib/dashboard-client/dashboard-client.test.ts packages/dashboard/src/modules/auth/services/dashboard-auth-token.ts packages/dashboard/src/modules/auth/services/dashboard-auth-token.test.ts packages/dashboard/src/modules/auth/services/auth-service/auth-service.ts packages/dashboard/src/modules/auth/services/auth-service/auth-service.test.ts packages/dashboard/src/modules/auth/services/auth-session-store.ts && git commit -m "feat(dashboard): store auth sessions in session storage" -m "Co-authored-by: Codex <noreply@openai.com>"`

### Task 3: Full verification and PR update

**Files:**

- Modify only if needed: `packages/server/__tests__/dashboard-provider-options-schema.install.test.ts`
- Modify only if needed: `packages/server/__tests__/dashboard-providers-mutation.test-support.ts`

**Interfaces:**

- Consumes: server Bearer behavior and browser request behavior from Tasks 1–2.
- Produces: a verified, pushed PR update.

- [ ] **Step 1: Run exact CI unit coverage**

Run: `bun run test:unit -- --concurrency=2`

Expected: all workspace unit tests pass. Update only fixtures intentionally modelling a password-enabled Dashboard request; retain passwordless loopback fixtures.

- [ ] **Step 2: Run static and diff checks**

Run: `bun run check && git diff --check && git status --short`

Expected: `check` exits zero apart from existing warnings, diff check emits nothing, and only planned files changed.

- [ ] **Step 3: Commit any needed fixture correction**

Run: `git add packages/server/__tests__/dashboard-provider-options-schema.install.test.ts packages/server/__tests__/dashboard-providers-mutation.test-support.ts && git commit -m "test: model dashboard bearer sessions" -m "Co-authored-by: Codex <noreply@openai.com>"`

Skip this commit when no fixture changes are required.

- [ ] **Step 4: Push and inspect PR checks**

Run: `git push && gh pr checks 176 --json name,state,bucket,link,startedAt,completedAt,workflow`

Expected: the branch updates and CI starts without a failed local-equivalent unit test.

