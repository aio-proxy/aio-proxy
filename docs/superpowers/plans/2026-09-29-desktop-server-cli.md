# Desktop Client — Phase 1 (Server + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add everything the macOS desktop client needs from the existing TypeScript side: a local desktop token, the versioned `GET /dashboard/api/desktop-summary` endpoint, non-blocking quota state, the hidden `__desktop-connect` discovery command, and the launchd/upgrade changes that let a desktop-owned service coexist with CLI installs.

**Architecture:** A same-user local token file (created by the server at boot, read-only for the CLI) authorizes exactly one loopback `GET` route. The route maps existing trace-store, provider, and quota-cache data into a strict v1 DTO and never awaits upstream quota reads. The CLI gains a discovery command that reports plist, launchd job, and HTTP instance facts separately, plus service/upgrade changes keyed on `AIO_PROXY_DESKTOP_EXEC`.

**Tech Stack:** Bun, TypeScript, Hono, zod v4, bun:test, launchd (`launchctl`, `plutil`).

**Spec:** `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (Phase 1 of its Phasing section). Do not start this plan until the Phase 0 spike (`docs/superpowers/plans/2026-09-29-desktop-spike.md`) reports go.

## Global Constraints

- The desktop token authorizes exactly one route: `GET /dashboard/api/desktop-summary`. `DashboardAuthentication.verify()` is not changed. No other route accepts the token.
- The token is accepted only from a loopback socket peer (`isDashboardLoopbackRequest`, Bun `requestIP`), never based on `Host`, `Origin`, or `X-Forwarded-For`.
- Token file: `$AIO_PROXY_HOME/desktop-token`, 32 CSPRNG bytes base64url (43 chars), mode `0600`, created by the server only, never overwritten or permission-repaired; the server loads it once at boot.
- `desktop-summary` never awaits an upstream quota read.
- DTO field names, types and enums exactly as the spec's `DesktopSummaryV1` block; `protocolVersion: 1`.
- `__desktop-connect` prints exactly one JSON object on stdout and nothing else; partial failures degrade fields, never abort.
- No automatic mutation of an external service; `service restart` is never the path for an external plist (desktop app responsibility, but nothing here may weaken it).
- Colocated tests: `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`. Non-test files stay under 500 lines.
- Before completion: `bun run preflight` (or `bun run check` plus affected package tests), and a build followed by `bun run lint:types`.
- Changeset targets `aio-proxy` plus each touched internal package, same bump level.

## Review Focus

- A config whose `server.host` is `localhost` or `::1` (not only wildcards) must yield a literal loopback `controlUrl` — pinned in Task 10.
- A plist edited by hand so it lacks `EnvironmentVariables.AIO_PROXY_HOME` must fall back to the default home, not crash discovery — pinned in Task 11.
- A server created with neither `configPath` nor `dbHome` (embedded use, many tests) must boot and answer 401 — pinned in Task 5.
- A Provider whose quota capability is permanently unavailable must report `unsupported`, not `loading` forever — pinned in Task 4.
- A token file written by hand with a trailing newline must still be accepted — pinned in Task 1.

---

### Task 1: Desktop token file (core)

**Files:**
- Create: `packages/core/src/desktop-token/index.ts`
- Create: `packages/core/src/desktop-token/desktop-token.ts`
- Create: `packages/core/src/desktop-token/desktop-token.test.ts`
- Modify: `packages/core/src/index.ts` (add export next to the `paths` export at line 244)

**Interfaces:**
- Produces:
  - `DESKTOP_TOKEN_FILE: 'desktop-token'`
  - `readDesktopToken(home: string, options?: { readonly uid?: number }): string | undefined`
  - `ensureDesktopToken(home: string, options?: { readonly uid?: number }): string` (throws `Error` whose message starts with `desktop token file rejected:` when a file exists but fails checks)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/desktop-token/desktop-token.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DESKTOP_TOKEN_FILE, ensureDesktopToken, readDesktopToken } from './desktop-token';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aio-desktop-token-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const tokenPath = () => join(home, DESKTOP_TOKEN_FILE);
const validToken = 'A'.repeat(43);

test('creates a private token once and returns the same value afterwards', () => {
  const first = ensureDesktopToken(home);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  expect(ensureDesktopToken(home)).toBe(first);
  expect(readDesktopToken(home)).toBe(first);
});

test('never replaces an existing valid token, including one with a trailing newline', () => {
  writeFileSync(tokenPath(), `${validToken}\n`, { mode: 0o600 });
  expect(ensureDesktopToken(home)).toBe(validToken);
  expect(readFileSync(tokenPath(), 'utf8')).toBe(`${validToken}\n`);
});

test('a missing file reads as no token', () => {
  expect(readDesktopToken(home)).toBeUndefined();
});

for (const [name, arrange] of [
  ['group-readable', () => {
    writeFileSync(tokenPath(), validToken, { mode: 0o600 });
    chmodSync(tokenPath(), 0o640);
  }],
  ['a symlink', () => {
    const target = join(home, 'elsewhere');
    writeFileSync(target, validToken, { mode: 0o600 });
    symlinkSync(target, tokenPath());
  }],
  ['malformed', () => writeFileSync(tokenPath(), 'short', { mode: 0o600 })],
] as const) {
  test(`a ${name} token file is rejected and left untouched`, () => {
    arrange();
    const before = readFileSync(tokenPath(), 'utf8');
    expect(readDesktopToken(home)).toBeUndefined();
    expect(() => ensureDesktopToken(home)).toThrow(/^desktop token file rejected:/u);
    expect(readFileSync(tokenPath(), 'utf8')).toBe(before);
  });
}

test('a token file owned by another uid is rejected', () => {
  writeFileSync(tokenPath(), validToken, { mode: 0o600 });
  const otherUid = (process.getuid?.() ?? 0) + 1;
  expect(readDesktopToken(home, { uid: otherUid })).toBeUndefined();
  expect(() => ensureDesktopToken(home, { uid: otherUid })).toThrow(/owned by another user/u);
});

test('concurrent creators in separate processes agree on one token', async () => {
  const modulePath = join(import.meta.dir, 'desktop-token.ts');
  for (let round = 0; round < 10; round += 1) {
    const roundHome = join(home, `round-${round}`);
    const script = `import { ensureDesktopToken } from ${JSON.stringify(modulePath)}; console.log(ensureDesktopToken(${JSON.stringify(roundHome)}));`;
    const runs = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
    const outputs = await Promise.all(runs.map(async (proc) => (await new Response(proc.stdout).text()).trim()));
    expect(outputs[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(outputs[1]).toBe(outputs[0]);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test src/desktop-token`
Expected: FAIL — `Cannot find module './desktop-token'`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/desktop-token/desktop-token.ts
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const DESKTOP_TOKEN_FILE = 'desktop-token';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type TokenOptions = { readonly uid?: number };
type Inspection = { readonly token: string } | { readonly missing: true } | { readonly rejected: string };

function inspect(path: string, options: TokenOptions): Inspection {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { rejected: `cannot stat (${(error as Error).message})` };
  }
  // lstat does not follow links, so a symlink is not a regular file here.
  if (!stat.isFile()) return { rejected: 'not a regular file' };
  const uid = options.uid ?? process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return { rejected: 'owned by another user' };
  if ((stat.mode & 0o077) !== 0) return { rejected: 'readable or writable by group or others' };
  const token = readFileSync(path, 'utf8').trim();
  return TOKEN_PATTERN.test(token) ? { token } : { rejected: 'malformed contents' };
}

/** The desktop token, or `undefined` when the file is missing or fails the ownership and permission checks. */
export function readDesktopToken(home: string, options: TokenOptions = {}): string | undefined {
  const result = inspect(join(home, DESKTOP_TOKEN_FILE), options);
  return 'token' in result ? result.token : undefined;
}

/**
 * Returns the desktop token, creating it when absent. A present file that fails the checks is never
 * overwritten or repaired: that would silently hand a token to whoever planted the file.
 */
export function ensureDesktopToken(home: string, options: TokenOptions = {}): string {
  const path = join(home, DESKTOP_TOKEN_FILE);
  const existing = inspect(path, options);
  if ('token' in existing) return existing.token;
  if ('rejected' in existing) throw new Error(`desktop token file rejected: ${existing.rejected}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, randomBytes(32).toString('base64url'));
  } finally {
    closeSync(fd);
  }
  try {
    // link() never replaces an existing name, so a concurrent creator that got there first keeps its token.
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temp);
  }
  const created = inspect(path, options);
  if ('token' in created) return created.token;
  throw new Error(`desktop token file rejected: ${'rejected' in created ? created.rejected : 'missing after create'}`);
}
```

```ts
// packages/core/src/desktop-token/index.ts
export { DESKTOP_TOKEN_FILE, ensureDesktopToken, readDesktopToken } from './desktop-token';
```

In `packages/core/src/index.ts`, next to line 244 (`export { aioHome, configPath, ... } from './paths/index';`), add:

```ts
export { DESKTOP_TOKEN_FILE, ensureDesktopToken, readDesktopToken } from './desktop-token/index';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test src/desktop-token`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/desktop-token packages/core/src/index.ts
git commit -m "feat(core): add local desktop token file"
```

---

### Task 2: `DesktopSummaryV1` schema and golden fixture (types)

**Files:**
- Create: `packages/types/src/desktop-summary/index.ts`
- Create: `packages/types/src/desktop-summary/desktop-summary.ts`
- Create: `packages/types/src/desktop-summary/desktop-summary.test.ts`
- Create: `packages/types/src/desktop-summary/fixtures/v1.json`
- Modify: `packages/types/src/index.ts` (add `export * from './desktop-summary/index';` after the `dashboard-provider-mutation` export)

**Interfaces:**
- Produces: `DesktopSummaryV1Schema`, `type DesktopSummaryV1`, `type DesktopQuota`, `type DesktopProvider`. The fixture file is the golden input for the Phase 2 Rust parser; keep its path stable.

- [ ] **Step 1: Write the fixture and the failing test**

```json
{
  "protocolVersion": 1,
  "generatedAt": "2026-09-29T08:00:00.000Z",
  "server": { "version": "0.36.0", "pid": 4312 },
  "usage24h": {
    "requests": "257",
    "failedRequests": "53",
    "inputTokens": "14815402",
    "outputTokens": "44305",
    "estimatedCostNanoUsd": "20521353840",
    "pricingCoverage": 1
  },
  "trend7d": [
    { "start": "2026-09-28T16:00:00.000Z", "requests": "257", "totalTokens": "14859707", "estimatedCostNanoUsd": "20521353840" }
  ],
  "activity": [{ "date": "2026-09-29", "totalTokens": "14859707" }],
  "providers": [
    {
      "id": "codex",
      "name": "Codex",
      "enabled": true,
      "state": "ok",
      "diagnostic": null,
      "quota": {
        "status": "ready",
        "sampledAt": "2026-09-29T07:58:00.000Z",
        "refreshFailed": false,
        "windows": [
          { "id": "primary", "label": { "en": "5 hours", "zh-Hans": "5 小时" }, "remainingRatio": 0.4, "resetsAt": "2026-09-29T10:00:00.000Z", "windowMinutes": 300 }
        ]
      }
    },
    {
      "id": "cursor",
      "name": "cursor",
      "enabled": true,
      "state": "degraded",
      "diagnostic": { "code": "CREDENTIAL_REFRESH_FAILED", "summary": "Refresh token expired" },
      "quota": { "status": "loading" }
    }
  ],
  "alerts": [{ "providerId": "cursor", "kind": "diagnostic", "message": "Refresh token expired" }]
}
```

```ts
// packages/types/src/desktop-summary/desktop-summary.test.ts
import { expect, test } from 'bun:test';

import fixture from './fixtures/v1.json' with { type: 'json' };
import { DesktopSummaryV1Schema } from './desktop-summary';

// The same file is the Rust parser's golden input; a schema change that breaks it breaks the desktop app.
test('the shared v1 fixture is a valid desktop summary', () => {
  expect(DesktopSummaryV1Schema.safeParse(fixture).success).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/types && bun test src/desktop-summary`
Expected: FAIL — `Cannot find module './desktop-summary'`.

- [ ] **Step 3: Implement the schema**

```ts
// packages/types/src/desktop-summary/desktop-summary.ts
import { z } from 'zod';

import { NonNegativeIntegerStringSchema } from '../dashboard/dashboard';
import { DashboardLocalizedTextSchema } from '../dashboard-localized-text';

// Every object is strict: this DTO is a cross-version contract with a native client, so an internal
// field leaking into it must fail the server's tests instead of silently becoming API.
const DesktopQuotaWindowSchema = z
  .object({
    id: z.string().min(1),
    label: DashboardLocalizedTextSchema,
    remainingRatio: z.number().min(0).max(1).nullable(),
    resetsAt: z.iso.datetime().nullable(),
    windowMinutes: z.number().int().positive().nullable(),
  })
  .strict();

export const DesktopQuotaSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('unsupported') }).strict(),
  z.object({ status: z.literal('loading') }).strict(),
  z.object({ status: z.literal('failed') }).strict(),
  z
    .object({
      status: z.literal('ready'),
      sampledAt: z.iso.datetime(),
      refreshFailed: z.boolean(),
      windows: z.array(DesktopQuotaWindowSchema),
    })
    .strict(),
]);

