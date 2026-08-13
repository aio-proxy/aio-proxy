# Remote API Key Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow non-loopback aio-proxy binding with optional caller API keys and safe remote Dashboard/Admin access.

**Architecture:** Add the `server.apiKeys` config contract as an array of `{ key, label? }` records. A small server middleware protects `/v1/*` when that array is non-empty and deletes caller credentials before the existing protocol route handlers run. Dashboard and Admin retain the current password-session mechanism, with direct-peer loopback treated as local and same-host Origin validation for browser mutations.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Bun test.

## Global Constraints

- `server.apiKeys` entries are `{ key, label? }`; `key` supports `{{env.NAME}}`, and `label` is display-only.
- No new dependencies or trusted-proxy support.
- Direct connection is the supported remote topology; a local reverse proxy is intentionally treated as loopback.
- Caller credentials must never be sent upstream or returned by Dashboard APIs.
- `/health` remains unauthenticated; an empty `apiKeys` array intentionally leaves model APIs open.

---

### Task 1: Define and redact the configuration contract

**Files:**
- Modify: `packages/types/src/config/config.ts`
- Test: `packages/types/src/config/config.test.ts`
- Modify: `packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts`
- Test: `packages/server/src/server/server-config.test.ts`

**Interfaces:**
- Produces `Config['server']['apiKeys']` as `readonly { readonly key: string; readonly label?: string }[]`.
- `ConfigAuthoringSchema` accepts template strings only in each entry's `key`.

- [ ] **Step 1: Write failing config and redaction tests**

```ts
test('accepts remote hosts and labeled API keys', () => {
  expect(ConfigSchema.parse({
    server: { host: '0.0.0.0', apiKeys: [{ key: 'runtime-key', label: 'CI' }] },
    providers: {},
  }).server).toMatchObject({ host: '0.0.0.0', apiKeys: [{ key: 'runtime-key', label: 'CI' }] });
});

test('redacts API key values while preserving labels', async () => {
  const app = await createServer({ config: { server: { apiKeys: [{ key: 'private-key', label: 'CI' }] }, providers: {} } });
  const body = await (await app.request('/dashboard/api/config', undefined, loopbackServer)).json();
  expect(body.server.apiKeys).toEqual([{ key: '****', label: 'CI' }]);
});
```

- [ ] **Step 2: Run the tests and verify they fail because the schema still rejects the host/key contract**

Run: `bun test packages/types/src/config/config.test.ts packages/server/src/server/server-config.test.ts`

- [ ] **Step 3: Implement the smallest schema and redaction changes**

```ts
const ApiKeySchema = z.strictObject({ key: z.string().min(1), label: z.string().min(1).optional() });
const ApiKeyAuthoringSchema = z.strictObject({
  key: z.union([z.string().min(1), ConfigTemplateStringSchema]),
  label: z.string().min(1).optional(),
});
```

Use a non-empty unrestricted host schema in both runtime and authoring server schemas. Special-case `server.apiKeys` in Dashboard redaction so only each entry's `key` becomes `****`.

- [ ] **Step 4: Run the same tests and verify they pass**

Run: `bun test packages/types/src/config/config.test.ts packages/server/src/server/server-config.test.ts`

### Task 2: Protect model API routes and strip caller credentials

**Files:**
- Create: `packages/server/src/server/api-key-auth.ts`
- Create: `packages/server/src/server/api-key-auth.test.ts`
- Modify: `packages/server/src/server/server.ts`

**Interfaces:**
- `requireApiKey` is Hono middleware receiving `() => readonly ApiKeyEntry[]`.
- It permits all requests when no configured key exists; otherwise accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`, removes both headers, and returns 401 on failure.

- [ ] **Step 1: Write failing middleware behavior tests**

```ts
test('rejects a model request without a configured caller key', async () => {
  const app = await createServer({ config: { server: { apiKeys: [{ key: 'client-key', label: 'CI' }] }, providers: {} } });
  expect((await app.request('/v1/models')).status).toBe(401);
});

