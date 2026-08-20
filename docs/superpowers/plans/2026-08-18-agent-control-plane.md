# Agent Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the typed Agent catalog contract, opaque per-installation credentials, RFC 8628 Device Authorization, composite model authentication, approval UI, and the small host-neutral runtime shared by the bundled Agent providers.

**Architecture:** `@aio-proxy/types` owns JSON contracts, `@aio-proxy/core` owns the SQLite-backed credential state machine and hot access-token index, and `@aio-proxy/server` owns Hono policy and routing. A private `@aio-proxy/agent-provider-runtime` package contains concrete Device Flow, refresh, catalog, and LKG functions used by the two delivery packages; it is not an SDK and has no host registry or host interface.

**Tech Stack:** Bun 1.3.14, TypeScript, Zod 4, Bun SQLite, Drizzle ORM, Hono 4, React 19, TanStack Query/Form/Router, Rstest.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`

## Global Constraints

- Implement only Agent catalog schema `1`; do not add schema negotiation infrastructure for a nonexistent schema `2`.
- Agent targets are exactly `opencode`, `pi`, and `omp`; client IDs are exactly `aio-proxy-opencode`, `aio-proxy-pi`, and `aio-proxy-omp`.
- Access tokens live 15 minutes; refresh tokens have a sliding 90-day expiry; consumed-token replay is idempotent for 30 seconds in one process.
- Token wire prefixes are exactly `aio_agent_at_v1_` and `aio_agent_rt_v1_`; token payloads are 32 random bytes encoded as base64url.
- SQLite stores only SHA-256 token hashes and non-secret metadata. Device-issue and refresh-rotation plaintext replay results exist only in memory for at most 30 seconds.
- Exactly one active `ServerState` may own a normalized SQLite path, even inside one process. Acquire the process-lifetime database lock before opening/migrating SQLite or constructing the access-token index; release it synchronously after database close and on every initialization failure.
- A recognizable invalid Agent token always fails closed and never falls back to anonymous or static API-key authentication.
- Device codes are 32 random bytes; user codes are eight non-ambiguous uppercase characters displayed as `XXXX-XXXX`; challenges expire after 10 minutes and start at a 5-second polling interval.
- Device endpoints accept only transport-peer loopback requests. Never trust `Forwarded`, `X-Forwarded-For`, `User-Agent`, query parameters, or custom headers as plugin identity.
- Agent approval mutations require a valid same-request Origin check even when Dashboard password authentication is enabled.
- Do not add Better Auth, JWT, a scope engine, public revoke/introspection, a background cleanup worker, a generic OAuth server, or a public Agent SDK.
- The shared runtime exports concrete functions only. Do not add a host adapter interface, registry, factory hierarchy, or runtime plugin seam.
- OpenCode V1 is required. OpenCode V2 is deferred and is not implemented or tested by any plan in this release.
- Dashboard inputs use TanStack Form, server state uses TanStack Query, API calls use the typed Hono client, and all user-facing copy is added to all five locale files.
- Handwritten non-test implementation files remain below 500 lines; split by responsibility before growing a file past 400 lines.
- Every user-visible change receives a Changeset in the final lifecycle/release plan; do not create a partial internal-package-only Changeset here.
- Every commit appends `Co-authored-by: Codex <noreply@openai.com>`.
- This plan precedes both adapter plans. The CLI lifecycle plan runs only after this plan and both adapter plans pass.

---

## File Structure

- `packages/types/src/agent-integration/agent-integration.ts` — all JSON-compatible Agent target, marker, state, catalog, Device Flow, approval, and admin schemas.
- `packages/types/src/agent-integration/index.ts` — export-only public barrel for those internal product contracts.
- `packages/core/src/db/schema/agent-identity.ts` — four Drizzle tables and their indexes/checks.
- `packages/core/src/agent-identity/repository.ts` — synchronous SQLite transactions and row decoding; no plaintext credential cache.
- `packages/core/src/agent-identity/tokens.ts` — versioned opaque token generation and hashing.
- `packages/core/src/agent-identity/agent-identity.ts` — credential issuance, rotation, replay detection, revocation, cleanup, and the in-memory access index.
- `packages/core/src/agent-identity/index.ts` — export-only barrel.
- `packages/core/src/db/ownership-lock/` — PID/starttime/heartbeat database ownership lock with fenced stale recovery and synchronous release.
- `packages/agent-provider/runtime/src/managed-state/` — export-only barrel, marker/state loading, its atomic-write tests, and no host behavior.
- `packages/agent-provider/runtime/src/oauth-client/` — export-only barrel, form-encoded Device/refresh requests, and polling tests.
- `packages/agent-provider/runtime/src/catalog-client/` — export-only barrel, authenticated schema-1 catalog fetch, failure classification, and LKG tests.
- `packages/agent-provider/runtime/src/single-flight/` — export-only barrel, one concrete promise coalescer, and its test.
- `packages/server/src/server/agent-auth/agent-auth.ts` — composite Agent/static/anonymous model middleware.
- `packages/server/src/server/list-models/agent-catalog/agent-catalog.ts` — the only neutral Agent catalog assembler.
- `packages/server/src/agent-authorization/device-challenges.ts` — in-memory RFC 8628 challenge state and rate limits.
- `packages/server/src/agent-authorization/routes.ts` — loopback Device/token, Dashboard approval, and local admin endpoints.
- `packages/dashboard/src/modules/agent-authorizations/` — typed service, TanStack hooks, and one approval page template.
- `packages/dashboard/src/routes/agents/authorize.tsx` — route-only binding for `/agents/authorize`.

### Task 1: Typed Agent wire contracts and reserved API-key prefixes

**Files:**

- Create: `packages/types/src/agent-integration/index.ts`
- Create: `packages/types/src/agent-integration/agent-integration.ts`
- Test: `packages/types/src/agent-integration/agent-integration.test.ts`
- Modify: `packages/types/src/config/config.ts`
- Modify: `packages/types/src/config/config.test.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**

- Produces: `AgentTarget`, `AgentManagedMarker`, `AgentManagedStateV1`, `AgentCatalogV1`, `AgentCatalogError`, `AgentTokenResponse`, `AgentAuthorizationDetails`, `AgentInstallationSummary`, `AgentAdminSnapshot`, `AgentRevokeStatus`, their Zod schemas, `AGENT_CLIENT_ID`, `AGENT_ACCESS_TOKEN_PREFIX`, `AGENT_REFRESH_TOKEN_PREFIX`, and `hasReservedAgentTokenPrefix(value)`.
- Consumes: existing `ModelMetadata` modality vocabulary and `ServerConfigSchema`/`ConfigAuthoringSchema` parsing.

- [ ] **Step 1: Write failing schema and config tests**

```ts
// packages/types/src/agent-integration/agent-integration.test.ts
import { expect, test } from 'bun:test';
import {
  AgentCatalogV1Schema,
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  AgentTokenResponseSchema,
  AgentTargetSchema,
  hasReservedAgentTokenPrefix,
} from './agent-integration';

test('schema 1 preserves every capability required by bundled adapters', () => {
  expect(
    AgentCatalogV1Schema.parse({
      schema_version: 1,
      agent: 'opencode',
      models: [{
        id: 'gpt-x', name: 'GPT X', reasoning: true, tool_call: true,
        temperature: false, attachment: true, input: ['text', 'image'],
        context_window: 128_000, max_output_tokens: null,
      }],
    }).models[0],
  ).toMatchObject({ tool_call: true, temperature: false, attachment: true });
});

test('marker accepts only canonical loopback installations', () => {
  const base = {
    format: 1, managedBy: 'aio-proxy', agent: 'pi',
    installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
    adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
  } as const;
  expect(AgentManagedMarkerSchema.safeParse(base).success).toBe(true);
  expect(AgentManagedMarkerSchema.safeParse({ ...base, endpoint: 'https://proxy.example' }).success).toBe(false);
  expect(AgentManagedMarkerSchema.safeParse({ ...base, adapterVersion: 'latest' }).success).toBe(false);
});

test('managed state accepts only fixed error categories', () => {
  expect(AgentManagedStateV1Schema.safeParse({
    format: 1, catalogSchema: 1, status: 'missing', lastSuccessfulAt: null,
    lastError: 'network', lkg: null,
  }).success).toBe(true);
  expect(AgentManagedStateV1Schema.safeParse({
    format: 1, catalogSchema: 1, status: 'missing', lastSuccessfulAt: null,
    lastError: 'secret bearer value', lkg: null,
  }).success).toBe(false);
  expect(AgentManagedStateV1Schema.safeParse({
    format: 1, catalogSchema: 1, status: 'fresh', lastSuccessfulAt: null,
    lastError: null, lkg: null,
  }).success).toBe(false);
});

test('recognizes both reserved Agent credential families', () => {
  expect(hasReservedAgentTokenPrefix('aio_agent_at_v1_x')).toBe(true);
  expect(hasReservedAgentTokenPrefix('aio_agent_rt_v1_x')).toBe(true);
  expect(hasReservedAgentTokenPrefix('ordinary-static-key')).toBe(false);
  expect(AgentTargetSchema.options).toEqual(['opencode', 'pi', 'omp']);
});

test('token responses require one exact 32-byte base64url payload', () => {
  const base = {
    token_type: 'Bearer',
    access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
    refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
    expires_in: 900,
  } as const;
  expect(AgentTokenResponseSchema.safeParse(base).success).toBe(true);
  expect(AgentTokenResponseSchema.safeParse({ ...base, access_token: 'aio_agent_at_v1_short' }).success)
    .toBe(false);
});
```

Add these exact config cases:

```ts
test.each(['aio_agent_at_v1_static', 'aio_agent_rt_v1_static'])(
  'rejects reserved Agent prefix %s as a static API key',
  (key) => {
    const input = { server: { apiKeys: [{ key }] }, providers: {} };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
    expect(ConfigAuthoringSchema.safeParse(input).success).toBe(false);
  },
);

test('keeps unresolved API-key templates valid in the authoring schema', () => {
  const input = { server: { apiKeys: [{ key: '{{ env.AIO_PROXY_API_KEY }}' }] }, providers: {} };
  expect(ConfigAuthoringSchema.safeParse(input).success).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test packages/types/src/agent-integration/agent-integration.test.ts packages/types/src/config/config.test.ts`

Expected: FAIL because the Agent module and reserved-prefix refinement do not exist.

- [ ] **Step 3: Implement the complete JSON contract**

```ts
// packages/types/src/agent-integration/agent-integration.ts
import { isIP } from 'node:net';
import { z } from 'zod';

export const AGENT_ACCESS_TOKEN_PREFIX = 'aio_agent_at_v1_';
export const AGENT_REFRESH_TOKEN_PREFIX = 'aio_agent_rt_v1_';
export const AgentTargetSchema = z.enum(['opencode', 'pi', 'omp']);
export type AgentTarget = z.output<typeof AgentTargetSchema>;

export const AGENT_CLIENT_ID = {
  opencode: 'aio-proxy-opencode', pi: 'aio-proxy-pi', omp: 'aio-proxy-omp',
} as const satisfies Record<AgentTarget, string>;

const SemverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
);
const LoopbackEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return url.protocol === 'http:' && url.username === '' && url.password === '' &&
    url.pathname === '/' && url.search === '' && url.hash === '' &&
    (host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127'));
}, 'Agent endpoint must be an HTTP loopback URL');

export const AgentManagedMarkerSchema = z.strictObject({
  format: z.literal(1), managedBy: z.literal('aio-proxy'), agent: AgentTargetSchema,
  installationId: z.uuid(), adapterVersion: SemverSchema, endpoint: LoopbackEndpointSchema,
});
export type AgentManagedMarker = z.output<typeof AgentManagedMarkerSchema>;

export const AgentCatalogModelV1Schema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), reasoning: z.boolean(),
  tool_call: z.boolean(), temperature: z.boolean(), attachment: z.boolean(),
  input: z.array(z.enum(['text', 'audio', 'image', 'video', 'pdf'])),
  context_window: z.number().int().positive().nullable(),
  max_output_tokens: z.number().int().positive().nullable(),
});
export const AgentCatalogV1Schema = z.strictObject({
  schema_version: z.literal(1), agent: AgentTargetSchema, models: z.array(AgentCatalogModelV1Schema),
});
export type AgentCatalogV1 = z.output<typeof AgentCatalogV1Schema>;
export const AgentCatalogErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }),
  supported_schema_versions: z.array(z.number().int().positive()).optional(),
});
export type AgentCatalogError = z.output<typeof AgentCatalogErrorSchema>;

export const AgentAdapterFailureSchema = z.enum([
  'network', 'unauthorized', 'server_error', 'invalid_json',
  'invalid_catalog', 'unsupported_schema',
]);
export type AgentAdapterFailure = z.output<typeof AgentAdapterFailureSchema>;
export const AgentManagedStateV1Schema = z.strictObject({
  format: z.literal(1), catalogSchema: z.literal(1),
  status: z.enum(['fresh', 'stale', 'missing']), lastSuccessfulAt: z.iso.datetime().nullable(),
  lastError: AgentAdapterFailureSchema.nullable(), lkg: AgentCatalogV1Schema.nullable(),
}).superRefine((state, context) => {
  const valid = state.status === 'fresh'
    ? state.lkg !== null && state.lastSuccessfulAt !== null && state.lastError === null
    : state.status === 'stale'
      ? state.lkg !== null && state.lastSuccessfulAt !== null && state.lastError !== null
      : state.lkg === null && state.lastSuccessfulAt === null;
  if (!valid) context.addIssue({ code: 'custom', message: 'inconsistent Agent managed state' });
});
export type AgentManagedStateV1 = z.output<typeof AgentManagedStateV1Schema>;

export const AgentTokenResponseSchema = z.strictObject({
  token_type: z.literal('Bearer'),
  access_token: z.string().regex(/^aio_agent_at_v1_[A-Za-z0-9_-]{43}$/u),
  refresh_token: z.string().regex(/^aio_agent_rt_v1_[A-Za-z0-9_-]{43}$/u),
  expires_in: z.literal(900),
});
export type AgentTokenResponse = z.output<typeof AgentTokenResponseSchema>;

export function hasReservedAgentTokenPrefix(value: string): boolean {
  return value.startsWith('aio_agent_at_') || value.startsWith('aio_agent_rt_');
}
```

Define the remaining wire and Dashboard/admin contracts in the same file. OAuth/catalog fields are snake_case; Dashboard/admin DTOs are camelCase:

```ts
export const AgentCatalogQuerySchema = z.strictObject({
  agent: AgentTargetSchema,
  adapter_version: SemverSchema,
  schema_version: z.literal('1'),
});

const AgentClientIdSchema = z.enum(['aio-proxy-opencode', 'aio-proxy-pi', 'aio-proxy-omp']);
export const AgentDeviceCodeRequestSchema = z.strictObject({
  client_id: AgentClientIdSchema,
  agent: AgentTargetSchema,
  installation_id: z.uuid(),
  adapter_version: SemverSchema,
});
export type AgentDeviceCodeRequest = z.output<typeof AgentDeviceCodeRequestSchema>;
export const AgentDeviceCodeResponseSchema = z.strictObject({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  user_code: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u),
  verification_uri: z.url(), verification_uri_complete: z.url(),
  expires_in: z.literal(600), interval: z.literal(5),
});
export type AgentDeviceCodeResponse = z.output<typeof AgentDeviceCodeResponseSchema>;
export const AgentTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.strictObject({
    grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    client_id: AgentClientIdSchema, device_code: z.string().min(1),
  }),
  z.strictObject({
    grant_type: z.literal('refresh_token'),
    client_id: AgentClientIdSchema, refresh_token: z.string().min(1),
  }),
]);
export type AgentTokenRequest = z.output<typeof AgentTokenRequestSchema>;
export const AgentOAuthErrorSchema = z.strictObject({
  error: z.enum(['authorization_pending', 'slow_down', 'access_denied', 'expired_token',
    'invalid_client', 'invalid_grant', 'authorization_unavailable', 'invalid_request',
    'rate_limited', 'capacity_exceeded']),
  error_description: z.string().min(1).optional(),
});
export type AgentOAuthError = z.output<typeof AgentOAuthErrorSchema>;

export const AgentAuthorizationResolveRequestSchema = z.strictObject({ userCode: z.string().min(1) });
const AgentAuthorizationPendingSchema = z.strictObject({
  status: z.literal('pending'), deviceId: z.uuid(), target: AgentTargetSchema,
  installationId: z.uuid(), adapterVersion: SemverSchema, expiresAt: z.iso.datetime(),
  permissions: z.tuple([z.literal('catalog'), z.literal('inference')]),
});
export const AgentAuthorizationDetailsSchema = z.discriminatedUnion('status', [
  AgentAuthorizationPendingSchema,
  z.strictObject({ status: z.literal('approved') }),
  z.strictObject({ status: z.literal('denied') }),
  z.strictObject({ status: z.literal('consumed') }),
  z.strictObject({ status: z.literal('expired') }),
]);
export type AgentAuthorizationDetails = z.output<typeof AgentAuthorizationDetailsSchema>;
export const AgentAuthorizationDecisionResponseSchema = z.strictObject({
  status: z.enum(['approved', 'denied', 'expired', 'consumed']),
});
export const AgentInstallationSummarySchema = z.strictObject({
  installationId: z.uuid(), target: AgentTargetSchema, adapterVersion: SemverSchema,
  createdAt: z.iso.datetime(), lastAuthorizedAt: z.iso.datetime(),
  authorization: z.enum(['active', 'expired', 'revoked']),
  accessExpiresAt: z.iso.datetime().nullable(),
});
export type AgentInstallationSummary = z.output<typeof AgentInstallationSummarySchema>;
export const AgentAdminSnapshotSchema = z.strictObject({
  installations: z.array(AgentInstallationSummarySchema),
  deviceAuthorization: z.enum(['available', 'password_required']),
  catalogSchemaVersions: z.tuple([z.literal(1)]),
});
export type AgentAdminSnapshot = z.output<typeof AgentAdminSnapshotSchema>;
export const AgentRevokeStatusSchema = z.enum(['revoked', 'expired', 'missing']);
export type AgentRevokeStatus = z.output<typeof AgentRevokeStatusSchema>;
export const AgentRevokeResponseSchema = z.strictObject({
  installationId: z.uuid(), status: AgentRevokeStatusSchema,
});
```

In `config.ts`, derive both concrete API-key schemas from one refinement:

```ts
const StaticApiKeySchema = z.string().min(1).refine(
  (value) => !hasReservedAgentTokenPrefix(value),
  'Static API keys cannot use reserved aio_agent_at_ or aio_agent_rt_ prefixes',
);

const ApiKeySchema = z.object({
  key: StaticApiKeySchema,
  label: z.string().min(1).optional(),
});
const ApiKeyAuthoringSchema = z.object({
  key: z.union([ConfigTemplateStringSchema, StaticApiKeySchema]),
  label: z.string().min(1).optional(),
});
```

The authoring union keeps templates valid before interpolation; after interpolation, `ConfigSchema` applies `StaticApiKeySchema`, so an environment value using either reserved prefix still fails. Export the new module from `packages/types/src/index.ts`; `agent-integration/index.ts` contains only `export * from './agent-integration';`.

- [ ] **Step 4: Run focused tests and type-aware lint**

Run: `bun test packages/types/src/agent-integration/agent-integration.test.ts packages/types/src/config/config.test.ts && bun run lint:types`

Expected: PASS; both concrete config paths reject reserved prefixes and the Agent contracts compile without host SDK dependencies.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/agent-integration packages/types/src/config/config.ts packages/types/src/config/config.test.ts packages/types/src/index.ts
git commit -m "feat(types): define agent integration contracts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Agent identity tables, migrations, and repository transactions

**Files:**

- Create: `packages/core/src/db/schema/agent-identity.ts`
- Create: `packages/core/src/agent-identity/repository.ts`
- Test: `packages/core/src/agent-identity/repository.test.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Modify: `packages/core/src/db/index.ts`
- Create (generated by Step 4; Drizzle prints the exact basename): the next `0005_*.sql` file under `packages/core/src/db/migrations/`
- Modify (generated): `packages/core/src/db/migrations/meta/0005_snapshot.json`
- Modify (generated): `packages/core/src/db/migrations/meta/_journal.json`
- Modify (generated): `packages/core/src/db/migrations.manifest.ts`
- Modify: `packages/core/src/db/migrations/migrations.test.ts`

**Interfaces:**

- Consumes: `AgentTarget` and `AgentInstallationSummary` from Task 1.
- Produces: private `createAgentIdentityRepository(sqlite)` used only inside `packages/core/src/agent-identity/`, with immediate transactions for issue, rotate, revoke, and cleanup.

- [ ] **Step 1: Write failing repository and migration-preservation tests**

```ts
// packages/core/src/agent-identity/repository.test.ts
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db';
import { createAgentIdentityRepository } from './repository';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-repository-'));
  roots.push(home);
  const handle = openDb({ home });
  return { handle, repo: createAgentIdentityRepository(handle.sqlite) };
};

test('issue replaces only the current family for one installation', () => {
  const { handle, repo } = fixture();
  repo.issue({ installationId: INSTALLATION, target: 'opencode', adapterVersion: '1.2.3',
    familyId: 'family-1', accessHash: 'at-1', refreshHash: 'rt-1', now: 1_000,
    accessExpiresAt: 901_000, refreshExpiresAt: 7_776_001_000 });
  repo.issue({ installationId: INSTALLATION, target: 'opencode', adapterVersion: '1.2.4',
    familyId: 'family-2', accessHash: 'at-2', refreshHash: 'rt-2', now: 2_000,
    accessExpiresAt: 902_000, refreshExpiresAt: 7_776_002_000 });
  expect(repo.readFamily('family-1')?.revokedAt).toBe(2_000);
  expect(repo.readFamily('family-2')?.revokedAt).toBeNull();
  handle.close();
});

test('issue cannot rebind an installation to another target or revoke its family', () => {
  const { handle, repo } = fixture();
  repo.issue({ installationId: INSTALLATION, target: 'opencode', adapterVersion: '1.2.3',
    familyId: 'family-1', accessHash: 'at-1', refreshHash: 'rt-1', now: 1_000,
    accessExpiresAt: 901_000, refreshExpiresAt: 7_776_001_000 });
  expect(repo.issue({
    installationId: INSTALLATION, target: 'pi', adapterVersion: '1.2.4',
    familyId: 'family-2', accessHash: 'at-2', refreshHash: 'rt-2', now: 2_000,
    accessExpiresAt: 902_000, refreshExpiresAt: 7_776_002_000,
  })).toEqual({ status: 'target_mismatch' });
  expect(repo.readFamily('family-1')?.revokedAt).toBeNull();
  expect(repo.readFamily('family-2')).toBeNull();
  expect(repo.loadActiveAccess(2_000)).toEqual([
    expect.objectContaining({ tokenHash: 'at-1', target: 'opencode' }),
  ]);
  expect(repo.listInstallations(2_000)).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, target: 'opencode' }),
  ]);
  handle.close();
});