export const DesktopProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    state: z.enum(['ok', 'degraded', 'unavailable', 'disabled']),
    diagnostic: z.object({ code: z.string().min(1), summary: z.string().min(1) }).strict().nullable(),
    quota: DesktopQuotaSchema,
  })
  .strict();

export const DesktopSummaryV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    server: z.object({ version: z.string().min(1), pid: z.number().int().positive() }).strict(),
    usage24h: z
      .object({
        requests: NonNegativeIntegerStringSchema,
        failedRequests: NonNegativeIntegerStringSchema,
        inputTokens: NonNegativeIntegerStringSchema,
        outputTokens: NonNegativeIntegerStringSchema,
        estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
        pricingCoverage: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    trend7d: z.array(
      z
        .object({
          start: z.iso.datetime(),
          requests: NonNegativeIntegerStringSchema,
          totalTokens: NonNegativeIntegerStringSchema,
          estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
        })
        .strict(),
    ),
    activity: z.array(z.object({ date: z.iso.date(), totalTokens: NonNegativeIntegerStringSchema }).strict()),
    providers: z.array(DesktopProviderSchema),
    alerts: z.array(
      z
        .object({
          providerId: z.string().min(1),
          kind: z.enum(['diagnostic', 'quota_exhausted']),
          message: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type DesktopQuota = z.output<typeof DesktopQuotaSchema>;
export type DesktopProvider = z.output<typeof DesktopProviderSchema>;
export type DesktopSummaryV1 = z.output<typeof DesktopSummaryV1Schema>;
```

```ts
// packages/types/src/desktop-summary/index.ts
export {
  DesktopProviderSchema,
  DesktopQuotaSchema,
  DesktopSummaryV1Schema,
  type DesktopProvider,
  type DesktopQuota,
  type DesktopSummaryV1,
} from './desktop-summary';
```

Check `DashboardLocalizedTextSchema` accepts both a plain string and a locale map (read `packages/types/src/dashboard-localized-text.ts`); if it rejects the fixture's `{ "en": …, "zh-Hans": … }` shape, replace it in `DesktopQuotaWindowSchema` with `z.union([z.string().min(1), z.record(z.string(), z.string().min(1))])`.

- [ ] **Step 4: Run tests**

Run: `cd packages/types && bun test src/desktop-summary && bun test src/package-export.test.ts`
Expected: PASS. If `package-export.test.ts` enumerates public exports, add the new names where it expects them.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/desktop-summary packages/types/src/index.ts
git commit -m "feat(types): add desktop summary v1 schema"
```

---

### Task 3: Quota cache `status()` and `refresh()`

**Files:**
- Modify: `packages/server/src/plugin-quota/cache/quota-cache.ts` (type at lines 18-22, returned object at lines 121-138)
- Modify: `packages/server/src/plugin-quota/cache/index.ts` (export the new type)
- Modify: `packages/server/src/server-state/quota-invalidation/quota-invalidation.test.ts:8-20` (the `recordingCache` fake must satisfy the widened type)
- Test: `packages/server/src/plugin-quota/cache/quota-cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OAuthQuotaCacheStatus =
    | { readonly kind: 'none' | 'unsupported' | 'loading' | 'failed' }
    | { readonly kind: 'ready'; readonly entry: OAuthQuotaCacheEntry };
  // added to OAuthQuotaCache:
  readonly status: (providerId: string) => OAuthQuotaCacheStatus;
  readonly refresh: (providerId: string) => void;
  ```

- [ ] **Step 1: Write the failing tests** (append to `quota-cache.test.ts`)

```ts
const never = (): OAuthQuotaReader => ({ read: () => new Promise<OAuthQuotaSnapshot>(() => {}) });

test('status reports loading while a first read is in flight and none before any read', () => {
  const cache = createOAuthQuotaCache(never());
  expect(cache.status('p').kind).toBe('none');
  cache.warm('p');
  expect(cache.status('p').kind).toBe('loading');
});

test('status tells a failed first read apart from one still loading', async () => {
  const cache = createOAuthQuotaCache(countingReader([new Error('upstream down')]));
  await cache.read('p').catch(() => {});
  expect(cache.status('p').kind).toBe('failed');
});

test('status keeps serving the old snapshot, flagged stale, after a failed refresh', async () => {
  const cache = createOAuthQuotaCache(countingReader([snapshot('a'), new Error('upstream down')]));
  await cache.read('p');
  await cache.read('p', true);
  const status = cache.status('p');
  expect(status.kind).toBe('ready');
  if (status.kind === 'ready') {
    expect(status.entry.snapshot).toEqual(snapshot('a'));
    expect(status.entry.stale).toBe(true);
  }
});

test('status reports a permanently unsupported provider as unsupported', async () => {
  const cache = createOAuthQuotaCache(countingReader([new OAuthQuotaCapabilityUnavailableError(true)]));
  await cache.read('p').catch(() => {});
  expect(cache.status('p').kind).toBe('unsupported');
});

test('refresh bypasses the cooldown in the background and shares one in-flight read', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);
  await cache.read('p');
  cache.refresh('p');
  cache.refresh('p');
  expect(reader.calls()).toBe(2);
  await cache.read('p');
  const status = cache.status('p');
  expect(status.kind === 'ready' && status.entry.snapshot).toEqual(snapshot('b'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && bun test src/plugin-quota/cache`
Expected: FAIL — `cache.status is not a function`.

- [ ] **Step 3: Implement**

In `quota-cache.ts`, after `OAuthQuotaCacheEntry`:

```ts
export type OAuthQuotaCacheStatus =
  | { readonly kind: 'none' | 'unsupported' | 'loading' | 'failed' }
  | { readonly kind: 'ready'; readonly entry: OAuthQuotaCacheEntry };
```

Extend `OAuthQuotaCache`:

```ts
export type OAuthQuotaCache = {
  readonly read: (providerId: string, refresh?: boolean) => Promise<OAuthQuotaCacheEntry>;
  readonly warm: (providerId: string) => void;
  readonly invalidate: (providerId: string) => void;
  /** A synchronous view of what the cache holds, for callers that must never wait on upstream. */
  readonly status: (providerId: string) => OAuthQuotaCacheStatus;
  /** Starts a read that ignores the cooldown, sharing any read already in flight; never awaited. */
  readonly refresh: (providerId: string) => void;
};
```

Add to the returned object, after `warm`:

```ts
    status: (providerId) => {
      if (unsupported.has(providerId)) return { kind: 'unsupported' };
      const entry = entries.get(providerId);
      if (entry !== undefined) return { kind: 'ready', entry };
      if (inFlight.has(providerId)) return { kind: 'loading' };
      if (failures.has(providerId)) return { kind: 'failed' };
      return { kind: 'none' };
    },
    refresh: (providerId) => {
      if (unsupported.has(providerId)) return;
      void start(providerId).catch(() => {});
    },
```

In `cache/index.ts`, export `type OAuthQuotaCacheStatus` alongside the existing exports. In `quota-invalidation.test.ts`, add `status: () => ({ kind: 'none' }),` and `refresh: () => {},` to the `recordingCache` object.

- [ ] **Step 4: Run tests**

Run: `cd packages/server && bun test src/plugin-quota src/server-state/quota-invalidation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugin-quota/cache packages/server/src/server-state/quota-invalidation/quota-invalidation.test.ts
git commit -m "feat(server): expose non-blocking quota cache status"
```

---

### Task 4: Desktop summary builder

**Files:**
- Create: `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.ts`
- Create: `packages/server/src/dashboard-routes/desktop-summary/desktop-summary.test.ts`
- (Task 5 adds `index.ts` and the route file in the same directory.)

**Interfaces:**
- Consumes: `OAuthQuotaCacheStatus`, `status`/`refresh` from Task 3; `DesktopSummaryV1`, `DesktopSummaryV1Schema` from Task 2.
- Produces:
  ```ts
  export type DesktopSummarySource = {
    readonly traceStore: Pick<TraceStore, 'overview' | 'overviewDashboard' | 'overviewDashboardActivity'>;
    readonly providerSummaries: ServerState['providerSummaries'];
    readonly quotaCache: Pick<OAuthQuotaCache, 'status' | 'warm' | 'refresh'>;
  };
  export type DesktopSummaryInput = { readonly version: string; readonly pid: number; readonly now: Date; readonly refresh: boolean };
  export async function buildDesktopSummary(source: DesktopSummarySource, input: DesktopSummaryInput): Promise<DesktopSummaryV1>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/dashboard-routes/desktop-summary/desktop-summary.test.ts
import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import {
  DesktopSummaryV1Schema,
  type DashboardOverviewActivityResponse,
  type DashboardOverviewResponse,
  type DashboardProviderSummary,
  type DashboardUsageOverviewResponse,
} from '@aio-proxy/types';

import { createOAuthQuotaCache } from '../../plugin-quota';
import { OAuthQuotaCapabilityUnavailableError } from '../../plugin-quota/errors';
import { buildDesktopSummary, type DesktopSummarySource } from './desktop-summary';

const now = new Date('2026-09-29T08:00:00.000Z');
const totals = (requests: string) => ({
  requestCount: requests, totalTokens: '100', inputTokens: '60', outputTokens: '40', cacheReadTokens: '0',
  cacheWriteTokens: '0', cacheHitRate: null, estimatedCostNanoUsd: '5', averageRpm: 0, averageTpm: 0,
});
const trend = (values: Record<string, string>) => ({
  buckets: [{ key: '2026-09-28T16:00:00.000Z', values }],
  series: Object.keys(values).map((key) => ({ key, kind: 'dimension' as const })),
});

const traceStore: DesktopSummarySource['traceStore'] = {
  overview: () =>
    ({
      range: '24h', metric: 'requests', groupBy: 'provider',
      rangeStart: '2026-09-28T08:00:00.000Z', rangeEnd: now.toISOString(), bucketUnit: 'hour',
      summary: {
        estimatedCostNanoUsd: '20', pricingCoverage: 0.5, pricedRequestCount: '5', usageRequestCount: '9',
        requestCount: '10', successCount: '7', failureCount: '3', cancelledCount: '0', successRate: 0.7,
        inputTokens: '600', outputTokens: '400', totalTokens: '1000', averageRpm: 0, averageTpm: 0,
      },
      series: [], buckets: [],
    }) satisfies DashboardUsageOverviewResponse,
  overviewDashboard: () =>
    ({
      range: '7d',
      summary: { current: totals('10'), previous: totals('0'), peakRpm: 0, peakTpm: 0, providerCount: 2 },
      modelTrendByMetric: {
        requests: trend({ a: '4', b: '6' }),
        tokens: trend({ a: '40', b: '60' }),
        cost: trend({ a: '1', b: '2' }),
      },
    }) satisfies DashboardOverviewResponse,
  overviewDashboardActivity: () =>
    ({
      from: '2026-09-29', to: '2026-09-29',
      items: [{ date: '2026-09-29', totalTokens: '1000', models: [{ modelId: 'gpt', totalTokens: '1000' }] }],
    }) satisfies DashboardOverviewActivityResponse,
};

const provider = (overrides: Partial<DashboardProviderSummary>): DashboardProviderSummary => ({
  id: 'p', kind: 'oauth', enabled: true, passthrough: false, last_status: 'unknown', last_latency: null,
  protocols: [], hasQuota: false, canRefreshCredential: false, clientModels: [], state: { status: 'ready' },
  ...overrides,
});

const source = (
  providers: readonly DashboardProviderSummary[],
  read: (providerId: string) => Promise<OAuthQuotaSnapshot>,
): DesktopSummarySource => ({
  traceStore,
  providerSummaries: async () => providers,
  quotaCache: createOAuthQuotaCache({ read }),
});

const input = { version: '0.36.0', pid: 4312, now, refresh: false };

test('maps usage, the 7-day trend, and activity into the strict v1 shape', async () => {
  const summary = await buildDesktopSummary(source([], async () => ({ items: [] })), input);
  expect(DesktopSummaryV1Schema.parse(summary)).toEqual(summary);
  expect(summary.usage24h).toEqual({
    requests: '10', failedRequests: '3', inputTokens: '600', outputTokens: '400',
    estimatedCostNanoUsd: '20', pricingCoverage: 0.5,
  });
  expect(summary.trend7d).toEqual([
    { start: '2026-09-28T16:00:00.000Z', requests: '10', totalTokens: '100', estimatedCostNanoUsd: '3' },
  ]);
  expect(summary.activity).toEqual([{ date: '2026-09-29', totalTokens: '1000' }]);
  expect(summary.server).toEqual({ version: '0.36.0', pid: 4312 });
});

test('returns at once with quota loading while upstream never answers', async () => {
  const started = performance.now();
  const summary = await buildDesktopSummary(
    source([provider({ id: 'slow', hasQuota: true })], () => new Promise(() => {})),
    input,
  );
  expect(performance.now() - started).toBeLessThan(100);
  expect(summary.providers[0]?.quota).toEqual({ status: 'loading' });
});

test('one provider failing its quota read does not fail the summary', async () => {
  const cache = createOAuthQuotaCache({
    read: async (id) => {
      if (id === 'bad') throw new Error('boom');
      return { items: [{ id: 'primary', displayName: 'Primary', remainingRatio: 0, resetsAt: Date.parse('2026-09-29T10:00:00.000Z'), windowMinutes: 300 }] };
    },
  });
  await cache.read('bad').catch(() => {});
  await cache.read('good');
  const summary = await buildDesktopSummary(
    {
      traceStore,
      providerSummaries: async () => [provider({ id: 'bad', hasQuota: true }), provider({ id: 'good', hasQuota: true })],
      quotaCache: cache,
    },
    input,
  );
  expect(summary.providers.map((entry) => entry.quota.status)).toEqual(['failed', 'ready']);
  expect(summary.providers[1]?.quota).toEqual({
    status: 'ready',
    sampledAt: expect.any(String),
    refreshFailed: false,
    windows: [{ id: 'primary', label: 'Primary', remainingRatio: 0, resetsAt: '2026-09-29T10:00:00.000Z', windowMinutes: 300 }],
  });
  expect(summary.alerts).toContainEqual({ providerId: 'good', kind: 'quota_exhausted', message: 'Primary' });
});

test('a permanently unsupported quota capability reports unsupported, not loading forever', async () => {
  const cache = createOAuthQuotaCache({ read: async () => { throw new OAuthQuotaCapabilityUnavailableError(true); } });
  await cache.read('p').catch(() => {});
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    input,
  );
  expect(summary.providers[0]?.quota).toEqual({ status: 'unsupported' });
});

test('maps provider state and turns diagnostics into alerts', async () => {
  const diagnostic = {
    code: 'CREDENTIAL_REFRESH_FAILED' as const, summary: 'Refresh token expired', retryable: true,
    occurredAt: now.toISOString(),
  };
  const summary = await buildDesktopSummary(
    source(
      [
        provider({ id: 'off', enabled: false }),
        provider({ id: 'down', state: { status: 'unavailable', diagnostic } }),
        provider({ id: 'warn', name: 'Warn', state: { status: 'ready', diagnostic } }),
        provider({ id: 'fine' }),
      ],
      async () => ({ items: [] }),
    ),
    input,
  );
  expect(summary.providers.map(({ id, name, state }) => ({ id, name, state }))).toEqual([
    { id: 'off', name: 'off', state: 'disabled' },
    { id: 'down', name: 'down', state: 'unavailable' },
    { id: 'warn', name: 'Warn', state: 'degraded' },
    { id: 'fine', name: 'fine', state: 'ok' },
  ]);
  expect(summary.alerts.filter((alert) => alert.kind === 'diagnostic').map((alert) => alert.providerId)).toEqual([
    'down',
    'warn',
  ]);
});

test('refresh starts a background read even inside the cooldown and does not wait for it', async () => {
  let calls = 0;
  const cache = createOAuthQuotaCache({
    read: async () => {
      calls += 1;
      if (calls === 1) return { items: [] };
      return new Promise<OAuthQuotaSnapshot>(() => {});
    },
  });
  await cache.read('p');
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    { ...input, refresh: true },
  );
  expect(calls).toBe(2);
  expect(summary.providers[0]?.quota.status).toBe('ready');
});
```

If `DashboardUsageOverviewResponse`, `DashboardOverviewActivityResponse`, or `OAuthQuotaCapabilityUnavailableError`'s import path differ from the above, fix the imports (search `packages/types/src/index.ts` and `packages/server/src/plugin-quota/index.ts`); do not change the assertions.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && bun test src/dashboard-routes/desktop-summary`
Expected: FAIL — `Cannot find module './desktop-summary'`.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/dashboard-routes/desktop-summary/desktop-summary.ts
import type { TraceStore } from '@aio-proxy/core/db';
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import type { DashboardProviderSummary, DesktopProvider, DesktopQuota, DesktopSummaryV1 } from '@aio-proxy/types';

import type { OAuthQuotaCache } from '../../plugin-quota';
import type { ServerState } from '../../server-state';

export type DesktopSummarySource = {
  readonly traceStore: Pick<TraceStore, 'overview' | 'overviewDashboard' | 'overviewDashboardActivity'>;
  readonly providerSummaries: ServerState['providerSummaries'];
  readonly quotaCache: Pick<OAuthQuotaCache, 'status' | 'warm' | 'refresh'>;
};

export type DesktopSummaryInput = {
  readonly version: string;
  readonly pid: number;
  readonly now: Date;
  readonly refresh: boolean;
};

type Bucket = { readonly key: string; readonly values: Readonly<Record<string, string>> };

const sumValues = (values: Readonly<Record<string, string>>): string => {
  let total = 0n;
  for (const value of Object.values(values)) total += BigInt(value);
  return String(total);
};

const totalsByKey = (buckets: readonly Bucket[]): ReadonlyMap<string, string> =>
  new Map(buckets.map((bucket) => [bucket.key, sumValues(bucket.values)]));

function quotaWindows(snapshot: OAuthQuotaSnapshot) {
  return snapshot.items.map((item) => ({
    id: item.id,
    label: item.displayName,
    remainingRatio: item.remainingRatio ?? null,
    resetsAt: item.resetsAt === undefined ? null : new Date(item.resetsAt).toISOString(),
    windowMinutes: item.windowMinutes ?? null,
  }));
}

// Reads only what the cache already holds. `warm`/`refresh` start background reads whose results the
// next summary picks up; awaiting them is exactly the ~1.3s stall this endpoint exists to avoid.
function quotaFor(cache: DesktopSummarySource['quotaCache'], summary: DashboardProviderSummary, refresh: boolean): DesktopQuota {
  if (!summary.hasQuota) return { status: 'none' };
  if (refresh) cache.refresh(summary.id);
  else cache.warm(summary.id);
  const status = cache.status(summary.id);
  if (status.kind !== 'ready') return { status: status.kind };
  return {
    status: 'ready',
    sampledAt: new Date(status.entry.sampledAt).toISOString(),
    refreshFailed: status.entry.stale,
    windows: quotaWindows(status.entry.snapshot),
  };
}

function providerState(summary: DashboardProviderSummary): DesktopProvider['state'] {
  if (!summary.enabled) return 'disabled';
  if (summary.state.status === 'unavailable') return 'unavailable';
  return summary.state.diagnostic === undefined ? 'ok' : 'degraded';
}

function toDesktopProvider(summary: DashboardProviderSummary, quota: DesktopQuota): DesktopProvider {
  const diagnostic = summary.state.diagnostic;
  return {
    id: summary.id,
    name: summary.name ?? summary.id,
    enabled: summary.enabled,
    state: providerState(summary),
    diagnostic: diagnostic === undefined ? null : { code: diagnostic.code, summary: diagnostic.summary },
    quota,
  };
}

function alertsFor(providers: readonly DesktopProvider[]): DesktopSummaryV1['alerts'] {
  const alerts: DesktopSummaryV1['alerts'][number][] = [];
  for (const entry of providers) {
    if (entry.diagnostic !== null) {
      alerts.push({ providerId: entry.id, kind: 'diagnostic', message: entry.diagnostic.summary });
    }
    if (entry.quota.status !== 'ready') continue;
    for (const window of entry.quota.windows) {
      if (window.remainingRatio !== 0) continue;
      const message = typeof window.label === 'string' ? window.label : (Object.values(window.label)[0] ?? window.id);
      alerts.push({ providerId: entry.id, kind: 'quota_exhausted', message });
    }
  }
  return alerts;
}

export async function buildDesktopSummary(
  source: DesktopSummarySource,
  input: DesktopSummaryInput,
): Promise<DesktopSummaryV1> {
  const usage = source.traceStore.overview({ range: '24h', metric: 'requests', groupBy: 'provider', now: input.now }).summary;
  const week = source.traceStore.overviewDashboard({ range: '7d', now: input.now }).modelTrendByMetric;
  const tokens = totalsByKey(week.tokens.buckets);
  const cost = totalsByKey(week.cost.buckets);
  const activity = source.traceStore.overviewDashboardActivity({ now: input.now });
  const summaries = await source.providerSummaries({ probe: false });
  const providers = summaries.map((summary) => toDesktopProvider(summary, quotaFor(source.quotaCache, summary, input.refresh)));
  return {
    protocolVersion: 1,
    generatedAt: input.now.toISOString(),
    server: { version: input.version, pid: input.pid },
    usage24h: {
      requests: usage.requestCount,
      failedRequests: usage.failureCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostNanoUsd: usage.estimatedCostNanoUsd,
      pricingCoverage: usage.pricingCoverage,
    },
    trend7d: week.requests.buckets.map((bucket) => ({
      start: bucket.key,
      requests: sumValues(bucket.values),
      totalTokens: tokens.get(bucket.key) ?? '0',
      estimatedCostNanoUsd: cost.get(bucket.key) ?? '0',
    })),
    activity: activity.items.map((item) => ({ date: item.date, totalTokens: item.totalTokens })),
    providers,
    alerts: alertsFor(providers),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && bun test src/dashboard-routes/desktop-summary`
Expected: PASS (6 tests). If `overviewDashboard`'s bucket `key` is not an RFC 3339 datetime at runtime, `DesktopSummaryV1Schema.parse` in the first test fails; convert with `new Date(bucket.key).toISOString()` rather than loosening the schema.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dashboard-routes/desktop-summary
git commit -m "feat(server): build the desktop summary without awaiting quota"
```

---

### Task 5: Token at boot, the `desktop-summary` route, and its guard

**Files:**
- Create: `packages/server/src/dashboard-routes/desktop-summary/route.ts`
- Create: `packages/server/src/dashboard-routes/desktop-summary/index.ts`
- Create: `packages/server/src/dashboard-routes/desktop-summary/route.test.ts`
- Modify: `packages/server/src/server-state/types.ts` (`ServerState`, near `configPath`)
- Modify: `packages/server/src/server-state/lifecycle.ts:142-161` (`ServerStateParts` pick list) and `:172-240` (`assembleServerState`)
- Modify: `packages/server/src/server-state/index.ts` (compute the token next to `serverDbOptions`, pass into `assembleServerState` at ~line 258)
- Modify: `packages/server/src/server-log.ts` (new log type + union member at ~line 295)
- Modify: `packages/server/src/server/create-routes.ts` (mount right after the `/health` route, ~line 234)

**Interfaces:**
- Consumes: `ensureDesktopToken` (Task 1), `buildDesktopSummary` (Task 4).
- Produces: `ServerState.desktopToken?: string`; `createDesktopSummaryRoute(state: ServerState, version: string): Hono`; `requireDesktopToken(expected: () => string | undefined): MiddlewareHandler`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/dashboard-routes/desktop-summary/route.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDesktopToken } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { DesktopSummaryV1Schema } from '@aio-proxy/types';

import { loopbackServer } from '../../dashboard-auth/test-support';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-desktop-summary-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, host: '127.0.0.1:9317' });
const serve = async (server: Record<string, unknown> = {}) =>
  createServer({ config: { server: { port: 9_317, ...server }, providers: {} }, dbHome: dir, watchConfig: false });

test('the desktop token reads the summary without a dashboard password', async () => {
  const app = await serve();
  const token = readDesktopToken(dir);
  expect(token).toBeDefined();
  const res = await app.request('/dashboard/api/desktop-summary', { headers: bearer(token ?? '') }, loopbackServer);
  expect(res.status).toBe(200);
  expect(DesktopSummaryV1Schema.safeParse(await res.json()).success).toBe(true);
});

test('with a dashboard password the token reads the summary but nothing else', async () => {
  const app = await serve({ password: await Bun.password.hash('pw') });
  const token = readDesktopToken(dir) ?? '';
  expect((await app.request('/dashboard/api/desktop-summary', { headers: bearer(token) }, loopbackServer)).status).toBe(200);
  expect((await app.request('/dashboard/api/providers', { headers: bearer(token) }, loopbackServer)).status).toBe(401);
});

test('without a password the token grants nothing beyond anonymous loopback access', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const anonymous = await app.request('/dashboard/api/providers', { headers: { host: '127.0.0.1:9317' } }, loopbackServer);
  const withToken = await app.request('/dashboard/api/providers', { headers: bearer(token) }, loopbackServer);
  expect(withToken.status).toBe(anonymous.status);
});

test('a missing or wrong token is refused', async () => {
  const app = await serve();
  expect((await app.request('/dashboard/api/desktop-summary', { headers: { host: '127.0.0.1:9317' } }, loopbackServer)).status).toBe(401);
  expect((await app.request('/dashboard/api/desktop-summary', { headers: bearer('B'.repeat(43)) }, loopbackServer)).status).toBe(401);
});

test('a non-loopback peer is refused even when headers claim loopback', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const res = await app.request(
    '/dashboard/api/desktop-summary',
    { headers: { ...bearer(token), origin: 'http://127.0.0.1:9317', 'x-forwarded-for': '127.0.0.1' } },
    peer('192.168.1.20'),
  );
  expect(res.status).toBe(401);
});

test.each(['::1', '::ffff:127.0.0.1', '127.0.0.2'])('loopback peer %s is accepted', async (address) => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  expect((await app.request('/dashboard/api/desktop-summary', { headers: bearer(token) }, peer(address))).status).toBe(200);
});

test('a real loopback socket reaches the summary with the token', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/dashboard/api/desktop-summary`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test('a server with no home still boots and refuses the summary', async () => {
  // Without dbHome/configPath the database falls back to aioHome(); point that at the temp dir so the
  // test never touches the developer's real ~/.aio-proxy. The token home stays undefined regardless.
  const previous = process.env['AIO_PROXY_HOME'];
  process.env['AIO_PROXY_HOME'] = dir;
  try {
    const app = await createServer({ config: { server: { port: 9_317 }, providers: {} }, watchConfig: false });
    const res = await app.request('/dashboard/api/desktop-summary', { headers: bearer('A'.repeat(43)) }, loopbackServer);
    expect(res.status).toBe(401);
    expect(readDesktopToken(dir)).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env['AIO_PROXY_HOME'];
    else process.env['AIO_PROXY_HOME'] = previous;
  }
});

test('a rejected token file does not stop the server from booting', async () => {
  writeFileSync(join(dir, 'desktop-token'), 'A'.repeat(43), { mode: 0o644 });
  const app = await serve();
  const res = await app.request('/dashboard/api/desktop-summary', { headers: bearer('A'.repeat(43)) }, loopbackServer);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && bun test src/dashboard-routes/desktop-summary/route.test.ts`
Expected: FAIL — requests to `/dashboard/api/desktop-summary` return 404.

- [ ] **Step 3: Implement the log type**

In `server-log.ts`, next to `DashboardAuthUnavailableLog`:

```ts
export type DesktopTokenUnavailableLog = {
  readonly error: string;
  readonly event: 'desktop_token.unavailable';
};
```

and add `| DesktopTokenUnavailableLog` to the `ServerLog` union (line ~295).

- [ ] **Step 4: Put the token on server state**

`types.ts`, in `ServerState` after `readonly configPath: string | undefined;`:

```ts
  /** The local desktop client's credential, loaded once at boot; absent when there is no home or the file was rejected. */
  readonly desktopToken?: string;
```

`lifecycle.ts`: add `| 'desktopToken'` to the `ServerStateParts` `Pick<ServerState, …>` list, and in `assembleServerState`'s returned object add (after `configPath: options.configPath,`):

```ts
    ...(parts.desktopToken === undefined ? {} : { desktopToken: parts.desktopToken }),
```

`index.ts`: below `serverDbOptions`, add

```ts
function loadDesktopToken(home: string | undefined, logger: ServerLogSink): string | undefined {
  if (home === undefined) return undefined;
  try {
    return ensureDesktopToken(home);
  } catch (error) {
    // A rejected or unwritable token file disables only the desktop client; the proxy must still start.
    logServerEvent(logger, { event: 'desktop_token.unavailable', error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
```

(import `ensureDesktopToken` from `@aio-proxy/core`, `logServerEvent` and `type ServerLogSink` from `../server-log` if not already imported), and in the `assembleServerState(runtime, { … })` call add:

```ts
    ...(() => {
      const desktopToken = loadDesktopToken(serverDbOptions(options).home, logger);
      return desktopToken === undefined ? {} : { desktopToken };
    })(),
```

If the IIFE reads poorly next to the surrounding code, compute `const desktopToken = loadDesktopToken(...)` a few lines above the call and spread `...(desktopToken === undefined ? {} : { desktopToken })`.

- [ ] **Step 5: Implement the route and guard**

```ts
// packages/server/src/dashboard-routes/desktop-summary/route.ts
import { timingSafeEqual } from 'node:crypto';

import { Hono, type MiddlewareHandler } from 'hono';

import { dashboardSessionToken, isDashboardLoopbackRequest } from '../../dashboard-auth';
import type { ServerState } from '../../server-state';
import { buildDesktopSummary } from './desktop-summary';

const sameToken = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The desktop token's only door. It is checked here rather than in `DashboardAuthentication.verify`
 * so the token never becomes a dashboard session, and it is accepted only from a loopback socket peer.
 */
export const requireDesktopToken =
  (expected: () => string | undefined): MiddlewareHandler =>
  async (context, next) => {
    const token = expected();
    const presented = dashboardSessionToken(context);
    if (token === undefined || presented === undefined || !isDashboardLoopbackRequest(context) || !sameToken(presented, token)) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };

export const createDesktopSummaryRoute = (state: ServerState, version: string) =>
  new Hono().get('/', requireDesktopToken(() => state.desktopToken), async (context) =>
    context.json(
      await buildDesktopSummary(state, {
        version,
        pid: process.pid,
        now: new Date(),
        refresh: context.req.query('refresh') === 'true',
      }),
    ),
  );
```

```ts
// packages/server/src/dashboard-routes/desktop-summary/index.ts
export { createDesktopSummaryRoute } from './route';
```

In `create-routes.ts`, directly after the `app.get('/health', …)` block:

```ts
  // Registered ahead of every `/dashboard/*` middleware on purpose: this route carries its own guard
  // (desktop token + loopback peer) and must not inherit dashboard-session authentication.
  app.route('/dashboard/api/desktop-summary', createDesktopSummaryRoute(state, version));
```

with `import { createDesktopSummaryRoute } from '../dashboard-routes/desktop-summary';`.

- [ ] **Step 6: Run tests**

Run: `cd packages/server && bun test src/dashboard-routes/desktop-summary src/server`
Expected: PASS, including the existing `dns-rebinding.test.ts` and `server.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src
git commit -m "feat(server): serve the desktop summary behind a local token"
```

---

### Task 6: launchd wrapper guard for a missing executable

**Files:**
- Modify: `packages/cli/src/service/unit-templates.ts:54` (`LAUNCHD_EXEC_WRAPPER`)
- Modify: `packages/cli/src/service/index.ts` (re-export the wrapper constants and `LAUNCHD_LABEL`)
- Test: `packages/cli/src/service/service.test.ts`

**Interfaces:**
- Produces: `LAUNCHD_EXEC_WRAPPER: string`, `LEGACY_LAUNCHD_EXEC_WRAPPERS: readonly string[]`, and the existing `LAUNCHD_LABEL`, all re-exported from `packages/cli/src/service/index.ts` (Task 11 imports them from `../service`, never from the private `unit-templates.ts`).

- [ ] **Step 1: Write the failing test** (append to `service.test.ts`; import `LAUNCHD_EXEC_WRAPPER` from `./unit-templates`)

```ts
const runWrapper = (exec: string) =>
  Bun.spawnSync(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, exec], { stdout: 'ignore', stderr: 'ignore' }).exitCode;

test('the launchd wrapper exits cleanly when its executable is gone, so KeepAlive does not respawn it', () => {
  expect(runWrapper(join(tmpdir(), 'aio-proxy-missing', 'aio-proxy'))).toBe(0);
});

test('the launchd wrapper still reports real failures and remaps only exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-wrapper-'));
  const exitsWith = (code: number) => {
    const path = join(dir, `exit-${code}`);
    writeFileSync(path, `#!/bin/sh\nexit ${code}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  expect(runWrapper(exitsWith(3))).toBe(3);
  expect(runWrapper(exitsWith(1))).toBe(0);
});
```

(add `mkdtempSync` to the `node:fs` import.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cli && bun test src/service/service.test.ts`
Expected: FAIL — the missing-executable case exits 127 (or `LAUNCHD_EXEC_WRAPPER` is not exported).

- [ ] **Step 3: Implement**

Replace line 54 in `unit-templates.ts`:

```ts
// `[ -x "$0" ] || exit 0` turns a vanished executable (desktop app deleted, brew uninstalled) into a
// clean exit, which SuccessfulExit=false does not relaunch; otherwise launchd respawns it forever.
export const LAUNCHD_EXEC_WRAPPER =
  '[ -x "$0" ] || exit 0; "$0" run; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"';

/** Wrappers written by earlier releases; still recognized as ours when inspecting an installed plist. */
export const LEGACY_LAUNCHD_EXEC_WRAPPERS: readonly string[] = [
  '"$0" run; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"',
];
```

Add to `packages/cli/src/service/index.ts`:

```ts
export { LAUNCHD_EXEC_WRAPPER, LAUNCHD_LABEL, LEGACY_LAUNCHD_EXEC_WRAPPERS } from './unit-templates';
```

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test src/service`
Expected: PASS (existing plist assertions still hold: the wrapper still contains `"$0" run` and the exit-1 remap).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "fix(cli): stop launchd respawning a service whose binary was removed"
```

---

### Task 7: `AIO_PROXY_DESKTOP_EXEC` override and the desktop unit marker

**Files:**
- Modify: `packages/cli/src/executable/executable.ts:34-59`
- Modify: `packages/cli/src/service/unit-templates.ts:3-8` (`UnitOptions`) and `:60-70` (launchd env)
- Modify: `packages/cli/src/service/service.ts:99-141` (`writeManagedUnit`)
- Test: `packages/cli/src/executable/executable.test.ts`, `packages/cli/src/service/service.test.ts`

**Interfaces:**
- Produces: `resolveAgentExecutable(which?, execPath?, realpath?, exists?, env?)` returns `env.AIO_PROXY_DESKTOP_EXEC` verbatim when it is an absolute path. `writeManagedUnit(os, exec?, target?, env?)`. `UnitOptions.upgradeMethod` includes `'desktop'`; `UnitOptions.desktopExec?: string`.

- [ ] **Step 1: Write the failing tests**

In `executable.test.ts`:

```ts
test('AIO_PROXY_DESKTOP_EXEC wins and is returned verbatim, never resolved through the symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-desktop-exec-'));
  const real = join(dir, 'App.app', 'Contents', 'MacOS', 'aio-proxy');
  writeExecutable(real);
  const link = join(dir, 'bin', 'aio-proxy');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(real, link);
  expect(
    resolveAgentExecutable(() => '/opt/homebrew/bin/aio-proxy', real, realpathSync, () => true, { AIO_PROXY_DESKTOP_EXEC: link }),
  ).toBe(link);
});

