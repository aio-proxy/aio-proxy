# OpenCode V1 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained, CLI-managed OpenCode V1 plugin that logs into aio-proxy with Device Authorization, publishes the authenticated schema-1 catalog from adapter-owned LKG, refreshes rotating credentials safely, and routes inference with the installation access token.

**Architecture:** `@aio-proxy/opencode-provider` contains one explicit V1 host binding and consumes only the concrete functions from `@aio-proxy/agent-provider-runtime`. Its `config` hook projects LKG into an in-memory custom Provider; its `auth.loader` owns request-time credential resolution, refresh persistence, catalog refresh, and a content-change-guarded instance rebuild. The emitted `dist/index.js` is bundled and has no runtime dependency on another aio-proxy workspace package.

**Tech Stack:** Bun 1.3.14, TypeScript, Rslib, OpenCode V1 `@opencode-ai/plugin` contract, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`

## Global Constraints

- The required compatibility floor is OpenCode `1.17.10`; the release gate also runs against the then-current version, initially pinned to `1.18.18`.
- This plan ships V1 only. Do not add a V2 `effect`, V2 credential storage, or dual-loader branching; the verified V1/V2 lifecycle and logout differences make V2 a separate future increment rather than a safe incidental export.
- The default export is exactly an object with `id: 'aio-proxy'` and `server`; do not export a legacy bare plugin function.
- The visible Provider ID is `aio-proxy`; the AI SDK package is `@ai-sdk/openai-compatible`; the base URL is the marker endpoint plus `/v1`.
- The required `options.apiKey` value `aio-proxy-managed` is a non-secret SDK placeholder. The custom fetch always replaces Authorization with the current installation access token, and aio-proxy never accepts the placeholder as authentication.
- Do not read or write OpenCode config or `auth.json` directly. `config` mutates only its in-memory argument and credential writes use `input.client.auth.set()`.
- Do not use V1 `provider.models` to register `aio-proxy`; OpenCode does not call it for an unknown Provider ID before config materialization.
- With no LKG, inject the Provider with an empty `models` object so the auth loader and login remain reachable.
- Read credentials with `getAuth()` immediately before refresh or request dispatch. Never close over an access or refresh token from loader initialization.
- Catalog refresh runs after login, on loader startup, and every `300_000` ms. Only a change to validated `catalog.models` may call `client.instance.dispose()`.
- A 401 never retries anonymously. Preserve LKG, attempt one credential refresh after re-reading host auth, and retry once with the returned access token. Inference returns that persistent retry 401 without anonymous fallback and does not latch login-required. A catalog second 401 or refresh `invalid_grant` throws the stable host-visible error `aio-proxy login required`; the stale catalog remains on disk.
- `dispose` clears the one owned interval; do not leave a detached timer.
- The emitted JS is self-contained. Only type-only host imports are allowed, and the artifact test must reject runtime imports containing `@aio-proxy/` or `@opencode-ai/plugin`.
- Handwritten non-test implementation files remain below 500 lines.
- Do not create a Changeset here; the lifecycle/release plan creates the single user-facing Changeset after both adapters and CLI lifecycle pass.
- Every commit appends `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Structure

- `packages/agent-provider/opencode/package.json` — private workspace package, build/test scripts, and type-only OpenCode development dependency.
- `packages/agent-provider/opencode/tsconfig.json` — package TypeScript configuration extending the workspace baseline.
- `packages/agent-provider/opencode/rslib.config.ts` — single-entry bundled ESM output at `dist/index.js`.
- `packages/agent-provider/opencode/src/index.ts` — export-only package entry.
- `packages/agent-provider/opencode/src/catalog/index.ts` — export-only private catalog barrel.
- `packages/agent-provider/opencode/src/catalog/catalog.ts` — schema-1 to OpenCode model projection and stable model-content digest.
- `packages/agent-provider/opencode/src/catalog/catalog.test.ts` — exact capability, modality, and nullable-limit mapping behavior.
- `packages/agent-provider/opencode/src/v1/index.ts` — export-only V1 barrel.
- `packages/agent-provider/opencode/src/v1/v1.ts` — Device login, credential refresh, authenticated fetch, LKG publication, rebuild guard, and disposal.
- `packages/agent-provider/opencode/src/v1/v1.test.ts` — host-contract tests with fake `PluginInput`, auth storage, timers, and HTTP responses.
- `packages/agent-provider/opencode/artifact.test.ts` — explicit post-build artifact import/shape/runtime-import gate; excluded from source-unit discovery.
- `packages/agent-provider/opencode/scripts/compat-v1.ts` — version-pinned real-host compatibility harness for `1.17.10` and current.

### Task 1: Package and exact OpenCode catalog projection

**Files:**

- Create: `packages/agent-provider/opencode/package.json`
- Create: `packages/agent-provider/opencode/tsconfig.json`
- Create: `packages/agent-provider/opencode/rslib.config.ts`
- Create: `packages/agent-provider/opencode/src/index.ts`
- Create: `packages/agent-provider/opencode/src/catalog/index.ts`
- Create: `packages/agent-provider/opencode/src/catalog/catalog.ts`
- Test: `packages/agent-provider/opencode/src/catalog/catalog.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: `AgentCatalogV1` from `@aio-proxy/types` and the OpenCode `ProviderConfig['models']` shape as a type-only development contract.
- Produces:
  - `toOpenCodeModels(catalog: AgentCatalogV1): Record<string, OpenCodeModelConfig>`
  - `openCodeCatalogDigest(catalog: AgentCatalogV1 | null): string`
  - bundled package entry `dist/index.js`.

- [ ] **Step 1: Write the failing projection tests**

```ts
// packages/agent-provider/opencode/src/catalog/catalog.test.ts
import { expect, test } from 'bun:test';
import type { AgentCatalogV1 } from '@aio-proxy/types';
import { openCodeCatalogDigest, toOpenCodeModels } from './catalog';