test('rotation consumes old refresh and inserts the successor atomically', () => {
  const { handle, repo } = fixture();
  repo.issue({ installationId: INSTALLATION, target: 'opencode', adapterVersion: '1.2.3',
    familyId: 'family-1', accessHash: 'at-1', refreshHash: 'rt-1', now: 1_000,
    accessExpiresAt: 901_000, refreshExpiresAt: 7_776_001_000 });
  expect(repo.rotate({ familyId: 'family-1', currentRefreshHash: 'rt-1',
    nextAccessHash: 'at-2', nextRefreshHash: 'rt-2', now: 2_000,
    accessExpiresAt: 902_000, refreshExpiresAt: 7_776_002_000 })).toBe(true);
  expect(repo.readRefresh('rt-1')?.consumedAt).toBe(2_000);
  expect(repo.readRefresh('rt-2')).toMatchObject({ consumedAt: null, expiresAt: 7_776_002_000 });
  expect(repo.readFamily('family-1')?.refreshExpiresAt).toBe(7_776_002_000);
  expect(repo.loadActiveAccess(2_000).map(({ tokenHash }) => tokenHash)).toEqual(['at-2']);
  expect(repo.rotate({ familyId: 'family-1', currentRefreshHash: 'rt-1',
    nextAccessHash: 'at-3', nextRefreshHash: 'rt-3', now: 2_001,
    accessExpiresAt: 902_001, refreshExpiresAt: 7_776_002_001 })).toBe(false);
  expect(repo.readRefresh('rt-3')).toBeNull();
  handle.close();
});
```

Append this preservation case to the existing `migrations.test.ts` harness. It follows that file's current `mkdtempSync` + `MIGRATIONS.slice(...)` pattern and stops the copied database at schema version `5` before `openDb()` applies migration `0005_*` as schema version `6`:

```ts
test('migration 6 preserves schema-5 session affinity data', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-migration-agent-'));
  const path = join(home, 'aio-proxy.db');
  const versionFive = new Database(path);
  try {
    for (const migration of MIGRATIONS.slice(0, 5)) versionFive.run(migration.sql);
    versionFive.run('PRAGMA user_version = 5');
    versionFive.run(`INSERT INTO session_affinity
      (session_source, session_id, requested_model_id, provider_id, revision, expires_at, updated_at)
      VALUES ('header', 'session-1', 'gpt-x', 'provider-a', 1, 999999, 1000)`);
  } finally {
    versionFive.close();
  }

  const handle = openDb({ home });
  try {
    expect(handle.sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'agent_%' ORDER BY name").all())
      .toHaveLength(4);
    expect(handle.sqlite.query("SELECT provider_id FROM session_affinity WHERE session_id = 'session-1'").get())
      .toEqual({ provider_id: 'provider-a' });
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test packages/core/src/agent-identity/repository.test.ts packages/core/src/db/migrations/migrations.test.ts`

Expected: FAIL because the schema/repository and schema-version-6 migration do not exist.

- [ ] **Step 3: Define the four tables and integrity indexes**

```ts
// packages/core/src/db/schema/agent-identity.ts
import type { AgentTarget } from '@aio-proxy/types';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const agentInstallation = sqliteTable('agent_installation', {
  installationId: text('installation_id').primaryKey(),
  target: text('target').$type<AgentTarget>().notNull(),
  createdAt: integer('created_at').notNull(),
  lastAuthorizedAt: integer('last_authorized_at').notNull(),
  adapterVersion: text('adapter_version').notNull(),
});

export const agentTokenFamily = sqliteTable('agent_token_family', {
  familyId: text('family_id').primaryKey(),
  installationId: text('installation_id').notNull().references(
    () => agentInstallation.installationId, { onDelete: 'cascade' },
  ),
  createdAt: integer('created_at').notNull(), revokedAt: integer('revoked_at'),
  refreshExpiresAt: integer('refresh_expires_at').notNull(),
}, (table) => [
  index('agent_family_installation_idx').on(table.installationId),
  uniqueIndex('agent_family_one_current_idx').on(table.installationId).where(sql`${table.revokedAt} is null`),
]);

export const agentAccessToken = sqliteTable('agent_access_token', {
  tokenHash: text('token_hash').primaryKey(),
  familyId: text('family_id').notNull().references(() => agentTokenFamily.familyId, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [index('agent_access_family_idx').on(table.familyId)]);

export const agentRefreshToken = sqliteTable('agent_refresh_token', {
  tokenHash: text('token_hash').primaryKey(),
  familyId: text('family_id').notNull().references(() => agentTokenFamily.familyId, { onDelete: 'cascade' }),
  issuedAt: integer('issued_at').notNull(), expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
}, (table) => [index('agent_refresh_family_idx').on(table.familyId)]);
```

Export the tables from both DB barrels. Implement exactly this private repository surface with prepared Bun SQLite statements and `sqlite.transaction(...).immediate()`. The rotate transaction deletes existing `agent_access_token` rows for the family before inserting `nextAccessHash`; old-refresh consumption, access replacement, successor-refresh insertion, and family-expiry update commit together:

```ts
type IssueRowsInput = {
  readonly installationId: string; readonly target: AgentTarget; readonly adapterVersion: string;
  readonly familyId: string; readonly accessHash: string; readonly refreshHash: string;
  readonly now: number; readonly accessExpiresAt: number; readonly refreshExpiresAt: number;
};
type RotateRowsInput = {
  readonly familyId: string; readonly currentRefreshHash: string;
  readonly nextAccessHash: string; readonly nextRefreshHash: string;
  readonly now: number; readonly accessExpiresAt: number; readonly refreshExpiresAt: number;
};
type StoredFamily = {
  readonly familyId: string; readonly installationId: string; readonly createdAt: number;
  readonly revokedAt: number | null; readonly refreshExpiresAt: number;
};
type StoredRefresh = {
  readonly tokenHash: string; readonly familyId: string; readonly installationId: string;
  readonly target: AgentTarget; readonly consumedAt: number | null; readonly expiresAt: number;
  readonly revokedAt: number | null;
};
type StoredAccessGrant = {
  readonly tokenHash: string; readonly familyId: string; readonly installationId: string;
  readonly target: AgentTarget; readonly expiresAt: number;
};
type IssueRowsResult =
  | { readonly status: 'issued'; readonly replacedFamilyIds: readonly string[] }
  | { readonly status: 'target_mismatch' };

type AgentIdentityRepository = {
  readonly issue: (input: IssueRowsInput) => IssueRowsResult;
  readonly rotate: (input: RotateRowsInput) => boolean;
  readonly readFamily: (familyId: string) => StoredFamily | null;
  readonly readRefresh: (tokenHash: string) => StoredRefresh | null;
  readonly loadActiveAccess: (now: number) => readonly StoredAccessGrant[];
  readonly revokeFamily: (familyId: string, now: number) => boolean;
  readonly revokeInstallation: (installationId: string, now: number) => {
    readonly status: AgentRevokeStatus; readonly familyId?: string;
  };
  readonly listInstallations: (now: number) => readonly AgentInstallationSummary[];
  readonly cleanup: (now: number, retentionMs: number) => void;
};
```

At the start of the `issue` immediate transaction, select the existing installation target. If it exists and differs from `input.target`, return `{ status: 'target_mismatch' }` before updating installation metadata or revoking any family. Otherwise `issue` upserts only same-target installation metadata, changes every current family for that installation from `revoked_at IS NULL` to `revoked_at = now`, inserts the new family/access/refresh rows, and returns `{ status: 'issued', replacedFamilyIds }` in the same transaction. `rotate` first performs `UPDATE agent_refresh_token SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`; only when `changes === 1` may the same immediate transaction update `agent_token_family.refresh_expires_at` and insert successor access/refresh rows. `revokeInstallation` returns `missing` when no installation row exists, `expired` when its only current family has passed `refresh_expires_at`, and `revoked` both when it changes a current family and when all of that installation's families are already revoked. `cleanup` deletes expired access rows immediately, refresh rows only after their own `expires_at`, and terminal families/installations only after `max(revoked_at, refresh_expires_at) + retentionMs`. No repository input or result contains a plaintext token.

- [ ] **Step 4: Generate and inspect schema migration 6 (`0005_*`)**

Run: `bun run build:migrations`

Expected: Drizzle prints the exact generated `0005_<name>.sql` path, creates `meta/0005_snapshot.json`, updates `_journal.json`, and `migrations.manifest.ts` reports `Updated 6 migrations.` Run `git diff -- packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts`; the SQL may contain only the four `agent_*` tables, their foreign keys, and indexes above.

- [ ] **Step 5: Run repository and migration tests GREEN**

Run: `bun test packages/core/src/agent-identity/repository.test.ts packages/core/src/db/migrations/migrations.test.ts`

Expected: PASS, including preservation of schema-5 data and atomic rotation.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/schema/agent-identity.ts packages/core/src/db/schema/index.ts packages/core/src/db/index.ts packages/core/src/agent-identity/repository.ts packages/core/src/agent-identity/repository.test.ts packages/core/src/db/migrations packages/core/src/db/migrations.manifest.ts
git commit -m "feat(core): persist agent token families" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Opaque credential state machine and in-memory access index

**Files:**

- Create: `packages/core/src/agent-identity/index.ts`
- Create: `packages/core/src/agent-identity/tokens.ts`
- Create: `packages/core/src/agent-identity/agent-identity.ts`
- Test: `packages/core/src/agent-identity/agent-identity.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Produces: `createAgentIdentityService(sqlite, options?)`, `AgentIdentityService`, `AgentAccessGrant`, `AgentInstallationTargetMismatchError`, and exact methods:
  - `authenticateAccessToken(token): AgentAccessAuthentication`
  - `issueCredential({ installationId, target, adapterVersion }): IssuedAgentCredential`
  - `refreshCredential({ clientId, refreshToken }): AgentRefreshResult`
  - `listInstallations(): readonly AgentInstallationSummary[]`
  - `revokeInstallation(installationId): AgentRevokeStatus`
- Consumes: Task 2 repository transactions and Task 1 token/client constants.

- [ ] **Step 1: Write failing state-machine tests with an injected clock/random source**

```ts
// packages/core/src/agent-identity/agent-identity.test.ts
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDb } from '../db';
import {
  AgentInstallationTargetMismatchError,
  createAgentIdentityService,
  type AgentIdentityService,
  type AgentRefreshResult,
  type IssuedAgentCredential,
} from './agent-identity';
import { hashAgentToken } from './tokens';

const INPUT = {
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  target: 'opencode',
  adapterVersion: '1.2.3',
} as const;

const roots: string[] = [];
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(input: { readonly sqlite?: Database; readonly now: number }) {
  let timestamp = input.now;
  let sequence = 0;
  let sqlite = input.sqlite;
  let close = () => {};
  if (sqlite === undefined) {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-identity-'));
    roots.push(home);
    const handle = openDb({ home });
    sqlite = handle.sqlite;
    close = handle.close;
    closes.push(close);
  }
  const service = createAgentIdentityService(sqlite, {
    now: () => timestamp,
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return {
    sqlite,
    service,
    close,
    setNow: (value: number) => { timestamp = value; },
    dump: () => JSON.stringify({
      access: sqlite.query('SELECT * FROM agent_access_token').all(),
      refresh: sqlite.query('SELECT * FROM agent_refresh_token').all(),
    }),
  };
}

function expectRefreshSuccess(result: AgentRefreshResult): IssuedAgentCredential {
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error(`expected refresh success, got ${result.reason}`);
  return result;
}

test('stores only hashes while an issued access token survives service restart', () => {
  const first = fixture({ now: 1_000 });
  const issued = first.service.issueCredential(INPUT);
  expect(first.dump()).not.toContain(issued.accessToken);
  expect(first.dump()).not.toContain(issued.refreshToken);
  const restarted = fixture({ sqlite: first.sqlite, now: 2_000 });
  expect(restarted.service.authenticateAccessToken(issued.accessToken)).toMatchObject({ status: 'valid' });
});

test('replays one rotation result for 30 seconds without creating another token', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const first = f.service.refreshCredential({ clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken });
  f.setNow(30_999);
  const replay = f.service.refreshCredential({ clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken });
  expect(replay).toEqual(first);
});

test('rotation replay keeps its full window past the old refresh expiry', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  f.setNow(issued.refreshExpiresAt - 1);
  const first = f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  });
  f.setNow(issued.refreshExpiresAt + 29_998);
  expect(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  })).toEqual(first);
});

test('successful rotation immediately replaces the prior family access token', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  expect(f.service.authenticateAccessToken(issued.accessToken).status).toBe('invalid');
  expect(f.service.authenticateAccessToken(rotated.accessToken).status).toBe('valid');
});

test('replay never discloses a rotated pair to a mismatched client', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  expect(f.service.refreshCredential({ clientId: 'aio-proxy-pi', refreshToken: issued.refreshToken }))
    .toEqual({ status: 'invalid_grant', reason: 'client_mismatch', familyRevoked: false });
});

test('restart inside replay window returns invalid_grant without revoking the family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  const restarted = fixture({ sqlite: f.sqlite, now: 11_000 });
  expect(restarted.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  })).toEqual({ status: 'invalid_grant', reason: 'replay_lost', familyRevoked: false });
  expect(restarted.service.authenticateAccessToken(rotated.accessToken).status).toBe('valid');
});

test('reuse after 30 seconds revokes the entire family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  const rotated = expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  f.setNow(31_001);
  expect(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  })).toEqual({ status: 'invalid_grant', reason: 'reuse', familyRevoked: true });
  expect(f.service.authenticateAccessToken(rotated.accessToken).status).toBe('invalid');
});
```

Add the following table-driven cases in the same test file; each row names the action and exact terminal assertion so there is no inferred behavior:

```ts
test.each([
  ['access expiry', 'expire', 'expired'],
  ['explicit revoke', 'revoke', 'invalid'],
] as const)('%s removes access from the hot path', (_name, action, status) => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  if (action === 'revoke') f.service.revokeInstallation(INPUT.installationId);
  else f.setNow(901_000);
  expect(f.service.authenticateAccessToken(issued.accessToken).status).toBe(status);
});

test('refresh slides expiry to now plus 90 days and rejects a target/client mismatch', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expect(f.service.refreshCredential({ clientId: 'aio-proxy-pi', refreshToken: issued.refreshToken }))
    .toEqual({ status: 'invalid_grant', reason: 'client_mismatch', familyRevoked: false });
  f.setNow(5_000);
  const rotated = expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  expect(rotated.refreshExpiresAt).toBe(5_000 + 90 * 24 * 60 * 60_000);
});

test('relogin replaces the old family and revoke is idempotent for missing or terminal installations', () => {
  const f = fixture({ now: 1_000 });
  const first = f.service.issueCredential(INPUT);
  f.setNow(2_000);
  const second = f.service.issueCredential({ ...INPUT, adapterVersion: '1.2.4' });
  expect(f.service.authenticateAccessToken(first.accessToken).status).toBe('invalid');
  expect(f.service.authenticateAccessToken(second.accessToken).status).toBe('valid');
  expect(f.service.revokeInstallation(INPUT.installationId)).toBe('revoked');
  expect(f.service.revokeInstallation(INPUT.installationId)).toBe('revoked');
  expect(f.service.revokeInstallation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('missing');
});

test('cross-target relogin leaves the original hot grant and refresh family valid', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expect(() => f.service.issueCredential({ ...INPUT, target: 'pi' }))
    .toThrow(AgentInstallationTargetMismatchError);
  expect(f.service.authenticateAccessToken(issued.accessToken)).toMatchObject({
    status: 'valid', grant: { target: 'opencode' },
  });
  expect(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }).status).toBe('success');
  expect(f.service.listInstallations()).toEqual([
    expect.objectContaining({ installationId: INPUT.installationId, target: 'opencode' }),
  ]);
});

test('cleanup retains consumed refresh evidence through its expiry and later removes the terminal family', () => {
  const f = fixture({ now: 1_000 });
  const issued = f.service.issueCredential(INPUT);
  expectRefreshSuccess(f.service.refreshCredential({
    clientId: 'aio-proxy-opencode', refreshToken: issued.refreshToken,
  }));
  const oldHash = hashAgentToken(issued.refreshToken);
  f.setNow(issued.refreshExpiresAt - 1);
  f.service.issueCredential({
    installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: 'pi', adapterVersion: '1.2.3',
  });
  expect(f.sqlite.query('SELECT consumed_at FROM agent_refresh_token WHERE token_hash = ?').get(oldHash))
    .toMatchObject({ consumed_at: 1_000 });
  expect(f.sqlite.query('SELECT COUNT(*) AS count FROM agent_access_token WHERE expires_at <= ?')
    .get(issued.refreshExpiresAt - 1)).toEqual({ count: 0 });

  f.setNow(issued.refreshExpiresAt + 90 * 24 * 60 * 60_000 + 1);
  f.service.issueCredential({
    installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target: 'omp', adapterVersion: '1.2.3',
  });
  expect(f.sqlite.query('SELECT * FROM agent_refresh_token WHERE token_hash = ?').get(oldHash)).toBeNull();
});
```

The `restart inside replay window` test is the receive→persist crash simulation: the old token gets `replay_lost` without a family revocation, while a later use beyond 30 seconds fails closed.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test packages/core/src/agent-identity/agent-identity.test.ts`

Expected: FAIL because `createAgentIdentityService` does not exist.

- [ ] **Step 3: Implement token generation, hashing, and result types**

```ts
// packages/core/src/agent-identity/tokens.ts
import { createHash, randomBytes } from 'node:crypto';
import { AGENT_ACCESS_TOKEN_PREFIX, AGENT_REFRESH_TOKEN_PREFIX } from '@aio-proxy/types';

export const hashAgentToken = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');

export const createAgentToken = (
  kind: 'access' | 'refresh', random: (size: number) => Buffer = randomBytes,
): string => `${kind === 'access' ? AGENT_ACCESS_TOKEN_PREFIX : AGENT_REFRESH_TOKEN_PREFIX}${random(32).toString('base64url')}`;
```

Define these result types verbatim; `IssuedAgentCredential` is the only plaintext return boundary:

```ts
export type AgentCredentialIssueInput = {
  readonly installationId: string; readonly target: AgentTarget; readonly adapterVersion: string;
};
export type AgentRefreshInput = {
  readonly clientId: (typeof AGENT_CLIENT_ID)[AgentTarget]; readonly refreshToken: string;
};
export type AgentAccessGrant = {
  readonly tokenHash: string; readonly familyId: string; readonly installationId: string;
  readonly target: AgentTarget; readonly expiresAt: number;
};
export type AgentAccessAuthentication =
  | { readonly status: 'valid'; readonly grant: AgentAccessGrant }
  | { readonly status: 'invalid' | 'expired' };
export type IssuedAgentCredential = {
  readonly accessToken: string; readonly refreshToken: string;
  readonly expiresIn: 900; readonly accessExpiresAt: number; readonly refreshExpiresAt: number;
};
export type AgentRefreshResult =
  | ({ readonly status: 'success' } & IssuedAgentCredential)
  | { readonly status: 'invalid_grant'; readonly reason: 'invalid' | 'client_mismatch' | 'replay_lost' | 'reuse'; readonly familyRevoked: boolean };
export type AgentRefreshSuccess = Extract<AgentRefreshResult, { readonly status: 'success' }>;
export class AgentInstallationTargetMismatchError extends Error {
  constructor() {
    super('Agent installation is already bound to another target');
    this.name = 'AgentInstallationTargetMismatchError';
  }
}
export type AgentIdentityService = {
  readonly authenticateAccessToken: (token: string) => AgentAccessAuthentication;
  readonly issueCredential: (input: AgentCredentialIssueInput) => IssuedAgentCredential;
  readonly refreshCredential: (input: AgentRefreshInput) => AgentRefreshResult;
  readonly listInstallations: () => readonly AgentInstallationSummary[];
  readonly revokeInstallation: (installationId: string) => AgentRevokeStatus;
};
type AgentIdentityOptions = {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => string;
};
```

- [ ] **Step 4: Implement the state machine around one repository**

```ts
const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
const REPLAY_MS = 30_000;
const MAX_REPLAY_RESULTS = 1_024;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export function createAgentIdentityService(sqlite: Database, options: AgentIdentityOptions = {}): AgentIdentityService {
  const now = options.now ?? Date.now;
  const repo = createAgentIdentityRepository(sqlite);
  const access = new Map(repo.loadActiveAccess(now()).map((grant) => [grant.tokenHash, grant]));
  const replay = new Map<string, { readonly until: number; readonly result: AgentRefreshSuccess }>();

  function authenticateAccessToken(token: string): AgentAccessAuthentication {
    const hash = hashAgentToken(token);
    const grant = access.get(hash);
    if (grant === undefined) return { status: 'invalid' };
    if (grant.expiresAt <= now()) { access.delete(hash); return { status: 'expired' }; }
    return { status: 'valid', grant };
  }

  function refreshCredential(input: AgentRefreshInput): AgentRefreshResult {
    const timestamp = now();
    const oldHash = hashAgentToken(input.refreshToken);
    const row = repo.readRefresh(oldHash);
    if (row === null || row.revokedAt !== null)
      return { status: 'invalid_grant', reason: 'invalid', familyRevoked: row !== null && row.revokedAt !== null };
    if (AGENT_CLIENT_ID[row.target] !== input.clientId)
      return { status: 'invalid_grant', reason: 'client_mismatch', familyRevoked: false };
    const cached = replay.get(oldHash);
    if (cached !== undefined && cached.until > timestamp) return cached.result;
    if (row.expiresAt <= timestamp)
      return { status: 'invalid_grant', reason: 'invalid', familyRevoked: false };
    if (row.consumedAt !== null) {
      if (timestamp - row.consumedAt <= REPLAY_MS)
        return { status: 'invalid_grant', reason: 'replay_lost', familyRevoked: false };
      repo.revokeFamily(row.familyId, timestamp); removeFamilyAccess(row.familyId);
      return { status: 'invalid_grant', reason: 'reuse', familyRevoked: true };
    }
    const result = rotate(row, timestamp);
    if (replay.size >= MAX_REPLAY_RESULTS) {
      const oldest = replay.keys().next().value;
      if (oldest !== undefined) replay.delete(oldest);
    }
    replay.set(oldHash, { until: timestamp + REPLAY_MS, result });
    return result;
  }

  cleanup(now());
  return { authenticateAccessToken, issueCredential, refreshCredential, listInstallations, revokeInstallation };
}
```

Complete the same closure with the credential-pair, rotation, revocation, listing, and cleanup functions below:

```ts
const makeUuid = options.randomUUID ?? crypto.randomUUID;
const makeBytes = options.randomBytes;

function createCredentialPair(timestamp: number): IssuedAgentCredential {
  return {
    accessToken: createAgentToken('access', makeBytes),
    refreshToken: createAgentToken('refresh', makeBytes),
    expiresIn: 900,
    accessExpiresAt: timestamp + ACCESS_TTL_MS,
    refreshExpiresAt: timestamp + REFRESH_TTL_MS,
  };
}

function removeFamilyAccess(familyId: string): void {
  for (const [hash, grant] of access) if (grant.familyId === familyId) access.delete(hash);
}

function cleanup(timestamp: number): void {
  for (const [hash, grant] of access) if (grant.expiresAt <= timestamp) access.delete(hash);
  for (const [hash, entry] of replay) if (entry.until <= timestamp) replay.delete(hash);
  repo.cleanup(timestamp, RETENTION_MS);
}

function issueCredential(input: AgentCredentialIssueInput): IssuedAgentCredential {
  const timestamp = now();
  const familyId = makeUuid();
  const result = createCredentialPair(timestamp);
  const issued = repo.issue({
    ...input,
    familyId,
    accessHash: hashAgentToken(result.accessToken),
    refreshHash: hashAgentToken(result.refreshToken),
    now: timestamp,
    accessExpiresAt: result.accessExpiresAt,
    refreshExpiresAt: result.refreshExpiresAt,
  });
  if (issued.status === 'target_mismatch') throw new AgentInstallationTargetMismatchError();
  for (const replaced of issued.replacedFamilyIds) removeFamilyAccess(replaced);
  access.set(hashAgentToken(result.accessToken), {
    tokenHash: hashAgentToken(result.accessToken), familyId,
    installationId: input.installationId, target: input.target, expiresAt: result.accessExpiresAt,
  });
  cleanup(timestamp);
  return result;
}

function rotate(row: StoredRefresh, timestamp: number): AgentRefreshSuccess {
  const result = createCredentialPair(timestamp);
  const nextAccessHash = hashAgentToken(result.accessToken);
  const changed = repo.rotate({
    familyId: row.familyId, currentRefreshHash: row.tokenHash,
    nextAccessHash, nextRefreshHash: hashAgentToken(result.refreshToken), now: timestamp,
    accessExpiresAt: result.accessExpiresAt, refreshExpiresAt: result.refreshExpiresAt,
  });
  if (!changed) throw new Error('agent refresh rotation lost its immediate transaction');
  removeFamilyAccess(row.familyId);
  access.set(nextAccessHash, {
    tokenHash: nextAccessHash, familyId: row.familyId,
    installationId: row.installationId, target: row.target, expiresAt: result.accessExpiresAt,
  });
  cleanup(timestamp);
  return { status: 'success', ...result };
}

function revokeInstallation(installationId: string): AgentRevokeStatus {
  const result = repo.revokeInstallation(installationId, now());
  if (result.familyId !== undefined) removeFamilyAccess(result.familyId);
  cleanup(now());
  return result.status;
}

function listInstallations(): readonly AgentInstallationSummary[] {
  return repo.listInstallations(now());
}
```

Change the construction tail to `cleanup(now())` before returning the service. `issueCredential`, successful refresh, revoke, and service construction call repository cleanup; ordinary `authenticateAccessToken` never touches SQLite. Do not add a timer. The thrown lost-transaction branch is an invariant breach, not a user-visible OAuth response: with one synchronous service writer it cannot occur, while the repository constraint still prevents a second process from minting a second successor.

- [ ] **Step 5: Run state-machine and migration tests GREEN**

Run: `bun test packages/core/src/agent-identity packages/core/src/db/migrations/migrations.test.ts`

Expected: PASS with deterministic clocks, including restart and crash-window cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent-identity packages/core/src/index.ts
git commit -m "feat(core): rotate agent credentials safely" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Private shared Device/catalog/LKG runtime

**Files:**

- Create: `packages/agent-provider/runtime/package.json`
- Create: `packages/agent-provider/runtime/tsconfig.json`
- Create: `packages/agent-provider/runtime/rslib.config.ts`
- Create: `packages/agent-provider/runtime/src/index.ts`
- Create: `packages/agent-provider/runtime/src/oauth-client/index.ts`
- Create: `packages/agent-provider/runtime/src/oauth-client/oauth-client.ts`
- Test: `packages/agent-provider/runtime/src/oauth-client/oauth-client.test.ts`
- Create: `packages/agent-provider/runtime/src/catalog-client/index.ts`
- Create: `packages/agent-provider/runtime/src/catalog-client/catalog-client.ts`
- Test: `packages/agent-provider/runtime/src/catalog-client/catalog-client.test.ts`
- Create: `packages/agent-provider/runtime/src/managed-state/index.ts`
- Create: `packages/agent-provider/runtime/src/managed-state/managed-state.ts`
- Test: `packages/agent-provider/runtime/src/managed-state/managed-state.test.ts`
- Create: `packages/agent-provider/runtime/src/single-flight/index.ts`
- Create: `packages/agent-provider/runtime/src/single-flight/single-flight.ts`
- Test: `packages/agent-provider/runtime/src/single-flight/single-flight.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: marker/state/catalog/token schemas from Task 1.
- Produces: `readManagedInstallation(importMetaUrl, expectedTarget)`, `requestDeviceAuthorization`, `pollDeviceAuthorization`, `refreshAgentCredential`, `refreshAgentCatalog`, `readLastKnownCatalog`, `createSingleFlight`, and `CATALOG_REFRESH_INTERVAL_MS = 300_000`.

Use these exact public signatures in `src/index.ts`; host adapters must not invent a second HTTP or state-file contract:

```ts
export type ManagedInstallation = {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly statePath: string;
  readonly marker: AgentManagedMarker;
};
export type AgentRuntimeRequestOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  /** Injectable clock; production host seams pass Date.now. */
  readonly now?: () => number;
  /** Injectable sleeper used by Device polling. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
};
export type RefreshCatalogInput = AgentRuntimeRequestOptions & {
  readonly marker: AgentManagedMarker;
  readonly statePath: string;
  readonly accessToken: string;
};
export type RefreshCatalogResult = {
  readonly catalog: AgentCatalogV1 | null;
  readonly source: 'network' | 'lkg' | 'missing';
  readonly status: 'fresh' | 'stale' | 'missing';
  readonly error?: AgentAdapterFailure;
};
export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentOAuthError['error'] | 'network' | 'invalid_response',
    readonly retryAfterSeconds?: number,
  ) { super(code); }
}

export declare function readManagedInstallation(
  importMetaUrl: string,
  expectedTarget: AgentTarget,
): Promise<ManagedInstallation>;
export declare function readLastKnownCatalog(
  statePath: string,
  expectedTarget: AgentTarget,
): Promise<AgentCatalogV1 | null>;
export declare function requestDeviceAuthorization(
  marker: AgentManagedMarker,
  options?: AgentRuntimeRequestOptions,
): Promise<AgentDeviceCodeResponse>;
export declare function pollDeviceAuthorization(
  marker: AgentManagedMarker,
  device: AgentDeviceCodeResponse,
  options?: AgentRuntimeRequestOptions,
): Promise<AgentTokenResponse>;
export declare function refreshAgentCredential(
  marker: AgentManagedMarker,
  refreshToken: string,
  options?: AgentRuntimeRequestOptions,
): Promise<AgentTokenResponse>;
export declare function refreshAgentCatalog(input: RefreshCatalogInput): Promise<RefreshCatalogResult>;
export declare function createSingleFlight<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult>;
```

`readManagedInstallation` checks only two fixed marker candidates: adjacent to the emitted entry and its direct parent. This supports OpenCode's root `index.js` and the Pi-family `dist/*.js` entries without scanning arbitrary ancestors.

- [ ] **Step 1: Write failing runtime tests beside the behavior they protect**

Put catalog response/LKG cases in `catalog-client/catalog-client.test.ts`, atomic state cases in
`managed-state/managed-state.test.ts`, Device/refresh cases in `oauth-client/oauth-client.test.ts`,
and the coalescing case in `single-flight/single-flight.test.ts`. Each directory's `index.ts` is
export-only. Reuse a small fixture only inside the test file that needs it; do not add a package-wide
test-support abstraction.

Place this exact local setup in `catalog-client.test.ts`; repeat it in
`managed-state.test.ts` for the atomic-state case rather than exporting test support:

```ts
import { afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCatalogV1, AgentManagedMarker, AgentManagedStateV1 } from '@aio-proxy/types';

const CATALOG: AgentCatalogV1 = {
  schema_version: 1,
  agent: 'opencode',
  models: [{
    id: 'compat-model', name: 'Compat Model', reasoning: false, tool_call: true,
    temperature: false, attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048,
  }],
};
const RUNTIME_MARKER = {
  format: 1, managedBy: 'aio-proxy', agent: 'opencode',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;
const runtimeRoots: string[] = [];

afterEach(() => {
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const freshState = (lkg: AgentCatalogV1, now: number): AgentManagedStateV1 => ({
  format: 1, catalogSchema: 1, status: 'fresh',
  lastSuccessfulAt: new Date(now).toISOString(), lastError: null, lkg,
});

function runtimeFixture(options: { readonly lkg?: AgentCatalogV1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-runtime-'));
  runtimeRoots.push(root);
  const statePath = join(root, '.aio-proxy-state.json');
  if (options.lkg !== undefined) {
    writeFileSync(statePath, JSON.stringify(freshState(options.lkg, 1_000)), { mode: 0o600 });
  }
  return {
    statePath,
    input: { marker: RUNTIME_MARKER, statePath, accessToken: 'agent-access' },
    readState: (): AgentManagedStateV1 => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}
```

```ts
test('catalog success validates before atomically replacing LKG', async () => {
  const f = runtimeFixture();
  const result = await refreshAgentCatalog({ ...f.input, fetch: async () => Response.json(CATALOG) });
  expect(result).toEqual({ catalog: CATALOG, source: 'network', status: 'fresh' });
  expect(JSON.parse(await Bun.file(f.statePath).text())).toMatchObject({ status: 'fresh', lastError: null });
});

test('401 never retries anonymously and never overwrites LKG', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const calls: Headers[] = [];
  const result = await refreshAgentCatalog({ ...f.input, fetch: async (_url, init) => {
    calls.push(new Headers(init?.headers)); return new Response('', { status: 401 });
  }});
  expect(calls).toHaveLength(1);
  expect(calls[0]?.get('authorization')).toBe('Bearer agent-access');
  expect(result).toMatchObject({ catalog: CATALOG, source: 'lkg', status: 'stale', error: 'unauthorized' });
});

test('single-flight shares one rotating refresh result', async () => {
  let calls = 0;
  const run = createSingleFlight(async () => { calls += 1; return 'rotated'; });
  expect(await Promise.all([run(), run(), run()])).toEqual(['rotated', 'rotated', 'rotated']);
  expect(calls).toBe(1);
});

test('single-flight clears a rejected operation so the next call can retry', async () => {
  let calls = 0;
  const run = createSingleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error('first');
    return 'recovered';
  });
  await expect(Promise.all([run(), run()])).rejects.toThrow('first');
  await expect(run()).resolves.toBe('recovered');
  expect(calls).toBe(2);
});
```

Append these table-driven assertions to the same test file:

```ts
test.each([
  ['malformed json', async () => new Response('{', { status: 200 }), 'invalid_json'],
  ['server failure', async () => new Response('', { status: 503 }), 'server_error'],
  ['network failure', async () => { throw new TypeError('offline'); }, 'network'],
] as const)('%s preserves LKG', async (_name, fetch, error) => {
  const f = runtimeFixture({ lkg: CATALOG });
  expect(await refreshAgentCatalog({ ...f.input, fetch })).toMatchObject({
    catalog: CATALOG, source: 'lkg', status: 'stale', error,
  });
});

test('a real 400 unsupported-schema body has its stable category and preserves LKG', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const result = await refreshAgentCatalog({ ...f.input, fetch: async () => Response.json({
    error: { code: 'unsupported_schema', message: 'Catalog schema 1 is not supported.' },
    supported_schema_versions: [2],
  }, { status: 400 }) });
  expect(result).toMatchObject({
    catalog: CATALOG, source: 'lkg', status: 'stale', error: 'unsupported_schema',
  });
  expect(f.readState().lkg).toEqual(CATALOG);
});

test('wrong target never replaces state', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  await refreshAgentCatalog({ ...f.input, fetch: async () => Response.json({ ...CATALOG, agent: 'pi' }) });
  expect(f.readState().lkg).toEqual(CATALOG);
});

test('missing LKG remains missing after a failed refresh', async () => {
  const f = runtimeFixture();
  expect(await refreshAgentCatalog({ ...f.input, fetch: async () => new Response('', { status: 503 }) }))
    .toEqual({ catalog: null, source: 'missing', status: 'missing', error: 'server_error' });
});

test('atomic state failure leaves the prior bytes and successful replacement is private', async () => {
  const f = runtimeFixture({ lkg: CATALOG });
  const before = await Bun.file(f.statePath).bytes();
  await expect(writeManagedState(f.statePath, freshState(CATALOG, 2_000), {
    rename: async () => { throw new Error('injected rename failure'); },
  })).rejects.toThrow('injected rename failure');
  expect(await Bun.file(f.statePath).bytes()).toEqual(before);
  await writeManagedState(f.statePath, freshState(CATALOG, 2_000));
  expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
});

test('device polling follows pending and slow_down without changing identity fields', async () => {
  const f = oauthFixture([
    jsonError(400, 'authorization_pending'),
    jsonError(400, 'slow_down'),
    Response.json(TOKEN),
  ]);
  await expect(pollDeviceAuthorization(f.marker, DEVICE, {
    fetch: f.fetch, sleep: f.sleep, now: f.now,
  })).resolves.toEqual(TOKEN);
  expect(f.sleeps).toEqual([5_000, 5_000, 10_000]);
  expect(f.events).toEqual([
    'sleep:5000', 'fetch', 'sleep:5000', 'fetch', 'sleep:10000', 'fetch',
  ]);
  expect(f.forms).toEqual([
    { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'aio-proxy-opencode', device_code: DEVICE.device_code },
    { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'aio-proxy-opencode', device_code: DEVICE.device_code },
    { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'aio-proxy-opencode', device_code: DEVICE.device_code },
  ]);
});

test.each(['access_denied', 'expired_token'] as const)('device polling stops on %s', async (code) => {
  const f = oauthFixture([jsonError(400, code)]);
  await expect(pollDeviceAuthorization(f.marker, DEVICE, {
    fetch: f.fetch, sleep: f.sleep, now: f.now,
  })).rejects.toMatchObject({ code });
});

test('refresh sends one fixed-client form and parses the token response', async () => {
  const f = oauthFixture([Response.json(TOKEN)]);
  await expect(refreshAgentCredential(f.marker, 'aio_agent_rt_v1_old', { fetch: f.fetch }))
    .resolves.toEqual(TOKEN);
  expect(f.forms).toEqual([{
    grant_type: 'refresh_token', client_id: 'aio-proxy-opencode', refresh_token: 'aio_agent_rt_v1_old',
  }]);
});

test('device response cannot redirect approval away from the marker origin', async () => {
  await expect(requestDeviceAuthorization(MARKER, {
    fetch: async () => Response.json({
      ...DEVICE,
      verification_uri: 'https://attacker.example/approve',
      verification_uri_complete: 'https://attacker.example/approve#code=ABCD-EFGH',
    }),
  })).rejects.toMatchObject({ code: 'invalid_response' });
});
```

Place these definitions above the OAuth tests:

```ts
const MARKER = {
  format: 1, managedBy: 'aio-proxy', agent: 'opencode',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;
const TOKEN = {
  token_type: 'Bearer', access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`, expires_in: 900,
} as const;
const DEVICE = {
  device_code: 'd'.repeat(43), user_code: 'ABCD-EFGH',
  verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
  verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
  expires_in: 600, interval: 5,
} as const;

const jsonError = (status: number, error: AgentOAuthError['error']): Response =>
  Response.json({ error }, { status });

function oauthFixture(responses: Response[]) {
  let timestamp = 1_000;
  const forms: Array<Record<string, string>> = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  return {
    marker: MARKER,
    forms,
    sleeps,
    events,
    now: () => timestamp,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds); events.push(`sleep:${milliseconds}`); timestamp += milliseconds;
    },
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push('fetch');
      forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected OAuth request');
      return response;
    },
  };
}
```

`writeManagedState` accepts a private optional `{ rename }` dependency used only by the atomic-failure test; its production default is `node:fs/promises.rename`.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun run --filter @aio-proxy/agent-provider-runtime test:unit`

Expected: FAIL because the private workspace package does not exist.

- [ ] **Step 3: Create the private package and concrete functions**

```json
{
  "name": "@aio-proxy/agent-provider-runtime",
  "version": "0.8.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "rslib", "test": "bun run test:unit", "test:unit": "bun test" },
  "dependencies": { "@aio-proxy/types": "workspace:*" },
  "devDependencies": { "@aio-proxy/infra": "workspace:*", "@rslib/core": "catalog:", "@types/bun": "catalog:", "typescript": "catalog:" }
}
```

Use the same bundled ESM build contract as the two delivery packages. The
runtime is bundled into those artifacts, while its own build remains the
type/artifact boundary checked by this task:

```ts
// packages/agent-provider/runtime/rslib.config.ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [{
    id: 'runtime',
    format: 'esm',
    bundle: true,
    autoExternal: false,
    dts: true,
    source: { entry: { index: './src/index.ts' } },
    output: { distPath: { root: './dist' } },
  }],
});
```

```json
{
  "extends": "@aio-proxy/infra/tsconfig/base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["bun"] },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Implement the managed marker/state file directly; these functions are the only file-system code in the shared runtime:

```ts
// packages/agent-provider/runtime/src/managed-state/managed-state.ts
import { open, readFile, rename as nodeRename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  type AgentCatalogV1,
  type AgentManagedMarker,
  type AgentManagedStateV1,
  type AgentTarget,
} from '@aio-proxy/types';
import { AgentRuntimeError } from '../oauth-client';

export type ManagedInstallation = {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly statePath: string;
  readonly marker: AgentManagedMarker;
};

export async function readManagedInstallation(
  importMetaUrl: string,
  expectedTarget: AgentTarget,
): Promise<ManagedInstallation> {
  const entryDir = dirname(fileURLToPath(importMetaUrl));
  for (const rootDir of [entryDir, dirname(entryDir)]) {
    const markerPath = join(rootDir, '.aio-proxy-managed.json');
    let body: unknown;
    try { body = JSON.parse(await readFile(markerPath, 'utf8')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new AgentRuntimeError('invalid_response');
    }
    const parsed = AgentManagedMarkerSchema.safeParse(body);
    if (!parsed.success || parsed.data.agent !== expectedTarget)
      throw new AgentRuntimeError('invalid_response');
    return {
      rootDir,
      markerPath,
      statePath: join(rootDir, '.aio-proxy-state.json'),
      marker: parsed.data,
    };
  }
  throw new AgentRuntimeError('invalid_response');
}

export async function readManagedState(statePath: string): Promise<AgentManagedStateV1 | null> {
  try {
    const parsed = AgentManagedStateV1Schema.safeParse(JSON.parse(await readFile(statePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readLastKnownCatalog(
  statePath: string,
  expectedTarget: AgentTarget,
): Promise<AgentCatalogV1 | null> {
  const state = await readManagedState(statePath);
  return state?.lkg?.agent === expectedTarget ? state.lkg : null;
}

export async function writeManagedState(
  statePath: string,
  state: AgentManagedStateV1,
  deps: { readonly rename?: typeof nodeRename } = {},
): Promise<void> {
  const parsed = AgentManagedStateV1Schema.parse(state);
  const parent = dirname(statePath);
  const temporary = join(parent, `.${basename(statePath)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await (deps.rename ?? nodeRename)(temporary, statePath);
    const directory = await open(parent, 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}
```

`ManagedInstallation` is imported from this file by the package barrel. The dependency is one-way because the OAuth client does not import managed state.

Implement every OAuth request through this one form helper:

```ts
// packages/agent-provider/runtime/src/oauth-client/oauth-client.ts
import {
  AGENT_CLIENT_ID,
  AgentDeviceCodeResponseSchema,
  AgentOAuthErrorSchema,
  AgentTokenResponseSchema,
  type AgentDeviceCodeResponse,
  type AgentManagedMarker,
  type AgentOAuthError,
  type AgentTokenResponse,
} from '@aio-proxy/types';

export type AgentRuntimeRequestOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentOAuthError['error'] | 'network' | 'invalid_response',
    readonly retryAfterSeconds?: number,
  ) { super(code); }
}

async function postForm(
  endpoint: string,
  path: string,
  body: Readonly<Record<string, string>>,
  options: AgentRuntimeRequestOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(new URL(path, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    if (options.signal?.aborted === true) throw options.signal.reason;
    throw new AgentRuntimeError('network');
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new AgentRuntimeError('invalid_response'); }
  if (!response.ok) {
    const error = AgentOAuthErrorSchema.safeParse(payload);
    if (!error.success) throw new AgentRuntimeError('invalid_response');
    throw new AgentRuntimeError(error.data.error);
  }
  return payload;
}

export async function requestDeviceAuthorization(
  marker: AgentManagedMarker,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentDeviceCodeResponse> {
  const body = await postForm(marker.endpoint, '/oauth/device/code', {
    client_id: AGENT_CLIENT_ID[marker.agent],
    agent: marker.agent,
    installation_id: marker.installationId,
    adapter_version: marker.adapterVersion,
  }, options);
  const parsed = AgentDeviceCodeResponseSchema.safeParse(body);
  if (!parsed.success) throw new AgentRuntimeError('invalid_response');
  validateDeviceAuthorizationUrls(marker, parsed.data);
  return parsed.data;
}

async function requestToken(
  marker: AgentManagedMarker,
  body: Readonly<Record<string, string>>,
  options: AgentRuntimeRequestOptions,
): Promise<AgentTokenResponse> {
  const payload = await postForm(marker.endpoint, '/oauth/token', body, options);
  const parsed = AgentTokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AgentRuntimeError('invalid_response');
  return parsed.data;
}

export async function pollDeviceAuthorization(
  marker: AgentManagedMarker,
  device: AgentDeviceCodeResponse,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentTokenResponse> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + device.expires_in * 1_000;
  let intervalSeconds: number = device.interval;
  const form = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: AGENT_CLIENT_ID[marker.agent],
    device_code: device.device_code,
  } as const;
  while (now() < deadline) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    await sleep(intervalSeconds * 1_000);
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (now() >= deadline) break;
    try {
      return await requestToken(marker, form, options);
    } catch (error) {
      if (!(error instanceof AgentRuntimeError)) throw error;
      if (error.code !== 'authorization_pending' && error.code !== 'slow_down') throw error;
      if (error.code === 'slow_down') intervalSeconds += 5;
    }
  }
  throw new AgentRuntimeError('expired_token');
}

export function refreshAgentCredential(
  marker: AgentManagedMarker,
  refreshToken: string,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentTokenResponse> {
  return requestToken(marker, {
    grant_type: 'refresh_token',
    client_id: AGENT_CLIENT_ID[marker.agent],
    refresh_token: refreshToken,
  }, options);
}
```

`src/index.ts` contains only explicit exports of the signatures listed in the
Interfaces block. Do not export `writeManagedState`, its file-system dependency
seam, or a host abstraction.

Implement `single-flight/single-flight.ts` with one extension-instance flight and
clear it on both fulfillment and rejection:

```ts
export function createSingleFlight<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  let active: Promise<TResult> | undefined;
  return (...args) => {
    active ??= Promise.resolve()
      .then(() => operation(...args))
      .finally(() => { active = undefined; });
    return active;
  };
}
```

Use `URLSearchParams` for all OAuth bodies and `AgentCatalogV1Schema.safeParse` before any state write. Parse non-success 400 responses with `AgentCatalogErrorSchema`; only `error.code === 'unsupported_schema'` maps to `unsupported_schema`, while an unrecognized 400 remains `server_error`. State replacement uses a sibling temporary file opened with mode `0o600`, `file.sync()`, rename, then parent-directory sync where supported. Persist only the fixed failure category, never caught error text. `requestDeviceAuthorization` binds `AGENT_CLIENT_ID[marker.agent]`, `marker.agent`, `marker.installationId`, and `marker.adapterVersion`; `pollDeviceAuthorization` and `refreshAgentCredential` reuse that same fixed client ID.

After `AgentDeviceCodeResponseSchema` parsing, `requestDeviceAuthorization` additionally validates the returned URLs with this exact helper before returning them:

```ts
function validateDeviceAuthorizationUrls(marker: AgentManagedMarker, device: AgentDeviceCodeResponse): void {
  const expected = new URL('/dashboard/agents/authorize', marker.endpoint);
  const base = new URL(device.verification_uri);
  const complete = new URL(device.verification_uri_complete);
  const fragment = new URLSearchParams(complete.hash.slice(1));
  const completeCode = fragment.get('code');
  const valid = base.origin === expected.origin && base.pathname === expected.pathname &&
    base.username === '' && base.password === '' && base.search === '' && base.hash === '' &&
    complete.origin === expected.origin && complete.pathname === expected.pathname &&
    complete.username === '' && complete.password === '' && complete.search === '' &&
    completeCode === device.user_code && [...fragment.keys()].length === 1;
  if (!valid) throw new AgentRuntimeError('invalid_response');
}
```

```ts
export const CATALOG_REFRESH_INTERVAL_MS = 300_000;

export async function refreshAgentCatalog(input: RefreshCatalogInput): Promise<RefreshCatalogResult> {
  const url = new URL('/v1/models', input.marker.endpoint);
  url.search = new URLSearchParams({
    agent: input.marker.agent, adapter_version: input.marker.adapterVersion, schema_version: '1',
  }).toString();
  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throwIfAborted(input.signal);
    return preserveLkg(input, 'network');
  }
  if (response.status === 401) return preserveLkg(input, 'unauthorized');
  if (response.status === 400) {
    const error = AgentCatalogErrorSchema.safeParse(await response.json().catch(() => null));
    if (error.success && error.data.error.code === 'unsupported_schema')
      return preserveLkg(input, 'unsupported_schema');
  }
  if (!response.ok) return preserveLkg(input, 'server_error');
  let body: unknown;
  try { body = await response.json(); }
  catch {
    throwIfAborted(input.signal);
    return preserveLkg(input, 'invalid_json');
  }
  const parsed = AgentCatalogV1Schema.safeParse(body);
  if (!parsed.success || parsed.data.agent !== input.marker.agent)
    return preserveLkg(input, 'invalid_catalog');
  const timestamp = new Date((input.now ?? Date.now)()).toISOString();
  await writeManagedState(input.statePath, {
    format: 1, catalogSchema: 1, status: 'fresh',
    lastSuccessfulAt: timestamp, lastError: null, lkg: parsed.data,
  });
  return { catalog: parsed.data, source: 'network', status: 'fresh' };
}
```

Use this failure path; call `throwIfAborted(input.signal)` in each `catch` before classifying it as a network/JSON failure:

```ts
async function preserveLkg(
  input: RefreshCatalogInput,
  error: AgentAdapterFailure,
): Promise<RefreshCatalogResult> {
  const previous = await readManagedState(input.statePath);
  const lkg = previous?.lkg?.agent === input.marker.agent ? previous.lkg : null;
  if (lkg !== null) {
    await writeManagedState(input.statePath, {
      ...previous!, status: 'stale', lastError: error, lkg,
    });
    return { catalog: lkg, source: 'lkg', status: 'stale', error };
  }
  await writeManagedState(input.statePath, {
    format: 1, catalogSchema: 1, status: 'missing',
    lastSuccessfulAt: null, lastError: error, lkg: null,
  });
  return { catalog: null, source: 'missing', status: 'missing', error };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}
```

Keep host credential reads/writes and model registration out of this package.

- [ ] **Step 4: Run package tests and build**

Run: `bun install && bun run --filter @aio-proxy/agent-provider-runtime test:unit && bun run --filter @aio-proxy/agent-provider-runtime build`

Expected: PASS; `dist/` contains no OpenCode, Pi, or OMP import.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-provider/runtime bun.lock
git commit -m "feat: share agent provider protocol runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Server-state identity wiring and composite model authentication

**Files:**

- Create: `packages/core/src/db/ownership-lock/index.ts`
- Create: `packages/core/src/db/ownership-lock/ownership-lock.ts`
- Test: `packages/core/src/db/ownership-lock/ownership-lock.test.ts`
- Modify: `packages/core/src/db/open-db.ts`
- Modify: `packages/core/src/db/index.ts`
- Create: `packages/server/src/server/agent-auth/index.ts`
- Create: `packages/server/src/server/agent-auth/agent-auth.ts`
- Test: `packages/server/src/server/agent-auth/agent-auth.test.ts`
- Test: `packages/server/src/server-state/database-ownership.test.ts`
- Test: `packages/server/src/server/server-lifecycle.test.ts`
- Modify: `packages/server/src/server-state/types.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/server-state/lifecycle.ts`
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/api-key-auth/api-key-auth.ts`
- Modify: `packages/server/src/server/api-key-auth/api-key-auth.test.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/__tests__/setup.ts`
- Create: `packages/server/__tests__/server-test-lifecycle.ts`
- Modify: `packages/cli/src/run/run.ts`
- Test: `packages/cli/__tests__/run-lifecycle.test.ts`

The ownership change also modifies the following exact current test/import set so no legacy fixture leaves a live default-path `ServerState`. These are mechanical value-import migrations to `#server-test-lifecycle`; type-only imports remain on production modules:

```text
packages/server/__tests__/anthropic-messages-failures.test.ts
packages/server/__tests__/anthropic-messages-failures.validation.test.ts
packages/server/__tests__/anthropic-messages-model.stream.test.ts
packages/server/__tests__/anthropic-messages-model.test.ts
packages/server/__tests__/anthropic-messages-native.test.ts
packages/server/__tests__/config-store-queue.oauth.test.ts
packages/server/__tests__/config-store-reconciliation.oauth.close.test.ts
packages/server/__tests__/config-store-reconciliation.oauth.retry.test.ts
packages/server/__tests__/config-store-reconciliation.oauth.test.ts
packages/server/__tests__/config-store.test.ts
packages/server/__tests__/cross-protocol-routing.test.ts
packages/server/__tests__/dashboard-provider-options-schema.install.test.ts
packages/server/__tests__/dashboard-provider-options-schema.test.ts
packages/server/__tests__/dashboard-providers-mutation.oauth.pending.test.ts
packages/server/__tests__/dashboard-providers-mutation.oauth.test.ts
packages/server/__tests__/dashboard-providers-mutation.test-support.ts
packages/server/__tests__/dashboard-static.diagnostics.test.ts
packages/server/__tests__/dashboard-static.test.ts
packages/server/__tests__/gemini-generate-content-native.test.ts
packages/server/__tests__/gemini-generate-content.test-support.ts
packages/server/__tests__/gemini-missing-provider.test.ts
packages/server/__tests__/openai-completions-boundaries.provider-missing.test.ts
packages/server/__tests__/openai-completions-boundaries.test.ts
packages/server/__tests__/openai-completions-errors.test.ts
packages/server/__tests__/openai-completions-fallback.routing.test.ts
packages/server/__tests__/openai-completions-fallback.test.ts
packages/server/__tests__/openai-completions-model-stream.model-selection.test.ts
packages/server/__tests__/openai-completions-model-stream.test.ts
packages/server/__tests__/openai-completions-native.aborts.test.ts
packages/server/__tests__/openai-completions-native.alias.test.ts
packages/server/__tests__/openai-completions-native.test.ts
packages/server/__tests__/openai-completions-usage.response.test.ts
packages/server/__tests__/openai-completions-usage.slow-catalog.test.ts
packages/server/__tests__/openai-completions-usage.test.ts
packages/server/__tests__/openai-responses-missing-provider.test.ts
packages/server/__tests__/openai-responses-model.reasoning.test.ts
packages/server/__tests__/openai-responses-model.test.ts
packages/server/__tests__/openai-responses-model.tools.test.ts
packages/server/__tests__/openai-responses-native.failover.test.ts
packages/server/__tests__/openai-responses-native.test.ts
packages/server/__tests__/plugin-snapshot/catalog.test.ts
packages/server/__tests__/plugin-snapshot/isolation-diagnostics.test.ts
packages/server/__tests__/plugin-snapshot/isolation-storage.test.ts
packages/server/__tests__/plugin-snapshot/isolation.test.ts
packages/server/__tests__/plugin-snapshot/lease-removal.test.ts
packages/server/__tests__/plugin-snapshot/recovery-close.test.ts
packages/server/__tests__/plugin-snapshot/recovery-deadline.test.ts
packages/server/__tests__/plugin-snapshot/recovery.test.ts
packages/server/__tests__/plugin-snapshot/reload-recovery.test.ts
packages/server/__tests__/plugin-snapshot/reload-serialization.test.ts
packages/server/__tests__/plugin-snapshot/reload.test.ts
packages/server/__tests__/provider-ordering.test.ts
packages/server/__tests__/server-health-models.aliases.test.ts
packages/server/__tests__/server-health-models.test.ts
packages/server/__tests__/server-model-ordering.listing-edge-cases.test.ts
packages/server/__tests__/server-model-ordering.test.ts
packages/server/__tests__/server-plugin-install.test.ts
packages/server/__tests__/server-provider-probe.probe-detail.test.ts
packages/server/__tests__/server-provider-probe.protocol-cap.test.ts
packages/server/__tests__/server-provider-probe.test.ts
packages/server/__tests__/server-reload.invalid-provider.test.ts
packages/server/__tests__/server-reload.oauth.test.ts
packages/server/__tests__/server-reload.test.ts
packages/server/__tests__/usage-dashboard.test.ts
packages/server/src/dashboard-auth/dashboard-auth.test.ts
packages/server/src/dashboard-auth/password-integration.test.ts
packages/server/src/dashboard-routes/config-network.test.ts
packages/server/src/dashboard-routes/events/events.test.ts
packages/server/src/dashboard-routes/oauth-capabilities.test.ts
packages/server/src/dashboard-routes/oauth-login.test.ts
packages/server/src/dashboard-routes/oauth-provider-edit.test.ts
packages/server/src/dashboard-routes/overview/overview.test.ts
packages/server/src/dashboard-routes/plugins/plugins.test.ts
packages/server/src/dashboard-routes/provider-draft/provider-draft.test.ts
packages/server/src/dashboard-routes/provider-enable/provider-enable.test.ts
packages/server/src/dashboard-routes/settings/settings.test.ts
packages/server/src/dashboard-routes/traces/traces.test.ts
packages/server/src/plugin-runtime/materialize.test.ts
packages/server/src/provider-runtime/materialize.test.ts
packages/server/src/routes/openai-responses-fallback.integration.test.ts
packages/server/src/routes/openai-responses-model.integration.test.ts
packages/server/src/routes/openai-responses-observability.test.ts
packages/server/src/routes/openai-responses-raw.integration.test.ts
packages/server/src/routes/openai-responses-unsupported.test.ts
packages/server/src/routes/token-count/anthropic-messages-count-tokens.test.ts
packages/server/src/server-state/oauth-quota.test.ts
packages/server/src/server/admin-reload.test.ts
packages/server/src/server/server-config.test.ts
packages/server/src/server/server.models.test.ts
```

**Interfaces:**

- Consumes: `createAgentIdentityService` from Task 3 and the existing `process-identity`/`recovery-fence` primitives already used by config/npm locks.
- Produces: `resolveDbPath(options): string`, `DatabaseOwnershipError`, `acquireDatabaseOwnershipLock(databasePath, options?): Promise<DatabaseOwnershipLock>` where `release(): void` is synchronous and idempotent, `ServerState.agentIdentity`, Hono variable `agentGrant?: AgentAccessGrant`, `requireModelAuthentication({ apiKeys, authenticateAgent })`, and an internal `CreateServerOptions.__test?: ServerStateTestHooks` pass-through used by HTTP tests.

```ts
export type DatabaseOwnershipLock = {
  readonly databasePath: string;
  readonly release: () => void;
};
export class DatabaseOwnershipError extends Error {
  constructor(readonly databasePath: string) {
    super(`Another aio-proxy server owns database: ${databasePath}`);
  }
}
export class DatabaseOwnershipPathError extends Error {
  constructor(readonly databasePath: string, readonly reason: 'symlink' | 'hardlink') {
    super(`Unsafe aio-proxy database path (${reason}): ${databasePath}`);
  }
}
export declare function acquireDatabaseOwnershipLock(
  databasePath: string,
  options?: { readonly waitMs?: number },
): Promise<DatabaseOwnershipLock>;
```

- [ ] **Step 1: Write failing database-ownership lifecycle tests**

```ts
// packages/core/src/db/ownership-lock/ownership-lock.test.ts
import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveDbPath } from '../open-db';
import {
  acquireDatabaseOwnershipLock,
  DatabaseOwnershipError,
} from './ownership-lock';

test('one normalized database path has one owner and synchronous release permits immediate reacquire', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-db-owner-'));
  const path = resolveDbPath({ home });
  const first = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  await expect(acquireDatabaseOwnershipLock(path, { waitMs: 25 }))
    .rejects.toBeInstanceOf(DatabaseOwnershipError);
  first.release();
  const second = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  second.release();
});

test('a dead PID/starttime generation is recovered under the existing recovery fence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-db-stale-owner-'));
  const path = resolveDbPath({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.server.lock`, JSON.stringify({
    version: 1, pid: 2_147_483_647, starttime: 'dead', owner: crypto.randomUUID(), createdAt: 0,
  }), { mode: 0o600 });
  const recovered = await acquireDatabaseOwnershipLock(path, { waitMs: 250 });
  recovered.release();
});

test('a first start creates a private missing database parent before exclusive lock creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-db-new-parent-'));
  const path = resolveDbPath({ home: join(root, 'nested', 'db-home') });
  const ownership = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  expect(lstatSync(dirname(path)).isDirectory()).toBe(true);
  if (process.platform !== 'win32') expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
  ownership.release();
  expect(existsSync(`${path}.server.lock`)).toBe(false);
});

test('parent-directory aliases resolve to one canonical database owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-db-parent-alias-'));
  const realHome = join(root, 'real');
  const aliasHome = join(root, 'alias');
  mkdirSync(realHome, { recursive: true });
  symlinkSync(realHome, aliasHome, 'dir');
  const first = await acquireDatabaseOwnershipLock(resolveDbPath({ home: realHome }), { waitMs: 25 });
  expect(first.databasePath).toBe(join(realpathSync(realHome), 'aio-proxy.db'));
  await expect(acquireDatabaseOwnershipLock(resolveDbPath({ home: aliasHome }), { waitMs: 25 }))
    .rejects.toBeInstanceOf(DatabaseOwnershipError);
  first.release();
});