test('a relative AIO_PROXY_DESKTOP_EXEC is ignored', () => {
  const launcher = '/opt/homebrew/bin/aio-proxy';
  expect(
    resolveAgentExecutable(() => launcher, launcher, (path) => path, () => true, { AIO_PROXY_DESKTOP_EXEC: 'bin/aio-proxy' }),
  ).toBe(launcher);
});
```

In `service.test.ts`:

```ts
test('a desktop-owned unit keeps the symlink path and carries both desktop markers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-desktop-unit-'));
  const link = join(dir, 'Application Support', 'aio-proxy-desktop', 'bin', 'aio-proxy');
  const target = join(dir, 'com.aio-proxy.agent.plist');
  await writeManagedUnit('darwin', link, target, { AIO_PROXY_DESKTOP_EXEC: link, PATH: '/usr/bin:/bin' });
  const plist = JSON.parse(
    Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', target]).stdout.toString(),
  ) as { ProgramArguments: string[]; EnvironmentVariables: Record<string, string> };
  expect(plist.ProgramArguments[3]).toBe(link);
  expect(plist.EnvironmentVariables['AIO_PROXY_DESKTOP_EXEC']).toBe(link);
  expect(plist.EnvironmentVariables['AIO_PROXY_UPGRADE_METHOD']).toBe('desktop');
});
```

(guard this test with `test.skipIf(process.platform !== 'darwin')` because it shells out to `plutil`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cli && bun test src/executable src/service`
Expected: FAIL — the override is ignored and the plist lacks the markers.