const catalog = (overrides: Partial<AgentCatalogV1['models'][number]> = {}): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'opencode',
  models: [{
    id: 'gpt-x', name: 'GPT X', reasoning: true, tool_call: false,
    temperature: true, attachment: true, input: ['text', 'image', 'pdf'],
    context_window: 200_000, max_output_tokens: 64_000, ...overrides,
  }],
});

test('maps every schema-1 capability without adapter-side guessing', () => {
  expect(toOpenCodeModels(catalog())).toEqual({
    'gpt-x': {
      name: 'GPT X', reasoning: true, tool_call: false, temperature: true, attachment: true,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      limit: { context: 200_000, output: 64_000 },
    },
  });
});

test('fills OpenCode-required numeric limits only when the wire value is null', () => {
  expect(toOpenCodeModels(catalog({ context_window: null, max_output_tokens: null }))['gpt-x']?.limit)
    .toEqual({ context: 128_000, output: 32_768 });
  expect(toOpenCodeModels(catalog({ context_window: 8_000, max_output_tokens: null }))['gpt-x']?.limit)
    .toEqual({ context: 8_000, output: 8_000 });
});

test('digest changes only when ordered model content changes', () => {
  const first = catalog();
  expect(openCodeCatalogDigest(first)).toBe(openCodeCatalogDigest(structuredClone(first)));
  expect(openCodeCatalogDigest(first)).not.toBe(openCodeCatalogDigest(catalog({ name: 'Renamed' })));
  expect(openCodeCatalogDigest(null)).toBe('missing');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bun test packages/agent-provider/opencode/src/catalog/catalog.test.ts`

Expected: FAIL because the package and catalog module do not exist.

- [ ] **Step 3: Create the package and minimal bundled build**

```json
{
  "name": "@aio-proxy/opencode-provider",
  "version": "0.8.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "rslib",
    "test": "bun run test:unit",
    "test:unit": "bun test src",
    "test:artifact": "bun test ./artifact.test.ts",
    "test:compat": "bun scripts/compat-v1.ts"
  },
  "dependencies": {
    "@aio-proxy/agent-provider-runtime": "workspace:*",
    "@aio-proxy/types": "workspace:*"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@opencode-ai/plugin": "1.18.18",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Use an explicit single-entry build and disable dependency auto-externalization so the CLI can install one file:

```ts
// packages/agent-provider/opencode/rslib.config.ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [{
    id: 'provider',
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

`src/index.ts` contains only:

```ts
export { opencodePlugin as default } from './v1';
```

- [ ] **Step 4: Implement the deterministic projection**

```ts
// packages/agent-provider/opencode/src/catalog/catalog.ts
import type { AgentCatalogV1 } from '@aio-proxy/types';
import type { Config } from '@opencode-ai/plugin';

type OpenCodeModelConfig = NonNullable<NonNullable<Config['provider']>[string]['models']>[string];
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 32_768;

export function toOpenCodeModels(catalog: AgentCatalogV1): Record<string, OpenCodeModelConfig> {
  return Object.fromEntries(catalog.models.map((model) => {
    const context = model.context_window ?? DEFAULT_CONTEXT;
    return [model.id, {
      name: model.name,
      reasoning: model.reasoning,
      tool_call: model.tool_call,
      temperature: model.temperature,
      attachment: model.attachment,
      modalities: { input: [...model.input], output: ['text'] },
      limit: { context, output: Math.min(context, model.max_output_tokens ?? DEFAULT_OUTPUT) },
    }];
  }));
}

export const openCodeCatalogDigest = (catalog: AgentCatalogV1 | null): string =>
  catalog === null ? 'missing' : JSON.stringify(catalog.models);
```

`catalog/index.ts` exports only these two functions. The type-only OpenCode import must be absent from emitted JavaScript.

- [ ] **Step 5: Run shared projection tests GREEN**

Run: `bun install && bun run --filter @aio-proxy/opencode-provider test:unit`

Expected: PASS. Do not build yet: `src/index.ts` intentionally points at the V1 entry created by Task 2.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-provider/opencode bun.lock
git commit -m "feat(opencode): map aio-proxy agent catalog" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: V1 Device login and rotating credential fetch

**Files:**

- Create: `packages/agent-provider/opencode/src/v1/index.ts`
- Create: `packages/agent-provider/opencode/src/v1/v1.ts`
- Test: `packages/agent-provider/opencode/src/v1/v1.test.ts`

**Interfaces:**

- Consumes from the shared runtime: `readManagedInstallation`, `requestDeviceAuthorization`, `pollDeviceAuthorization`, `refreshAgentCredential`, `createSingleFlight`, and `refreshAgentCatalog`.
- Produces: `opencodePlugin: PluginModule`, whose `server(input): Promise<Hooks>` has `auth`, `config`, and `dispose` hooks, plus the file-private-to-the-package `createOpenCodeV1Server(input, deps)` imported directly only by `v1.test.ts`. `src/v1/index.ts` exports only `opencodePlugin`.

- [ ] **Step 1: Write failing login and request-authentication tests**

```ts
// packages/agent-provider/opencode/src/v1/v1.test.ts
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentRuntimeError, readLastKnownCatalog, refreshAgentCatalog } from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentDeviceCodeResponse, AgentManagedMarker,
  AgentTokenResponse } from '@aio-proxy/types';
import type { Config, Hooks, PluginInput } from '@opencode-ai/plugin';
import { createOpenCodeV1Server, type OpenCodeV1Deps } from './v1';

type AuthLoader = NonNullable<NonNullable<Hooks['auth']>['loader']>;
type GetAuth = Parameters<AuthLoader>[0];
type Auth = Awaited<ReturnType<GetAuth>>;
type Provider = Parameters<AuthLoader>[1];

test('authorize presents Device Code and returns OpenCode OAuth credentials', async () => {
  const f = await fixture();
  f.device.resolve({
    device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    expires_in: 600, interval: 5,
  });
  f.poll.resolve({ token_type: 'Bearer', access_token: 'aio_agent_at_v1_access',
    refresh_token: 'aio_agent_rt_v1_refresh', expires_in: 900 });
  f.catalogResponses.push(catalog({ name: 'After Login' }));
  const hooks = await f.server();
  const flow = await hooks.auth!.methods[0]!.authorize();
  expect(flow).toMatchObject({ method: 'auto', url: expect.stringContaining('#code=ABCD-EFGH') });
  expect(await flow.callback()).toEqual({
    type: 'success', provider: 'aio-proxy', access: 'aio_agent_at_v1_access',
    refresh: 'aio_agent_rt_v1_refresh', expires: f.now + 900_000,
  });
  expect(f.readState().lkg.models[0].name).toBe('After Login');
  expect(f.authSet).not.toHaveBeenCalled();
  expect(f.instanceDispose).not.toHaveBeenCalled();
});

test('fetch re-reads expired auth, persists one rotation, and replaces caller authorization', async () => {
  const f = await fixture({ auth: { type: 'oauth', access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 999 } });
  f.setNow(1_000);
  f.refresh.resolve({ token_type: 'Bearer', access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new', expires_in: 900 });
  const loader = (await f.server()).auth!.loader!;
  const options = await loader(f.getAuth, f.provider);
  await Promise.all([
    options.fetch('http://127.0.0.1:9317/v1/chat/completions', { headers: { authorization: 'Bearer caller' } }),
    options.fetch('http://127.0.0.1:9317/v1/chat/completions'),
  ]);
  expect(f.refreshCalls).toBe(1);
  expect(f.authSet).toHaveBeenCalledTimes(1);
  expect(f.upstreamHeaders).toEqual(['Bearer aio_agent_at_v1_new', 'Bearer aio_agent_at_v1_new']);
});

test('401 never falls back to an anonymous retry', async () => {
  const f = await fixture({ upstreamStatus: 401 });
  f.refresh.resolve({ token_type: 'Bearer', access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new', expires_in: 900 });
  const options = await (await f.server()).auth!.loader!(f.getAuth, f.provider);
  const request = new Request('http://127.0.0.1:9317/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}',
  });
  await options.fetch(request);
  expect(f.upstreamHeaders).toHaveLength(2);
  expect(f.upstreamBodies).toEqual(['{"messages":[]}', '{"messages":[]}']);
  expect(f.upstreamHeaders.every((value) => value?.startsWith('Bearer aio_agent_at_v1_'))).toBe(true);
  expect(f.refreshCalls).toBe(1);
  expect(f.anonymousCalls).toBe(0);
});

test('two catalog 401 responses preserve LKG and require login after one rotation', async () => {
  const f = await fixture({ lkg: catalog() });
  f.catalogResponses.push(401, 401);
  f.refresh.resolve({ token_type: 'Bearer', access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new', expires_in: 900 });
  await expect((await f.server()).auth!.loader!(f.getAuth, f.provider))
    .rejects.toThrow('aio-proxy login required');
  expect(f.refreshCalls).toBe(1);
  expect(f.catalogRefreshCalls).toBe(2);
  expect(f.readState()).toMatchObject({ status: 'stale', lastError: 'unauthorized' });
  expect(f.anonymousCalls).toBe(0);
});

test('catalog 401 plus refresh invalid_grant preserves LKG and requires login', async () => {
  const f = await fixture({ lkg: catalog() });
  f.catalogResponses.push(401);
  f.refresh.reject(new AgentRuntimeError('invalid_grant'));
  await expect((await f.server()).auth!.loader!(f.getAuth, f.provider))
    .rejects.toThrow('aio-proxy login required');
  expect(f.refreshCalls).toBe(1);
  expect(f.readState()).toMatchObject({ status: 'stale', lastError: 'unauthorized' });
  expect(f.anonymousCalls).toBe(0);
});

test('config injects a zero-model provider before the first successful catalog', async () => {
  const f = await fixture({ lkg: null });
  const config = { provider: {} } as Config;
  await (await f.server()).config!(config);
  expect(config.provider?.['aio-proxy']).toEqual({
    name: 'aio-proxy', npm: '@ai-sdk/openai-compatible',
    options: { apiKey: 'aio-proxy-managed', baseURL: 'http://127.0.0.1:9317/v1' }, models: {},
  });
});

test('concurrent loaders share one catalog refresh and one interval, then dispose clears it', async () => {
  const f = await fixture();
  const hooks = await f.server();
  await Promise.all([
    hooks.auth!.loader!(f.getAuth, f.provider),
    hooks.auth!.loader!(f.getAuth, f.provider),
  ]);
  expect(f.catalogRefreshCalls).toBe(1);
  expect(f.activeIntervals()).toBe(1);
  await hooks.dispose!();
  expect(f.activeIntervals()).toBe(0);
});
```

Use this deterministic fixture rather than leaving host behavior implicit:

```ts
type FixtureOptions = {
  readonly auth?: Auth;
  readonly lkg?: AgentCatalogV1 | null;
  readonly upstreamStatus?: number;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const deferred = <T>() => Promise.withResolvers<T>();
const catalog = (overrides: Partial<AgentCatalogV1['models'][number]> = {}): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'opencode',
  models: [{ id: 'gpt-x', name: 'GPT X', reasoning: true, tool_call: true,
    temperature: false, attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048, ...overrides }],
});

async function fixture(options: FixtureOptions = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'aio-proxy-opencode-unit-'));
  roots.push(rootDir);
  const statePath = join(rootDir, '.aio-proxy-state.json');
  const marker = {
    format: 1, managedBy: 'aio-proxy', agent: 'opencode',
    installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
    adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
  } as const satisfies AgentManagedMarker;
  await Bun.write(join(rootDir, '.aio-proxy-managed.json'), JSON.stringify(marker));
  if (options.lkg !== undefined) await Bun.write(statePath, JSON.stringify({
    format: 1, catalogSchema: 1, status: options.lkg === null ? 'missing' : 'fresh',
    lastSuccessfulAt: options.lkg === null ? null : '2026-08-18T00:00:00.000Z',
    lastError: null, lkg: options.lkg,
  }));

  let now = 1_000;
  let storedAuth: Auth = options.auth ?? {
    type: 'oauth', access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh', expires: 901_000,
  };
  const device = deferred<AgentDeviceCodeResponse>();
  const poll = deferred<AgentTokenResponse>();
  const refresh = deferred<AgentTokenResponse>();
  let refreshCalls = 0;
  const catalogResponses: Array<AgentCatalogV1 | number> = [];
  const upstreamHeaders: Array<string | null> = [];
  const upstreamBodies: string[] = [];
  let anonymousCalls = 0;
  let catalogRefreshCalls = 0;
  const intervals = new Map<number, () => void | Promise<void>>();
  let intervalSequence = 0;

  const authSet = mock(async ({ body }: { readonly body: Auth }) => { storedAuth = body; });
  const instanceDispose = mock(async () => {});
  const input = {
    client: { auth: { set: authSet }, instance: { dispose: instanceDispose } },
  } as unknown as PluginInput;
  const runtimeFetch: typeof fetch = async (request, init) => {
    const normalized = new Request(request, init);
    const url = new URL(normalized.url);
    const authorization = normalized.headers.get('authorization');
    if (authorization === null) anonymousCalls += 1;
    if (url.pathname === '/v1/models') {
      const next = catalogResponses.shift();
      return next === undefined
        ? new Response('', { status: 503 })
        : typeof next === 'number' ? new Response('', { status: next }) : Response.json(next);
    }
    upstreamHeaders.push(authorization);
    upstreamBodies.push(await normalized.text());
    return new Response('', { status: options.upstreamStatus ?? 200 });
  };
  const deps: OpenCodeV1Deps = {
    now: () => now,
    fetch: runtimeFetch,
    readManagedInstallation: async () => ({
      rootDir, markerPath: join(rootDir, '.aio-proxy-managed.json'), statePath, marker,
    }),
    readLastKnownCatalog,
    requestDeviceAuthorization: async () => device.promise,
    pollDeviceAuthorization: async () => poll.promise,
    refreshAgentCredential: async () => { refreshCalls += 1; return refresh.promise; },
    refreshAgentCatalog: (value) => {
      catalogRefreshCalls += 1;
      return refreshAgentCatalog({ ...value, fetch: runtimeFetch, now: () => now });
    },
    setInterval: (callback) => {
      const id = ++intervalSequence;
      intervals.set(id, callback);
      return id as ReturnType<typeof globalThis.setInterval>;
    },
    clearInterval: (id) => { intervals.delete(id as number); },
  };
  return {
    authSet, catalogResponses, device, instanceDispose, poll, refresh, upstreamBodies, upstreamHeaders,
    get anonymousCalls() { return anonymousCalls; },
    get now() { return now; },
    get catalogRefreshCalls() { return catalogRefreshCalls; },
    get refreshCalls() { return refreshCalls; },
    getAuth: async () => structuredClone(storedAuth),
    provider: { id: 'aio-proxy' } as Provider,
    server: () => createOpenCodeV1Server(input, deps),
    setNow: (value: number) => { now = value; },
    activeIntervals: () => intervals.size,
    runRefreshTimer: async () => { for (const callback of intervals.values()) await callback(); },
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}
```

`OpenCodeV1Deps` is a narrow internal test seam, not a host abstraction:

```ts
export type OpenCodeV1Deps = {
  readonly now: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly readLastKnownCatalog: typeof readLastKnownCatalog;
  readonly requestDeviceAuthorization: typeof requestDeviceAuthorization;
  readonly pollDeviceAuthorization: typeof pollDeviceAuthorization;
  readonly refreshAgentCredential: typeof refreshAgentCredential;
  readonly refreshAgentCatalog: typeof refreshAgentCatalog;
  readonly setInterval: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
};
```

The production constant supplies the imported runtime functions, `Date.now`, `globalThis.fetch`, and global timer functions. The fixture's `getAuth()` always reads mutable `storedAuth`; `auth.set()` updates it, so token capture at loader initialization fails the tests.

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test packages/agent-provider/opencode/src/v1/v1.test.ts`

Expected: FAIL because the V1 module does not exist.

- [ ] **Step 3: Implement the production dependency set and complete V1 server**

```ts
// packages/agent-provider/opencode/src/v1/v1.ts
import {
  AgentRuntimeError,
  CATALOG_REFRESH_INTERVAL_MS,
  createSingleFlight,
  pollDeviceAuthorization,
  readLastKnownCatalog,
  readManagedInstallation,
  refreshAgentCatalog,
  refreshAgentCredential,
  requestDeviceAuthorization,
  type RefreshCatalogResult,
} from '@aio-proxy/agent-provider-runtime';
import type { Config, Hooks, PluginInput, PluginModule } from '@opencode-ai/plugin';
import { toOpenCodeModels } from '../catalog';

const PROVIDER_ID = 'aio-proxy';
const loginRequired = (): Error => new Error('aio-proxy login required');
type AuthLoader = NonNullable<NonNullable<Hooks['auth']>['loader']>;
type GetAuth = Parameters<AuthLoader>[0];
type Auth = Awaited<ReturnType<GetAuth>>;
type OAuthAuth = Extract<Auth, { type: 'oauth' }>;

const productionDeps: OpenCodeV1Deps = {
  now: Date.now,
  fetch: globalThis.fetch.bind(globalThis),
  readManagedInstallation,
  readLastKnownCatalog,
  requestDeviceAuthorization,
  pollDeviceAuthorization,
  refreshAgentCredential,
  refreshAgentCatalog,
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

export async function createOpenCodeV1Server(
  input: PluginInput,
  deps: OpenCodeV1Deps,
): Promise<Hooks> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'opencode');
  let catalog = await deps.readLastKnownCatalog(managed.statePath, 'opencode');
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const rotate = createSingleFlight(async (getAuth: GetAuth): Promise<OAuthAuth> => {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    let token: Awaited<ReturnType<typeof refreshAgentCredential>>;
    try {
      token = await deps.refreshAgentCredential(managed.marker, current.refresh, {
        fetch: deps.fetch,
        now: deps.now,
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.code === 'invalid_grant') throw loginRequired();
      throw error;
    }
    const next: OAuthAuth = {
      type: 'oauth',
      access: token.access_token,
      refresh: token.refresh_token,
      expires: deps.now() + token.expires_in * 1_000,
    };
    await input.client.auth.set({ path: { id: PROVIDER_ID }, body: next });
    return next;
  });

  async function resolveAccess(getAuth: GetAuth): Promise<string> {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    if (current.access !== '' && current.expires > deps.now()) return current.access;
    return (await rotate(getAuth)).access;
  }

  async function recoverUnauthorized(getAuth: GetAuth, rejectedAccess: string): Promise<OAuthAuth> {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    if (current.access !== rejectedAccess && current.expires > deps.now()) return current;
    return rotate(getAuth);
  }

  async function fetchWithAccess(
    access: string,
    request: Request,
  ): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${access}`);
    return deps.fetch(new Request(request, { headers }));
  }

  async function authenticatedFetch(
    getAuth: GetAuth,
    request: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const normalized = new Request(request, init);
    const access = await resolveAccess(getAuth);
    // Preserve one untouched copy for the authenticated retry. This matters for
    // Request bodies backed by streams, which cannot be reconstructed after fetch.
    const first = await fetchWithAccess(access, normalized.clone());
    if (first.status !== 401) return first;
    const next = await recoverUnauthorized(getAuth, access);
    return fetchWithAccess(next.access, normalized);
  }

  async function refreshWithAccess(accessToken: string): Promise<RefreshCatalogResult> {
    const result = await deps.refreshAgentCatalog({
      marker: managed.marker,
      statePath: managed.statePath,
      accessToken,
      fetch: deps.fetch,
      now: deps.now,
    });
    catalog = result.catalog;
    return result;
  }

  async function refreshFromStoredCredential(getAuth: GetAuth): Promise<void> {
    const access = await resolveAccess(getAuth);
    const first = await refreshWithAccess(access);
    if (first.error !== 'unauthorized') return;
    const next = await recoverUnauthorized(getAuth, access);
    const second = await refreshWithAccess(next.access);
    if (second.error === 'unauthorized') throw loginRequired();
  }

  const refreshCatalogFromStore = createSingleFlight(refreshFromStoredCredential);

  async function createLoader(getAuth: GetAuth): Promise<Record<string, unknown>> {
    await refreshCatalogFromStore(getAuth);
    timer ??= deps.setInterval(() => {
      void refreshCatalogFromStore(getAuth).catch(() => {
        console.warn('[aio-proxy] background catalog refresh failed');
      });
    }, CATALOG_REFRESH_INTERVAL_MS);
    return {
      apiKey: 'aio-proxy-managed',
      fetch: authenticatedFetch.bind(undefined, getAuth),
    };
  }

  async function publishConfig(config: Config): Promise<void> {
    config.provider ??= {};
    config.provider[PROVIDER_ID] = {
      name: PROVIDER_ID,
      npm: '@ai-sdk/openai-compatible',
      options: {
        apiKey: 'aio-proxy-managed',
        baseURL: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
      },
      models: catalog === null ? {} : toOpenCodeModels(catalog),
    };
  }

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: 'oauth',
        label: PROVIDER_ID,
        async authorize() {
          const device = await deps.requestDeviceAuthorization(managed.marker, {
            fetch: deps.fetch,
            now: deps.now,
          });
          return {
            method: 'auto' as const,
            url: device.verification_uri_complete,
            instructions: `Approve aio-proxy with code ${device.user_code}`,
            callback: async () => {
              const token = await deps.pollDeviceAuthorization(managed.marker, device, {
                fetch: deps.fetch,
                now: deps.now,
              });
              const result = await refreshWithAccess(token.access_token);
              if (result.error === 'unauthorized') throw loginRequired();
              return {
                type: 'success' as const,
                provider: PROVIDER_ID,
                access: token.access_token,
                refresh: token.refresh_token,
                expires: deps.now() + token.expires_in * 1_000,
              };
            },
          };
        },
      }],
      loader: createLoader,
    },
    config: publishConfig,
    async dispose() {
      if (timer !== undefined) deps.clearInterval(timer);
      timer = undefined;
    },
  };
}