test.each(['symlink', 'hardlink'] as const)('rejects a database-file %s alias', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), `aio-proxy-db-${kind}-`));
  const home = join(root, 'home');
  const other = join(root, 'other.db');
  mkdirSync(home, { recursive: true });
  writeFileSync(other, '');
  const path = resolveDbPath({ home });
  if (kind === 'symlink') symlinkSync(other, path, 'file');
  else linkSync(other, path);
  await expect(acquireDatabaseOwnershipLock(path, { waitMs: 25 }))
    .rejects.toMatchObject({ reason: kind });
});
```

```ts
// packages/server/src/server-state/database-ownership.test.ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseOwnershipError, resolveDbPath } from '@aio-proxy/core/db';
import { ConfigSchema } from '@aio-proxy/types';
import { createServerState } from './index';
import type { InternalServerStateOptions } from './types';

test('normal close and initialization failure both release database ownership immediately', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-owner-'));
  const failing = {
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: home,
    __test: { createRouter: () => { throw new Error('injected initialization failure'); } },
  } satisfies InternalServerStateOptions;
  await expect(createServerState(failing)).rejects.toThrow('injected initialization failure');

  const first = await createServerState({
    config: failing.config, dbHome: home, providerInstances: [],
  });
  await expect(createServerState({
    config: failing.config, dbHome: home, providerInstances: [],
  })).rejects.toBeInstanceOf(DatabaseOwnershipError);
  first.close();

  const restarted = await createServerState({
    config: failing.config, dbHome: home, providerInstances: [],
  });
  restarted.close();
});