- [ ] **Step 3: Implement**

`executable.ts` — add the parameter and early return (keep the rest of the body unchanged):

```ts
export function resolveAgentExecutable(
  which: (name: string) => string | null = Bun.which,
  execPath: string = process.execPath,
  realpath: (path: string) => string = realpathSync,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // The desktop app points launchd at a stable symlink it owns. Returned verbatim: resolving it (or
  // passing it through resolveStableManagedExec) would pin the plist inside one app bundle version.
  const desktopExec = env['AIO_PROXY_DESKTOP_EXEC'];
  if (desktopExec !== undefined && isAbsolute(desktopExec)) return desktopExec;
  // …existing body unchanged…
```

(import `isAbsolute` from `node:path`.)

`unit-templates.ts`:

```ts
export type UnitOptions = {
  readonly exec: string;
  readonly configPath: string;
  readonly path?: string;
  readonly upgradeMethod?: 'brew' | 'bun' | 'npm' | 'pnpm' | 'desktop';
  /** Set only for a desktop-owned unit; the daemon inherits it so any later rewrite keeps the symlink. */
  readonly desktopExec?: string;
};
```

and in `renderLaunchdPlist`, destructure `desktopExec` and append to `environmentVariables`:

```ts
    ...(desktopExec === undefined
      ? []
      : [launchdText('key', 'AIO_PROXY_DESKTOP_EXEC'), launchdText('string', desktopExec)]),
```