export const opencodePlugin = {
  id: PROVIDER_ID,
  server: (input) => createOpenCodeV1Server(input, productionDeps),
} satisfies PluginModule;
```

`createOpenCodeV1Server` is exported only from `v1.ts` so its colocated test can inject deterministic dependencies; `src/v1/index.ts` exports only `opencodePlugin`. Expected OAuth/network failures are normalized by the shared runtime. The one background catch emits a fixed string and never serializes a credential or caught error.

- [ ] **Step 4: Re-run the focused test after replacing every global with `deps`**

Run: `bun test packages/agent-provider/opencode/src/v1/v1.test.ts --test-name-pattern 'authorize|re-reads|401'`

Expected: PASS; `deps.now`, `deps.fetch`, `deps.setInterval`, and `deps.clearInterval` are the only clock, HTTP, and timer effects inside `createOpenCodeV1Server`.

- [ ] **Step 5: Run V1 tests and the first complete build GREEN**

Run: `bun test packages/agent-provider/opencode/src/v1/v1.test.ts && bun run --filter @aio-proxy/opencode-provider build`

Expected: PASS; two simultaneous expired requests produce one token exchange and one `auth.set`, concurrent
loader refreshes issue one catalog request, a 401 retry preserves the exact POST body, and `dist/index.js` now exists.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-provider/opencode/src/v1 packages/agent-provider/opencode/src/index.ts
git commit -m "feat(opencode): add device login and rotating auth" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Config-hook LKG publication and terminating rebuild lifecycle

**Files:**

- Modify: `packages/agent-provider/opencode/src/v1/v1.ts`
- Modify: `packages/agent-provider/opencode/src/v1/v1.test.ts`

**Interfaces:**

- Consumes: Task 1 mapping/digest and shared runtime LKG result.
- Produces: one in-memory Provider projection per OpenCode config pass and at most one `instance.dispose()` for each distinct validated model content.

- [ ] **Step 1: Add failing lifecycle tests**

```ts
test('new catalog content persists before one rebuild and identical content terminates', async () => {
  const f = await fixture({ lkg: catalog({ name: 'Old' }) });
  f.catalogResponses.push(catalog({ name: 'New' }), catalog({ name: 'New' }));
  const hooks = await f.server();
  await hooks.auth!.loader!(f.getAuth, f.provider);
  expect(f.readState().lkg.models[0].name).toBe('New');
  expect(f.instanceDispose).toHaveBeenCalledTimes(1);
  await f.runRefreshTimer();
  expect(f.instanceDispose).toHaveBeenCalledTimes(1);
});