test('a failed first start in a missing nested dbHome leaves no live ownership generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-server-new-owner-'));
  const home = join(root, 'nested', 'db-home');
  const config = ConfigSchema.parse({ providers: {} });
  await expect(createServerState({
    config, dbHome: home,
    __test: { createRouter: () => { throw new Error('injected first-start failure'); } },
  } satisfies InternalServerStateOptions)).rejects.toThrow('injected first-start failure');
  const databasePath = resolveDbPath({ home });
  expect(existsSync(`${databasePath}.server.lock`)).toBe(false);
  const restarted = await createServerState({ config, dbHome: home, providerInstances: [] });
  restarted.close();
});

test.each(['scheduler', 'recovery', 'login_sessions', 'watcher'] as const)(
  'failure after %s unwinds startup resources and permits immediate restart', async (failStartupAfter) => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-startup-unwind-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    const config = ConfigSchema.parse({ providers: {} });
    await expect(createServerState({
      config, configPath, dbHome: home,
      __test: { failStartupAfter },
    } satisfies InternalServerStateOptions)).rejects.toThrow(`injected startup failure: ${failStartupAfter}`);
    expect(existsSync(`${resolveDbPath({ home })}.server.lock`)).toBe(false);
    const restarted = await createServerState({ config, configPath, dbHome: home, providerInstances: [] });
    restarted.close();
  },
);
```

```ts
// packages/server/src/server/server-lifecycle.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server';

test('createServer exposes idempotent close and route-assembly failure closes state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-app-close-'));
  const first = await createServer({ config: { providers: {} }, dbHome: home });
  first.close();
  first.close();
  const second = await createServer({ config: { providers: {} }, dbHome: home });
  second.close();

  await expect(createServer({
    config: { providers: {} }, dbHome: home,
    __test: { createRoutes: () => { throw new Error('injected route assembly failure'); } },
  })).rejects.toThrow('injected route assembly failure');
  const afterFailure = await createServer({ config: { providers: {} }, dbHome: home });
  afterFailure.close();
});
```

```ts
// packages/cli/__tests__/run-lifecycle.test.ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRunArgs, freePort, repoCwd, waitForOk } from './cli-test-helpers';

test.each(['SIGINT', 'SIGTERM'] as const)('%s closes the app before the CLI exits', async (signal) => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-run-close-'));
  const port = freePort();
  const start = () => Bun.spawn(cliRunArgs(port), {
    cwd: repoCwd,
    env: { ...process.env, AIO_PROXY_HOME: home },
    stderr: 'ignore', stdout: 'ignore',
  });
  const first = start();
  await waitForOk(`http://127.0.0.1:${port}/health`, {
    probeTimeoutMs: 250, readinessTimeoutMs: 5_000,
  });
  first.kill(signal);
  await first.exited;
  expect(existsSync(join(home, 'aio-proxy.db.server.lock'))).toBe(false);

  const restarted = start();
  await waitForOk(`http://127.0.0.1:${port}/health`, {
    probeTimeoutMs: 250, readinessTimeoutMs: 5_000,
  });
  restarted.kill(signal);
  await restarted.exited;
});
```

- [ ] **Step 2: Write the complete authentication matrix as failing tests**

```ts
const VALID_GRANT = {
  tokenHash: 'hash', familyId: 'family', installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  target: 'opencode', expiresAt: 901_000,
} as const;

const staticCases = [
  ['anonymous when unlocked', [], '/probe', {}, 200],
  ['valid bearer', [{ key: 'static' }], '/probe', { authorization: 'Bearer static' }, 200],
  ['valid x-api-key', [{ key: 'static' }], '/probe', { 'x-api-key': 'static' }, 200],
  ['valid Gemini header', [{ key: 'static' }], '/probe', { 'x-goog-api-key': 'static' }, 200],
  ['valid Gemini query', [{ key: 'static' }], '/probe?key=static', {}, 200],
  ['invalid static key', [{ key: 'static' }], '/probe', { authorization: 'Bearer wrong' }, 401],
] as const;

test.each(staticCases)('%s', async (_name, apiKeys, path, headers, status) => {
  const app = authenticatedApp({ apiKeys, authenticateAgent: () => ({ status: 'invalid' }) });
  expect((await app.request(path, { headers })).status).toBe(status);
});

test.each([[], [{ key: 'static' }]] as const)(
  'valid Agent access is accepted with static configuration %j',
  async (apiKeys) => {
    const app = authenticatedApp({ apiKeys, authenticateAgent: () => ({ status: 'valid', grant: VALID_GRANT }) });
    const response = await app.request('/probe', {
      headers: { authorization: 'Bearer aio_agent_at_v1_valid' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ target: 'opencode', authorization: null });
  },
);

test.each(['invalid', 'expired'] as const)(
  'recognizable %s Agent access never degrades to anonymous mode',
  async (status) => {
    const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status }) });
    const response = await app.request('/probe', {
      headers: { authorization: 'Bearer aio_agent_at_v1_invalid' },
    });
    expect(response.status).toBe(401);
  },
);