`service.ts` — `writeManagedUnit` gains `env` and skips upgrade-method detection for the desktop exec:

```ts
export async function writeManagedUnit(
  os: SupportedPlatform,
  exec: string = resolveAgentExecutable(),
  target: string = os === 'darwin' ? launchdPlistPath() : systemdUnitPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const cfg = configPath();
  const desktopExec = env['AIO_PROXY_DESKTOP_EXEC'];
  const desktopOwned = desktopExec !== undefined && desktopExec !== '' && exec === desktopExec;
  let upgradeMethod: UnitOptions['upgradeMethod'];
  if (desktopOwned) {
    // Sparkle updates the bundle behind the symlink; no package manager or binary self-update may touch it.
    upgradeMethod = 'desktop';
  } else {
    // …existing detection block (the current `try { resolveUpgradeTargetFrom(exec) … }` and the
    // `isPlatformCliBinary` PATH scan), assigning to `upgradeMethod` exactly as today…
  }
  const unit = {
    exec,
    configPath: cfg,
    path: managedServicePath(homedir(), env['PATH']),
    ...(upgradeMethod === undefined ? {} : { upgradeMethod }),
    ...(desktopOwned ? { desktopExec } : {}),
  };
  // …rest unchanged…
```

Keep the existing detection code byte-for-byte inside the `else`, only replacing its reads of `process.env['PATH']` with `env['PATH']`. Import `type UnitOptions` from `./unit-templates`.

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test src/executable src/service src/run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/executable packages/cli/src/service
git commit -m "feat(cli): let the desktop app own the managed unit through a stable symlink"
```

---

### Task 8: `service start` kickstarts an already-loaded launchd job

**Files:**
- Modify: `packages/cli/src/service/service.ts:167-190` (`ServiceStartIo`, `serviceStart`)
- Test: `packages/cli/src/service/service.test.ts:67-78` (existing darwin start test) plus a new test

**Interfaces:**
- Produces: `launchdJobTarget(uid?: number): string` (`gui/<uid>/com.aio-proxy.agent`), exported for Task 11; `ServiceStartIo.jobLoaded?: () => Promise<boolean>`.

- [ ] **Step 1: Write the failing test and pin the existing one**

Change the existing `serviceStart on ${platform} starts an installed service through its manager` test to pass `jobLoaded: async () => false` (so it never shells out to the real `launchctl`), and add:

```ts
test('serviceStart kickstarts a loaded launchd job instead of re-loading it', async () => {
  const runManager = mock(async () => 0);
  await serviceStart({
    platform: 'darwin',
    unitInstalled: () => true,
    unitPath: '/tmp/service.plist',
    runManager,
    install: async () => {},
    jobLoaded: async () => true,
  });
  expect(runManager).toHaveBeenCalledWith(['launchctl', 'kickstart', launchdJobTarget()]);
  expect(runManager).not.toHaveBeenCalledWith(['launchctl', 'load', '-w', '/tmp/service.plist']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cli && bun test src/service/service.test.ts`
Expected: FAIL — `launchdJobTarget` is not exported / `load -w` is called.

- [ ] **Step 3: Implement**

```ts
export const launchdJobTarget = (uid: number = process.getuid?.() ?? 0): string => `gui/${uid}/${LAUNCHD_LABEL}`;

const launchdJobLoaded = async (): Promise<boolean> =>
  (await Bun.spawn(['launchctl', 'print', launchdJobTarget()], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0;

type ServiceStartIo = Pick<ServiceRestartIo, 'platform' | 'unitInstalled' | 'unitPath' | 'runManager' | 'install'> & {
  readonly jobLoaded?: () => Promise<boolean>;
};
```

and replace the darwin branch inside `serviceStart`'s `try`:

```ts
    if (os === 'darwin') {
      // `load -w` does nothing for a job launchd already holds, so a loaded job whose process exited
      // (a clean stop, or the wrapper's missing-executable exit) has to be kickstarted instead.
      if (installed && (await (io.jobLoaded ?? launchdJobLoaded)())) {
        await run(['launchctl', 'kickstart', launchdJobTarget()]);
        return;
      }
      // RunAtLoad=true means `load -w` also starts the job.
      await run(['launchctl', 'load', '-w', io.unitPath ?? launchdPlistPath()]);
      return;
    }
```

Add `launchdJobTarget` and the existing `managedUnitPath` to the `./service` export list in `packages/cli/src/service/index.ts` (Task 11 imports both from `../service`).

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test src/service src/upgrade`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "fix(cli): restart a loaded but stopped launchd job on service start"
```

---

### Task 9: Refuse self-upgrade of a desktop-managed binary

**Files:**
- Modify: `packages/cli/src/upgrade/upgrade.ts` (`UpgradeDeps`, `defaultDeps`, start of `runUpgradeCommand`)
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` (`cli.upgrade.desktop_managed`)
- Test: `packages/cli/src/upgrade/upgrade.test.ts`

**Interfaces:**
- Produces: `isDesktopManagedInstall(env?: NodeJS.ProcessEnv, execPath?: string, realpath?: (p: string) => string): boolean`; `UpgradeDeps.isDesktopManaged: () => boolean`.

- [ ] **Step 1: Add the message in all five locales** (inside the existing `cli.upgrade` object of each file, next to `detect_failed`)

- en: `"desktop_managed": "This aio-proxy is managed by the aio-proxy desktop app. Update it from the desktop app."`
- zh-Hans: `"desktop_managed": "此 aio-proxy 由 aio-proxy 桌面端管理，请通过桌面端更新。"`
- zh-Hant: `"desktop_managed": "此 aio-proxy 由 aio-proxy 桌面端管理，請透過桌面端更新。"`
- ja: `"desktop_managed": "この aio-proxy は aio-proxy デスクトップアプリで管理されています。デスクトップアプリから更新してください。"`
- ko: `"desktop_managed": "이 aio-proxy는 aio-proxy 데스크톱 앱에서 관리됩니다. 데스크톱 앱에서 업데이트하세요."`

Run: `cd packages/i18n && bun run build && bun run test`
Expected: PASS (locale parity).

- [ ] **Step 2: Write the failing tests** (append to `upgrade.test.ts`)

```ts
test('a desktop-managed process refuses to upgrade before touching any installer', async () => {
  const install = mock(async () => {});
  const resolveTarget = mock(async () => ({ method: 'binary' as const, path: '/tmp/aio-proxy' }));
  const error = await runUpgradeCommand({}, () => {}, { isDesktopManaged: () => true, install, resolveTarget }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliExit);
  expect((error as CliExit).message).toBe(m['cli.upgrade.desktop_managed']());
  expect(resolveTarget).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

test('isDesktopManagedInstall recognizes the desktop markers and an app-bundle binary', () => {
  expect(isDesktopManagedInstall({ AIO_PROXY_UPGRADE_METHOD: 'desktop' }, '/usr/local/bin/aio-proxy', (p) => p)).toBe(true);
  expect(isDesktopManagedInstall({ AIO_PROXY_DESKTOP_EXEC: '/x/bin/aio-proxy' }, '/usr/local/bin/aio-proxy', (p) => p)).toBe(true);
  expect(
    isDesktopManagedInstall({}, '/Users/u/Library/Application Support/aio-proxy-desktop/bin/aio-proxy', () => '/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy'),
  ).toBe(true);
  expect(isDesktopManagedInstall({}, '/opt/homebrew/bin/aio-proxy', (p) => p)).toBe(false);
});
```

(import `m` from `@aio-proxy/i18n`, `mock` from `bun:test`, and `isDesktopManagedInstall` from `./upgrade` if not already imported.)

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/cli && bun test src/upgrade/upgrade.test.ts`
Expected: FAIL — `isDesktopManaged` is not a dependency / function not exported.

- [ ] **Step 4: Implement**

```ts
/**
 * A binary inside a desktop app bundle belongs to Sparkle: rewriting it breaks the app's signature,
 * and a package-manager install would fork the daemon away from the app. This covers `aio-proxy
 * upgrade`, Dashboard apply, and auto-update, which all funnel through runUpgradeCommand.
 */
export const isDesktopManagedInstall = (
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  realpath: (path: string) => string = realpathSync,
): boolean => {
  if (env['AIO_PROXY_UPGRADE_METHOD'] === 'desktop') return true;
  if ((env['AIO_PROXY_DESKTOP_EXEC'] ?? '') !== '') return true;
  try {
    return /\.app\/Contents\/MacOS\//u.test(realpath(execPath));
  } catch {
    return false;
  }
};
```

Add `readonly isDesktopManaged: () => boolean;` to `UpgradeDeps`, `isDesktopManaged: () => isDesktopManagedInstall(),` to `defaultDeps`, and as the first statement after `const deps = createUpgradeDeps(overrides);` in `runUpgradeCommand`:

```ts
  if (deps.isDesktopManaged()) throw new CliExit(EXIT.unrecoverable, m['cli.upgrade.desktop_managed']());
```

(import `realpathSync` from `node:fs`.)

- [ ] **Step 5: Run tests**

Run: `cd packages/cli && bun test src/upgrade src/run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/upgrade packages/i18n/messages
git commit -m "feat(cli): refuse to self-upgrade a desktop-managed binary"
```

---

### Task 10: Control address for a specific home, mapped to a local literal

**Files:**
- Modify: `packages/core/src/paths/paths.ts` (add `configPathIn`) and `packages/core/src/paths/index.ts`, `packages/core/src/index.ts:244`
- Modify: `packages/cli/src/control-plane/control-plane.ts` (`resolveControlAddress` gains a path parameter; add `localControlHost`; `probeHealth` gains `fetchImpl`/`timeoutMs`)
- Test: `packages/core/src/paths/paths.test.ts`, `packages/cli/src/control-plane/control-plane.test.ts`

**Interfaces:**
- Produces:
  - `configPathIn(home: string): string` (core); `configPath()` becomes `configPathIn(aioHome())`.
  - `resolveControlAddress(options, path?: string)`, default `configPath()`.
  - `localControlHost(host: string): string | undefined` — returns a literal loopback IP or `undefined` for a non-loopback bind.
  - `probeHealth(base: string, fetchImpl?: typeof fetch, timeoutMs?: number)`.

- [ ] **Step 1: Write the failing tests**

`paths.test.ts`:

```ts
test('configPathIn finds the existing config file inside an explicit home', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-home-'));
  writeFileSync(join(home, 'config.yaml'), 'providers: {}\n');
  expect(configPathIn(home)).toBe(join(home, 'config.yaml'));
});
```

`control-plane.test.ts`:

```ts
test.each([
  ['0.0.0.0', '127.0.0.1'],
  ['', '127.0.0.1'],
  ['::', '::1'],
  ['localhost', '127.0.0.1'],
  ['127.0.0.1', '127.0.0.1'],
  ['127.0.0.5', '127.0.0.5'],
  ['::1', '::1'],
  ['192.168.1.5', undefined],
  ['proxy.example.com', undefined],
])('localControlHost(%p) is %p', (host, expected) => {
  expect(localControlHost(host)).toBe(expected);
});

test('resolveControlAddress reads the config at an explicit path, not the environment home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-ctrl-explicit-'));
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "host": "0.0.0.0", "port": 19317 }, "providers": {} }\n');
  const { host, port } = await resolveControlAddress({}, join(home, 'config.jsonc'));
  expect({ host, port }).toEqual({ host: '0.0.0.0', port: '19317' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && bun test src/paths && cd ../cli && bun test src/control-plane`
Expected: FAIL — `configPathIn` / `localControlHost` not exported.

- [ ] **Step 3: Implement**

`paths.ts`:

```ts
export function configPathIn(home: string): string {
  return CONFIG_FILE_NAMES.map((name) => join(home, name)).find(existsSync) ?? join(home, 'config.jsonc');
}

export function configPath(): string {
  return configPathIn(aioHome());
}
```

Export `configPathIn` from `paths/index.ts` and add it to the core index export at line 244.

`control-plane.ts`:

```ts
export async function resolveControlAddress(
  options: { readonly host?: string; readonly port?: string },
  path: string = configPath(),
): Promise<{ readonly host: string; readonly port: string }> {
  if (options.host !== undefined && options.port !== undefined) {
    return { host: options.host, port: options.port };
  }
  let configured: { host?: string; port?: number } = {};
  try {
    const config = parseRuntimeConfig(await new AtomicConfigFile(path).read(), readServiceEnvironment(path));
    configured = { host: config.server.host, port: config.server.port };
  } catch {
    // Unreadable / malformed / not-yet-created config: keep the loopback defaults.
  }
  return {
    host: options.host ?? configured.host ?? DEFAULT_CONTROL_HOST,
    port: options.port ?? (configured.port === undefined ? DEFAULT_CONTROL_PORT : String(configured.port)),
  };
}

// A local client must connect to a literal loopback address: a wildcard bind is not a destination,
// and a hostname or LAN address could route a bearer token off this machine.
export const localControlHost = (host: string): string | undefined => {
  if (host === '' || host === '0.0.0.0' || host === 'localhost') return '127.0.0.1';
  if (host === '::' || host === '::1') return '::1';
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u.test(host)) return host;
  return undefined;
};
```

and change `probeHealth`'s signature to `(base: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3_000)` using `fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })`.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && bun test src/paths && cd ../cli && bun test src/control-plane src/status src/upgrade`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/paths packages/core/src/index.ts packages/cli/src/control-plane
git commit -m "feat(cli): resolve a control address for an explicit home"
```

---

### Task 11: `__desktop-connect` discovery command

**Files:**
- Create: `packages/cli/src/desktop-connect/index.ts`
- Create: `packages/cli/src/desktop-connect/launchd-inspect.ts`
- Create: `packages/cli/src/desktop-connect/launchd-inspect.test.ts`
- Create: `packages/cli/src/desktop-connect/desktop-connect.ts`
- Create: `packages/cli/src/desktop-connect/desktop-connect.test.ts`
- Modify: `packages/cli/src/main.ts` (register the hidden command next to `registerHiddenPostUpgrade`)

**Interfaces:**
- Consumes: `LAUNCHD_EXEC_WRAPPER`, `LEGACY_LAUNCHD_EXEC_WRAPPERS` (Task 6); `launchdJobTarget`, `managedUnitPath` (Task 8 / existing); `readDesktopToken` (Task 1); `configPathIn`, `aioHome` (Task 10 / existing); `resolveControlAddress`, `localControlHost`, `controlBaseUrl`, `probeHealth` (Task 10).
- Produces (consumed by the Phase 2 Rust client through JSON):
  ```ts
  export type DesktopConnectResult = {
    readonly protocolVersion: 1;
    readonly bundledVersion: string;
    readonly unit: { readonly present: boolean; readonly wrapperValid: boolean; readonly target: string | null; readonly home: string | null; readonly owner: 'desktop' | 'external' | 'unknown' | null };
    readonly job: { readonly loaded: boolean; readonly disabled: boolean; readonly pid: number | null };
    readonly instance: { readonly controlUrl: string | null; readonly dashboardUrl: string | null; readonly reachable: boolean; readonly version: string | null; readonly pid: number | null; readonly matchesJob: boolean | null };
    readonly token: string | null;
  };
  export async function desktopConnect(deps: DesktopConnectDeps): Promise<DesktopConnectResult>;
  export async function printDesktopConnect(deps: DesktopConnectDeps, write: (text: string) => void): Promise<void>;
  ```

- [ ] **Step 1: Write the failing inspection tests**

```ts
// packages/cli/src/desktop-connect/launchd-inspect.test.ts
import { expect, test } from 'bun:test';