test('stale refresh preserves LKG without rebuilding for status-only changes', async () => {
  const old = catalog({ name: 'Old' });
  const f = await fixture({ lkg: old });
  const hooks = await f.server();
  await hooks.auth!.loader!(f.getAuth, f.provider);
  expect(f.readState()).toMatchObject({ status: 'stale', lkg: old });
  expect(f.instanceDispose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test packages/agent-provider/opencode/src/v1/v1.test.ts --test-name-pattern 'catalog content|status-only'`

Expected: FAIL because validated model changes are not yet connected to `instance.dispose()`.

- [ ] **Step 3: Add the model-content rebuild guard**

```ts
import { openCodeCatalogDigest, toOpenCodeModels } from '../catalog';

async function refreshWithAccess(
  accessToken: string,
  rebuildOnChange = true,
): Promise<RefreshCatalogResult> {
  const before = openCodeCatalogDigest(catalog);
  const result = await deps.refreshAgentCatalog({
    marker: managed.marker,
    statePath: managed.statePath,
    accessToken,
    fetch: deps.fetch,
    now: deps.now,
  });
  catalog = result.catalog;
  if (rebuildOnChange && openCodeCatalogDigest(catalog) !== before) {
    await input.client.instance.dispose();
  }
  return result;
}
```

In the same Task 3 edit, change the Device callback's post-poll call from
`await refreshWithAccess(token.access_token)` to
`await refreshWithAccess(token.access_token, false)`.

Call `refreshAgentCatalog` only after it has atomically committed fresh state or selected the prior LKG. Compare only `catalog.models`; do not rebuild on `fresh → stale`, error-category, or timestamp changes. Set the in-memory `catalog` before `dispose()` so any config pass racing the request observes the new value; the next process/instance also reads the same LKG from disk. The Device callback passes `false`: OpenCode persists the returned credential only after the callback resolves, so login may commit LKG but must not dispose the instance inside that pre-persistence window. A later loader/config pass reads the committed LKG with host-owned credentials already durable.

- [ ] **Step 4: Run lifecycle and package tests GREEN**

Run: `bun run --filter @aio-proxy/opencode-provider test:unit`

Expected: PASS, including the second identical refresh and the stale status-only refresh making zero additional dispose calls.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-provider/opencode/src/v1
git commit -m "feat(opencode): publish catalog through V1 config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Artifact boundary and real OpenCode V1 compatibility matrix

**Files:**

- Create: `packages/agent-provider/opencode/artifact.test.ts`
- Create: `packages/agent-provider/opencode/scripts/compat-v1.ts`
- Modify: `packages/agent-provider/opencode/package.json`

**Interfaces:**

- Consumes: built `dist/index.js`, `opencode-ai@1.17.10`, `opencode-ai@1.18.18`, and a temporary fake aio-proxy server implementing the exact schema-1/OAuth wire contract.
- Produces: a repeatable compatibility command that proves file discovery, V1 login, rotating refresh, catalog publication, and one OpenAI-compatible inference request.

- [ ] **Step 1: Write the failing artifact test**

```ts
import { expect, test } from 'bun:test';

test('built artifact is a self-contained V1 PluginModule', async () => {
  const code = await Bun.file(new URL('./dist/index.js', import.meta.url)).text();
  const runtimeImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:@aio-proxy\/|@opencode-ai\/plugin)/u;
  expect(runtimeImport.test(code)).toBe(false);
  const plugin = (await import(new URL('./dist/index.js', import.meta.url).href)).default;
  expect(plugin.id).toBe('aio-proxy');
  expect(typeof plugin.server).toBe('function');
  expect('effect' in plugin).toBe(false);
});
```

- [ ] **Step 2: Run it to verify RED**

Run: `bun run --filter @aio-proxy/opencode-provider build && bun run --filter @aio-proxy/opencode-provider test:artifact`

Expected: PASS if Tasks 1–3 honored the bundle boundary. This task adds a permanent artifact regression guard;
it does not manufacture a failing product state after the bundle already exists.

- [ ] **Step 3: Implement the real-host harness**

```ts
// packages/agent-provider/opencode/scripts/compat-v1.ts
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const INSTALLATION_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const DEVICE_CODE = 'e'.repeat(43);
const INITIAL_ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const INITIAL_REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const ROTATED_ACCESS = `aio_agent_at_v1_${'c'.repeat(43)}`;
const ROTATED_REFRESH = `aio_agent_rt_v1_${'d'.repeat(43)}`;
const versions = (process.env.OPENCODE_COMPAT_VERSIONS ?? '1.17.10,1.18.18')
  .split(',').map((value) => value.trim()).filter(Boolean);

type CommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type Stats = {
  readonly refreshExchanges: number;
  readonly inferenceAttempts: number;
  readonly anonymousCatalogCalls: number;
  readonly anonymousInferenceCalls: number;
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function startFakeProxy(options: { readonly rejectConsumedRefresh?: boolean } = {}) {
  let refreshExchanges = 0;
  let inferenceAttempts = 0;
  let anonymousCatalogCalls = 0;
  let anonymousInferenceCalls = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      if (url.pathname === '/oauth/device/code') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === 'aio-proxy-opencode', 'wrong Device client');
        check(body.get('agent') === 'opencode', 'wrong Device target');
        check(body.get('installation_id') === INSTALLATION_ID, 'wrong installation');
        return Response.json({
          device_code: DEVICE_CODE,
          user_code: 'ABCD-EFGH',
          verification_uri: `${url.origin}/dashboard/agents/authorize`,
          verification_uri_complete: `${url.origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/oauth/token') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === 'aio-proxy-opencode', 'wrong token client');
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          check(body.get('device_code') === DEVICE_CODE, 'wrong device code');
          return Response.json({ token_type: 'Bearer', access_token: INITIAL_ACCESS,
            refresh_token: INITIAL_REFRESH, expires_in: 900 });
        }
        check(body.get('grant_type') === 'refresh_token', 'wrong refresh grant');
        check(body.get('refresh_token') === INITIAL_REFRESH, 'wrong refresh token');
        if (options.rejectConsumedRefresh === true && refreshExchanges > 0) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        refreshExchanges += 1;
        await Bun.sleep(250);
        return Response.json({ token_type: 'Bearer', access_token: ROTATED_ACCESS,
          refresh_token: ROTATED_REFRESH, expires_in: 900 });
      }
      if (url.pathname === '/v1/models') {
        if (authorization === null) anonymousCatalogCalls += 1;
        check(
          authorization === null ||
            authorization === `Bearer ${INITIAL_ACCESS}` ||
            authorization === `Bearer ${ROTATED_ACCESS}`,
          'catalog used a disallowed Authorization value',
        );
        if (authorization !== `Bearer ${INITIAL_ACCESS}` && authorization !== `Bearer ${ROTATED_ACCESS}`)
          return new Response('', { status: 401 });
        check(url.searchParams.get('agent') === 'opencode', 'wrong catalog target');
        check(url.searchParams.get('schema_version') === '1', 'wrong catalog schema');
        return Response.json({
          schema_version: 1,
          agent: 'opencode',
          models: [{ id: 'compat-model', name: 'Compat Model', reasoning: false,
            tool_call: true, temperature: false, attachment: false, input: ['text'],
            context_window: 8_192, max_output_tokens: 2_048 }],
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        inferenceAttempts += 1;
        if (authorization === null) anonymousInferenceCalls += 1;
        check(
          authorization === null ||
            authorization === `Bearer ${INITIAL_ACCESS}` ||
            authorization === `Bearer ${ROTATED_ACCESS}`,
          'inference used a disallowed Authorization value',
        );
        if (authorization === `Bearer ${INITIAL_ACCESS}`) return new Response('', { status: 401 });
        if (authorization !== `Bearer ${ROTATED_ACCESS}`) return new Response('', { status: 401 });
        const stream = [
          'data: {"id":"compat","object":"chat.completion.chunk","created":0,"model":"compat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"compat-ok"},"finish_reason":null}]}\n\n',
          'data: {"id":"compat","object":"chat.completion.chunk","created":0,"model":"compat-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    stats: (): Stats => ({ refreshExchanges, inferenceAttempts,
      anonymousCatalogCalls, anonymousInferenceCalls }),
    stop: () => server.stop(true),
  };
}

async function runCommandRaw(version: string, root: string, args: string[]): Promise<CommandResult> {
  const configDir = join(root, 'config');
  const proc = Bun.spawn(['bunx', '--bun', `opencode-ai@${version}`, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      BROWSER: 'true',
      CI: '1',
      NO_COLOR: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  check(!timedOut, `${version} timed out: ${args.join(' ')}`);
  return { exitCode, stdout, stderr };
}

async function runCommand(version: string, root: string, args: string[]): Promise<CommandResult> {
  const result = await runCommandRaw(version, root, args);
  check(result.exitCode === 0,
    `${version} ${args.join(' ')} failed (${result.exitCode})\n${result.stderr}`);
  return result;
}

async function installManagedPlugin(root: string, endpoint: string): Promise<void> {
  const configDir = join(root, 'config');
  const managedDir = join(configDir, 'plugins', 'aio-proxy');
  await mkdir(managedDir, { recursive: true });
  await copyFile(new URL('../dist/index.js', import.meta.url), join(managedDir, 'index.js'));
  await writeFile(join(managedDir, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  await writeFile(join(managedDir, '.aio-proxy-managed.json'), JSON.stringify({
    format: 1, managedBy: 'aio-proxy', agent: 'opencode', installationId: INSTALLATION_ID,
    adapterVersion: '1.2.3', endpoint,
  }), { mode: 0o600 });
  await writeFile(join(configDir, 'plugins', 'aio-proxy.js'),
    `// aio-proxy-managed:v1:${INSTALLATION_ID}\nexport { default } from "./aio-proxy/index.js";\n`,
    { mode: 0o600 });
}

async function runVersion(version: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-opencode-${version}-`));
  const proxy = startFakeProxy();
  try {
    await installManagedPlugin(root, proxy.endpoint);

    await runCommand(version, root,
      ['auth', 'login', '--provider', 'aio-proxy', '--method', 'aio-proxy']);
    const models = await runCommand(version, root, ['models', 'aio-proxy']);
    check(models.stdout.includes('aio-proxy/compat-model'), `${version} did not publish compat-model`);
    const authPath = join(root, 'data', 'opencode', 'auth.json');
    const auth = await Bun.file(authPath).json() as Record<string, {
      access: string; refresh: string; expires: number;
    }>;
    check(auth['aio-proxy'] !== undefined, `${version} did not persist aio-proxy auth`);
    auth['aio-proxy'].expires = 0;
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    const inferences = await Promise.all([
      runCommand(version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat']),
      runCommand(version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat']),
    ]);
    for (const inference of inferences) {
      check(`${inference.stdout}\n${inference.stderr}`.includes('compat-ok'),
        `${version} did not return compat-ok`);
    }
    const stats = proxy.stats();
    check(stats.refreshExchanges >= 1 && stats.refreshExchanges <= 2,
      `${version} refresh count was ${stats.refreshExchanges}`);
    check(stats.inferenceAttempts === 2, `${version} inference count was ${stats.inferenceAttempts}`);
    check(stats.anonymousCatalogCalls === 0, `${version} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${version} made an anonymous inference request`);
  } finally {
    proxy.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function runReceivePersistFailure(version: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-opencode-crash-${version}-`));
  const proxy = startFakeProxy({ rejectConsumedRefresh: true });
  const authPath = join(root, 'data', 'opencode', 'auth.json');
  const authDir = dirname(authPath);
  try {
    await installManagedPlugin(root, proxy.endpoint);
    await runCommand(version, root,
      ['auth', 'login', '--provider', 'aio-proxy', '--method', 'aio-proxy']);
    const auth = await Bun.file(authPath).json() as Record<string, {
      access: string; refresh: string; expires: number;
    }>;
    const stored = auth['aio-proxy'];
    check(stored !== undefined, `${version} did not persist crash fixture auth`);
    stored.expires = 0;
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });

    // The refresh response is received, then client.auth.set() fails at the
    // persistence boundary. Directory and file permissions cover both direct
    // writes and atomic-replace implementations.
    await chmod(authPath, 0o400);
    await chmod(authDir, 0o500);
    const persistenceFailure = await runCommandRaw(
      version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat'],
    );
    check(persistenceFailure.exitCode !== 0,
      `${version} unexpectedly succeeded while auth persistence was blocked`);
    await chmod(authDir, 0o700);
    await chmod(authPath, 0o600);

    const unchanged = await Bun.file(authPath).json() as typeof auth;
    check(unchanged['aio-proxy']?.refresh === INITIAL_REFRESH,
      `${version} replaced the old refresh credential before persistence succeeded`);
    const relaunch = await runCommandRaw(
      version, root, ['run', '--model', 'aio-proxy/compat-model', 'compat'],
    );
    const diagnostic = `${relaunch.stdout}\n${relaunch.stderr}`;
    check(relaunch.exitCode !== 0, `${version} silently reused a consumed refresh credential`);
    check(/invalid_grant|log[ -]?in|required authentication/iu.test(diagnostic),
      `${version} did not emit a re-login diagnostic after invalid_grant:\n${diagnostic}`);

    const stats = proxy.stats();
    check(stats.refreshExchanges === 1, `${version} created ${stats.refreshExchanges} rotated pairs`);
    check(stats.anonymousCatalogCalls === 0, `${version} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${version} made an anonymous inference request`);
  } finally {
    await chmod(authDir, 0o700).catch(() => {});
    await chmod(authPath, 0o600).catch(() => {});
    proxy.stop();
    await rm(root, { recursive: true, force: true });
  }
}