test.each(['aio_agent_rt_v1_refresh', 'aio_agent_at_v1_revoked'])(
  'reserved bearer %s cannot enter static or anonymous auth',
  async (token) => {
    const app = authenticatedApp({ apiKeys: [], authenticateAgent: () => ({ status: 'invalid' }) });
    expect((await app.request('/probe', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  },
);

test('static credentials and credential query fields are stripped before dispatch', async () => {
  const app = authenticatedApp({ apiKeys: [{ key: 'static' }], authenticateAgent: () => ({ status: 'invalid' }) });
  const response = await app.request('/probe?key=static&keep=yes', {
    headers: { authorization: 'Bearer static', 'x-api-key': 'static', 'x-goog-api-key': 'static' },
  });
  expect(await response.json()).toMatchObject({
    authorization: null, xApiKey: null, xGoogApiKey: null, search: '?keep=yes', target: null,
  });
});
```

Use this test app so every stripping/grant assertion observes the actual Hono request passed to routing:

```ts
function authenticatedApp(input: {
  readonly apiKeys: readonly { readonly key: string }[];
  readonly authenticateAgent: (token: string) => AgentAccessAuthentication;
}) {
  const app = new Hono<AgentEnv>();
  app.use('*', requireModelAuthentication({
    apiKeys: () => input.apiKeys, authenticateAgent: input.authenticateAgent,
  }));
  app.get('/probe', (context) => context.json({
    authorization: context.req.header('authorization') ?? null,
    xApiKey: context.req.header('x-api-key') ?? null,
    xGoogApiKey: context.req.header('x-goog-api-key') ?? null,
    search: new URL(context.req.url).search,
    target: context.get('agentGrant')?.target ?? null,
  }));
  return app;
}
```

Keep the existing protocol-shaped 401 assertions for `/v1/messages`, `/v1beta/models`, and `/v1/models` in `api-key-auth.test.ts`.

- [ ] **Step 3: Run tests to verify RED**

Run: `bun test packages/core/src/db/ownership-lock packages/server/src/server-state/database-ownership.test.ts packages/server/src/server/agent-auth/agent-auth.test.ts packages/server/src/server/api-key-auth/api-key-auth.test.ts`

Expected: FAIL because database ownership and Agent credential dispatch do not exist.

- [ ] **Step 4: Add the database-path ownership lock and transfer it into ServerState**

Export the existing pure `resolveDbPath(options)` from `open-db.ts`. Implement the database-specific lock beside it; do not add a public generic lock abstraction. Before exclusive lock creation, synchronously create `dirname(databasePath)` recursively with mode `0o700` and, on non-Windows platforms, apply `chmodSync(..., 0o700)`, matching the directory protection that `openDb()` currently performs too late for this ordering. Canonicalize that now-existing parent with `realpathSync.native()` and use `join(canonicalParent, basename(databasePath))` for both the lock and the later `openDb()` call. If the database already exists, `lstatSync` must show a regular non-symlink file and `statSync(...).nlink === 1`; otherwise throw `DatabaseOwnershipPathError`. This makes parent symlink aliases converge and rejects database-file symlink/hardlink aliases without adding a global lock registry or native dependency. Concurrent `mkdir` is idempotent; never create the database file itself in the lock module. The lock path is exactly `${canonicalDatabasePath}.server.lock`. Its record is strict version `1` JSON containing `pid`, process `starttime` (or `unavailable`), random `owner`, and `createdAt`. Acquisition uses exclusive create, a 10-second heartbeat, PID/starttime liveness, a 60-second fallback stale threshold when starttime cannot be verified, and the existing recovery fence before removing an unchanged stale generation. After `openDb()` creates/opens the canonical path, re-run the regular-file/non-symlink/`nlink === 1` check before constructing the identity hot index; a failure closes the handle and releases the lock.

The lifetime handle must use a synchronously closable file descriptor (`openSync`/`closeSync`). `release()` clears the heartbeat, compares owner plus `dev`/`ino` against the held descriptor, unlinks only that exact generation, and closes the descriptor in `finally`; a second call is a no-op. Do not reuse the async `NpmInstallLock.release()` in a synchronous `ServerState.close()`.

Resolve and acquire before `openDb()` or any migration/hot-index construction, then transfer ownership only when assembly succeeds:

```ts
function serverDbOptions(options: ServerStateOptions): OpenDbOptions {
  if (options.dbHome !== undefined) return { home: options.dbHome };
  return options.configPath === undefined ? {} : { home: dirname(options.configPath) };
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const dbOptions = serverDbOptions(options);
  const startup = createStartupCleanup();
  const databaseOwnership = await acquireDatabaseOwnershipLock(resolveDbPath(dbOptions));
  startup.add(databaseOwnership.release);
  try {
    const dbHandle = openDb({ home: dirname(databaseOwnership.databasePath) });
    startup.add(dbHandle.close);
    assertSafeOwnedDatabaseFile(databaseOwnership.databasePath);
    const state = await initializeServerState(
      options, dbHandle, databaseOwnership, startup.add,
    );
    startup.disarm();
    return state;
  } catch (error) {
    startup.unwind();
    throw error;
  }
}
```

`createStartupCleanup()` is a private closure over `Array<() => void>`. `add()` appends a cleanup, `unwind()` invokes every registered cleanup once in reverse order while catching each error so one bad close cannot skip database/lock release, and `disarm()` clears the array after ownership transfers to `ServerState`. Preserve the original startup error; cleanup errors are fixed-category diagnostics only and never replace it:

```ts
function createStartupCleanup() {
  const cleanups: Array<() => void> = [];
  let armed = true;
  return {
    add(cleanup: () => void) {
      if (!armed) throw new Error('startup cleanup is already disarmed');
      cleanups.push(cleanup);
    },
    unwind() {
      if (!armed) return;
      armed = false;
      for (const cleanup of cleanups.reverse()) {
        try { cleanup(); } catch {}
      }
      cleanups.length = 0;
    },
    disarm() {
      armed = false;
      cleanups.length = 0;
    },
  };
}
```

Cleanup failure never replaces the original startup error and never skips later cleanup; do not add a new log-event type solely for this failure-only path. `initializeServerState` receives `registerStartupCleanup` and registers each close immediately after its resource exists:

```ts
const events = createDashboardEventHub(options.eventLimits);
registerStartupCleanup(() => events.close());

runtime.scheduler = new CatalogScheduler({
  repository,
  diagnostics,
  rebuild: () => queue(() => commitConfig(runtime, (manager.current() as Snapshot).config, 'catalog')),
});
registerStartupCleanup(() => runtime.scheduler.close());
failAfter('scheduler');

const configStore = await startRecovery(runtime, {
  recoverAccounts,
  recoveryScheduler,
  reconciliationRetryMs: testHooks?.reconciliationRetryMs ?? RECOVERY_DRAIN_RETRY_MS,
}, registerStartupCleanup);
failAfter('recovery');

const oauthLoginSessions = startLoginSessions(runtime, configStore, reload);
registerStartupCleanup(() => oauthLoginSessions.close());
failAfter('login_sessions');

const watcher = options.configPath !== undefined && options.watchConfig !== false
  ? watchConfigFile(options.configPath, reload)
  : undefined;
if (watcher !== undefined) registerStartupCleanup(() => watcher.close());
failAfter('watcher');
```

Define `failAfter` once from `testHooks?.failStartupAfter`; it throws only on an exact match:

```ts
type StartupResource = NonNullable<ServerStateTestHooks['failStartupAfter']>;
const failAfter = (resource: StartupResource): void => {
  if (testHooks?.failStartupAfter === resource) {
    throw new Error(`injected startup failure: ${resource}`);
  }
};
```

Change `startRecovery` to accept the same registrar, assign `runtime.recovery`, and register `() => recovery.close()` **before** awaiting `recovery.start()`. This ordering also closes recovery when `start()` itself rejects:

```ts
export async function startRecovery(
  runtime: ServerRuntime,
  deps: {
    readonly recoverAccounts: Parameters<typeof createRecovery>[0]['recoverAccounts'];
    readonly recoveryScheduler: Parameters<typeof createRecovery>[0]['scheduler'];
    readonly reconciliationRetryMs: number;
  },
  registerStartupCleanup: (cleanup: () => void) => void,
): Promise<ConfigStore> {
  const recovery = createRecovery({
    configFile: runtime.configFile,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    recoverAccounts: deps.recoverAccounts,
    scheduler: deps.recoveryScheduler,
    reconciliationRetryMs: deps.reconciliationRetryMs,
    enqueue: runtime.queue,
    canDeleteAccount: runtime.manager.canDeleteAccount,
    reloadNow: (operations) => reloadNow(runtime, operations),
  });
  runtime.recovery = recovery;
  registerStartupCleanup(() => recovery.close());
  await recovery.start();
  return createConfigStore({
    getConfigPath: () => runtime.options.configPath,
    ...(runtime.configFile === undefined ? {} : { file: runtime.configFile }),
    accountRemovals: runtime.accountRemovals,
    enqueue: runtime.queue,
    onReconciliationNeeded: recovery.scheduleReconciliation,
    repository: runtime.repository,
    verify: (candidate) => commitConfig(runtime, parseRuntimeConfig(candidate), 'config-store'),
  });
}
```

Do not register resources without a close contract and do not add a generalized lifecycle framework.

`initializeServerState` is the existing body after database open; it does not acquire or reopen SQLite. Add `databaseOwnership` to `ServerStateParts`. Preserve synchronous close and guarantee database-before-lock order even if another lifecycle close throws:

```ts
({
  close() {
    if (runtime.closed) return;
    runtime.closed = true;
    const failures: unknown[] = [];
    for (const close of [
      () => parts.watcher?.close(),
      () => runtime.scheduler.close(),
      parts.closeRecovery,
      () => parts.oauthLoginSessions.close(),
      () => events.close(),
      () => dbHandle.close(),
      parts.databaseOwnership.release,
    ]) {
      try { close(); } catch (error) { failures.push(error); }
    }
    if (failures[0] !== undefined) throw failures[0];
  },
});
```

Expose that close path through the actual server and CLI lifecycle without erasing Hono's inferred route type:

```ts
export type CreateServerOptions = {
  readonly __test?: ServerStateTestHooks & { readonly createRoutes?: typeof createRoutes };
  readonly config: unknown;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly port?: number;
  readonly host?: string;
  readonly dashboardAssets?: DashboardAssets;
  readonly logger?: ServerLogSink;
  readonly watchConfig?: boolean;
  readonly version?: string;
};

export type AppType = ReturnType<typeof createRoutes> & { readonly close: () => void };

const state = await createServerState(stateOptions);
try {
  const routes = (options.__test?.createRoutes ?? createRoutes)(
    state,
    options.dashboardAssets,
    () => dashboardAuthAvailable,
    options.version,
    options.port ?? state.currentConfig().server.port,
    options.host ?? state.currentConfig().server.host,
  );
  let closed = false;
  return Object.assign(routes, {
    close() {
      if (closed) return;
      closed = true;
      state.close();
    },
  });
} catch (error) {
  try { state.close(); } catch {}
  throw error;
}
```

Add `...(options.__test === undefined ? {} : { __test: options.__test })` to `stateOptions`; the intersection remains assignable to `ServerStateTestHooks`, while `createServer` alone reads the optional `createRoutes`. Do not cast the Hono app to a bare `Hono`, and preserve the route-assembly error if close itself also throws.

In `packages/cli/src/run/run.ts`, replace the current bare listen with this lifecycle. A failed listen preserves its original error, and the shared signal handler is idempotent so back-to-back signals cannot double-close:

```ts
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({ hostname: host, port, idleTimeout: 255, fetch: app.fetch });
} catch (error) {
  try { app.close(); } catch {}
  throw error;
}

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  try {
    server.stop(true);
  } finally {
    try {
      app.close();
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    }
  }
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

Keep the existing startup log and `--open` behavior after listener creation. Let the drained event loop exit; do not call `process.exit()` or create a second shutdown manager.

- [ ] **Step 5: Run the complete server suite to expose legacy shared-home fixtures**

Run this after Step 4 has added database ownership but before changing test imports:

```bash
bun run --filter @aio-proxy/server test:unit
```

Expected: FAIL with `DatabaseOwnershipError` from legacy tests that create a server against the preload's shared default `AIO_PROXY_HOME` and never close it. In particular, `dashboard-auth.test.ts` currently constructs `first` and `second` concurrently against that default path. This RED run proves the test-lifecycle migration is required by the production ownership contract rather than being test-only cleanup.

- [ ] **Step 6: Add the server-test lifecycle wrapper and global cleanup**

Add the package-private import alias:

```diff
 // packages/server/package.json
 {
   "name": "@aio-proxy/server",
   "version": "0.8.0",
   "private": true,
   "type": "module",
+  "imports": {
+    "#server-test-lifecycle": "./__tests__/server-test-lifecycle.ts"
+  },
   "exports": {
```

Create the wrapper with no production export. It gives each pathless fixture a unique database home, preserves an explicitly supplied `dbHome` or `configPath`, registers every successfully created app/state for LIFO close, and removes only homes created through this helper:

```ts
// packages/server/__tests__/server-test-lifecycle.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createServer as createProductionServer,
  type AppType,
  type CreateServerOptions,
} from '../src/server/server';
import {
  createServerState as createProductionServerState,
  type ServerState,
  type ServerStateOptions,
} from '../src/server-state';

const trackedCloses: Array<() => void> = [];
const temporaryHomes: string[] = [];

export function createServerTestHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-test-'));
  temporaryHomes.push(home);
  return home;
}

export async function createServer(options: CreateServerOptions): Promise<AppType> {
  const effectiveOptions: CreateServerOptions =
    options.dbHome === undefined && options.configPath === undefined
      ? { ...options, dbHome: createServerTestHome() }
      : options;
  const app = await createProductionServer(effectiveOptions);
  trackedCloses.push(() => app.close());
  return app;
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const effectiveOptions: ServerStateOptions =
    options.dbHome === undefined && options.configPath === undefined
      ? { ...options, dbHome: createServerTestHome() }
      : options;
  const state = await createProductionServerState(effectiveOptions);
  trackedCloses.push(() => state.close());
  return state;
}

export function cleanupServerTestLifecycle(): void {
  let firstFailure: unknown;
  for (const close of trackedCloses.splice(0).reverse()) {
    try {
      close();
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  }
  for (const home of temporaryHomes.splice(0).reverse()) {
    try {
      rmSync(home, { force: true, recursive: true });
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
```

Register one outer cleanup hook in the existing preload; keep the isolated `AIO_PROXY_HOME` and models.dev fetch guard unchanged:

```diff
 // packages/server/__tests__/setup.ts
+import { afterEach } from 'bun:test';
 import { mkdtempSync, rmSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';

+import { cleanupServerTestLifecycle } from '#server-test-lifecycle';
+
 const testHome = mkdtempSync(join(tmpdir(), 'aio-proxy-server-tests-'));

 process.env.AIO_PROXY_HOME = testHome;
 process.on('exit', () => rmSync(testHome, { force: true, recursive: true }));
+afterEach(cleanupServerTestLifecycle);
```

Do not mutate `process.env.AIO_PROXY_HOME` per test, monkey-patch production constructors, or add a general resource registry.

- [ ] **Step 7: Migrate legacy value imports and preserve the real restart case**

For every file in the exact test/import set listed in this task's `Files` section, import the `createServer` and `createServerState` runtime values from `#server-test-lifecycle`. Keep all types and unrelated runtime exports on their production modules. These are the complete forms that need splitting:

Simple value imports:

```ts
import { createServer } from '#server-test-lifecycle';
import { createServerState } from '#server-test-lifecycle';
```

Preserve a local alias:

```ts
import { createServer as createBaseServer } from '#server-test-lifecycle';
```

Preserve production types:

```ts
import { createServerState } from '#server-test-lifecycle';
import type { ServerState } from '../../server-state';
```

Preserve unrelated production values:

```ts
import { createServer as createBaseServer } from '#server-test-lifecycle';
import { directoryDashboardAssets, serverDefaults } from '@aio-proxy/server';
```

The ownership and lifecycle tests added in Step 1 are intentional exceptions: `packages/server/src/server-state/database-ownership.test.ts` and `packages/server/src/server/server-lifecycle.test.ts` continue importing the production functions directly so the wrapper cannot hide an ownership regression.

Update the Dashboard-auth restart test to use one helper-owned home, close the first app before recreating it, and therefore retain actual restart semantics:

```diff
 // packages/server/src/dashboard-auth/dashboard-auth.test.ts
-import { createServer as createBaseServer } from '../server';
+import {
+  createServer as createBaseServer,
+  createServerTestHome,
+} from '#server-test-lifecycle';
@@
   test('accepts a session after recreating the server with the same hash', async () => {
     const hash = await Bun.password.hash('restart-safe');
-    const first = await createServer({ config: { server: { password: hash }, providers: {} } });
+    const dbHome = createServerTestHome();
+    const first = await createServer({
+      config: { server: { password: hash }, providers: {} },
+      dbHome,
+    });
     const token = await tokenFrom(await login(first, 'restart-safe'));
-    const second = await createServer({ config: { server: { password: hash }, providers: {} } });
+    first.close();
+    const second = await createServer({
+      config: { server: { password: hash }, providers: {} },
+      dbHome,
+    });
```

Do not change explicit `dbHome`/`configPath` values elsewhere. The full suite must continue to surface any accidental simultaneous reuse; only this restart test is allowed to reuse a path, and it closes before reacquiring ownership.

- [ ] **Step 8: Run the migrated server suite GREEN and audit production imports**

Run:

```bash
bun run --filter @aio-proxy/server test:unit
rg -n "^import .*create(Server|ServerState).* from " packages/server --glob '*.test.ts' --glob '*.test-support.ts' | rg -v "#server-test-lifecycle"
```

Expected: the server suite passes without `DatabaseOwnershipError`. The import audit reports only `database-ownership.test.ts` and `server-lifecycle.test.ts`; every other current server fixture goes through the lifecycle wrapper. Because explicit paths are preserved, this GREEN run also verifies there is no remaining close-before-recreate violation.

- [ ] **Step 9: Wire one identity service into ServerState**

Create it from the same `dbHandle.sqlite` used by the rest of server state; do not open a second database handle. Apply these exact type additions:

```diff
// packages/server/src/server-state/types.ts
+import type { AgentIdentityService } from '@aio-proxy/core';
@@
 export type ServerStateTestHooks = {
+  readonly agentIdentity?: AgentIdentityService;
+  readonly failStartupAfter?: 'scheduler' | 'recovery' | 'login_sessions' | 'watcher';
   readonly configFile?: AtomicConfigFile;
@@
 export type ServerState = ProviderRouteSource & {
+  readonly agentIdentity: AgentIdentityService;
   readonly close: () => void;
```

Construct the default exactly once at the start of `initializeServerState`, using the handle already opened under the ownership lock, and pass it through `assembleServerState`:

```diff
// packages/server/src/server-state/index.ts
import { createAgentIdentityService } from '@aio-proxy/core';

 async function initializeServerState(
   options: ServerStateOptions,
   dbHandle: OpenDbHandle,
   databaseOwnership: DatabaseOwnershipLock,
   registerStartupCleanup: (cleanup: () => void) => void,
 ): Promise<ServerState> {
  const internalOptions = options as InternalServerStateOptions;
  const testHooks = internalOptions.__test;
+  const agentIdentity = testHooks?.agentIdentity ?? createAgentIdentityService(dbHandle.sqlite);
@@
   return assembleServerState(runtime, {
+    agentIdentity,
+    databaseOwnership,
     manager,
```

```diff
// packages/server/src/server-state/lifecycle.ts
 export type ServerStateParts = Pick<
   ServerState,
+  | 'agentIdentity'
   | 'configStore'
@@
   return {
+    agentIdentity: parts.agentIdentity,
     acquireProviderSnapshot: manager.acquire,
```

Expose the already-private test hook through `createServer` without changing production callers:

```diff
// packages/server/src/server/server.ts
+import type { ServerStateTestHooks } from '../server-state/types';
@@
 export type CreateServerOptions = {
+  readonly __test?: ServerStateTestHooks & { readonly createRoutes?: typeof createRoutes };
   readonly config: unknown;
@@
   const stateOptions: InternalServerStateOptions = {
     config,
     __dashboardAuthHealthChanged: (available) => {
       dashboardAuthAvailable = available;
     },
+    ...(options.__test === undefined ? {} : { __test: options.__test }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
```

This identity-wiring step only exposes the test hooks and identity service. Keep the complete idempotent route ownership transfer from Step 4 as the single `createServer` implementation; in particular, do not replace it with a direct `{ close: state.close }` assignment or let a close failure replace the original route-assembly error.

- [ ] **Step 10: Replace route middleware with explicit credential dispatch**

```ts
export const requireModelAuthentication = (deps: ModelAuthenticationDeps): MiddlewareHandler<AgentEnv> =>
  async (context, next) => {
    const bearer = bearerToken(context.req.header('authorization'));
    if (bearer !== undefined && hasReservedAgentTokenPrefix(bearer)) {
      if (!bearer.startsWith(AGENT_ACCESS_TOKEN_PREFIX)) return authenticationError(context);
      const result = deps.authenticateAgent(bearer);
      if (result.status !== 'valid') return authenticationError(context);
      context.set('agentGrant', result.grant);
      stripCallerCredentials(context);
      await next();
      return;
    }
    return authenticateStaticOrAnonymous(context, next, deps.apiKeys());
  };
```

Move the existing header/query deletion into an exported `stripCallerCredentials(context)` in `api-key-auth.ts` and use it from both static and Agent success paths, so a request carrying an Agent bearer plus an extra `x-api-key`, `x-goog-api-key`, `key`, or `auth_token` cannot leak any caller credential upstream. Retain all existing static key/header/query behavior and protocol-shaped 401 bodies. Register this middleware for both `/v1/*` and `/v1beta/*`. Do not change routing pipeline code.

- [ ] **Step 11: Run ownership and authentication tests GREEN**

Run: `bun test packages/core/src/db/ownership-lock packages/server/src/server-state/database-ownership.test.ts packages/server/src/server/server-lifecycle.test.ts packages/server/src/server/agent-auth packages/server/src/server/api-key-auth packages/server/src/server/server.test.ts packages/cli/__tests__/run-lifecycle.test.ts`

Expected: PASS; only one hot token index can exist per normalized database path, both close paths release immediately, valid caller credentials are stripped, and an Agent grant is available only in process memory.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/db packages/server/package.json packages/server/__tests__ packages/server/src packages/cli/src/run/run.ts packages/cli/__tests__/run-lifecycle.test.ts
git commit -m "feat(server): authenticate agent installations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Neutral Agent catalog assembly and `/v1/models` dispatch

**Files:**

- Create: `packages/server/src/server/list-models/agent-catalog/index.ts`
- Create: `packages/server/src/server/list-models/agent-catalog/agent-catalog.ts`
- Test: `packages/server/src/server/list-models/agent-catalog/agent-catalog.test.ts`
- Modify: `packages/server/src/server/list-models/index.ts`
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/server.models.test.ts`

**Interfaces:**

- Consumes: `resolveEnabledModels`, `resolveModelField`, `resolveModelCapabilities`, `resolveAggregatedLimit`, `AgentCatalogQuerySchema`, and `context.get('agentGrant')`.
- Produces: `agentCatalog(state, target): Promise<AgentCatalogV1>`, route-local `parseAgentCatalogNegotiation`, and the strict Agent/Codex/standard routing order that executes malformed-Agent parsing before authentication.

- [ ] **Step 1: Write failing assembler and HTTP matrix tests**

Use the existing cached models.dev fixture setup and add this exact assembler assertion:

```ts
test('assembler fixes neutral defaults and honors resolved metadata', async () => {
  const state = await catalogState({
    metadata: {
      explicit: {
        name: 'Explicit', reasoning: true, toolCall: false, temperature: true, attachment: true,
        modalities: { input: ['text', 'image'] }, limit: { context: 200_000, output: 64_000 },
      },
    },
  });
  await expect(agentCatalog(state, 'pi')).resolves.toEqual({
    schema_version: 1,
    agent: 'pi',
    models: [
      { id: 'defaults', name: 'defaults', reasoning: false, tool_call: true, temperature: false,
        attachment: false, input: ['text'], context_window: null, max_output_tokens: null },
      { id: 'explicit', name: 'Explicit', reasoning: true, tool_call: false, temperature: true,
        attachment: true, input: ['text', 'image'], context_window: 200_000, max_output_tokens: 64_000 },
    ],
  });
});
```

`catalogState` is a colocated test helper backed by the normal snapshot builder, not a hand-written `ServerState` mock:

```ts
async function catalogState(input: { readonly metadata: Record<string, ModelMetadata> }) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-catalog-'));
  cleanupHomes.push(home);
  const provider = {
    id: 'provider-a', kind: 'ai-sdk', enabled: true,
    models: ['defaults', 'explicit'],
    alias: {
      defaults: { model: 'defaults', preserve: false },
      explicit: { model: 'explicit', preserve: false },
    },
    metadata: input.metadata,
    invoke: () => new ReadableStream(),
  } satisfies AiSdkProviderInstance;
  return createServerState({
    config: ConfigSchema.parse({ providers: {} }), dbHome: home, providerInstances: [provider],
  });
}
```

Close each returned state before removing its `cleanupHomes` directory in `afterEach`.

In `server.models.test.ts`, create one injected identity service, issue one credential for each target, and run these HTTP rows:

```ts
let app: Awaited<ReturnType<typeof createBaseServer>>;
let lockedApp: Awaited<ReturnType<typeof createBaseServer>>;
let opencode: IssuedAgentCredential;
let pi: IssuedAgentCredential;
let omp: IssuedAgentCredential;
let closeIdentity: () => void = () => {};

beforeEach(async () => {
  const identityDb = openDb({ home: mkdtempSync(join(tmpdir(), 'aio-proxy-model-auth-')) });
  closeIdentity = identityDb.close;
  const identity = createAgentIdentityService(identityDb.sqlite);
  opencode = identity.issueCredential({ installationId: crypto.randomUUID(), target: 'opencode', adapterVersion: '1.2.3' });
  pi = identity.issueCredential({ installationId: crypto.randomUUID(), target: 'pi', adapterVersion: '1.2.3' });
  omp = identity.issueCredential({ installationId: crypto.randomUUID(), target: 'omp', adapterVersion: '1.2.3' });
  app = await createBaseServer({ config, dbHome: dir, __test: { agentIdentity: identity } });
  lockedApp = await createBaseServer({
    config: { ...config, server: { ...config.server, apiKeys: [{ key: 'static-key' }] } },
    dbHome: mkdtempSync(join(tmpdir(), 'aio-proxy-locked-models-')),
    __test: { agentIdentity: identity },
  });
});

const cases = [
  ['opencode', 'opencode', 'opencode', 200],
  ['pi', 'pi', 'pi', 200],
  ['omp', 'omp', 'omp', 200],
  ['anonymous', null, 'opencode', 401],
  ['target mismatch', 'opencode', 'pi', 403],
] as const;

test.each(cases)('%s Agent catalog dispatch', async (_name, credentialTarget, agent, status) => {
  const credential = credentialTarget === null
    ? undefined
    : credentialTarget === 'opencode' ? opencode : credentialTarget === 'pi' ? pi : omp;
  const headers = credential === undefined ? {} : { authorization: `Bearer ${credential.accessToken}` };
  const response = await app.request(
    `/v1/models?agent=${agent}&adapter_version=1.2.3&schema_version=1`, { headers }, loopbackServer,
  );
  expect(response.status).toBe(status);
  if (status === 200) expect(await response.json()).toMatchObject({ schema_version: 1, agent });
});

test.each([
  ['/v1/models?agent=opencode&schema_version=1', opencode.accessToken, 400],
  ['/v1/models?agent=opencode&adapter_version=latest&schema_version=1', opencode.accessToken, 400],
  ['/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=2', opencode.accessToken, 400],
  ['/v1/models', opencode.accessToken, 400],
] as const)('rejects malformed or missing Agent negotiation: %s', async (path, token, status) => {
  const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } }, loopbackServer);
  expect(response.status).toBe(status);
  if (path.endsWith('schema_version=2')) {
    expect(await response.json()).toEqual({
      error: { code: 'unsupported_schema', message: 'Agent catalog schema 2 is not supported.' },
      supported_schema_versions: [1],
    });
  }
});