import { LAUNCHD_EXEC_WRAPPER, LEGACY_LAUNCHD_EXEC_WRAPPERS } from '../service';
import { inspectUnit, parseDisabled, parseJobPrint, unitOwner } from './launchd-inspect';

const plist = (args: unknown, env: Record<string, string> = { AIO_PROXY_HOME: '/Users/u/.aio-proxy' }) => ({
  ProgramArguments: args,
  EnvironmentVariables: env,
});

test('reads the target and home from a current or legacy wrapper', () => {
  for (const wrapper of [LAUNCHD_EXEC_WRAPPER, ...LEGACY_LAUNCHD_EXEC_WRAPPERS]) {
    expect(inspectUnit(plist(['/bin/sh', '-c', wrapper, '/x/aio-proxy']))).toEqual({
      present: true, wrapperValid: true, target: '/x/aio-proxy', home: '/Users/u/.aio-proxy',
    });
  }
});

test('an unrecognized wrapper is reported invalid with no target', () => {
  expect(inspectUnit(plist(['/usr/local/bin/aio-proxy', 'run']))).toEqual({
    present: true, wrapperValid: false, target: null, home: '/Users/u/.aio-proxy',
  });
});

test('a hand-edited plist without AIO_PROXY_HOME reports no home', () => {
  expect(inspectUnit(plist(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/x/aio-proxy'], {})).home).toBeNull();
  expect(inspectUnit({ ProgramArguments: ['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/x/aio-proxy'] }).home).toBeNull();
});

test('owner compares the wrapper target with the desktop symlink', () => {
  const unit = inspectUnit(plist(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/link/aio-proxy']));
  expect(unitOwner(unit, '/link/aio-proxy')).toBe('desktop');
  expect(unitOwner(unit, '/other/aio-proxy')).toBe('external');
  expect(unitOwner(unit, undefined)).toBe('external');
  expect(unitOwner(inspectUnit(plist(['/usr/local/bin/aio-proxy', 'run'])), '/link/aio-proxy')).toBe('unknown');
  expect(unitOwner({ present: false, wrapperValid: false, target: null, home: null }, '/link/aio-proxy')).toBeNull();
});

test('parses launchctl print for a running, a stopped, and an unloaded job', () => {
  expect(parseJobPrint(0, 'gui/501/com.aio-proxy.agent = {\n\tstate = running\n\tpid = 4312\n}')).toEqual({ loaded: true, pid: 4312 });
  expect(parseJobPrint(0, 'gui/501/com.aio-proxy.agent = {\n\tstate = not running\n}')).toEqual({ loaded: true, pid: null });
  expect(parseJobPrint(113, 'Could not find service')).toEqual({ loaded: false, pid: null });
});

test('parses print-disabled in both the current and the older boolean format', () => {
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => disabled\n}')).toBe(true);
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => enabled\n}')).toBe(false);
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => true\n}')).toBe(true);
  expect(parseDisabled('disabled services = {\n\t"com.other" => disabled\n}')).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cli && bun test src/desktop-connect`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the inspection module**

```ts
// packages/cli/src/desktop-connect/launchd-inspect.ts
import { isPlainObject } from 'es-toolkit/predicate';

import { LAUNCHD_EXEC_WRAPPER, LAUNCHD_LABEL, LEGACY_LAUNCHD_EXEC_WRAPPERS } from '../service';

export type UnitInspection = {
  readonly present: boolean;
  readonly wrapperValid: boolean;
  readonly target: string | null;
  readonly home: string | null;
};

const KNOWN_WRAPPERS = new Set([LAUNCHD_EXEC_WRAPPER, ...LEGACY_LAUNCHD_EXEC_WRAPPERS]);

/** `plist` is `plutil -convert json` output. ProgramArguments[0] is /bin/sh; the aio-proxy path is the fourth element. */
export function inspectUnit(plist: unknown): UnitInspection {
  if (!isPlainObject(plist)) return { present: true, wrapperValid: false, target: null, home: null };
  const args = plist['ProgramArguments'];
  const env = plist['EnvironmentVariables'];
  const home = isPlainObject(env) && typeof env['AIO_PROXY_HOME'] === 'string' ? env['AIO_PROXY_HOME'] : null;
  const wrapperValid =
    Array.isArray(args) &&
    args.length === 4 &&
    args[0] === '/bin/sh' &&
    args[1] === '-c' &&
    typeof args[2] === 'string' &&
    KNOWN_WRAPPERS.has(args[2]) &&
    typeof args[3] === 'string';
  return { present: true, wrapperValid, target: wrapperValid ? (args[3] as string) : null, home };
}

export function unitOwner(
  unit: UnitInspection,
  desktopExec: string | undefined,
): 'desktop' | 'external' | 'unknown' | null {
  if (!unit.present) return null;
  if (!unit.wrapperValid || unit.target === null) return 'unknown';
  return desktopExec !== undefined && unit.target === desktopExec ? 'desktop' : 'external';
}

export function parseJobPrint(code: number, stdout: string): { readonly loaded: boolean; readonly pid: number | null } {
  if (code !== 0) return { loaded: false, pid: null };
  const match = /^\s*pid = (\d+)\s*$/mu.exec(stdout);
  return { loaded: true, pid: match === null ? null : Number(match[1]) };
}

export function parseDisabled(stdout: string): boolean {
  const match = new RegExp(`"${LAUNCHD_LABEL.replaceAll('.', '\\.')}" => (\\w+)`, 'u').exec(stdout);
  return match?.[1] === 'disabled' || match?.[1] === 'true';
}
```

- [ ] **Step 4: Write the failing discovery tests**

```ts
// packages/cli/src/desktop-connect/desktop-connect.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LAUNCHD_EXEC_WRAPPER } from '../service';
import { desktopConnect, printDesktopConnect, type DesktopConnectDeps } from './desktop-connect';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aio-desktop-connect-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const link = '/Users/u/Library/Application Support/aio-proxy-desktop/bin/aio-proxy';
const home = () => join(root, 'service-home');

const writeConfig = (dir: string, host: string, port: number) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.jsonc'), JSON.stringify({ server: { host, port }, providers: {} }));
};

type Scenario = {
  readonly plist?: unknown;
  readonly jobPrint?: { readonly code: number; readonly stdout: string };
  readonly disabled?: string;
  readonly token?: string;
  readonly summaryPid?: number;
  readonly failLaunchctl?: boolean;
};

const deps = (scenario: Scenario, requests: Array<{ url: string; auth: string | null }> = []): DesktopConnectDeps => ({
  platform: 'darwin',
  env: { AIO_PROXY_DESKTOP_EXEC: link },
  bundledVersion: '0.37.0',
  plistPath: '/tmp/com.aio-proxy.agent.plist',
  defaultHome: () => join(root, 'default-home'),
  plistExists: () => scenario.plist !== undefined,
  readToken: () => scenario.token,
  run: async (cmd) => {
    if (cmd[0] === 'plutil') return { code: 0, stdout: JSON.stringify(scenario.plist) };
    if (scenario.failLaunchctl === true) throw new Error('launchctl missing');
    if (cmd[1] === 'print') return scenario.jobPrint ?? { code: 113, stdout: '' };
    return { code: 0, stdout: scenario.disabled ?? '' };
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/health')) return Response.json({ status: 'ok', version: '0.36.0' });
    if (scenario.summaryPid === undefined) return new Response('not found', { status: 404 });
    return Response.json({ protocolVersion: 1, server: { version: '0.36.0', pid: scenario.summaryPid } });
  }) as typeof fetch,
});

const desktopPlist = (target = link) => ({
  ProgramArguments: ['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, target],
  EnvironmentVariables: { AIO_PROXY_HOME: home() },
});

test('a desktop-owned running service is identified end to end', async () => {
  writeConfig(home(), '127.0.0.1', 19317);
  const result = await desktopConnect(
    deps({
      plist: desktopPlist(),
      jobPrint: { code: 0, stdout: 'state = running\n\tpid = 4312\n' },
      disabled: '"com.aio-proxy.agent" => enabled',
      token: 'T'.repeat(43),
      summaryPid: 4312,
    }),
  );
  expect(result).toEqual({
    protocolVersion: 1,
    bundledVersion: '0.37.0',
    unit: { present: true, wrapperValid: true, target: link, home: home(), owner: 'desktop' },
    job: { loaded: true, disabled: false, pid: 4312 },
    instance: {
      controlUrl: 'http://127.0.0.1:19317',
      dashboardUrl: 'http://127.0.0.1:19317/dashboard',
      reachable: true,
      version: '0.36.0',
      pid: 4312,
      matchesJob: true,
    },
    token: 'T'.repeat(43),
  });
});

test("an external service is probed at the plist's home, and a pid mismatch is reported", async () => {
  writeConfig(home(), '0.0.0.0', 29317);
  writeConfig(join(root, 'default-home'), '127.0.0.1', 9317);
  const requests: Array<{ url: string; auth: string | null }> = [];
  const result = await desktopConnect(
    deps(
      {
        plist: desktopPlist('/opt/homebrew/bin/aio-proxy'),
        jobPrint: { code: 0, stdout: 'pid = 100\n' },
        token: 'T'.repeat(43),
        summaryPid: 200,
      },
      requests,
    ),
  );
  expect(result.unit.owner).toBe('external');
  expect(result.instance.controlUrl).toBe('http://127.0.0.1:29317');
  expect(result.instance.matchesJob).toBe(false);
  expect(requests.every((request) => request.url.startsWith('http://127.0.0.1:29317/'))).toBe(true);
});

test('a non-loopback bind yields no control URL and no request carries the token', async () => {
  writeConfig(home(), '192.168.1.5', 9317);
  const requests: Array<{ url: string; auth: string | null }> = [];
  const result = await desktopConnect(deps({ plist: desktopPlist(), token: 'T'.repeat(43) }, requests));
  expect(result.instance).toEqual({
    controlUrl: null, dashboardUrl: null, reachable: false, version: null, pid: null, matchesJob: null,
  });
  expect(requests).toEqual([]);
});

test('an older instance without desktop-summary reports its /health version and an unknown pid', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(
    deps({ plist: desktopPlist(), jobPrint: { code: 0, stdout: 'pid = 7\n' }, token: 'T'.repeat(43) }),
  );
  expect(result.instance).toMatchObject({ reachable: true, version: '0.36.0', pid: null, matchesJob: null });
});

test('no plist falls back to the default home and reports no owner', async () => {
  writeConfig(join(root, 'default-home'), '127.0.0.1', 9317);
  const result = await desktopConnect(deps({}));
  expect(result.unit).toEqual({ present: false, wrapperValid: false, target: null, home: null, owner: null });
  expect(result.instance.controlUrl).toBe('http://127.0.0.1:9317');
});

test('a launchctl failure degrades the job fields instead of aborting', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  const result = await desktopConnect(deps({ plist: desktopPlist(), failLaunchctl: true }));
  expect(result.job).toEqual({ loaded: false, disabled: false, pid: null });
});

test('the command prints exactly one JSON line', async () => {
  writeConfig(home(), '127.0.0.1', 9317);
  let output = '';
  await printDesktopConnect(deps({ plist: desktopPlist(), failLaunchctl: true }), (text) => {
    output += text;
  });
  expect(output.endsWith('\n')).toBe(true);
  expect(output.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(output).protocolVersion).toBe(1);
});
```

- [ ] **Step 5: Run to verify failure**

Run: `cd packages/cli && bun test src/desktop-connect/desktop-connect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement discovery**

```ts
// packages/cli/src/desktop-connect/desktop-connect.ts
import { existsSync } from 'node:fs';

import { aioHome, configPathIn, readDesktopToken } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import { controlBaseUrl, localControlHost, probeHealth, resolveControlAddress } from '../control-plane';
import { launchdJobTarget, managedUnitPath } from '../service';
import { inspectUnit, parseDisabled, parseJobPrint, type UnitInspection, unitOwner } from './launchd-inspect';

const PROBE_TIMEOUT_MS = 2_000;

export type DesktopConnectDeps = {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly bundledVersion: string;
  readonly plistPath: string;
  readonly defaultHome: () => string;
  readonly plistExists: () => boolean;
  readonly readToken: (home: string) => string | undefined;
  readonly run: (cmd: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly fetch: typeof fetch;
};

export type DesktopConnectResult = {
  readonly protocolVersion: 1;
  readonly bundledVersion: string;
  readonly unit: UnitInspection & { readonly owner: 'desktop' | 'external' | 'unknown' | null };
  readonly job: { readonly loaded: boolean; readonly disabled: boolean; readonly pid: number | null };
  readonly instance: {
    readonly controlUrl: string | null;
    readonly dashboardUrl: string | null;
    readonly reachable: boolean;
    readonly version: string | null;
    readonly pid: number | null;
    readonly matchesJob: boolean | null;
  };
  readonly token: string | null;
};

const NO_UNIT: UnitInspection = { present: false, wrapperValid: false, target: null, home: null };
const UNREACHABLE: DesktopConnectResult['instance'] = {
  controlUrl: null, dashboardUrl: null, reachable: false, version: null, pid: null, matchesJob: null,
};

async function readUnit(deps: DesktopConnectDeps): Promise<UnitInspection> {
  if (!deps.plistExists()) return NO_UNIT;
  try {
    const { code, stdout } = await deps.run(['plutil', '-convert', 'json', '-o', '-', deps.plistPath]);
    return code === 0 ? inspectUnit(JSON.parse(stdout)) : inspectUnit(undefined);
  } catch {
    return inspectUnit(undefined);
  }
}

async function readJob(deps: DesktopConnectDeps): Promise<DesktopConnectResult['job']> {
  try {
    const printed = await deps.run(['launchctl', 'print', launchdJobTarget()]);
    const disabled = await deps.run(['launchctl', 'print-disabled', `gui/${process.getuid?.() ?? 0}`]);
    return { ...parseJobPrint(printed.code, printed.stdout), disabled: parseDisabled(disabled.stdout) };
  } catch {
    return { loaded: false, disabled: false, pid: null };
  }
}

async function summaryIdentity(
  deps: DesktopConnectDeps,
  controlUrl: string,
  token: string | undefined,
): Promise<{ readonly version: string; readonly pid: number } | undefined> {
  if (token === undefined) return undefined;
  try {
    const res = await deps.fetch(`${controlUrl}/dashboard/api/desktop-summary`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const server = isPlainObject(body) ? body['server'] : undefined;
    if (!isPlainObject(server) || typeof server['version'] !== 'string' || typeof server['pid'] !== 'number') return undefined;
    return { version: server['version'], pid: server['pid'] };
  } catch {
    return undefined;
  }
}

export async function desktopConnect(deps: DesktopConnectDeps): Promise<DesktopConnectResult> {
  const unit = await readUnit(deps);
  const owner = unitOwner(unit, deps.env['AIO_PROXY_DESKTOP_EXEC']);
  const job = await readJob(deps);
  // The service's own home, not this process's environment: the app is launched from Finder and
  // does not inherit the shell that installed the service.
  const home = unit.home ?? deps.defaultHome();
  const token = deps.readToken(home);
  const address = await resolveControlAddress({}, configPathIn(home));
  const host = localControlHost(address.host);
  if (host === undefined) return { protocolVersion: 1, bundledVersion: deps.bundledVersion, unit: { ...unit, owner }, job, instance: UNREACHABLE, token: token ?? null };
  const controlUrl = controlBaseUrl(host, address.port);
  const health = await probeHealth(controlUrl, deps.fetch, PROBE_TIMEOUT_MS);
  const identity = health === null ? undefined : await summaryIdentity(deps, controlUrl, token);
  const pid = identity?.pid ?? null;
  return {
    protocolVersion: 1,
    bundledVersion: deps.bundledVersion,
    unit: { ...unit, owner },
    job,
    instance: {
      controlUrl,
      dashboardUrl: `${controlUrl}/dashboard`,
      reachable: health !== null,
      version: identity?.version ?? health?.version ?? null,
      pid,
      matchesJob: pid === null || job.pid === null ? null : pid === job.pid,
    },
    token: token ?? null,
  };
}

/** stdout carries exactly this one line; anything human-readable belongs on stderr. */
export async function printDesktopConnect(deps: DesktopConnectDeps, write: (text: string) => void): Promise<void> {
  write(`${JSON.stringify(await desktopConnect(deps))}\n`);
}

export const defaultDesktopConnectDeps = (bundledVersion: string): DesktopConnectDeps => ({
  platform: process.platform,
  env: process.env,
  bundledVersion,
  plistPath: managedUnitPath('darwin') ?? '',
  defaultHome: aioHome,
  plistExists: () => {
    const path = managedUnitPath('darwin');
    return path !== undefined && existsSync(path);
  },
  readToken: (home) => readDesktopToken(home),
  run: async (cmd) => {
    const proc = Bun.spawn(cmd as string[], { stdout: 'pipe', stderr: 'ignore' });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  },
  fetch,
});
```

(`platform` is carried for the command guard below; `resolveControlAddress` uses the global fetch-free config read, and `probeHealth` uses `deps.fetch` from Task 10.)

```ts
// packages/cli/src/desktop-connect/index.ts
export { defaultDesktopConnectDeps, desktopConnect, printDesktopConnect, type DesktopConnectResult } from './desktop-connect';
```

In `main.ts`, add next to `registerHiddenPostUpgrade` and call it where that one is called:

```ts
const registerHiddenDesktopConnect = (program: Command): void => {
  program.command('__desktop-connect', { hidden: true }).action(async () => {
    const { defaultDesktopConnectDeps, printDesktopConnect } = await import('./desktop-connect');
    const deps = defaultDesktopConnectDeps(VERSION);
    if (deps.platform !== 'darwin') throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: deps.platform }));
    await printDesktopConnect(deps, (text) => process.stdout.write(text));
  });
};
```

(extend the existing `import { isKnownCliUserError, toExitCode } from './exit';` with `CliExit, EXIT`.) The update banner (`printUpdateBanner`) writes to stderr, so stdout stays exactly one JSON line without further changes.

- [ ] **Step 7: Run tests**

Run: `cd packages/cli && bun test src/desktop-connect src/main`
Expected: PASS.

- [ ] **Step 8: Manual check on a Mac with a running service**

Run: `cd packages/cli && bun src/main.dev.ts __desktop-connect | python3 -m json.tool`
Expected: one JSON object; `unit.owner` is `external` (a CLI-installed service) or `null`; `instance.reachable` matches whether the proxy is running. Do not paste the `token` value anywhere.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/desktop-connect packages/cli/src/main.ts
git commit -m "feat(cli): add hidden desktop discovery command"
```

---

### Task 12: Changeset and full verification

**Files:**
- Create: `.changeset/<generated-name>.md` via `bun changeset`

- [ ] **Step 1: Author the changeset**

Run: `bun changeset` and select `aio-proxy`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/cli`, `@aio-proxy/types`, `@aio-proxy/i18n`, all `minor`. Body:

```md
`aio-proxy service start` now restarts a launchd service that is loaded but not running, and a service whose binary was removed no longer respawns in a loop. The proxy also exposes a token-protected local summary endpoint and a discovery command for the upcoming macOS desktop app, and refuses to self-upgrade a binary that the desktop app manages.
```

- [ ] **Step 2: Run the full gate**

Run: `bun run preflight`
Expected: PASS. Then run `bun run build && bun run lint:types`.
Expected: PASS. Fix any type errors in test fakes that construct `OAuthQuotaCache` or `ServerState` by adding the new members, not by loosening types.

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: add changeset for desktop server and CLI support"
```