for (const version of versions) {
  await runVersion(version);
  await runReceivePersistFailure(version);
}
```

Both versions intentionally run the same public V1 commands. `--method aio-proxy` removes an interactive method-selection prompt but does not bypass Device Authorization. OpenCode V1 has no cross-process auth-file lock, so the delayed happy-path refresh permits either one process to observe the other's persisted credential or both processes to exchange the same old refresh token inside the server's 30-second replay window; both must converge on the identical rotated pair. The second scenario makes the credential store non-writable only after login, proving that a received refresh response cannot be treated as durable before `client.auth.set()` succeeds; the unchanged old credential then receives `invalid_grant`, exits nonzero with a re-login diagnostic, and never retries catalog or inference anonymously. A future host command change must update this pinned gate; it must not add runtime version branching to the adapter.

- [ ] **Step 4: Run artifact and compatibility gates GREEN**

Run: `bun run --filter @aio-proxy/opencode-provider build && bun test packages/agent-provider/opencode/artifact.test.ts && bun run --filter @aio-proxy/opencode-provider test:compat`

Expected: PASS for `1.17.10` and `1.18.18`; both discover the adjacent `aio-proxy.js` entry, load the default V1 `server` export, and fail closed with a re-login diagnostic in the receive-before-persist crash window. No V2 acceptance is run because V2 is intentionally deferred.

- [ ] **Step 5: Run package and repository checks**

Run: `bun run --filter @aio-proxy/opencode-provider test:unit && bun run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-provider/opencode
git commit -m "test(opencode): pin V1 host compatibility" -m "Co-authored-by: Codex <noreply@openai.com>"
```