test.each([
  '/v1/models?agent=opencode&schema_version=1',
  '/v1/models?agent=opencode&adapter_version=latest&schema_version=1',
  '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=2',
] as const)('malformed Agent negotiation wins over the global API-key gate: %s', async (path) => {
  const response = await lockedApp.request(path, {}, loopbackServer);
  expect(response.status).toBe(400);
});

test('Agent negotiation wins over client_version and static keys cannot read it', async () => {
  const agentResponse = await app.request(
    '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=1&client_version=0.146.0',
    { headers: { authorization: `Bearer ${opencode.accessToken}` } }, loopbackServer,
  );
  expect(await agentResponse.json()).toMatchObject({ schema_version: 1, agent: 'opencode' });
  expect((await lockedApp.request(
    '/v1/models?agent=opencode&adapter_version=1.2.3&schema_version=1',
    { headers: { authorization: 'Bearer static-key' } }, loopbackServer,
  )).status).toBe(401);
});
```

Retain the existing exact assertions that `client_version` returns `{ models }` and a standard request returns `{ object: 'list', data }`; run both with no Agent credential after the new cases.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test packages/server/src/server/list-models/agent-catalog packages/server/src/server/server.models.test.ts`

Expected: FAIL because the assembler and Agent query branch do not exist.

- [ ] **Step 3: Implement the single assembler**

```ts
export async function agentCatalog(state: ServerState, agent: AgentTarget): Promise<AgentCatalogV1> {
  const resolved = await resolveEnabledModels(state);
  return {
    schema_version: 1,
    agent,
    models: resolved.map((model) => {
      const capabilities = resolveModelCapabilities(model);
      return {
        id: model.slug,
        name: resolveModelField(model, (metadata) => metadata.name) ?? model.slug,
        reasoning: capabilities?.reasoning ?? false,
        tool_call: capabilities?.toolCall ?? true,
        temperature: capabilities?.temperature ?? false,
        attachment: capabilities?.attachment ?? false,
        input: capabilities?.modalities?.input ?? ['text'],
        context_window: resolveAggregatedLimit(model, 'context') ?? null,
        max_output_tokens: resolveAggregatedLimit(model, 'output') ?? null,
      };
    }),
  };
}
```

- [ ] **Step 4: Implement route precedence and stable errors**

Register the dedicated `/v1/models` chain before the global `/v1/*` middleware. Its first handler detects whether any of `agent`, `adapter_version`, or `schema_version` is present, copies only those three fields into a new object, and parses that object; never pass `client_version` or unrelated query fields to `AgentCatalogQuerySchema`. Return the stable 400 body before invoking authentication:

```ts
const agentQueryFields = ['agent', 'adapter_version', 'schema_version'] as const;

const parseAgentCatalogNegotiation: MiddlewareHandler<AgentEnv> = async (context, next) => {
  const raw = Object.fromEntries(agentQueryFields.flatMap((field) => {
    const value = context.req.query(field);
    return value === undefined ? [] : [[field, value] as const];
  }));
  if (Object.keys(raw).length === 0) {
    context.set('agentCatalogQuery', null);
    await next();
    return;
  }
  if (raw.schema_version !== undefined && raw.schema_version !== '1') {
    return context.json({
      error: { code: 'unsupported_schema', message: `Agent catalog schema ${raw.schema_version} is not supported.` },
      supported_schema_versions: [1],
    }, 400);
  }
  const parsed = AgentCatalogQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
  }
  context.set('agentCatalogQuery', parsed.data);
  await next();
};
```

Use one `modelAuthentication` instance for this route and the remaining protocol routes, but do not let the later wildcard run twice:

```ts
app.get('/v1/models', parseAgentCatalogNegotiation, modelAuthentication, listModelsHandler(state));
app.use('/v1/*', modelAuthentication);
app.use('/v1beta/*', modelAuthentication);
```

`listModelsHandler` checks the parsed value first. A valid Agent query requires an Agent grant; no grant returns the existing protocol-shaped 401 and target mismatch returns 403. Any Agent grant with `agentCatalogQuery === null` returns 400 and cannot enter Codex/standard behavior. Only then run the existing `client_version` branch byte-for-byte, followed by the standard list. Because the route was registered first and returns a response, the later `/v1/*` wildcard does not process it.

- [ ] **Step 5: Run catalog/server tests GREEN**

Run: `bun test packages/server/src/server/list-models packages/server/src/server/server.models.test.ts`

Expected: PASS, including exact capability defaults and legacy response shapes.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/list-models packages/server/src/server/server.ts packages/server/src/server/server.models.test.ts
git commit -m "feat(server): serve authenticated agent catalogs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Device Authorization, Dashboard approval API, and local admin API

**Files:**

- Create: `packages/server/src/agent-authorization/index.ts`
- Create: `packages/server/src/agent-authorization/device-challenges.ts`
- Create: `packages/server/src/agent-authorization/routes.ts`
- Test: `packages/server/src/agent-authorization/device-challenges.test.ts`
- Test: `packages/server/src/agent-authorization/routes.test.ts`
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/admin-reload.test.ts`

**Interfaces:**

- Consumes: `state.agentIdentity`, typed DTOs, existing Dashboard authentication, `isDashboardLoopbackRequest`, and model-server configured password/API keys.
- Produces: the eight exact endpoints in the spec, `GET /admin/agent-installations` returning `AgentAdminSnapshot`, three concrete Hono route builders, and `createDeviceChallengeStore({ identity, verificationUri, now, randomBytes, randomUUID })` with this private route-facing surface:

```ts
type DeviceChallengeStore = {
  readonly create: (input: AgentDeviceCodeRequest, source: string) => AgentDeviceCodeResponse;
  readonly resolve: (userCode: string, source: string) => AgentAuthorizationDetails;
  readonly approve: (deviceId: string, source: string) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly deny: (deviceId: string, source: string) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly poll: (input: { readonly clientId: string; readonly deviceCode: string }, source: string) =>
    | { readonly ok: true; readonly token: AgentTokenResponse }
    | { readonly ok: false; readonly error: AgentOAuthError['error']; readonly interval?: number };
};

// routes.ts exports createAgentOAuthRoutes(input), createAgentApprovalRoutes(input),
// and createAgentAdminRoutes(input). Leave their chained Hono return types inferred;
// an explicit `: Hono` would erase the path types consumed by the Dashboard client.
```

- [ ] **Step 1: Write failing challenge-state tests**

```ts
import { AgentInstallationTargetMismatchError } from '@aio-proxy/core';

test('pending, slow_down, approval, and duplicate consume are deterministic', () => {
  const f = challengeFixture();
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'slow_down', interval: 10 });
  expect(f.issueCredential).not.toHaveBeenCalled();
  f.advance(10_000);
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'authorization_pending' });
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  expect(details).toMatchObject({ status: 'pending', target: 'opencode', installationId: DEVICE_REQUEST.installation_id });
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  expect(f.store.approve(details.deviceId, '127.0.0.1')).toBe('approved');
  f.advance(10_000);
  const first = f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1');
  const duplicate = f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1');
  expect(first).toEqual(duplicate);
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
  f.advance(30_001);
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'expired_token' });
});

test('deny and expiry never issue credentials', () => {
  const denied = challengeFixture();
  const first = denied.store.create(DEVICE_REQUEST, '127.0.0.1');
  const firstDetails = denied.store.resolve(first.user_code, '127.0.0.1');
  if (firstDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(denied.store.deny(firstDetails.deviceId, '127.0.0.1')).toBe('denied');
  expect(denied.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: first.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'access_denied' });

  const expired = challengeFixture();
  const second = expired.store.create(DEVICE_REQUEST, '127.0.0.1');
  expired.advance(600_001);
  expect(expired.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: second.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'expired_token' });
  expect(denied.issueCredential).not.toHaveBeenCalled();
  expect(expired.issueCredential).not.toHaveBeenCalled();
});

test('the first approval decision is terminal', () => {
  const denied = challengeFixture();
  const deniedCode = denied.store.create(DEVICE_REQUEST, '127.0.0.1');
  const deniedDetails = denied.store.resolve(deniedCode.user_code, '127.0.0.1');
  if (deniedDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(denied.store.deny(deniedDetails.deviceId, '127.0.0.1')).toBe('denied');
  expect(denied.store.approve(deniedDetails.deviceId, '127.0.0.1')).toBe('denied');

  const approved = challengeFixture();
  const approvedCode = approved.store.create(DEVICE_REQUEST, '127.0.0.1');
  const approvedDetails = approved.store.resolve(approvedCode.user_code, '127.0.0.1');
  if (approvedDetails.status !== 'pending') throw new Error('expected pending challenge');
  expect(approved.store.approve(approvedDetails.deviceId, '127.0.0.1')).toBe('approved');
  expect(approved.store.deny(approvedDetails.deviceId, '127.0.0.1')).toBe('approved');
});

test('new login replaces the same installation challenge and restart forgets pending state', () => {
  const f = challengeFixture();
  const old = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const current = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  expect(f.store.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: old.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'expired_token' });
  expect(current.device_code).not.toBe(old.device_code);
  const restarted = f.newStore();
  expect(restarted.poll({ clientId: DEVICE_REQUEST.client_id, deviceCode: current.device_code }, '127.0.0.1'))
    .toEqual({ ok: false, error: 'expired_token' });
});

test('an immutable installation-target conflict becomes invalid_grant without consumption', () => {
  const f = challengeFixture();
  f.issueCredential.mockImplementation(() => { throw new AgentInstallationTargetMismatchError(); });
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  f.advance(5_000);
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const poll = () => f.store.poll({
    clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code,
  }, '127.0.0.1');
  expect(poll()).toEqual({ ok: false, error: 'invalid_grant' });
  f.advance(5_000);
  expect(poll()).toEqual({ ok: false, error: 'invalid_grant' });
});

test('a new challenge after consume keeps the old device-code replay alive', () => {
  const f = challengeFixture();
  const old = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const details = f.store.resolve(old.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const first = f.store.poll({
    clientId: DEVICE_REQUEST.client_id, deviceCode: old.device_code,
  }, '127.0.0.1');

  const current = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  const replay = f.store.poll({
    clientId: DEVICE_REQUEST.client_id, deviceCode: old.device_code,
  }, '127.0.0.1');
  expect(current.device_code).not.toBe(old.device_code);
  expect(replay).toEqual(first);
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
});

test('a consume just before Device expiry still has a full 30-second replay window', () => {
  const f = challengeFixture();
  const created = f.store.create(DEVICE_REQUEST, '127.0.0.1');
  f.advance(599_999);
  const details = f.store.resolve(created.user_code, '127.0.0.1');
  if (details.status !== 'pending') throw new Error('expected pending challenge');
  f.store.approve(details.deviceId, '127.0.0.1');
  const request = {
    clientId: DEVICE_REQUEST.client_id, deviceCode: created.device_code,
  } as const;
  const first = f.store.poll(request, '127.0.0.1');
  f.advance(29_999);
  expect(f.store.poll(request, '127.0.0.1')).toEqual(first);
  f.advance(1);
  expect(f.store.poll(request, '127.0.0.1'))
    .toEqual({ ok: false, error: 'expired_token' });
  expect(f.issueCredential).toHaveBeenCalledTimes(1);
});

test('caps every retained challenge and rate-limits each source bucket', () => {
  const f = challengeFixture();
  for (let index = 0; index < 256; index += 1) {
    f.store.create({ ...DEVICE_REQUEST, installation_id: uuid(index) }, `127.0.0.${index + 1}`);
  }
  expect(() => f.store.create({ ...DEVICE_REQUEST, installation_id: uuid(999) }, '127.0.1.1'))
    .toThrow(expect.objectContaining({ status: 429 }));

  const limited = challengeFixture();
  for (let index = 0; index < 10; index += 1) {
    limited.store.create({ ...DEVICE_REQUEST, installation_id: uuid(index) }, '127.0.0.1');
  }
  expect(() => limited.store.create({ ...DEVICE_REQUEST, installation_id: uuid(11) }, '127.0.0.1'))
    .toThrow(expect.objectContaining({ status: 429 }));
});
```

Place this fixture above the tests:

```ts
const DEVICE_REQUEST = {
  client_id: 'aio-proxy-opencode', agent: 'opencode',
  installation_id: '0f4dcb50-d68c-4b99-8af1-da32480ddd09', adapter_version: '1.2.3',
} as const;
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function challengeFixture() {
  let timestamp = 1_000;
  let sequence = 1;
  const issueCredential = mock(() => ({
    accessToken: 'aio_agent_at_v1_access', refreshToken: 'aio_agent_rt_v1_refresh',
    expiresIn: 900 as const, accessExpiresAt: timestamp + 900_000,
    refreshExpiresAt: timestamp + 90 * 24 * 60 * 60_000,
  }));
  const deps = {
    identity: { issueCredential } as Pick<AgentIdentityService, 'issueCredential'>,
    verificationUri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    now: () => timestamp,
    randomBytes: (size: number) => {
      let value = sequence++;
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) {
        bytes[index] = value % 32;
        value = Math.floor(value / 32);
      }
      return bytes;
    },
    randomUUID: () => uuid(sequence++),
  };
  return {
    issueCredential,
    store: createDeviceChallengeStore(deps),
    newStore: () => createDeviceChallengeStore(deps),
    advance: (milliseconds: number) => { timestamp += milliseconds; },
  };
}
```

Add the other rate-limit buckets explicitly:

```ts
test.each(['resolve', 'decision'] as const)('%s rate limit resets after one minute', (kind) => {
  const f = challengeFixture();
  const call = kind === 'resolve'
    ? () => f.store.resolve('ZZZZ-ZZZZ', '127.0.0.1')
    : () => f.store.approve(uuid(900), '127.0.0.1');
  for (let index = 0; index < 10; index += 1) call();
  expect(call).toThrow(expect.objectContaining({ status: 429 }));
  f.advance(60_001);
  expect(call).not.toThrow();
});

test('rate-source maps are bounded and expired buckets are reusable', () => {
  const f = challengeFixture();
  for (let index = 0; index < 256; index += 1) {
    f.store.resolve('ZZZZ-ZZZZ', `127.0.1.${index}`);
  }
  expect(() => f.store.resolve('ZZZZ-ZZZZ', '127.0.2.1'))
    .toThrow(expect.objectContaining({ status: 429, code: 'rate_limited' }));
  f.advance(60_001);
  expect(() => f.store.resolve('ZZZZ-ZZZZ', '127.0.2.1')).not.toThrow();
});
```

- [ ] **Step 2: Write failing route/security tests**

```ts
test('device endpoint is form-only, loopback-only, and binds the fixed client tuple', async () => {
  const f = await routeFixture();
  const valid = await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer);
  expect(valid.status).toBe(200);
  expect(valid.headers.get('cache-control')).toBe('no-store');
  const created = await valid.json();
  expect(created).toMatchObject({
    user_code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u),
    verification_uri_complete: expect.stringContaining('/dashboard/agents/authorize#code='),
  });
  expect(JSON.stringify(f.logs)).not.toContain(created.device_code);
  expect(JSON.stringify(f.logs)).not.toContain(created.user_code);
  expect((await f.app.request('/oauth/device/code', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(DEVICE_REQUEST),
  }, loopbackServer)).status).toBe(400);
  expect((await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), {
    requestIP: () => ({ address: '203.0.113.10' }),
  })).status).toBe(404);
  expect((await f.app.request('/oauth/device/code', {
    ...form(DEVICE_REQUEST), headers: {
      ...form(DEVICE_REQUEST).headers, forwarded: 'for=127.0.0.1', 'x-forwarded-for': '127.0.0.1',
    },
  }, { requestIP: () => ({ address: '203.0.113.10' }) })).status).toBe(404);
  expect((await f.app.request('/oauth/device/code', form({ ...DEVICE_REQUEST, client_id: 'aio-proxy-pi' }), loopbackServer)).status)
    .toBe(400);
});

test('static API keys without a Dashboard password disable challenge creation', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }] });
  const response = await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'authorization_unavailable' });
});

test.each(['resolve', 'approve', 'deny'] as const)(
  'Dashboard %s maps DeviceChallengeError rate limits to stable 429 JSON',
  async (operation) => {
    const f = await routeFixture();
    const path = operation === 'resolve'
      ? '/dashboard/api/agent-authorizations/resolve'
      : `/dashboard/api/agent-authorizations/${crypto.randomUUID()}/${operation}`;
    const init = operation === 'resolve'
      ? json({ userCode: 'ZZZZ-ZZZZ' }, {
          origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
        })
      : json({}, { origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin' });
    for (let index = 0; index < 10; index += 1) {
      expect((await f.app.request(path, init, loopbackServer)).status).toBe(200);
    }
    const limited = await f.app.request(path, init, loopbackServer);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  },
);

test('approval requires both Dashboard session and same origin when locked', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }], password: 'dashboard-password' });
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const resolveBody = { userCode: created.user_code };
  const originOnly = await f.app.request('/dashboard/api/agent-authorizations/resolve', json(resolveBody, {
    origin: 'http://127.0.0.1:9317',
  }), loopbackServer);
  expect(originOnly.status).toBe(401);

  const token = await f.login('dashboard-password');
  const crossOrigin = await f.app.request('/dashboard/api/agent-authorizations/resolve', json(resolveBody, {
    authorization: `Bearer ${token}`, origin: 'https://evil.example',
  }), loopbackServer);
  expect(crossOrigin.status).toBe(403);
  const resolved = await f.app.request('/dashboard/api/agent-authorizations/resolve', json(resolveBody, {
    authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
  }), loopbackServer);
  expect(resolved.status).toBe(200);
  const details = await resolved.json();
  expect(details).not.toHaveProperty('device_code');
  const approved = await f.app.request(`/dashboard/api/agent-authorizations/${details.deviceId}/approve`, json({}, {
    authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
  }), loopbackServer);
  expect(await approved.json()).toEqual({ status: 'approved' });

  const deniedChallenge = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const deniedDetails = await (await f.app.request(
    '/dashboard/api/agent-authorizations/resolve',
    json({ userCode: deniedChallenge.user_code }, {
      authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
    }), loopbackServer,
  )).json();
  const denied = await f.app.request(
    `/dashboard/api/agent-authorizations/${deniedDetails.deviceId}/deny`,
    json({}, {
      authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
    }), loopbackServer,
  );
  expect(await denied.json()).toEqual({ status: 'denied' });
});