test('accepts X-API-Key and removes caller credentials before route dispatch', async () => {
  const observed = await requestThroughConfiguredProvider({ 'x-api-key': 'client-key' });
  expect(observed.get('x-api-key')).toBeNull();
  expect(observed.get('authorization')).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test packages/server/src/server/api-key-auth.test.ts`

- [ ] **Step 3: Implement `requireApiKey` and mount it only for `/v1/*` before model listing and protocol routes**

```ts
app.use('/v1/*', requireApiKey(() => state.currentConfig().server.apiKeys));
```

Compare candidate key strings with `timingSafeEqual`, reject malformed `Authorization` schemes, and delete `authorization` and `x-api-key` from the request before `next()`.

- [ ] **Step 4: Run focused tests and the affected server suite**

Run: `bun test packages/server/src/server/api-key-auth.test.ts packages/server/src/server/server.models.test.ts`

### Task 3: Allow remote Dashboard/Admin while retaining password sessions

**Files:**
- Modify: `packages/server/src/dashboard-auth/routes.ts`
- Modify: `packages/server/src/server/server.ts`
- Test: `packages/server/src/dashboard-auth/dashboard-auth.test.ts`
- Test: `packages/server/src/server/server-config.test.ts`

**Interfaces:**
- Export a loopback predicate/middleware helper based only on Bun's direct `requestIP` peer address.
- Remote Dashboard/Admin requires an enabled `DashboardAuthentication`; local `/admin/*` retains the existing session-less CLI path.

- [ ] **Step 1: Write failing remote-management tests**

```ts
test('allows a remote password session to use Dashboard and Admin from its own host', async () => {
  const remote = { requestIP: () => ({ address: '192.168.1.20' }) };
  const app = await createServer({ config: { server: { password: await Bun.password.hash('password') }, providers: {} } });
  const login = await app.request('/dashboard/api/auth/login', loginRequest('http://proxy.example:22078'), remote);
  const cookie = cookieFrom(login);
  expect((await app.request('/dashboard/api/config', { headers: { cookie } }, remote)).status).toBe(200);
  expect((await app.request('/admin/reload', { headers: { cookie, origin: 'http://proxy.example:22078' }, method: 'POST' }, remote)).status).toBe(200);
});

test('rejects remote Dashboard without a password and cross-host mutations', async () => {
  expect((await app.request('/dashboard', undefined, remote)).status).toBe(404);
  expect((await app.request('/dashboard/api/auth/login', loginRequest('http://evil.example'), remote)).status).toBe(403);
});
```

- [ ] **Step 2: Run the tests and verify failure under the current loopback-only guards**

Run: `bun test packages/server/src/dashboard-auth/dashboard-auth.test.ts packages/server/src/server/server-config.test.ts`

- [ ] **Step 3: Replace fixed loopback origins with same-host Origin checking and scope access by direct peer**

Use `new URL(origin).host === context.req.header('host')` for unsafe Dashboard/Admin methods. Keep origin-less local CLI Admin requests valid. Remove Dashboard's unconditional loopback guard; for non-loopback peers, return 404 unless `server.password` is configured, and require its session for Dashboard APIs and Admin. Change the session cookie path to `/` so the existing session can authenticate `/admin/*`.

- [ ] **Step 4: Run focused Dashboard/Admin tests**

Run: `bun test packages/server/src/dashboard-auth/dashboard-auth.test.ts packages/server/src/server/server-config.test.ts`

### Task 4: Document the public contract and release it

**Files:**
- Modify: user-facing configuration documentation located by `rg -n "server:|host:" README.md docs website`
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add one configuration example and deployment constraint**

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "apiKeys": [{ "key": "{{env.AIO_PROXY_KEY}}", "label": "CI" }]
  }
}
```

State that empty `apiKeys` leaves model APIs open, remote Dashboard needs `server.password`, and local reverse proxies are treated as loopback.

- [ ] **Step 2: Generate a patch changeset**

Run: `bun changeset`

Select `aio-proxy` and `@aio-proxy/types` at patch level, with a note describing remote bind support and optional labeled API keys.

- [ ] **Step 3: Run formatting and affected tests**

Run: `bun run check && bun test packages/types/src/config/config.test.ts packages/server/src/server/api-key-auth.test.ts packages/server/src/dashboard-auth/dashboard-auth.test.ts`

### Task 5: Verify the complete change

**Files:**
- Verify: all files above

- [ ] **Step 1: Inspect the final diff for API key leakage and unintended generated files**

Run: `git diff --check && git status --short && git diff -- packages/types/src/config packages/server/src`

- [ ] **Step 2: Run the repository preflight**

Run: `bun run preflight`

- [ ] **Step 3: Commit the implementation**

```bash
git add packages/types packages/server docs .changeset
git commit -m "feat: add remote API key access" -m "Co-authored-by: Codex <noreply@openai.com>"
```