test('an authenticated remote Dashboard may approve a challenge created by a local plugin', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }], password: 'dashboard-password' });
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const token = await f.login('dashboard-password');
  const remoteServer = { requestIP: () => ({ address: '203.0.113.10' }) };
  const resolved = await f.app.request(
    'https://proxy.example/dashboard/api/agent-authorizations/resolve',
    json({ userCode: created.user_code }, {
      authorization: `Bearer ${token}`, origin: 'https://proxy.example', 'sec-fetch-site': 'same-origin',
    }),
    remoteServer,
  );
  expect(resolved.status).toBe(200);
  const details = await resolved.json();
  const approved = await f.app.request(
    `https://proxy.example/dashboard/api/agent-authorizations/${details.deviceId}/approve`,
    json({}, {
      authorization: `Bearer ${token}`, origin: 'https://proxy.example', 'sec-fetch-site': 'same-origin',
    }),
    remoteServer,
  );
  expect(await approved.json()).toEqual({ status: 'approved' });
});

test('token endpoint consumes once, replays the same result, rotates, and never logs credentials', async () => {
  const f = await routeFixture();
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const details = await (await f.app.request(
    '/dashboard/api/agent-authorizations/resolve',
    json({ userCode: created.user_code }, {
      origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
    }),
    loopbackServer,
  )).json();
  await f.app.request(
    `/dashboard/api/agent-authorizations/${details.deviceId}/approve`,
    json({}, { origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin' }),
    loopbackServer,
  );
  const deviceGrant = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: DEVICE_REQUEST.client_id,
    device_code: created.device_code,
  };
  const first = await f.app.request('/oauth/token', form(deviceGrant), loopbackServer);
  const firstBody = await first.clone().json();
  const duplicateBody = await (await f.app.request('/oauth/token', form(deviceGrant), loopbackServer)).json();
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(duplicateBody).toEqual(firstBody);

  const refreshBody = await (await f.app.request('/oauth/token', form({
    grant_type: 'refresh_token', client_id: DEVICE_REQUEST.client_id,
    refresh_token: firstBody.refresh_token,
  }), loopbackServer)).json();
  expect(refreshBody.access_token).not.toBe(firstBody.access_token);
  expect(refreshBody.refresh_token).not.toBe(firstBody.refresh_token);
  const serializedLogs = JSON.stringify(f.logs);
  for (const secret of [created.device_code, created.user_code, firstBody.access_token,
    firstBody.refresh_token, refreshBody.access_token, refreshBody.refresh_token]) {
    expect(serializedLogs).not.toContain(secret);
  }
});

test('refresh validates client binding before any replay result can be returned', async () => {
  const f = await routeFixture();
  const token = f.agentIdentity.issueCredential({
    installationId: DEVICE_REQUEST.installation_id, target: 'opencode', adapterVersion: '1.2.3',
  });
  const wrongClient = await f.app.request('/oauth/token', form({
    grant_type: 'refresh_token', client_id: 'aio-proxy-pi', refresh_token: token.refreshToken,
  }), loopbackServer);
  expect(wrongClient.status).toBe(400);
  expect(await wrongClient.json()).toMatchObject({ error: 'invalid_grant' });
  const correct = await f.app.request('/oauth/token', form({
    grant_type: 'refresh_token', client_id: DEVICE_REQUEST.client_id, refresh_token: token.refreshToken,
  }), loopbackServer);
  expect(correct.status).toBe(200);
});

test('admin snapshot and revoke are loopback-only, idempotent, and secret-free', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }] });
  const response = await f.app.request('/admin/agent-installations', undefined, loopbackServer);
  const body = await response.json();
  expect(body).toEqual({
  installations: [],
  deviceAuthorization: 'password_required',
  catalogSchemaVersions: [1],
});
  expect(JSON.stringify(body).toLowerCase()).not.toContain('hash');
  const id = DEVICE_REQUEST.installation_id;
  const first = await f.app.request(`/admin/agent-installations/${id}/revoke`, { method: 'POST' }, loopbackServer);
  const second = await f.app.request(`/admin/agent-installations/${id}/revoke`, { method: 'POST' }, loopbackServer);
  expect(await first.json()).toEqual({ installationId: id, status: 'missing' });
  expect(await second.json()).toEqual({ installationId: id, status: 'missing' });

  const remoteFixture = await routeFixture({ password: 'dashboard-password' });
  const dashboardToken = await remoteFixture.login('dashboard-password');
  const remote = await remoteFixture.app.request('/admin/agent-installations', {
    headers: { authorization: `Bearer ${dashboardToken}` },
  }, { requestIP: () => ({ address: '203.0.113.10' }) });
  expect(remote.status).toBe(404);
});
```

Use these exact request helpers and fixture:

```ts
const form = (value: Record<string, string>): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(value),
});
const json = (value: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
});

async function routeFixture(server: { apiKeys?: Array<{ key: string }>; password?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-routes-'));
  routeHomes.push(home);
  const identityDb = openDb({ home: join(home, 'identity') });
  routeCloses.push(identityDb.close);
  const agentIdentity = createAgentIdentityService(identityDb.sqlite);
  const logs: unknown[] = [];
  const app = await createServer({
    config: { server: { host: '127.0.0.1', port: 9_317, ...server }, providers: {} },
    dbHome: join(home, 'server'), host: '127.0.0.1', port: 9_317,
    logger: (entry) => logs.push(entry), __test: { agentIdentity },
  });
  return {
    app,
    agentIdentity,
    logs,
    login: async (password: string): Promise<string> => {
      const response = await app.request('/dashboard/api/auth/login', json({ password }, {
        origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin',
      }), loopbackServer);
      const body = await response.json();
      if (!response.ok || typeof body.token !== 'string') throw new Error('Dashboard login failed in fixture');
      return body.token;
    },
  };
}
```

The existing `afterEach` closes `routeCloses` before recursively removing `routeHomes`. For the token endpoint success test, assert the serialized log capture contains none of the submitted device code or returned access/refresh tokens.

- [ ] **Step 3: Run tests to verify RED**

Run: `bun test packages/server/src/agent-authorization`

Expected: FAIL because no challenge store or routes exist.

- [ ] **Step 4: Implement the bounded in-memory state machine**

```ts
// packages/server/src/agent-authorization/device-challenges.ts
import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';
import { AgentInstallationTargetMismatchError, type AgentIdentityService } from '@aio-proxy/core';
import {
  AGENT_CLIENT_ID,
  type AgentAuthorizationDetails,
  type AgentDeviceCodeRequest,
  type AgentDeviceCodeResponse,
  type AgentOAuthError,
  type AgentTarget,
  type AgentTokenResponse,
} from '@aio-proxy/types';

const DEVICE_TTL_MS = 10 * 60_000;
const INITIAL_POLL_SECONDS = 5;
const CREDENTIAL_REPLAY_MS = 30_000;
const MAX_CHALLENGES = 256;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_SOURCES = 256;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class DeviceChallengeError extends Error {
  constructor(
    readonly status: 400 | 429,
    readonly code: 'invalid_client' | 'rate_limited' | 'capacity_exceeded',
  ) { super(code); }
}

type Challenge = {
  readonly deviceId: string; readonly deviceCode: string; readonly userCode: string;
  readonly clientId: string; readonly target: AgentTarget; readonly installationId: string;
  readonly adapterVersion: string; readonly createdAt: number; readonly expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  intervalSeconds: number; nextPollAt: number;
  issued?: AgentTokenResponse; issuedUntil?: number;
};

type PollInput = { readonly clientId: string; readonly deviceCode: string };
type PollResult =
  | { readonly ok: true; readonly token: AgentTokenResponse }
  | { readonly ok: false; readonly error: AgentOAuthError['error']; readonly interval?: number };
type RateBucket = { startedAt: number; count: number };

export type DeviceChallengeStore = {
  readonly create: (input: AgentDeviceCodeRequest, source: string) => AgentDeviceCodeResponse;
  readonly resolve: (userCode: string, source: string) => AgentAuthorizationDetails;
  readonly approve: (
    deviceId: string,
    source: string,
  ) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly deny: (
    deviceId: string,
    source: string,
  ) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly poll: (input: PollInput, source: string) => PollResult;
};

type DeviceChallengeStoreInput = {
  readonly identity: Pick<AgentIdentityService, 'issueCredential'>;
  readonly verificationUri: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUUID?: () => string;
};

export function createDeviceChallengeStore(input: DeviceChallengeStoreInput): DeviceChallengeStore {
  const now = input.now ?? Date.now;
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const randomUUID = input.randomUUID ?? nodeRandomUUID;
  const byDeviceCode = new Map<string, Challenge>();
  const byUserCode = new Map<string, Challenge>();
  const byDeviceId = new Map<string, Challenge>();
  const byInstallation = new Map<string, Challenge>();
  const createRates = new Map<string, RateBucket>();
  const resolveRates = new Map<string, RateBucket>();
  const decisionRates = new Map<string, RateBucket>();

  const installationKey = (clientId: string, installationId: string): string =>
    `${clientId}\0${installationId}`;

  const releaseInstallationSlot = (challenge: Challenge): void => {
    const key = installationKey(challenge.clientId, challenge.installationId);
    if (byInstallation.get(key) === challenge) byInstallation.delete(key);
  };

  const deleteChallenge = (challenge: Challenge): void => {
    byDeviceCode.delete(challenge.deviceCode);
    byUserCode.delete(challenge.userCode.replace('-', ''));
    byDeviceId.delete(challenge.deviceId);
    releaseInstallationSlot(challenge);
  };

  const pruneExpired = (timestamp: number): void => {
    for (const challenge of byDeviceId.values()) {
      const expired = challenge.status === 'consumed'
        ? challenge.issuedUntil! <= timestamp
        : challenge.expiresAt <= timestamp;
      if (expired) {
        deleteChallenge(challenge);
      }
    }
  };

  const checkRate = (rates: Map<string, RateBucket>, source: string, timestamp: number): void => {
    const current = rates.get(source);
    if (current === undefined || timestamp - current.startedAt >= RATE_WINDOW_MS) {
      for (const [key, bucket] of rates) {
        if (timestamp - bucket.startedAt >= RATE_WINDOW_MS) rates.delete(key);
      }
      if (!rates.has(source) && rates.size >= MAX_RATE_SOURCES) {
        throw new DeviceChallengeError(429, 'rate_limited');
      }
      rates.set(source, { startedAt: timestamp, count: 1 });
      return;
    }
    if (current.count >= RATE_LIMIT) throw new DeviceChallengeError(429, 'rate_limited');
    current.count += 1;
  };

  const uniqueDeviceCode = (): string => {
    for (let attempt = 0; attempt <= MAX_CHALLENGES; attempt += 1) {
      const value = Buffer.from(randomBytes(32)).toString('base64url');
      if (!byDeviceCode.has(value)) return value;
    }
    throw new DeviceChallengeError(429, 'capacity_exceeded');
  };

  const uniqueUserCode = (): { readonly raw: string; readonly display: string } => {
    for (let attempt = 0; attempt <= MAX_CHALLENGES; attempt += 1) {
      const bytes = randomBytes(8);
      let raw = '';
      for (let index = 0; index < 8; index += 1) {
        raw += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length]!;
      }
      if (!byUserCode.has(raw)) return { raw, display: `${raw.slice(0, 4)}-${raw.slice(4)}` };
    }
    throw new DeviceChallengeError(429, 'capacity_exceeded');
  };

  const terminal = (challenge: Challenge | undefined): AgentAuthorizationDetails => {
    if (challenge === undefined) return { status: 'expired' };
    if (challenge.status !== 'pending') return { status: challenge.status };
    return {
      status: 'pending',
      deviceId: challenge.deviceId,
      target: challenge.target,
      installationId: challenge.installationId,
      adapterVersion: challenge.adapterVersion,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      permissions: ['catalog', 'inference'],
    };
  };

  function create(request: AgentDeviceCodeRequest, source: string): AgentDeviceCodeResponse {
    const timestamp = now();
    pruneExpired(timestamp);
    checkRate(createRates, source, timestamp);
    if (AGENT_CLIENT_ID[request.agent] !== request.client_id) {
      throw new DeviceChallengeError(400, 'invalid_client');
    }
    const key = installationKey(request.client_id, request.installation_id);
    const previous = byInstallation.get(key);
    if (previous !== undefined) deleteChallenge(previous);
    if (byDeviceId.size >= MAX_CHALLENGES) throw new DeviceChallengeError(429, 'capacity_exceeded');

    const deviceCode = uniqueDeviceCode();
    const userCode = uniqueUserCode();
    const challenge: Challenge = {
      deviceId: randomUUID(),
      deviceCode,
      userCode: userCode.display,
      clientId: request.client_id,
      target: request.agent,
      installationId: request.installation_id,
      adapterVersion: request.adapter_version,
      createdAt: timestamp,
      expiresAt: timestamp + DEVICE_TTL_MS,
      status: 'pending',
      intervalSeconds: INITIAL_POLL_SECONDS,
      nextPollAt: timestamp + INITIAL_POLL_SECONDS * 1_000,
    };
    byDeviceCode.set(deviceCode, challenge);
    byUserCode.set(userCode.raw, challenge);
    byDeviceId.set(challenge.deviceId, challenge);
    byInstallation.set(key, challenge);
    return {
      device_code: deviceCode,
      user_code: userCode.display,
      verification_uri: input.verificationUri,
      verification_uri_complete: `${input.verificationUri}#code=${encodeURIComponent(userCode.display)}`,
      expires_in: 600,
      interval: INITIAL_POLL_SECONDS,
    };
  }

  function resolve(userCode: string, source: string): AgentAuthorizationDetails {
    const timestamp = now();
    checkRate(resolveRates, source, timestamp);
    pruneExpired(timestamp);
    const normalized = userCode.toUpperCase().replaceAll(/[^A-HJ-NP-Z2-9]/gu, '');
    return terminal(normalized.length === 8 ? byUserCode.get(normalized) : undefined);
  }

  function decide(
    deviceId: string,
    source: string,
    decision: 'approved' | 'denied',
  ): 'approved' | 'denied' | 'expired' | 'consumed' {
    const timestamp = now();
    checkRate(decisionRates, source, timestamp);
    pruneExpired(timestamp);
    const challenge = byDeviceId.get(deviceId);
    if (challenge === undefined) return 'expired';
    if (challenge.status === 'pending') challenge.status = decision;
    return challenge.status;
  }

  function poll(request: PollInput, _source: string): PollResult {
    const timestamp = now();
    pruneExpired(timestamp);
    const challenge = byDeviceCode.get(request.deviceCode);
    if (challenge === undefined) return { ok: false, error: 'expired_token' };
    if (challenge.clientId !== request.clientId) return { ok: false, error: 'invalid_client' };
    if (challenge.status === 'denied') return { ok: false, error: 'access_denied' };
    if (challenge.status === 'consumed') return { ok: true, token: challenge.issued! };
    if (timestamp < challenge.nextPollAt) {
      challenge.intervalSeconds += 5;
      challenge.nextPollAt = timestamp + challenge.intervalSeconds * 1_000;
      return { ok: false, error: 'slow_down', interval: challenge.intervalSeconds };
    }
    challenge.nextPollAt = timestamp + challenge.intervalSeconds * 1_000;
    if (challenge.status === 'pending') return { ok: false, error: 'authorization_pending' };
    let issued;
    try {
      issued = input.identity.issueCredential({
        installationId: challenge.installationId,
        target: challenge.target,
        adapterVersion: challenge.adapterVersion,
      });
    } catch (error) {
      if (error instanceof AgentInstallationTargetMismatchError)
        return { ok: false, error: 'invalid_grant' };
      throw error;
    }
    challenge.issued = {
      token_type: 'Bearer', access_token: issued.accessToken,
      refresh_token: issued.refreshToken, expires_in: issued.expiresIn,
    };
    challenge.issuedUntil = timestamp + CREDENTIAL_REPLAY_MS;
    challenge.status = 'consumed';
    releaseInstallationSlot(challenge);
    return { ok: true, token: challenge.issued };
  }

  return {
    create,
    resolve,
    approve: (deviceId, source) => decide(deviceId, source, 'approved'),
    deny: (deviceId, source) => decide(deviceId, source, 'denied'),
    poll,
  };
}
```

The cap applies to every unexpired challenge retained for polling idempotency,
including approved, denied, and consumed entries; this keeps the whole store
bounded rather than only its `pending` subset. The only plaintext token copy is
`Challenge.issued`, and pruning removes a consumed challenge and its result at
`issuedUntil = consumedAt + 30_000`; the original Device `expiresAt` no longer
participates after consumption. Consuming a challenge
removes only its `byInstallation` active-slot mapping; its device-code, user-code,
and device-id indexes remain until replay expiry, so a new same-installation
challenge cannot destroy the old idempotent result.

- [ ] **Step 5: Mount protocol and policy routes**

Create the concrete route builders in `routes.ts`:

```ts
type AgentOAuthRouteInput = {
  readonly challenges: DeviceChallengeStore;
  readonly identity: AgentIdentityService;
  readonly currentConfig: () => Config;
};
type AgentApprovalRouteInput = Pick<AgentOAuthRouteInput, 'challenges' | 'currentConfig'>;
type AgentAdminRouteInput = Pick<AgentOAuthRouteInput, 'identity' | 'currentConfig'>;

const requestPeer = (context: Context): string => {
  const env = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  const address = env?.requestIP?.(context.req.raw)?.address;
  if (address === undefined) throw new Error('loopback middleware admitted a request without a transport peer');
  return address;
};
const noStore = (context: Context): void => context.header('cache-control', 'no-store');
const oauthError = (context: Context, status: ContentfulStatusCode, error: AgentOAuthError['error']) => {
  noStore(context);
  return context.json({ error }, status);
};
const formValidator = <T>(schema: ZodType<T>) => validator('form', (raw, context) => {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : oauthError(context, 400, 'invalid_request');
});
const resolveValidator = validator('json', (raw, context) => {
  const parsed = AgentAuthorizationResolveRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'invalid_request' }, 400);
});
const challengeError = (context: Context, error: unknown) => {
  if (error instanceof DeviceChallengeError) {
    noStore(context);
    return context.json({ error: error.code }, error.status);
  }
  throw error;
};

export const createAgentOAuthRoutes = ({ challenges, identity, currentConfig }: AgentOAuthRouteInput) =>
  new Hono()
    .use('*', requireDashboardLoopback)
    .post('/device/code', formValidator(AgentDeviceCodeRequestSchema), (context) => {
      const body = context.req.valid('form');
      if (AGENT_CLIENT_ID[body.agent] !== body.client_id) return oauthError(context, 400, 'invalid_client');
      const server = currentConfig().server;
      if (server.apiKeys.length > 0 && server.password === undefined)
        return oauthError(context, 503, 'authorization_unavailable');
      try {
        const response = challenges.create(body, requestPeer(context));
        noStore(context);
        return context.json(response);
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/token', formValidator(AgentTokenRequestSchema), (context) => {
      const body = context.req.valid('form');
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const result = challenges.poll({ clientId: body.client_id, deviceCode: body.device_code }, requestPeer(context));
        if (!result.ok) {
          if (result.interval !== undefined) context.header('retry-after', String(result.interval));
          return oauthError(context, 400, result.error);
        }
        noStore(context);
        return context.json(result.token);
      }
      const result = identity.refreshCredential({ clientId: body.client_id, refreshToken: body.refresh_token });
      if (result.status !== 'success') return oauthError(context, 400, 'invalid_grant');
      noStore(context);
      return context.json({
        token_type: 'Bearer' as const, access_token: result.accessToken,
        refresh_token: result.refreshToken, expires_in: result.expiresIn,
      });
    });

const requireAgentApprovalOrigin: MiddlewareHandler = async (context, next) => {
  const origin = context.req.header('origin');
  const fetchSite = context.req.header('sec-fetch-site');
  if (origin !== new URL(context.req.url).origin ||
      (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none'))
    return context.json({ error: 'forbidden' }, 403);
  await next();
};

export const createAgentApprovalRoutes = ({ challenges, currentConfig }: AgentApprovalRouteInput) =>
  new Hono()
    .use('*', requireAgentApprovalOrigin)
    .use('*', async (context, next) => {
      const server = currentConfig().server;
      if (server.apiKeys.length > 0 && server.password === undefined)
        return context.json({ error: 'authorization_unavailable' }, 503);
      await next();
    })
    .post('/resolve', resolveValidator, (context) => {
      try {
        return context.json(challenges.resolve(context.req.valid('json').userCode, requestPeer(context)));
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/:deviceId/approve', (context) => {
      try {
        return context.json({ status: challenges.approve(context.req.param('deviceId'), requestPeer(context)) });
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/:deviceId/deny', (context) => {
      try {
        return context.json({ status: challenges.deny(context.req.param('deviceId'), requestPeer(context)) });
      } catch (error) {
        return challengeError(context, error);
      }
    });

export const createAgentAdminRoutes = ({ identity, currentConfig }: AgentAdminRouteInput) =>
  new Hono()
    .use('*', requireDashboardLoopback)
    .get('/', (context) => context.json({
      installations: identity.listInstallations(),
      deviceAuthorization: currentConfig().server.apiKeys.length > 0 && currentConfig().server.password === undefined
        ? 'password_required' as const : 'available' as const,
      catalogSchemaVersions: [1] as const,
    }))
    .post('/:installationId/revoke', (context) => {
      const installationId = context.req.param('installationId');
      if (!z.string().uuid().safeParse(installationId).success)
        return context.json({ error: 'invalid_request' }, 400);
      return context.json({ installationId, status: identity.revokeInstallation(installationId) });
    });
```

In `createRoutes`, create exactly one challenge store and mount it through this wiring after the existing `/dashboard/api/*` and `/admin/*` policy middleware:

```ts
// loopbackOriginHostname() already returns `[::1]` for an IPv6 loopback bind.
const approvalOrigin = `http://${expectedLoopbackHost}:${loopbackPort}`;
const challenges = createDeviceChallengeStore({
  identity: state.agentIdentity,
  verificationUri: new URL('/dashboard/agents/authorize', approvalOrigin).href,
});
const currentConfig = () => state.currentConfig();
const agentOAuthRoutes = createAgentOAuthRoutes({ challenges, identity: state.agentIdentity, currentConfig });
const agentApprovalRoutes = createAgentApprovalRoutes({ challenges, currentConfig });
const agentAdminRoutes = createAgentAdminRoutes({ identity: state.agentIdentity, currentConfig });

const routes = app
  .route('/oauth', agentOAuthRoutes)
  .route('/dashboard/api/agent-authorizations', agentApprovalRoutes)
  .route('/admin/agent-installations', agentAdminRoutes)
  .route('/', anthropicMessagesRoutes)
  .route('/', geminiGenerateContentRoutes)
  .route('/', openAICompletionsRoutes)
  .route('/', openAIResponsesRoutes)
  .route('/dashboard/api/auth', dashboardAuthRoutes)
  .route('/dashboard/api', dashboardRoutes);
```

Keep both existing `app.use('/dashboard/api/*', ...)` policy registrations before mounting
`agentApprovalRoutes`. They provide Dashboard session authentication while allowing a password-authenticated
remote Dashboard to approve a challenge created by a local plugin; do not put
`requireDashboardLoopback` on the approval sub-app. `expectedLoopbackHost` already comes from
`loopbackOriginHostname()`, so interpolating it above produces `http://[::1]:<port>` for IPv6. Add
`/oauth/device/code` and `/oauth/token` to the `honoLogger.skip` predicate; do not emit a second request
log containing form bodies. The Agent admin sub-app retains its own `requireDashboardLoopback`, even though
the surrounding generic admin control plane can be password-authenticated remotely. There is no public revoke
or introspection route.

- [ ] **Step 6: Run security and server tests GREEN**

Run: `bun test packages/server/src/agent-authorization packages/server/src/server/admin-reload.test.ts packages/server/src/server/server.test.ts`

Expected: PASS; forwarded headers cannot create challenges, Origin is never authentication, and no response/log includes a secret.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/agent-authorization packages/server/src/server/server.ts packages/server/src/server/admin-reload.test.ts
git commit -m "feat(server): add agent device authorization" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Dashboard Device Code approval page

**Files:**

- Create: `packages/dashboard/src/modules/agent-authorizations/services/agent-authorizations-service/agent-authorizations-service.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/services/agent-authorizations-service/index.ts`
- Test: `packages/dashboard/src/modules/agent-authorizations/services/agent-authorizations-service/agent-authorizations-service.test.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/lib/user-code/user-code.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/lib/user-code/index.ts`
- Test: `packages/dashboard/src/modules/agent-authorizations/lib/user-code/user-code.test.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/hooks/use-agent-authorization/use-agent-authorization.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/hooks/use-agent-authorization/index.ts`
- Create: `packages/dashboard/src/modules/agent-authorizations/templates/agent-authorization-page/agent-authorization-page.tsx`
- Create: `packages/dashboard/src/modules/agent-authorizations/templates/agent-authorization-page/index.ts`
- Test: `packages/dashboard/src/modules/agent-authorizations/templates/agent-authorization-page/agent-authorization-page.test.tsx`
- Create: `packages/dashboard/src/routes/agents/authorize.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify (generated): `packages/dashboard/src/route-tree.gen.ts`

**Interfaces:**

- Consumes: the typed Hono routes from Task 7 and the existing root authentication gate.
- Produces: `/dashboard/agents/authorize#code=XXXX-XXXX`, `normalizeAgentUserCode(value): string`, an `AgentAuthorizationRequestError`, a TanStack Form code input, and three TanStack Query mutations. No query cache key is added because resolve/approve/deny are commands and the page owns their returned state.

- [ ] **Step 1: Write failing pure-code and typed-service tests**

```ts
// packages/dashboard/src/modules/agent-authorizations/lib/user-code/user-code.test.ts
import { expect, test } from '@rstest/core';
import { normalizeAgentUserCode } from './user-code';

test.each([
  ['', ''], ['ab c-23de', 'ABC2-3DE'], ['abcd2345extra', 'ABCD-2345'],
  ['a!b@c#d$', 'ABCD'], ['io10abcd', 'ABCD'],
])('normalizes %j to %j without accepting more than eight symbols', (input, expected) => {
  expect(normalizeAgentUserCode(input)).toBe(expected);
});
```

```ts
// packages/dashboard/src/modules/agent-authorizations/services/agent-authorizations-service/agent-authorizations-service.test.ts
import { beforeEach, expect, rs, test } from '@rstest/core';
import { decideAgentAuthorization, resolveAgentAuthorization } from './agent-authorizations-service';

const mocks = rs.hoisted(() => ({ approve: rs.fn(), deny: rs.fn(), resolve: rs.fn() }));
rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: { dashboard: { api: { 'agent-authorizations': {
    resolve: { $post: mocks.resolve },
    ':deviceId': { approve: { $post: mocks.approve }, deny: { $post: mocks.deny } },
  } } } },
}));

beforeEach(() => {
  mocks.resolve.mockReset(); mocks.approve.mockReset(); mocks.deny.mockReset();
});

test('uses the typed resolve and decision routes', async () => {
  mocks.resolve.mockResolvedValue(Response.json({ status: 'expired' }));
  mocks.approve.mockResolvedValue(Response.json({ status: 'approved' }));
  await expect(resolveAgentAuthorization('ABCD-EFGH')).resolves.toEqual({ status: 'expired' });
  await expect(decideAgentAuthorization('device-id', 'approve')).resolves.toEqual({ status: 'approved' });
  expect(mocks.resolve).toHaveBeenCalledWith({ json: { userCode: 'ABCD-EFGH' } });
  expect(mocks.approve).toHaveBeenCalledWith({ param: { deviceId: 'device-id' }, json: {} });
});

test.each([
  [503, { error: 'authorization_unavailable' }, 'authorization_unavailable'],
  [404, { error: 'not_found' }, 'not_found'],
  [429, { error: 'rate_limited' }, 'rate_limited'],
] as const)('preserves stable error code for status %s', async (status, body, code) => {
  mocks.resolve.mockResolvedValue(Response.json(body, { status }));
  await expect(resolveAgentAuthorization('ABCD-EFGH')).rejects.toMatchObject({ status, code });
});
```

- [ ] **Step 2: Write failing page behavior tests**

```tsx
// packages/dashboard/src/modules/agent-authorizations/templates/agent-authorization-page/agent-authorization-page.test.tsx
import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentAuthorizationPage } from './agent-authorization-page';

const mocks = rs.hoisted(() => ({ approve: rs.fn(), deny: rs.fn(), resolve: rs.fn() }));
rs.mock('@aio-proxy/i18n', () => ({ m: {
  'dashboard.agent_authorization.title': () => 'Authorize aio-proxy',
  'dashboard.agent_authorization.instructions': () => 'Enter the code shown by your Agent.',
  'dashboard.agent_authorization.code_label': () => 'Authorization code',
  'dashboard.agent_authorization.code_placeholder': () => 'ABCD-EFGH',
  'dashboard.agent_authorization.code_invalid': () => 'Enter the eight-character code.',
  'dashboard.agent_authorization.permissions_title': () => 'Requested access',
  'dashboard.agent_authorization.permission_catalog': () => 'Read the model catalog',
  'dashboard.agent_authorization.permission_inference': () => 'Run model inference',
  'dashboard.agent_authorization.target': () => 'Agent',
  'dashboard.agent_authorization.installation': () => 'Installation ID',
  'dashboard.agent_authorization.version': () => 'Adapter version',
  'dashboard.agent_authorization.expires': () => 'Expires',
  'dashboard.agent_authorization.resolve': () => 'Continue',
  'dashboard.agent_authorization.approve': () => 'Approve',
  'dashboard.agent_authorization.deny': () => 'Deny',
  'dashboard.agent_authorization.pending': () => 'Waiting for your decision.',
  'dashboard.agent_authorization.approved': () => 'Authorization approved.',
  'dashboard.agent_authorization.denied': () => 'Authorization denied.',
  'dashboard.agent_authorization.expired': () => 'This authorization code expired.',
  'dashboard.agent_authorization.consumed': () => 'This authorization code was already used.',
  'dashboard.agent_authorization.password_required': () => 'Set a Dashboard password.',
  'dashboard.agent_authorization.network_error': () => 'aio-proxy is unavailable.',
  'dashboard.agent_authorization.retry': () => 'Use another code',
} }));
rs.mock('../../services/agent-authorizations-service', () => ({
  resolveAgentAuthorization: mocks.resolve,
  decideAgentAuthorization: (deviceId: string, decision: 'approve' | 'deny') =>
    decision === 'approve' ? mocks.approve(deviceId) : mocks.deny(deviceId),
}));

const PENDING = {
  status: 'pending', deviceId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09', target: 'opencode',
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', adapterVersion: '1.2.3',
  expiresAt: '2026-08-18T12:10:00.000Z', permissions: ['catalog', 'inference'],
} as const;
const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <AgentAuthorizationPage />
  </QueryClientProvider>,
);

beforeEach(() => {
  mocks.resolve.mockReset(); mocks.approve.mockReset(); mocks.deny.mockReset();
  window.history.replaceState({}, '', '/dashboard/agents/authorize');
});

test('consumes a fragment only after the authenticated page mounts and shows no credential', async () => {
  window.history.replaceState({}, '', '/dashboard/agents/authorize#code=abcd-efgh');
  mocks.resolve.mockResolvedValue(PENDING);
  const authGate = render(<div>Dashboard sign in</div>);
  expect(window.location.pathname).toBe('/dashboard/agents/authorize');
  expect(window.location.hash).toBe('#code=abcd-efgh');
  authGate.unmount();
  const view = renderPage();
  expect(screen.getByLabelText(/code/i)).toHaveValue('ABCD-EFGH');
  expect(window.location.pathname).toBe('/dashboard/agents/authorize');
  expect(window.location.hash).toBe('');
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  expect(await screen.findByText('opencode')).toBeInTheDocument();
  expect(screen.getByText(PENDING.installationId)).toBeInTheDocument();
  expect(screen.getByText('1.2.3')).toBeInTheDocument();
  expect(screen.getByText(/model catalog/i)).toBeInTheDocument();
  expect(screen.getByText(/inference/i)).toBeInTheDocument();
  expect(view.container.textContent).not.toMatch(/aio_agent_|device[_-]code/iu);
});

test('approves and denies only the resolved opaque device id', async () => {
  mocks.resolve.mockResolvedValue(PENDING);
  mocks.approve.mockResolvedValue({ status: 'approved' });
  mocks.deny.mockResolvedValue({ status: 'denied' });
  renderPage();
  fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /approve/i }));
  await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(PENDING.deviceId));
  expect(await screen.findByText(/approved/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /retry|another/i }));
  fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
  await screen.findByText('opencode');
  fireEvent.click(screen.getByRole('button', { name: /deny/i }));
  await waitFor(() => expect(mocks.deny).toHaveBeenCalledWith(PENDING.deviceId));
});

test.each([
  ['approved', /approved/i], ['denied', /denied/i], ['expired', /expired/i], ['consumed', /already used/i],
] as const)(
  'renders the %s terminal state returned by resolve', async (status, message) => {
    mocks.resolve.mockResolvedValue({ status });
    renderPage();
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: 'ABCD-EFGH' } });
    fireEvent.click(screen.getByRole('button', { name: /continue|resolve/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  },
);
```

- [ ] **Step 3: Run tests to verify RED**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- agent-authorizations agent-authorization-page`

Expected: FAIL because the route/module/messages do not exist.

- [ ] **Step 4: Implement the pure normalizer, typed service, and mutation hook**

```ts
// lib/user-code/user-code.ts
export const normalizeAgentUserCode = (value: string): string => {
  const raw = value.toUpperCase().replaceAll(/[^A-HJ-NP-Z2-9]/gu, '').slice(0, 8);
  return raw.length <= 4 ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
};
```

```ts
// services/agent-authorizations-service/agent-authorizations-service.ts
import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { dashboardClient } from '@/lib/dashboard-client';

export class AgentAuthorizationRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`agent authorization request failed: ${status} ${code}`);
  }
}

const requireOk = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({})) as { readonly error?: unknown };
  if (!response.ok) throw new AgentAuthorizationRequestError(
    response.status, typeof body.error === 'string' ? body.error : 'request_failed',
  );
  return body as T;
};

export const resolveAgentAuthorization = async (userCode: string): Promise<AgentAuthorizationDetails> => {
  const response = await dashboardClient.dashboard.api['agent-authorizations'].resolve.$post({
    json: { userCode },
  });
  return requireOk(response);
};

export const decideAgentAuthorization = async (
  deviceId: string,
  decision: 'approve' | 'deny',
): Promise<{ readonly status: 'approved' | 'denied' | 'expired' | 'consumed' }> => {
  const routes = dashboardClient.dashboard.api['agent-authorizations'][':deviceId'];
  const response = decision === 'approve'
    ? await routes.approve.$post({ param: { deviceId }, json: {} })
    : await routes.deny.$post({ param: { deviceId }, json: {} });
  return requireOk(response);
};
```

```ts
// hooks/use-agent-authorization/use-agent-authorization.ts
import { useMutation } from '@tanstack/react-query';
import { decideAgentAuthorization, resolveAgentAuthorization } from '../../services/agent-authorizations-service';

export const useAgentAuthorization = () => {
  const resolve = useMutation({ mutationFn: resolveAgentAuthorization });
  const approve = useMutation({ mutationFn: (deviceId: string) => decideAgentAuthorization(deviceId, 'approve') });
  const deny = useMutation({ mutationFn: (deviceId: string) => decideAgentAuthorization(deviceId, 'deny') });
  return {
    resolve, approve, deny,
    reset: () => { resolve.reset(); approve.reset(); deny.reset(); },
  };
};
```

Each `index.ts` is export-only. No hook invalidates a cache key: the returned command state belongs to this page and disappears when the page unmounts.

- [ ] **Step 5: Implement the route and single page component**

```tsx
// templates/agent-authorization-page/agent-authorization-page.tsx
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';
import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { normalizeAgentUserCode } from '../../lib/user-code';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';

const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const terminalMessage = (status: 'approved' | 'denied' | 'expired' | 'consumed'): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

export const AgentAuthorizationPage: React.FC = () => {
  const authorization = useAgentAuthorization();
  const form = useForm({
    defaultValues: { userCode: '' },
    onSubmit: ({ value }) => {
      authorization.approve.reset(); authorization.deny.reset();
      authorization.resolve.mutate(value.userCode);
    },
  });
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    if (code !== null) form.setFieldValue('userCode', normalizeAgentUserCode(code));
    if (window.location.hash !== '')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [form]);

  const result = authorization.approve.data ?? authorization.deny.data ?? authorization.resolve.data;
  const pending = result?.status === 'pending' ? result : undefined;
  const isPending = authorization.resolve.isPending || authorization.approve.isPending || authorization.deny.isPending;
  const error = authorization.resolve.error ?? authorization.approve.error ?? authorization.deny.error;
  const errorMessage = error instanceof AgentAuthorizationRequestError && error.code === 'authorization_unavailable'
    ? m['dashboard.agent_authorization.password_required']()
    : m['dashboard.agent_authorization.network_error']();

  return (
    <main className="mx-auto flex min-h-full max-w-2xl items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle><h1>{m['dashboard.agent_authorization.title']()}</h1></CardTitle>
          <CardDescription>{m['dashboard.agent_authorization.instructions']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {result === undefined ? (
            <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
              <form.Field name="userCode" validators={{ onSubmit: ({ value }) =>
                codeSchema.safeParse(value).success ? undefined : m['dashboard.agent_authorization.code_invalid']() }}>
                {(field) => <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                  <FieldLabel htmlFor="agent-user-code">{m['dashboard.agent_authorization.code_label']()}</FieldLabel>
                  <Input id="agent-user-code" autoComplete="one-time-code" value={field.state.value}
                    placeholder={m['dashboard.agent_authorization.code_placeholder']()}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(normalizeAgentUserCode(event.target.value))} />
                  <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
                </Field>}
              </form.Field>
              <Button type="submit" disabled={isPending}>{m['dashboard.agent_authorization.resolve']()}</Button>
            </form>
          ) : null}

          {pending === undefined ? null : <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
            <h2>{m['dashboard.agent_authorization.permissions_title']()}</h2>
            <p>{m['dashboard.agent_authorization.pending']()}</p>
            <dl>
              <dt>{m['dashboard.agent_authorization.target']()}</dt><dd>{pending.target}</dd>
              <dt>{m['dashboard.agent_authorization.installation']()}</dt><dd>{pending.installationId}</dd>
              <dt>{m['dashboard.agent_authorization.version']()}</dt><dd>{pending.adapterVersion}</dd>
              <dt>{m['dashboard.agent_authorization.expires']()}</dt><dd>{new Date(pending.expiresAt).toLocaleString()}</dd>
            </dl>
            <ul>
              <li>{m['dashboard.agent_authorization.permission_catalog']()}</li>
              <li>{m['dashboard.agent_authorization.permission_inference']()}</li>
            </ul>
            <div className="flex gap-3">
              <Button disabled={isPending} onClick={() => authorization.approve.mutate(pending.deviceId)}>
                {m['dashboard.agent_authorization.approve']()}
              </Button>
              <Button variant="outline" disabled={isPending} onClick={() => authorization.deny.mutate(pending.deviceId)}>
                {m['dashboard.agent_authorization.deny']()}
              </Button>
            </div>
          </section>}

          {result !== undefined && result.status !== 'pending' ? <section role="status">
            <p>{terminalMessage(result.status)}</p>
            <Button variant="outline" onClick={authorization.reset}>{m['dashboard.agent_authorization.retry']()}</Button>
          </section> : null}
          {error === null || error === undefined ? null : <p role="alert">{errorMessage}</p>}
        </CardContent>
      </Card>
    </main>
  );
};
```

Do not render `error.message`; it may contain transport detail. The two fixed localized categories above are the complete user-visible error surface for this page.

```tsx
// packages/dashboard/src/routes/agents/authorize.tsx
import { createFileRoute } from '@tanstack/react-router';
import { AgentAuthorizationPage } from '@/modules/agent-authorizations/templates/agent-authorization-page';

export const Route = createFileRoute('/agents/authorize')({ component: AgentAuthorizationPage });
```

Use the shared Card, Field, Input, and Button primitives only; do not add a UI dependency or a second React component to the page file.

- [ ] **Step 6: Add complete five-locale copy and generate artifacts**

Add the following exact keys. Use the values in the corresponding locale column; do not copy English into the other locale files.

| Key suffix after `dashboard.agent_authorization.` | English | 日本語 | 한국어 | 简体中文 | 繁體中文 |
| --- | --- | --- | --- | --- | --- |
| `title` | Authorize aio-proxy | aio-proxy を承認 | aio-proxy 승인 | 授权 aio-proxy | 授權 aio-proxy |
| `instructions` | Enter the code shown by your Agent. | Agent に表示されたコードを入力してください。 | Agent에 표시된 코드를 입력하세요. | 输入 Agent 中显示的代码。 | 輸入 Agent 中顯示的代碼。 |
| `code_label` | Authorization code | 承認コード | 승인 코드 | 授权码 | 授權碼 |
| `code_placeholder` | ABCD-EFGH | ABCD-EFGH | ABCD-EFGH | ABCD-EFGH | ABCD-EFGH |
| `code_invalid` | Enter the eight-character code. | 8 文字のコードを入力してください。 | 8자리 코드를 입력하세요. | 请输入 8 位授权码。 | 請輸入 8 位授權碼。 |
| `permissions_title` | Requested access | 要求されたアクセス | 요청된 액세스 | 请求的权限 | 要求的權限 |
| `permission_catalog` | Read the model catalog | モデルカタログの読み取り | 모델 카탈로그 읽기 | 读取模型目录 | 讀取模型目錄 |
| `permission_inference` | Run model inference | モデル推論の実行 | 모델 추론 실행 | 调用模型推理 | 呼叫模型推理 |
| `target` | Agent | Agent | Agent | Agent | Agent |
| `installation` | Installation ID | インストール ID | 설치 ID | 安装 ID | 安裝 ID |
| `version` | Adapter version | アダプターバージョン | 어댑터 버전 | 适配器版本 | 轉接器版本 |
| `expires` | Expires | 有効期限 | 만료 | 过期时间 | 到期時間 |
| `resolve` | Continue | 続行 | 계속 | 继续 | 繼續 |
| `approve` | Approve | 承認 | 승인 | 批准 | 批准 |
| `deny` | Deny | 拒否 | 거부 | 拒绝 | 拒絕 |
| `pending` | Waiting for your decision. | 承認待ちです。 | 결정을 기다리는 중입니다. | 等待你的决定。 | 等待你的決定。 |
| `approved` | Authorization approved. Return to your Agent. | 承認しました。Agent に戻ってください。 | 승인이 완료되었습니다. Agent로 돌아가세요. | 已批准授权，请返回 Agent。 | 已批准授權，請返回 Agent。 |
| `denied` | Authorization denied. | 承認を拒否しました。 | 승인이 거부되었습니다. | 已拒绝授权。 | 已拒絕授權。 |
| `expired` | This authorization code expired. | この承認コードは期限切れです。 | 이 승인 코드는 만료되었습니다. | 此授权码已过期。 | 此授權碼已過期。 |
| `consumed` | This authorization code was already used. | この承認コードは使用済みです。 | 이 승인 코드는 이미 사용되었습니다. | 此授权码已使用。 | 此授權碼已使用。 |
| `password_required` | Set a Dashboard password before approving Agent access. | Agent アクセスを承認する前に Dashboard パスワードを設定してください。 | Agent 액세스를 승인하기 전에 Dashboard 비밀번호를 설정하세요. | 请先设置 Dashboard 密码，再批准 Agent 访问。 | 請先設定 Dashboard 密碼，再批准 Agent 存取。 |
| `network_error` | aio-proxy is unavailable. Check the server and try again. | aio-proxy に接続できません。サーバーを確認して再試行してください。 | aio-proxy에 연결할 수 없습니다. 서버를 확인하고 다시 시도하세요. | 无法连接 aio-proxy，请检查服务后重试。 | 無法連線 aio-proxy，請檢查服務後重試。 |
| `retry` | Use another code | 別のコードを使う | 다른 코드 사용 | 使用其他授权码 | 使用其他授權碼 |

Run: `bun run i18n:compile && bun run --filter @aio-proxy/dashboard build`

Expected: Paraglide accessors and `route-tree.gen.ts` regenerate; the route remains `/agents/authorize` under the Dashboard base.

- [ ] **Step 7: Run Dashboard tests GREEN**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- agent-authorizations agent-authorization-page login-page`

Expected: PASS, including login-route preservation and all terminal states.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/modules/agent-authorizations packages/dashboard/src/routes/agents/authorize.tsx packages/dashboard/src/route-tree.gen.ts packages/i18n/messages packages/i18n/src/paraglide
git commit -m "feat(dashboard): approve agent installations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 9: Control-plane integration verification

**Files:**

- No new files. This task is a verification gate over the files committed in Tasks 1–8.

**Interfaces:**

- Consumes: Tasks 1–8.
- Produces: a control plane and shared runtime ready for the two host adapter plans.

- [ ] **Step 1: Run focused end-to-end server coverage**

Run: `bun test packages/core/src/agent-identity packages/core/src/db/ownership-lock packages/server/src/agent-authorization packages/server/src/server-state/database-ownership.test.ts packages/server/src/server/agent-auth packages/server/src/server/list-models`

Expected: PASS with no network access, no plaintext token in test database dumps/log captures, and no second hot token index for one database path.

- [ ] **Step 2: Run package builds and static checks**

Run: `bun run --filter @aio-proxy/types build && bun run --filter @aio-proxy/core build && bun run --filter @aio-proxy/agent-provider-runtime build && bun run --filter @aio-proxy/server test:unit && bun run --filter @aio-proxy/dashboard build && bun run check`

Expected: PASS. Generated types expose no OpenCode/Pi/OMP SDK type from `@aio-proxy/types` or the server.

- [ ] **Step 3: Run migration and diff hygiene checks**

Run: `bun run build:migrations && git diff --check && git status --short`

Expected: migration generation reports the manifest verified with no second migration; diff check emits nothing; status contains only planned files.
