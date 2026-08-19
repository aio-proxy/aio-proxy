# Pi-family Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one self-contained `@aio-proxy/pi-provider` package whose shared Device/catalog logic is exposed through a native official-Pi entry and a native OMP entry.

**Architecture:** A small package-local core maps schema-1 catalogs and runs the concrete Device/refresh/LKG operations from `@aio-proxy/agent-provider-runtime`. `official-pi.ts` binds that core to official Pi's credential-aware `refreshModels(context)` lifecycle; `omp.ts` binds it to OMP's `fetchDynamicModels(apiKey)` and ModelRegistry lifecycle. The two bindings remain explicit because their callback, timer, refresh, and model-publication contracts differ.

**Tech Stack:** Bun 1.3.14, TypeScript, Rslib, `@earendil-works/pi-coding-agent` 0.84.2 types, `@oh-my-pi/pi-coding-agent` 17.3.7 types, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`

## Global Constraints

- Publish one private workspace package named `@aio-proxy/pi-provider`; do not split official Pi and OMP into separate products.
- The package manifest contains both `"pi": { "extensions": ["./dist/official-pi.js"] }` and `"omp": { "extensions": ["./dist/omp.js"] }`. OMP selects `omp` and must not also load `pi`.
- The required floors are official Pi `0.84.2` and OMP `17.3.7`; the compatibility gate also runs each then-current version, initially the same pinned versions on 2026-08-18.
- Provider ID is `aio-proxy`, API is `openai-completions`, `authHeader` is `true`, and base URL is the marker endpoint plus `/v1`.
- Official Pi uses `refreshModels(context.credential)` and `context.publish`/return semantics. OMP uses `fetchDynamicModels(apiKey)` and `refreshRuntimeProviders('online')`; do not route either through the other host's compatibility shim.
- Production adapter code never reads or writes host credential files. Login and refresh return credentials to the host, and request keys come from the host resolver. The compatibility harness may seed official Pi's documented `auth.json` solely as test setup; OMP test setup must use `discoverAuthStorage()` and its normal SQLite store.
- Official Pi presents Device Authorization with `callbacks.onDeviceCode`. OMP has no `onDeviceCode`; it uses `callbacks.onAuth({ url, instructions })` with `verification_uri_complete`.
- Catalog refresh runs after login, at host startup, and every `300_000` ms. Concurrent refreshes in one extension instance are coalesced.
- Official Pi owns one raw interval and clears it on `session_shutdown`. OMP uses `ctx.setInterval`, whose lifecycle is host-managed; do not create a raw OMP timer. Both host tests must assert the refresh timer delay is exactly `300_000` ms.
- Official Pi receives a host-resolved credential in `refreshModels(context)`; a catalog 401 preserves LKG and throws `aio-proxy login required` because that callback cannot persist an extra token rotation. OMP may force one host credential refresh with `getApiKeyForProvider('aio-proxy', undefined, { forceRefresh: true })`, then retry once; undefined refresh output, refresh `invalid_grant`, or a second 401 throws the same stable error. Neither binding retries anonymously.
- OMP can call `fetchDynamicModels(apiKey)` with `apiKey === undefined` because the host filters expired OAuth credentials. Before `session_start`, serve adapter LKG without network access and mark pending recovery; do not throw early. After an active host context exists, resolve the key only through `getApiKeyForProvider('aio-proxy', undefined, { forceRefresh: true })` and retry only with that returned key. A real upstream catalog 401 still uses its own one-shot force-refresh path.
- `PiFamilyCatalogResult` retains `source` and `status`. When `source` is `missing`, do not return a silent empty catalog: `unauthorized` throws `aio-proxy login required`, `unsupported_schema` throws `aio-proxy adapter upgrade required`, and `network` / `server_error` / `invalid_json` / `invalid_catalog` throw `aio-proxy server required`.
- The package build script is exactly `rslib --lib pi-family`. Plain `rslib` also builds the repository `library` config and is not acceptable.
- Compatibility isolation deletes inherited `PI_OFFLINE` together with `OMP_AUTH_BROKER_URL` and `OMP_PROFILE`. Crash-window host output must contain the exact substring `aio-proxy login required`.
- Keep the current flat package paths and identities: `packages/agent-provider-runtime`, `packages/opencode-provider`, and `packages/pi-provider`. Do not migrate to `packages/agent-provider/*`.
- OMP performs an offline/background runtime-provider refresh before `session_start`. A 401 in that phase returns LKG and records pending recovery; the first `session_start` force-refreshes the host credential before one online runtime-provider refresh.
- Adapter-owned `.aio-proxy-state.json` is the LKG source of truth. Host model caches are downstream copies and are never read as aio-proxy state.
- Host model types can express only `text` and `image`; drop unsupported modalities rather than coercing audio/video/pdf to image.
- Official Pi `0.84.2` and OMP `17.3.7` expose the same `id/name/reasoning/input/cost/contextWindow/maxTokens` model fields and no explicit tool-capability field; do not invent or cast a `supportsTools` property.
- The build emits two self-contained ESM files. Runtime imports containing `@aio-proxy/`, `@earendil-works/`, or `@oh-my-pi/` are forbidden in both artifacts.
- Do not add a host interface, Agent SDK, adapter registry, generalized provider factory, schema-2 branch, or package-local credential store.
- Handwritten non-test implementation files remain below 500 lines.
- Do not create a Changeset here; the lifecycle/release plan creates one user-facing Changeset after both adapter packages and the CLI lifecycle pass.
- Every commit appends `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Structure

- `packages/pi-provider/package.json` — private package metadata, dual host manifests, scripts, and pinned type-only host dependencies.
- `packages/pi-provider/tsconfig.json` — workspace TypeScript configuration.
- `packages/pi-provider/rslib.config.ts` — bundled `official-pi` and `omp` ESM entries.
- `packages/pi-provider/src/core/index.ts` — export-only package-private core barrel.
- `packages/pi-provider/src/core/core.ts` — catalog projection plus concrete login, refresh, and LKG operations.
- `packages/pi-provider/src/core/core.test.ts` — exact capability/modality/limit projection and OAuth behavior.
- `packages/pi-provider/src/official-pi/index.ts` — export-only official Pi barrel.
- `packages/pi-provider/src/official-pi/official-pi.ts` — native official Pi registration and timer lifecycle.
- `packages/pi-provider/src/official-pi/official-pi.test.ts` — official callbacks, credential-aware catalog, and shutdown tests.
- `packages/pi-provider/src/omp/index.ts` — export-only OMP barrel.
- `packages/pi-provider/src/omp/omp.ts` — native OMP registration, 401 recovery, and managed timer.
- `packages/pi-provider/src/omp/omp.test.ts` — OMP callbacks, ModelRegistry recovery, cache refresh, and timer tests.
- `packages/pi-provider/artifact.test.ts` — explicit post-build dual-manifest/self-contained gate; excluded from source-unit discovery.
- `packages/pi-provider/scripts/compat-host.ts` — version-pinned real-loader/login/catalog/inference matrix for both hosts.

### Task 1: Package and shared Pi-family projection/OAuth core

**Files:**

- Create: `packages/pi-provider/package.json`
- Create: `packages/pi-provider/tsconfig.json`
- Create: `packages/pi-provider/rslib.config.ts`
- Create: `packages/pi-provider/src/core/index.ts`
- Create: `packages/pi-provider/src/core/core.ts`
- Test: `packages/pi-provider/src/core/core.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: `ManagedInstallation`, Device/token/catalog helpers, and `createSingleFlight` from `@aio-proxy/agent-provider-runtime`.
- Produces:
  - `PiFamilyModel`
  - `PiFamilyCatalogResult` with `models`, `source`, `status`, and optional `error`
  - `toPiFamilyModels(catalog): PiFamilyModel[]`
  - `piFamilyUnavailableMessage(error): string`
  - `readPiFamilyModels(managed, accessToken, options?): Promise<PiFamilyCatalogResult>`
  - `loginPiFamily(managed, presentDevice, options?): Promise<OAuthCredentials>`
  - `refreshPiFamilyCredential(marker, credentials, options?): Promise<OAuthCredentials>`

- [ ] **Step 1: Write failing shared-core tests**

```ts
// packages/pi-provider/src/core/core.test.ts
import { expect, mock, test } from 'bun:test';
import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';
import {
  loginPiFamily, piFamilyUnavailableMessage, readPiFamilyModels,
  refreshPiFamilyCredential, toPiFamilyModels,
} from './core';

const marker = {
  format: 1, managedBy: 'aio-proxy', agent: 'pi',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const catalog: AgentCatalogV1 = {
  schema_version: 1,
  agent: 'pi',
  models: [{
    id: 'gpt-x', name: 'GPT X', reasoning: true, tool_call: false,
    temperature: true, attachment: true,
    input: ['text', 'image', 'audio', 'video', 'pdf'],
    context_window: 200_000, max_output_tokens: 64_000,
  }],
};

test('maps the common Pi-family surface without inventing modalities or prices', () => {
  expect(toPiFamilyModels(catalog)).toEqual([{
    id: 'gpt-x', name: 'GPT X', reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000, maxTokens: 64_000,
  }]);
});

test('uses host-required numeric defaults only for null limits', () => {
  const nullLimits = structuredClone(catalog);
  nullLimits.models[0]!.context_window = null;
  nullLimits.models[0]!.max_output_tokens = null;
  expect(toPiFamilyModels(nullLimits)[0]).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
  nullLimits.models[0]!.context_window = 8_000;
  expect(toPiFamilyModels(nullLimits)[0]).toMatchObject({ contextWindow: 8_000, maxTokens: 8_000 });
});

test('login presents the exact Device response and returns host-owned OAuth credentials', async () => {
  const present = mock(() => {});
  const device = {
    device_code: 'device-code', user_code: 'ABCD-EFGH',
    verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    expires_in: 600, interval: 5,
  } as const;
  const credentials = await loginPiFamily(
    { rootDir: '/managed', markerPath: '/managed/.aio-proxy-managed.json',
      statePath: '/managed/.aio-proxy-state.json', marker },
    present,
    {
      now: () => 1_000,
      requestDeviceAuthorization: async () => device,
      pollDeviceAuthorization: async () => ({
        token_type: 'Bearer', access_token: 'aio_agent_at_v1_access',
        refresh_token: 'aio_agent_rt_v1_refresh', expires_in: 900,
      }),
      refreshAgentCatalog: async () => ({ catalog, source: 'network', status: 'fresh' }),
    },
  );
  expect(present).toHaveBeenCalledWith(device);
  expect(credentials).toEqual({
    access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh', expires: 901_000,
  });
});

test('login rejects a freshly issued credential that cannot read the catalog', async () => {
  await expect(loginPiFamily(
    { rootDir: '/managed', markerPath: '/managed/.aio-proxy-managed.json',
      statePath: '/managed/.aio-proxy-state.json', marker },
    () => {},
    {
      requestDeviceAuthorization: async () => ({
        device_code: 'device-code', user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600, interval: 5,
      }),
      pollDeviceAuthorization: async () => ({
        token_type: 'Bearer', access_token: 'aio_agent_at_v1_access',
        refresh_token: 'aio_agent_rt_v1_refresh', expires_in: 900,
      }),
      refreshAgentCatalog: async () => ({
        catalog, source: 'lkg', status: 'stale', error: 'unauthorized',
      }),
    },
  )).rejects.toThrow('aio-proxy login required');
});

test('refresh returns a complete rotated credential and forwards cancellation', async () => {
  const signal = AbortSignal.abort('test cancellation is passed but not observed by this stub');
  const refresh = mock(async (_marker, _token, options) => {
    expect(options.signal).toBe(signal);
    return { token_type: 'Bearer' as const, access_token: 'aio_agent_at_v1_new',
      refresh_token: 'aio_agent_rt_v1_new', expires_in: 900 };
  });
  await expect(refreshPiFamilyCredential(marker, { access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 0 }, {
    now: () => 2_000, signal, refreshAgentCredential: refresh,
  })).resolves.toEqual({ access: 'aio_agent_at_v1_new', refresh: 'aio_agent_rt_v1_new', expires: 902_000 });
});

test('refresh invalid_grant becomes one stable host-visible login diagnostic', async () => {
  await expect(refreshPiFamilyCredential(
    marker,
    { access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 0 },
    { refreshAgentCredential: async () => { throw new AgentRuntimeError('invalid_grant'); } },
  )).rejects.toThrow('aio-proxy login required');
});

const managed = {
  rootDir: '/managed', markerPath: '/managed/.aio-proxy-managed.json',
  statePath: '/managed/.aio-proxy-state.json', marker,
} as const;

test.each([
  ['unauthorized', 'aio-proxy login required'],
  ['network', 'aio-proxy server required'],
  ['server_error', 'aio-proxy server required'],
  ['invalid_json', 'aio-proxy server required'],
  ['invalid_catalog', 'aio-proxy server required'],
  ['unsupported_schema', 'aio-proxy adapter upgrade required'],
] as const)('missing %s maps to %s', (error, message) => {
  expect(piFamilyUnavailableMessage(error)).toBe(message);
});

test.each([
  'unauthorized', 'network', 'server_error', 'invalid_json', 'invalid_catalog', 'unsupported_schema',
] as const)('readPiFamilyModels preserves missing %s without inventing models', async (error) => {
  await expect(readPiFamilyModels(managed, 'token', {
    refreshAgentCatalog: async () => ({ catalog: null, source: 'missing', status: 'missing', error }),
  })).resolves.toEqual({ models: [], source: 'missing', status: 'missing', error });
});

test('login rejects a missing catalog with the spec start-server diagnostic', async () => {
  await expect(loginPiFamily(managed, () => {}, {
    requestDeviceAuthorization: async () => ({
      device_code: 'device-code', user_code: 'ABCD-EFGH',
      verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
      verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
      expires_in: 600, interval: 5,
    }),
    pollDeviceAuthorization: async () => ({
      token_type: 'Bearer', access_token: 'aio_agent_at_v1_access',
      refresh_token: 'aio_agent_rt_v1_refresh', expires_in: 900,
    }),
    refreshAgentCatalog: async () => ({
      catalog: null, source: 'missing', status: 'missing', error: 'network',
    }),
  })).rejects.toThrow('aio-proxy server required');
});

test('login rejects a missing incompatible schema with the upgrade diagnostic', async () => {
  await expect(loginPiFamily(managed, () => {}, {
    requestDeviceAuthorization: async () => ({
      device_code: 'device-code', user_code: 'ABCD-EFGH',
      verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
      verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
      expires_in: 600, interval: 5,
    }),
    pollDeviceAuthorization: async () => ({
      token_type: 'Bearer', access_token: 'aio_agent_at_v1_access',
      refresh_token: 'aio_agent_rt_v1_refresh', expires_in: 900,
    }),
    refreshAgentCatalog: async () => ({
      catalog: null, source: 'missing', status: 'missing', error: 'unsupported_schema',
    }),
  })).rejects.toThrow('aio-proxy adapter upgrade required');
});

test('undefined access token rereads LKG without a catalog request', async () => {
  const refresh = mock(async () => { throw new Error('network must not run'); });
  await expect(readPiFamilyModels(managed, undefined, {
    readLastKnownCatalog: async () => catalog,
    refreshAgentCatalog: refresh,
  })).resolves.toEqual({
    models: toPiFamilyModels(catalog), source: 'lkg', status: 'stale',
  });
  expect(refresh).not.toHaveBeenCalled();
});

test('undefined access token without LKG is missing and does not touch the network', async () => {
  const refresh = mock(async () => { throw new Error('network must not run'); });
  await expect(readPiFamilyModels(managed, undefined, {
    readLastKnownCatalog: async () => null,
    refreshAgentCatalog: refresh,
  })).resolves.toEqual({ models: [], source: 'missing', status: 'missing' });
  expect(refresh).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test packages/pi-provider/src/core/core.test.ts`

Expected: FAIL because the package and core do not exist.

- [ ] **Step 3: Create the dual-entry private package**

```json
{
  "name": "@aio-proxy/pi-provider",
  "version": "0.8.0",
  "private": true,
  "type": "module",
  "files": ["dist", "package.json"],
  "pi": { "extensions": ["./dist/official-pi.js"] },
  "omp": { "extensions": ["./dist/omp.js"] },
  "scripts": {
    "build": "rslib --lib pi-family",
    "test": "bun run test:unit",
    "test:unit": "bun test src",
    "test:artifact": "bun test ./artifact.test.ts",
    "test:compat": "bun scripts/compat-host.ts"
  },
  "dependencies": {
    "@aio-proxy/agent-provider-runtime": "workspace:*",
    "@aio-proxy/types": "workspace:*"
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@oh-my-pi/pi-coding-agent": "17.3.7",
    "@rslib/core": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

```ts
// packages/pi-provider/rslib.config.ts
import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [{
    id: 'pi-family', format: 'esm', bundle: true, autoExternal: false, dts: true,
    source: {
      entry: {
        'official-pi': './src/official-pi/index.ts',
        omp: './src/omp/index.ts',
      },
    },
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

- [ ] **Step 4: Implement the concrete shared operations**

```ts
// packages/pi-provider/src/core/core.ts
import {
  AgentRuntimeError,
  pollDeviceAuthorization,
  readLastKnownCatalog,
  refreshAgentCatalog,
  refreshAgentCredential,
  requestDeviceAuthorization,
  type ManagedInstallation,
  type RefreshCatalogResult,
} from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentDeviceCodeResponse, AgentManagedMarker, AgentTarget } from '@aio-proxy/types';

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 16_384;

export type OAuthCredentials = { readonly access: string; readonly refresh: string; readonly expires: number };
export type PiFamilyModel = {
  readonly id: string; readonly name: string; readonly reasoning: boolean;
  readonly input: Array<'text' | 'image'>;
  readonly cost: { readonly input: 0; readonly output: 0; readonly cacheRead: 0; readonly cacheWrite: 0 };
  readonly contextWindow: number; readonly maxTokens: number;
};
export type PiFamilyCatalogResult = {
  readonly models: PiFamilyModel[];
  readonly source: RefreshCatalogResult['source'];
  readonly status: RefreshCatalogResult['status'];
  readonly error?: RefreshCatalogResult['error'];
};

export function piFamilyUnavailableMessage(error: RefreshCatalogResult['error']): string {
  if (error === 'unauthorized') return 'aio-proxy login required';
  if (error === 'unsupported_schema') return 'aio-proxy adapter upgrade required';
  return 'aio-proxy server required';
}

export const toPiFamilyModels = (catalog: AgentCatalogV1): PiFamilyModel[] =>
  catalog.models.map((model) => {
    const contextWindow = model.context_window ?? DEFAULT_CONTEXT;
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(contextWindow, model.max_output_tokens ?? DEFAULT_OUTPUT),
    };
  });

type CoreOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly requestDeviceAuthorization?: typeof requestDeviceAuthorization;
  readonly pollDeviceAuthorization?: typeof pollDeviceAuthorization;
  readonly refreshAgentCredential?: typeof refreshAgentCredential;
  readonly refreshAgentCatalog?: typeof refreshAgentCatalog;
  readonly readLastKnownCatalog?: (
    statePath: string,
    expectedTarget: AgentTarget,
  ) => Promise<AgentCatalogV1 | null>;
};

const credentialFromToken = (
  token: { readonly access_token: string; readonly refresh_token: string; readonly expires_in: number },
  now: () => number,
): OAuthCredentials => ({
  access: token.access_token,
  refresh: token.refresh_token,
  expires: now() + token.expires_in * 1_000,
});

export async function loginPiFamily(
  managed: ManagedInstallation,
  presentDevice: (device: AgentDeviceCodeResponse) => void,
  options: CoreOptions = {},
): Promise<OAuthCredentials> {
  const request = options.requestDeviceAuthorization ?? requestDeviceAuthorization;
  const poll = options.pollDeviceAuthorization ?? pollDeviceAuthorization;
  const device = await request(managed.marker, options);
  presentDevice(device);
  const token = await poll(managed.marker, device, options);
  const catalog = await (options.refreshAgentCatalog ?? refreshAgentCatalog)({
    marker: managed.marker,
    statePath: managed.statePath,
    accessToken: token.access_token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (catalog.error === 'unauthorized' || catalog.source === 'missing') {
    throw new Error(piFamilyUnavailableMessage(catalog.error));
  }
  return credentialFromToken(token, options.now ?? Date.now);
}

export async function refreshPiFamilyCredential(
  marker: AgentManagedMarker,
  credential: OAuthCredentials,
  options: CoreOptions = {},
): Promise<OAuthCredentials> {
  let token: Awaited<ReturnType<typeof refreshAgentCredential>>;
  try {
    token = await (options.refreshAgentCredential ?? refreshAgentCredential)(
      marker, credential.refresh, options,
    );
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === 'invalid_grant')
      throw new Error('aio-proxy login required');
    throw error;
  }
  return credentialFromToken(token, options.now ?? Date.now);
}

export async function readPiFamilyModels(
  managed: ManagedInstallation,
  accessToken: string | undefined,
  options: CoreOptions = {},
): Promise<PiFamilyCatalogResult> {
  if (accessToken === undefined) {
    const lkg = await (options.readLastKnownCatalog ?? readLastKnownCatalog)(
      managed.statePath, managed.marker.agent,
    );
    return lkg === null
      ? { models: [], source: 'missing', status: 'missing' }
      : { models: toPiFamilyModels(lkg), source: 'lkg', status: 'stale' };
  }
  const result = await (options.refreshAgentCatalog ?? refreshAgentCatalog)({
    marker: managed.marker,
    statePath: managed.statePath,
    accessToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    models: result.catalog === null ? [] : toPiFamilyModels(result.catalog),
    source: result.source,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
```

`core/index.ts` contains only explicit exports of the types/functions above, including `piFamilyUnavailableMessage`. Do not export `CoreOptions`; it is inferred at call sites and exists only to keep unit effects deterministic.

- [ ] **Step 5: Run shared-core tests GREEN**

Run: `bun install && bun run --filter @aio-proxy/pi-provider test:unit`

Expected: PASS. Do not build yet: the two entry files are created by Tasks 2–3.

- [ ] **Step 6: Commit**

```bash
git add packages/pi-provider bun.lock
git commit -m "feat(pi): add shared provider integration core" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Native official Pi entry

**Files:**

- Create: `packages/pi-provider/src/official-pi/index.ts`
- Create: `packages/pi-provider/src/official-pi/official-pi.ts`
- Test: `packages/pi-provider/src/official-pi/official-pi.test.ts`

**Interfaces:**

- Consumes: official Pi `ExtensionAPI`, `RefreshModelsContext`, and `OAuthCredentials` as type-only contracts plus Task 1 core.
- Produces: default official Pi `ExtensionFactory`; one registered `aio-proxy` provider; one raw 5-minute timer per loaded extension, cleared on `session_shutdown`.

- [ ] **Step 1: Write failing official-host tests**

```ts
// packages/pi-provider/src/official-pi/official-pi.test.ts
import { expect, mock, test } from 'bun:test';
import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { toPiFamilyModels, type PiFamilyCatalogResult } from '../core';
import { registerOfficialPi, type OfficialPiDeps } from './official-pi';


test('uses onDeviceCode and returns credentials without touching auth storage', async () => {
  const f = await fixture();
  const onDeviceCode = mock(() => {});
  const credentials = await f.provider.oauth!.login({
    onAuth: mock(() => {}), onDeviceCode, onPrompt: async () => '', onSelect: async () => undefined,
  });
  expect(onDeviceCode).toHaveBeenCalledWith({
    userCode: 'ABCD-EFGH',
    verificationUri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    intervalSeconds: 5, expiresInSeconds: 600,
  });
  expect(credentials).toMatchObject({ access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh' });
});

test('refreshModels consumes host-refreshed context credential and publishes exact models', async () => {
  const f = await fixture();
  const models = await f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
    allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async () => true,
  });
  expect(f.catalogAccesses).toEqual(['host-current']);
  expect(models).toEqual([expect.objectContaining({ id: 'compat-model', reasoning: false })]);
  expect(models[0]).toEqual({
    id: 'compat-model', name: 'compat-model', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192, maxTokens: 2_048,
  });
});

test('catalog 401 keeps host LKG and returns a stable re-login diagnostic', async () => {
  const f = await fixture({ catalogResults: [{
    models: toPiFamilyModels(hostCatalog('lkg')), source: 'lkg', status: 'stale', error: 'unauthorized',
  }] });
  await expect(f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
    allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async () => true,
  })).rejects.toThrow('aio-proxy login required');
  expect(f.catalogAccesses).toEqual(['host-current']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('offline refresh re-reads the current LKG instead of the registration snapshot', async () => {
  const f = await fixture();
  f.setLkg(hostCatalog('new-lkg'));
  const models = await f.provider.refreshModels!({
    allowNetwork: false, force: false,
    signal: new AbortController().signal, publish: async () => true,
  });
  expect(models.map(({ id }) => id)).toEqual(['new-lkg']);
  expect(f.catalogAccesses).toEqual([]);
});

test('missing catalog after a network failure throws the start-server diagnostic', async () => {
  const f = await fixture({ catalogResults: [{
    models: [], source: 'missing', status: 'missing', error: 'network',
  }] });
  await expect(f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
    allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async () => true,
  })).rejects.toThrow('aio-proxy server required');
});

test('missing incompatible schema throws the upgrade diagnostic', async () => {
  const f = await fixture({ catalogResults: [{
    models: [], source: 'missing', status: 'missing', error: 'unsupported_schema',
  }] });
  await expect(f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
    allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async () => true,
  })).rejects.toThrow('aio-proxy adapter upgrade required');
});

test('one raw timer requests a forced provider refresh and shutdown clears it', async () => {
  const f = await fixture();
  const refresh = mock(async () => ({ aborted: false, errors: new Map() }));
  const context = { modelRegistry: { refresh } };
  await f.emit('session_start', context);
  await f.emit('session_start', context);
  expect(f.activeTimers()).toBe(1);
  expect(f.timerDelays).toEqual([300_000]);
  await f.tick();
  expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ['aio-proxy'], force: true });
  await f.emit('session_shutdown', context);
  expect(f.activeTimers()).toBe(0);
});
```

Use this complete fixture. Its fake `ExtensionAPI` deliberately exposes no auth-file method, so the binding cannot hide direct credential-file access:

```ts
const HOST_MARKER = {
  format: 1, managedBy: 'aio-proxy', agent: 'pi',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const hostCatalog = (id = 'compat-model'): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'pi',
  models: [{
    id, name: id, reasoning: false, tool_call: true, temperature: false,
    attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048,
  }],
});

async function fixture(options: { readonly catalogResults?: PiFamilyCatalogResult[] } = {}) {
  let lkg = hostCatalog();
  let provider: ProviderConfig | undefined;
  const catalogAccesses: Array<string | undefined> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const timers = new Map<number, () => void | Promise<void>>();
  const timerDelays: number[] = [];
  let timerSequence = 0;
  const catalogResults = [...(options.catalogResults ?? [])];
  const managed = {
    rootDir: '/managed', markerPath: '/managed/.aio-proxy-managed.json',
    statePath: '/managed/.aio-proxy-state.json', marker: HOST_MARKER,
  } as const;
  const credentials = {
    access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh', expires: 901_000,
  } as const;

  const api = {
    registerProvider: (_name: string, config: ProviderConfig) => { provider = config; },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const deps: OfficialPiDeps = {
    readManagedInstallation: async () => managed,
    readLastKnownCatalog: async () => structuredClone(lkg),
    loginPiFamily: async (_managed, present) => {
      present({
        device_code: 'device', user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600, interval: 5,
      });
      return credentials;
    },
    refreshPiFamilyCredential: async () => credentials,
    readPiFamilyModels: async (_managed, access) => {
      catalogAccesses.push(access);
      return catalogResults.shift() ?? {
        models: toPiFamilyModels(lkg), source: 'network', status: 'fresh',
      };
    },
    setInterval: ((callback: () => void | Promise<void>, delay: number) => {
      const id = ++timerSequence;
      timerDelays.push(delay);
      timers.set(id, callback);
      return id as ReturnType<typeof globalThis.setInterval>;
    }) as OfficialPiDeps['setInterval'],
    clearInterval: ((handle: ReturnType<typeof globalThis.setInterval>) => {
      timers.delete(handle as number);
    }) as OfficialPiDeps['clearInterval'],
  };
  await registerOfficialPi(api, deps);
  if (provider === undefined) throw new Error('official Pi provider was not registered');

  return {
    provider,
    catalogAccesses,
    timerDelays,
    setLkg: (next: AgentCatalogV1) => { lkg = next; },
    activeTimers: () => timers.size,
    tick: async () => { for (const callback of timers.values()) await callback(); },
    emit: async (event: 'session_start' | 'session_shutdown', context: unknown) => {
      const handler = handlers.get(event);
      if (handler === undefined) throw new Error(`missing ${event} handler`);
      await handler({}, context);
    },
  };
}
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bun test packages/pi-provider/src/official-pi/official-pi.test.ts`

Expected: FAIL because the official entry does not exist.

- [ ] **Step 3: Implement the official Pi binding**

```ts
// packages/pi-provider/src/official-pi/official-pi.ts
import {
  CATALOG_REFRESH_INTERVAL_MS,
  createSingleFlight,
  readLastKnownCatalog,
  readManagedInstallation,
} from '@aio-proxy/agent-provider-runtime';
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';
import {
  loginPiFamily,
  piFamilyUnavailableMessage,
  readPiFamilyModels,
  refreshPiFamilyCredential,
  toPiFamilyModels,
  type OAuthCredentials,
} from '../core';

const PROVIDER_ID = 'aio-proxy';
type RefreshModelsContext = Parameters<NonNullable<ProviderConfig['refreshModels']>>[0];

export type OfficialPiDeps = {
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly readLastKnownCatalog: typeof readLastKnownCatalog;
  readonly loginPiFamily: typeof loginPiFamily;
  readonly refreshPiFamilyCredential: typeof refreshPiFamilyCredential;
  readonly readPiFamilyModels: typeof readPiFamilyModels;
  readonly setInterval: typeof globalThis.setInterval;
  readonly clearInterval: typeof globalThis.clearInterval;
};

const productionDeps: OfficialPiDeps = {
  readManagedInstallation,
  readLastKnownCatalog,
  loginPiFamily,
  refreshPiFamilyCredential,
  readPiFamilyModels,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

export async function registerOfficialPi(pi: ExtensionAPI, deps: OfficialPiDeps): Promise<void> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'pi');
  const lkg = await deps.readLastKnownCatalog(managed.statePath, 'pi');
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const refreshModels = createSingleFlight(async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
    const access = context.credential?.type === 'oauth' ? context.credential.access : undefined;
    const result = context.allowNetwork
      ? await deps.readPiFamilyModels(managed, access, { signal: context.signal })
      : await deps.readLastKnownCatalog(managed.statePath, 'pi').then((current) => (
          current === null
            ? { models: [], source: 'missing' as const, status: 'missing' as const }
            : { models: toPiFamilyModels(current), source: 'lkg' as const, status: 'stale' as const }
        ));
    if (result.error === 'unauthorized') throw new Error('aio-proxy login required');
    if (result.source === 'missing') throw new Error(piFamilyUnavailableMessage(result.error));
    return [...result.models];
  });

  const config: ProviderConfig = {
    name: PROVIDER_ID,
    baseUrl: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
    api: 'openai-completions',
    authHeader: true,
    models: lkg === null ? [] : [...toPiFamilyModels(lkg)],
    refreshModels,
    oauth: {
      name: PROVIDER_ID,
      login: (callbacks) => deps.loginPiFamily(managed, (device) => callbacks.onDeviceCode({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        intervalSeconds: device.interval,
        expiresInSeconds: device.expires_in,
      }), callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
      refreshToken: (credential, signal) => deps.refreshPiFamilyCredential(
        managed.marker,
        credential,
        signal === undefined ? {} : { signal },
      ),
      getApiKey: (credential) => credential.access,
    },
  };
  pi.registerProvider(PROVIDER_ID, config);

  pi.on('session_start', async (_event, context: ExtensionContext) => {
    await context.modelRegistry.refresh({ allowNetwork: true, providers: [PROVIDER_ID], force: true });
    timer ??= deps.setInterval(() => {
      void context.modelRegistry
        .refresh({ allowNetwork: true, providers: [PROVIDER_ID], force: true })
        .catch(() => console.warn('[aio-proxy] official Pi catalog refresh failed'));
    }, CATALOG_REFRESH_INTERVAL_MS);
  });
  pi.on('session_shutdown', () => {
    if (timer !== undefined) deps.clearInterval(timer);
    timer = undefined;
  });
}

export default async function officialPi(pi: ExtensionAPI): Promise<void> {
  await registerOfficialPi(pi, productionDeps);
}
```

Use type-only imports for both official packages; emitted JavaScript must contain neither scope. `official-pi/index.ts` contains only `export { default } from './official-pi';`.

- [ ] **Step 4: Run official entry tests GREEN**

Run: `bun test packages/pi-provider/src/official-pi/official-pi.test.ts`

Expected: PASS; the host-refreshed credential is the only catalog access token, exactly one timer exists with delay `300_000`, missing catalogs throw the spec diagnostics, and shutdown clears the timer.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-provider/src/official-pi
git commit -m "feat(pi): register native official Pi provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Native OMP entry

**Files:**

- Create: `packages/pi-provider/src/omp/index.ts`
- Create: `packages/pi-provider/src/omp/omp.ts`
- Test: `packages/pi-provider/src/omp/omp.test.ts`

**Interfaces:**

- Consumes: OMP `ExtensionAPI`, `ExtensionContext`, `fetchDynamicModels(apiKey)`, and ModelRegistry APIs as type-only contracts plus Task 1 core, including `piFamilyUnavailableMessage` and `PiFamilyCatalogResult.source`.
- Produces: default OMP `ExtensionFactory`; one registered `aio-proxy` provider; one host-managed 5-minute refresh timer whose delay is exactly `300_000` ms.

- [ ] **Step 1: Write failing OMP lifecycle tests**

```ts
// packages/pi-provider/src/omp/omp.test.ts
import { expect, mock, test } from 'bun:test';
import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';
import type { ExtensionAPI, ProviderConfig } from '@oh-my-pi/pi-coding-agent';
import { toPiFamilyModels, type PiFamilyCatalogResult } from '../core';
import { registerOmp, type OmpDeps } from './omp';

test('OMP login presents verification_uri_complete through onAuth', async () => {
  const f = await fixture();
  const onAuth = mock(() => {});
  await f.provider.oauth!.login({ onAuth, onPrompt: async () => '' });
  expect(onAuth).toHaveBeenCalledWith({
    url: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    instructions: 'Approve aio-proxy with code ABCD-EFGH',
  });
});

test('catalog 401 force-refreshes host auth once and retries only with the returned key', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels(), source: 'lkg', status: 'stale', error: 'unauthorized' },
    { models: fModels('fresh'), source: 'network', status: 'fresh' },
  ] });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'fresh' }),
  ]);
  expect(getApiKeyForProvider).toHaveBeenCalledWith(
    'aio-proxy', undefined, { forceRefresh: true },
  );
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('a second catalog 401 requires login after exactly one forced refresh', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
  ] });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old'))
    .rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('a missing refreshed OMP credential requires login without an anonymous retry', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
  ] });
  const getApiKeyForProvider = mock(async () => undefined);
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old'))
    .rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old']);
});

test('a failed OMP credential refresh uses the stable login-required diagnostic', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
  ] });
  const getApiKeyForProvider = mock(async () => { throw new Error('invalid_grant'); });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old'))
    .rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old']);
});

test('pre-session undefined key serves LKG without network and marks pending recovery', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale' },
    { models: fModels('fresh'), source: 'network', status: 'fresh' },
  ] });
  await expect(f.provider.fetchDynamicModels!(undefined)).resolves.toEqual([
    expect.objectContaining({ id: 'lkg' }),
  ]);
  expect(f.catalogAccesses).toEqual([undefined]);

  const order: string[] = [];
  const getApiKeyForProvider = mock(async () => {
    order.push('credential');
    return 'aio_agent_at_v1_new';
  });
  const refreshRuntimeProviders = mock(async () => {
    order.push('catalog');
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });

  expect(order).toEqual(['credential', 'catalog']);
  expect(getApiKeyForProvider).toHaveBeenCalledWith(
    'aio-proxy', undefined, { forceRefresh: true },
  );
  expect(f.catalogAccesses).toEqual([undefined, 'aio_agent_at_v1_new']);
});

test('pre-session undefined key without LKG throws aio-proxy login required', async () => {
  const f = await fixture({ catalogResults: [
    { models: [], source: 'missing', status: 'missing' },
  ] });
  await expect(f.provider.fetchDynamicModels!(undefined))
    .rejects.toThrow('aio-proxy login required');
  expect(f.catalogAccesses).toEqual([undefined]);
});

test('active-context undefined key force-refreshes and retries only with the host key', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('fresh'), source: 'network', status: 'fresh' },
  ] });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!(undefined)).resolves.toEqual([
    expect.objectContaining({ id: 'fresh' }),
  ]);
  expect(getApiKeyForProvider).toHaveBeenCalledWith(
    'aio-proxy', undefined, { forceRefresh: true },
  );
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_new']);
});

test('active-context undefined key that cannot refresh requires login without a catalog token', async () => {
  const f = await fixture();
  const getApiKeyForProvider = mock(async () => undefined);
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!(undefined))
    .rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual([]);
});

test('pre-session 401 serves LKG, then refreshes auth before the online republish', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
    { models: fModels('fresh'), source: 'network', status: 'fresh' },
  ] });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'lkg' }),
  ]);

  const order: string[] = [];
  const getApiKeyForProvider = mock(async () => {
    order.push('credential');
    return 'aio_agent_at_v1_new';
  });
  const refreshRuntimeProviders = mock(async () => {
    order.push('catalog');
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });

  expect(order).toEqual(['credential', 'catalog']);
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('pre-session recovery does not force-refresh twice when the republish also gets 401', async () => {
  const f = await fixture({ catalogResults: [
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
    { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
  ] });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'lkg' }),
  ]);

  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  const refreshRuntimeProviders = mock(async () => {
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await expect(f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  })).rejects.toThrow('aio-proxy login required');

  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('uses one managed timer and refreshes only runtime providers online', async () => {
  const f = await fixture();
  const refreshRuntimeProviders = mock(async () => {});
  const context = {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider: mock(async () => 'access'), refreshRuntimeProviders },
  };
  await f.emit('session_start', context);
  await f.emit('session_start', context);
  expect(f.activeTimers()).toBe(1);
  expect(f.setInterval.mock.calls[0]?.[1]).toBe(300_000);
  await f.tick();
  expect(refreshRuntimeProviders).toHaveBeenCalledWith('online');
  expect(f.setInterval).toHaveBeenCalledTimes(1);
});

test('missing catalog after a server failure throws the start-server diagnostic', async () => {
  const f = await fixture({ catalogResults: [{
    models: [], source: 'missing', status: 'missing', error: 'server_error',
  }] });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old'))
    .rejects.toThrow('aio-proxy server required');
});
```

Use this complete fixture; the binding receives no timer dependency, and the only schedulable function is the context-owned `setInterval` passed by each test:

```ts
const OMP_MARKER = {
  format: 1, managedBy: 'aio-proxy', agent: 'omp',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const ompCatalog = (id = 'compat-model'): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'omp',
  models: [{
    id, name: id, reasoning: false, tool_call: true, temperature: false,
    attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048,
  }],
});
const fModels = (id = 'compat-model') => toPiFamilyModels(ompCatalog(id));

async function fixture(options: { readonly catalogResults?: PiFamilyCatalogResult[] } = {}) {
  let provider: ProviderConfig | undefined;
  const catalogAccesses: Array<string | undefined> = [];
  const results = [...(options.catalogResults ?? [{
    models: fModels(), source: 'network' as const, status: 'fresh' as const,
  }])];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const timers = new Map<number, () => void | Promise<void>>();
  let timerSequence = 0;
  const setInterval = mock((callback: () => void | Promise<void>, _delay: number) => {
    const id = ++timerSequence;
    timers.set(id, callback);
    return id as unknown as Timer;
  });
  const managed = {
    rootDir: '/managed', markerPath: '/managed/.aio-proxy-managed.json',
    statePath: '/managed/.aio-proxy-state.json', marker: OMP_MARKER,
  } as const;
  const credentials = {
    access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh', expires: 901_000,
  } as const;

  const api = {
    registerProvider: (_name: string, config: ProviderConfig) => { provider = config; },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const deps: OmpDeps = {
    readManagedInstallation: async () => managed,
    loginPiFamily: async (_managed, present) => {
      present({
        device_code: 'device', user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600, interval: 5,
      });
      return credentials;
    },
    refreshPiFamilyCredential: async () => credentials,
    readPiFamilyModels: async (_managed, access) => {
      catalogAccesses.push(access);
      return results.shift() ?? { models: fModels(), source: 'network', status: 'fresh' };
    },
  };
  await registerOmp(api, deps);
  if (provider === undefined) throw new Error('OMP provider was not registered');

  return {
    provider,
    catalogAccesses,
    setInterval,
    activeTimers: () => timers.size,
    tick: async () => { for (const callback of timers.values()) await callback(); },
    emit: async (event: 'session_start' | 'session_shutdown', context: unknown) => {
      const handler = handlers.get(event);
      if (handler === undefined) throw new Error(`missing ${event} handler`);
      await handler({}, context);
    },
  };
}
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bun test packages/pi-provider/src/omp/omp.test.ts`

Expected: FAIL because the OMP entry does not exist.

- [ ] **Step 3: Implement the OMP-native binding**

```ts
// packages/pi-provider/src/omp/omp.ts
import {
  CATALOG_REFRESH_INTERVAL_MS,
  createSingleFlight,
  readManagedInstallation,
} from '@aio-proxy/agent-provider-runtime';
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from '@oh-my-pi/pi-coding-agent';
import {
  loginPiFamily,
  piFamilyUnavailableMessage,
  readPiFamilyModels,
  refreshPiFamilyCredential,
  type OAuthCredentials,
} from '../core';

const PROVIDER_ID = 'aio-proxy';

export type OmpDeps = {
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly loginPiFamily: typeof loginPiFamily;
  readonly refreshPiFamilyCredential: typeof refreshPiFamilyCredential;
  readonly readPiFamilyModels: typeof readPiFamilyModels;
};

const productionDeps: OmpDeps = {
  readManagedInstallation, loginPiFamily, refreshPiFamilyCredential, readPiFamilyModels,
};

export async function registerOmp(pi: ExtensionAPI, deps: OmpDeps): Promise<void> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'omp');
  let context: ExtensionContext | undefined;
  let timerStarted = false;
  let pendingCredentialRecovery = false;
  let credentialRecoveryInProgress = false;

  const loginRequired = (): Error => new Error('aio-proxy login required');
  const forceRefreshCredential = async (activeContext: ExtensionContext): Promise<string> => {
    try {
      const refreshed = await activeContext.modelRegistry.getApiKeyForProvider(
        PROVIDER_ID, undefined, { forceRefresh: true },
      );
      if (refreshed === undefined) throw loginRequired();
      return refreshed;
    } catch {
      throw loginRequired();
    }
  };

  const publishOrThrow = (result: Awaited<ReturnType<typeof readPiFamilyModels>>): ProviderModelConfig[] => {
    if (result.source === 'missing') throw new Error(piFamilyUnavailableMessage(result.error));
    return result.models;
  };

  const fetchModels = createSingleFlight(async (apiKey: string | undefined): Promise<ProviderModelConfig[]> => {
    if (apiKey === undefined && context === undefined) {
      const lkg = await deps.readPiFamilyModels(managed, undefined);
      if (lkg.source === 'missing') throw loginRequired();
      pendingCredentialRecovery = true;
      return lkg.models;
    }
    let usedForcedKey = false;
    let key = apiKey;
    if (key === undefined) {
      key = await forceRefreshCredential(context!);
      usedForcedKey = true;
    }
    const first = await deps.readPiFamilyModels(managed, key);
    if (first.error !== 'unauthorized') return publishOrThrow(first);
    if (context === undefined) {
      if (first.source === 'missing') throw loginRequired();
      pendingCredentialRecovery = true;
      return first.models;
    }
    if (usedForcedKey || credentialRecoveryInProgress) throw loginRequired();
    const refreshed = await forceRefreshCredential(context);
    const second = await deps.readPiFamilyModels(managed, refreshed);
    if (second.error === 'unauthorized') throw loginRequired();
    return publishOrThrow(second);
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
    api: 'openai-completions',
    authHeader: true,
    oauth: {
      name: PROVIDER_ID,
      login: (callbacks) => deps.loginPiFamily(managed, (device) => callbacks.onAuth({
        url: device.verification_uri_complete,
        instructions: `Approve aio-proxy with code ${device.user_code}`,
      }), callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
      refreshToken: (credential: OAuthCredentials) => deps.refreshPiFamilyCredential(managed.marker, credential),
      getApiKey: (credential: OAuthCredentials) => credential.access,
    },
    fetchDynamicModels: fetchModels,
  });

  pi.on('session_start', async (_event, nextContext: ExtensionContext) => {
    context = nextContext;
    if (pendingCredentialRecovery) {
      pendingCredentialRecovery = false;
      await forceRefreshCredential(context);
      credentialRecoveryInProgress = true;
      try {
        await context.modelRegistry.refreshRuntimeProviders('online');
      } finally {
        credentialRecoveryInProgress = false;
      }
    } else {
      await context.modelRegistry.refreshRuntimeProviders('online');
    }
    if (timerStarted) return;
    timerStarted = true;
    context.setInterval(() => {
      void context?.modelRegistry
        .refreshRuntimeProviders('online')
        .catch(() => console.warn('[aio-proxy] OMP catalog refresh failed'));
    }, CATALOG_REFRESH_INTERVAL_MS);
  });
  pi.on('session_shutdown', () => {
    context = undefined;
    timerStarted = false;
  });
}

export default async function omp(pi: ExtensionAPI): Promise<void> {
  await registerOmp(pi, productionDeps);
}
```

OMP's managed timer is automatically cleared by the host. Resetting `timerStarted` only permits a future session lifecycle to schedule its own managed timer; do not retain or clear a raw handle. `omp/index.ts` contains only `export { default } from './omp';`.

- [ ] **Step 4: Run OMP/package tests and the first complete build GREEN**

Run: `bun run --filter @aio-proxy/pi-provider test:unit && bun run --filter @aio-proxy/pi-provider build`

Expected: PASS; pre-session undefined keys serve LKG, active-context undefined keys refresh only through `getApiKeyForProvider`, 401 recovery still makes at most one force-refresh, the managed timer delay is `300_000`, and both `dist/official-pi.js` and `dist/omp.js` exist.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-provider/src/omp
git commit -m "feat(pi): register native OMP provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Artifact boundary and pinned real-host compatibility matrix

**Files:**

- Create: `packages/pi-provider/artifact.test.ts`
- Create: `packages/pi-provider/scripts/compat-host.ts`
- Modify: `packages/pi-provider/package.json`

**Interfaces:**

- Consumes: built dual entries; official Pi/OMP package loaders and print-mode CLIs; a temporary fake aio-proxy implementing Device, refresh, catalog, and OpenAI-compatible inference.
- Produces: one repeatable `test:compat` command proving the correct manifest entry, native login callback, host credential persistence after a third fresh process, catalog projection, replay-safe concurrent refresh, exact `aio-proxy login required` crash-window copy, and inference for each pinned host version.

- [ ] **Step 1: Write the artifact/manifest guard**

```ts
// packages/pi-provider/artifact.test.ts
import { expect, test } from 'bun:test';
import manifest from './package.json' with { type: 'json' };

test('manifest selects one explicit entry per host', () => {
  expect(manifest.scripts.build).toBe('rslib --lib pi-family');
  expect(manifest.pi.extensions).toEqual(['./dist/official-pi.js']);
  expect(manifest.omp.extensions).toEqual(['./dist/omp.js']);
  expect(new Set([...manifest.pi.extensions, ...manifest.omp.extensions]).size).toBe(2);
});

test.each(['official-pi', 'omp'])('%s artifact is self-contained', async (entry) => {
  const url = new URL(`./dist/${entry}.js`, import.meta.url);
  const code = await Bun.file(url).text();
  const runtimeImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:@aio-proxy\/|@earendil-works\/|@oh-my-pi\/)/u;
  expect(runtimeImport.test(code)).toBe(false);
  expect(typeof (await import(url.href)).default).toBe('function');
});
```

- [ ] **Step 2: Run the artifact guard**

Run: `bun run --filter @aio-proxy/pi-provider build && bun run --filter @aio-proxy/pi-provider test:artifact`

Expected: PASS if Tasks 1–3 kept every host import type-only. This is a permanent artifact regression guard, not an artificial RED step.

- [ ] **Step 3: Implement one real-host matrix script**

```ts
// packages/pi-provider/scripts/compat-host.ts
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLATION_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const DEVICE_CODE = 'e'.repeat(43);
const INITIAL_ACCESS = `aio_agent_at_v1_${'a'.repeat(43)}`;
const INITIAL_REFRESH = `aio_agent_rt_v1_${'b'.repeat(43)}`;
const ROTATED_ACCESS = `aio_agent_at_v1_${'c'.repeat(43)}`;
const ROTATED_REFRESH = `aio_agent_rt_v1_${'d'.repeat(43)}`;
const PRINT_ARGS = ['-p', '--no-session', '--model', 'aio-proxy/compat-model', 'compat'] as const;

type Target = 'pi' | 'omp';
type Scenario = 'concurrent' | 'crash';
type Host = {
  readonly target: Target;
  readonly packageName: string;
  readonly version: string;
  readonly binary: 'pi' | 'omp';
  readonly manifestEntry: 'official-pi.js' | 'omp.js';
};
type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type Stats = {
  readonly refreshRequests: number;
  readonly rotatedPairs: number;
  readonly successfulInferenceCalls: number;
  readonly anonymousCatalogCalls: number;
  readonly anonymousInferenceCalls: number;
  readonly oldRefreshAfterReject: number;
  readonly rotatedRefreshRequests: number;
  readonly disallowedAuthorizationCalls: number;
};
type OAuthCredential = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
};
type HostModel = Readonly<Record<string, unknown>>;
type ProviderRegistration = {
  readonly name: string;
  readonly config: {
    readonly oauth: {
      readonly login: (callbacks: {
        readonly onAuth: (value: { readonly url?: string }) => void;
        readonly onDeviceCode: (value: unknown) => void;
        readonly onPrompt: () => Promise<string>;
        readonly onSelect: () => Promise<undefined>;
        readonly signal: AbortSignal;
      }) => Promise<OAuthCredential>;
      readonly refreshToken?: (
        credential: OAuthCredential,
        signal?: AbortSignal,
      ) => Promise<OAuthCredential>;
      readonly getApiKey: (credential: OAuthCredential) => string;
    };
    readonly refreshModels?: (context: Readonly<Record<string, unknown>>) => Promise<readonly HostModel[]>;
    readonly fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly HostModel[]>;
  };
  readonly extensionPath?: string;
  readonly sourceId?: string;
};
type HostApi = {
  readonly discoverAndLoadExtensions: (...args: unknown[]) => Promise<{
    readonly errors: readonly unknown[];
    readonly runtime: { readonly pendingProviderRegistrations: readonly ProviderRegistration[] };
  }>;
  readonly discoverAuthStorage?: (agentDir: string) => Promise<{
    readonly set: (provider: string, credential: OAuthCredential & { readonly type: 'oauth' }) => Promise<void>;
    readonly close: () => void;
  }>;
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const versions = (name: string, fallback: string): string[] =>
  [...new Set((process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean))];

const hosts: Host[] = [
  ...versions('PI_OFFICIAL_COMPAT_VERSIONS', '0.84.2').map((version) => ({
    target: 'pi' as const,
    packageName: '@earendil-works/pi-coding-agent',
    version,
    binary: 'pi' as const,
    manifestEntry: 'official-pi.js' as const,
  })),
  ...versions('OMP_COMPAT_VERSIONS', '17.3.7').map((version) => ({
    target: 'omp' as const,
    packageName: '@oh-my-pi/pi-coding-agent',
    version,
    binary: 'omp' as const,
    manifestEntry: 'omp.js' as const,
  })),
];

function isolatedEnv(root: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    PI_CODING_AGENT_DIR: agentDir,
    BROWSER: 'true',
    CI: '1',
    NO_COLOR: '1',
  };
  delete env.OMP_AUTH_BROKER_URL;
  delete env.OMP_PROFILE;
  delete env.PI_OFFLINE;
  return env;
}

async function run(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  check(!timedOut, `timed out: ${command.join(' ')}`);
  return { stdout, stderr, exitCode };
}

function startFakeProxy(target: Target) {
  const clientId = `aio-proxy-${target}`;
  let refreshRequests = 0;
  let rotatedPairs = 0;
  let successfulInferenceCalls = 0;
  let anonymousCatalogCalls = 0;
  let anonymousInferenceCalls = 0;
  let oldRefreshAfterReject = 0;
  let rotatedRefreshRequests = 0;
  let disallowedAuthorizationCalls = 0;
  let rotated = false;
  let rejectOldRefresh = false;

  const assertAllowedInstallationAuthorization = (authorization: string | null, surface: 'catalog' | 'inference'): void => {
    if (authorization === null) return;
    if (authorization === `Bearer ${INITIAL_ACCESS}` || authorization === `Bearer ${ROTATED_ACCESS}`) return;
    disallowedAuthorizationCalls += 1;
    check(false, `${surface} used a disallowed Authorization value`);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      if (url.pathname === '/oauth/device/code') {
        const body = new URLSearchParams(await request.text());
        check(body.get('client_id') === clientId, 'wrong Device client');
        check(body.get('agent') === target, 'wrong Device target');
        check(body.get('installation_id') === INSTALLATION_ID, 'wrong installation');
        check(body.get('adapter_version') === '1.2.3', 'wrong adapter version');
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
        check(body.get('client_id') === clientId, 'wrong token client');
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          check(body.get('device_code') === DEVICE_CODE, 'wrong device code');
          return Response.json({
            token_type: 'Bearer',
            access_token: INITIAL_ACCESS,
            refresh_token: INITIAL_REFRESH,
            expires_in: 900,
          }, { headers: { 'cache-control': 'no-store' } });
        }
        check(body.get('grant_type') === 'refresh_token', 'wrong refresh grant');
        refreshRequests += 1;
        const refreshToken = body.get('refresh_token');
        if (refreshToken === INITIAL_REFRESH) {
          if (rejectOldRefresh) {
            oldRefreshAfterReject += 1;
            return Response.json(
              { error: 'invalid_grant', error_description: 'refresh token already consumed' },
              { status: 400, headers: { 'cache-control': 'no-store' } },
            );
          }
          if (!rotated) {
            rotated = true;
            rotatedPairs += 1;
          }
          await Bun.sleep(250);
          return Response.json({
            token_type: 'Bearer',
            access_token: ROTATED_ACCESS,
            refresh_token: ROTATED_REFRESH,
            expires_in: 900,
          }, { headers: { 'cache-control': 'no-store' } });
        }
        if (refreshToken === ROTATED_REFRESH) {
          rotatedRefreshRequests += 1;
          return Response.json({
            token_type: 'Bearer',
            access_token: ROTATED_ACCESS,
            refresh_token: ROTATED_REFRESH,
            expires_in: 900,
          }, { headers: { 'cache-control': 'no-store' } });
        }
        check(false, 'unexpected refresh token');
      }
      if (url.pathname === '/v1/models') {
        if (authorization === null) anonymousCatalogCalls += 1;
        assertAllowedInstallationAuthorization(authorization, 'catalog');
        if (authorization !== `Bearer ${INITIAL_ACCESS}` && authorization !== `Bearer ${ROTATED_ACCESS}`) {
          return new Response('', { status: 401 });
        }
        check(url.searchParams.get('agent') === target, 'wrong catalog target');
        check(url.searchParams.get('schema_version') === '1', 'wrong catalog schema');
        return Response.json({
          schema_version: 1,
          agent: target,
          models: [{
            id: 'compat-model',
            name: 'Compat Model',
            reasoning: false,
            tool_call: true,
            temperature: false,
            attachment: false,
            input: ['text'],
            context_window: 8_192,
            max_output_tokens: 2_048,
          }],
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        if (authorization === null) anonymousInferenceCalls += 1;
        assertAllowedInstallationAuthorization(authorization, 'inference');
        if (authorization === `Bearer ${INITIAL_ACCESS}`) return new Response('', { status: 401 });
        if (authorization !== `Bearer ${ROTATED_ACCESS}`) return new Response('', { status: 401 });
        successfulInferenceCalls += 1;
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
    rejectOldRefresh: () => { rejectOldRefresh = true; },
    stats: (): Stats => ({
      refreshRequests,
      rotatedPairs,
      successfulInferenceCalls,
      anonymousCatalogCalls,
      anonymousInferenceCalls,
      oldRefreshAfterReject,
      rotatedRefreshRequests,
      disallowedAuthorizationCalls,
    }),
    stop: () => server.stop(true),
  };
}

async function installManagedPlugin(agentDir: string, target: Target, endpoint: string): Promise<void> {
  const pluginDir = join(agentDir, 'extensions', 'aio-proxy');
  await mkdir(join(pluginDir, 'dist'), { recursive: true });
  await Promise.all([
    copyFile(new URL('../dist/official-pi.js', import.meta.url), join(pluginDir, 'dist', 'official-pi.js')),
    copyFile(new URL('../dist/omp.js', import.meta.url), join(pluginDir, 'dist', 'omp.js')),
  ]);
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: '@aio-proxy/pi-provider',
    type: 'module',
    pi: { extensions: ['./dist/official-pi.js'] },
    omp: { extensions: ['./dist/omp.js'] },
  }), { mode: 0o600 });
  await writeFile(join(pluginDir, '.aio-proxy-managed.json'), JSON.stringify({
    format: 1,
    managedBy: 'aio-proxy',
    agent: target,
    installationId: INSTALLATION_ID,
    adapterVersion: '1.2.3',
    endpoint,
  }), { mode: 0o600 });
}

async function seedExpiredCredential(
  target: Target,
  hostApi: HostApi,
  agentDir: string,
  credential: OAuthCredential,
): Promise<void> {
  const expired = { type: 'oauth' as const, ...credential, expires: 0 };
  if (target === 'pi') {
    await writeFile(
      join(agentDir, 'auth.json'),
      `${JSON.stringify({ 'aio-proxy': expired }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return;
  }
  const discoverAuthStorage = hostApi.discoverAuthStorage;
  check(discoverAuthStorage !== undefined, 'OMP did not export discoverAuthStorage');
  const authStorage = await discoverAuthStorage(agentDir);
  try {
    await authStorage.set('aio-proxy', expired);
  } finally {
    authStorage.close();
  }
}

async function runProbe(
  target: Target,
  packageRoot: string,
  root: string,
  agentDir: string,
  scenario: Scenario,
  manifestEntry: string,
): Promise<void> {
  const packageEntry = target === 'pi'
    ? join(packageRoot, 'dist', 'index.js')
    : join(packageRoot, 'src', 'index.ts');
  const hostApi = await import(pathToFileURL(packageEntry).href) as HostApi;
  const loaded = target === 'pi'
    ? await hostApi.discoverAndLoadExtensions([], root, agentDir)
    : await hostApi.discoverAndLoadExtensions([], root);
  check(loaded.errors.length === 0, `${target} loader errors: ${JSON.stringify(loaded.errors)}`);
  const registrations = loaded.runtime.pendingProviderRegistrations
    .filter((entry) => entry.name === 'aio-proxy');
  check(registrations.length === 1, `${target} registered ${registrations.length} providers`);
  const registration = registrations[0]!;
  const source = target === 'pi' ? registration.extensionPath : registration.sourceId;
  check(source?.endsWith(manifestEntry), `${target} loaded ${source ?? 'no path'}`);

  const devicePresentations: unknown[] = [];
  const authPresentations: Array<{ url?: string }> = [];
  const signal = new AbortController().signal;
  const credential = await registration.config.oauth.login({
    onAuth: (value: { url?: string }) => { authPresentations.push(value); },
    onDeviceCode: (value: unknown) => { devicePresentations.push(value); },
    onPrompt: async () => '',
    onSelect: async () => undefined,
    signal,
  });
  if (target === 'pi') {
    check(devicePresentations.length === 1, 'official Pi did not use onDeviceCode');
  } else {
    check(authPresentations.length === 1, 'OMP did not use onAuth');
    check(authPresentations[0]?.url?.endsWith('#code=ABCD-EFGH'), 'OMP omitted the complete URL');
  }

  const apiKey = registration.config.oauth.getApiKey(credential);
  let models: readonly HostModel[];
  if (target === 'pi') {
    const refreshModels = registration.config.refreshModels;
    check(refreshModels !== undefined, 'official Pi registration omitted refreshModels');
    models = await refreshModels({
      credential: { type: 'oauth', ...credential },
      allowNetwork: true,
      force: true,
      signal,
      publish: async () => true,
    });
  } else {
    const fetchDynamicModels = registration.config.fetchDynamicModels;
    check(fetchDynamicModels !== undefined, 'OMP registration omitted fetchDynamicModels');
    models = await fetchDynamicModels(apiKey);
  }
  check(models.length === 1, `${target} returned ${models.length} models`);
  check(JSON.stringify(models[0]) === JSON.stringify({
    id: 'compat-model',
    name: 'Compat Model',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  }), `${target} projected the wrong model shape: ${JSON.stringify(models[0])}`);

  if (scenario === 'crash') {
    const refreshToken = registration.config.oauth.refreshToken;
    check(refreshToken !== undefined, 'missing refreshToken');
    await refreshToken(credential, signal);
  }
  await seedExpiredCredential(target, hostApi, agentDir, credential);
  console.log('PROBE_OK');
}

function assertSuccessfulPair(results: readonly CommandResult[], stats: Stats, host: string): void {
  for (const result of results) {
    check(result.exitCode === 0, `${host} print mode failed:\n${result.stderr}`);
    check(`${result.stdout}\n${result.stderr}`.includes('compat-ok'), `${host} missed compat-ok`);
  }
  check(
    stats.refreshRequests >= 1 && stats.refreshRequests <= 2,
    `${host} refresh request count was ${stats.refreshRequests}`,
  );
  check(stats.rotatedPairs === 1, `${host} issued ${stats.rotatedPairs} rotated pairs`);
  check(stats.successfulInferenceCalls === 2, `${host} inference count was ${stats.successfulInferenceCalls}`);
  check(stats.anonymousCatalogCalls === 0, `${host} made an anonymous catalog request`);
  check(stats.anonymousInferenceCalls === 0, `${host} made an anonymous inference request`);
  check(stats.disallowedAuthorizationCalls === 0, `${host} used a disallowed Authorization value`);
}

async function runScenario(
  host: Host,
  installRoot: string,
  packageRoot: string,
  binary: string,
  scenario: Scenario,
): Promise<void> {
  const root = join(installRoot, scenario);
  const agentDir = join(root, 'agent');
  await mkdir(root, { recursive: true });
  const proxy = startFakeProxy(host.target);
  try {
    await installManagedPlugin(agentDir, host.target, proxy.endpoint);
    const env = isolatedEnv(root, agentDir);
    const probe = await run([
      host.target === 'pi' ? 'node' : process.execPath,
      import.meta.path,
      '--probe',
      host.target,
      packageRoot,
      root,
      agentDir,
      scenario,
      host.manifestEntry,
    ], root, env);
    check(probe.exitCode === 0 && probe.stdout.includes('PROBE_OK'),
      `${host.target}@${host.version} probe failed:\n${probe.stderr}`);

    const label = `${host.target}@${host.version}`;
    if (scenario === 'concurrent') {
      const results = await Promise.all([
        run([binary, ...PRINT_ARGS], root, env),
        run([binary, ...PRINT_ARGS], root, env),
      ]);
      const afterPair = proxy.stats();
      assertSuccessfulPair(results, afterPair, label);
      proxy.rejectOldRefresh();
      const persisted = await run([binary, ...PRINT_ARGS], root, env);
      check(persisted.exitCode === 0, `${label} persisted-rotation process failed:\n${persisted.stderr}`);
      check(`${persisted.stdout}\n${persisted.stderr}`.includes('compat-ok'),
        `${label} persisted-rotation process missed compat-ok`);
      const afterPersist = proxy.stats();
      check(afterPersist.refreshRequests === afterPair.refreshRequests,
        `${label} refreshed again after persisted rotation`);
      check(afterPersist.oldRefreshAfterReject === 0,
        `${label} reused a consumed refresh token`);
      check(afterPersist.rotatedRefreshRequests === 0,
        `${label} refreshed an already-rotated token`);
      check(afterPersist.rotatedPairs === 1, `${label} issued ${afterPersist.rotatedPairs} rotated pairs`);
      check(afterPersist.successfulInferenceCalls === 3,
        `${label} inference count was ${afterPersist.successfulInferenceCalls}`);
      check(afterPersist.anonymousCatalogCalls === 0, `${label} made an anonymous catalog request`);
      check(afterPersist.anonymousInferenceCalls === 0, `${label} made an anonymous inference request`);
      check(afterPersist.disallowedAuthorizationCalls === 0,
        `${label} used a disallowed Authorization value`);
      return;
    }

    proxy.rejectOldRefresh();
    const result = await run([binary, ...PRINT_ARGS], root, env);
    check(result.exitCode !== 0, `${label} crash-window run unexpectedly succeeded`);
    check(`${result.stdout}\n${result.stderr}`.includes('aio-proxy login required'),
      `${label} omitted a re-login diagnostic`);
    const stats = proxy.stats();
    check(stats.successfulInferenceCalls === 0, `${label} inferred after invalid_grant`);
    check(stats.anonymousCatalogCalls === 0, `${label} made an anonymous catalog request`);
    check(stats.anonymousInferenceCalls === 0, `${label} made an anonymous inference request`);
    check(stats.disallowedAuthorizationCalls === 0, `${label} used a disallowed Authorization value`);
  } finally {
    proxy.stop();
  }
}

async function runHost(host: Host): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aio-proxy-${host.target}-${host.version}-`));
  try {
    await writeFile(join(root, 'package.json'), '{"private":true}\n');
    const install = await run(
      [process.execPath, 'add', '--exact', `${host.packageName}@${host.version}`],
      root,
      { ...process.env, CI: '1' },
      120_000,
    );
    check(install.exitCode === 0, `${host.packageName}@${host.version} install failed:\n${install.stderr}`);
    const packageRoot = join(root, 'node_modules', ...host.packageName.split('/'));
    const binary = join(root, 'node_modules', '.bin', host.binary);
    await runScenario(host, root, packageRoot, binary, 'concurrent');
    await runScenario(host, root, packageRoot, binary, 'crash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--probe') {
  const [, , , target, packageRoot, root, agentDir, scenario, manifestEntry] = process.argv;
  check(target === 'pi' || target === 'omp', 'invalid probe target');
  check(scenario === 'concurrent' || scenario === 'crash', 'invalid probe scenario');
  await runProbe(target, packageRoot!, root!, agentDir!, scenario, manifestEntry!);
} else {
  for (const host of hosts) await runHost(host);
}
```

The OMP storage branch must create its normal `<agentDir>/agent.db` through `discoverAuthStorage(agentDir)`; it must never fabricate OMP `auth.json`. Isolated host processes must drop inherited `PI_OFFLINE` together with the OMP broker/profile variables. After the concurrent pair succeeds, `rejectOldRefresh` latches the issuer so the initial refresh token is consumed; a third entirely fresh host process must then infer with the persisted rotated credentials, increment `successfulInferenceCalls` to 3, and leave `refreshRequests`, `oldRefreshAfterReject`, and `rotatedRefreshRequests` unchanged. Catalog and inference hard-reject every unexpected non-null `Authorization` value and latch `disallowedAuthorizationCalls` because a throw inside `Bun.serve` can become a 500 without failing the harness; failure text must never include header or token values. The crash scenario deliberately discards one returned rotation and flips the fake server directly to post-replay `invalid_grant`, so Task 3 of the control-plane plan remains the single test of the exact 30-second clock boundary. Crash-window host output must contain the exact substring `aio-proxy login required`; prefix/suffix host text is allowed. `PI_OFFICIAL_COMPAT_VERSIONS` and `OMP_COMPAT_VERSIONS` accept comma-separated floor/current lists; their defaults are the pinned floors above.

- [ ] **Step 4: Run real-host compatibility GREEN**

Run: `bun run --filter @aio-proxy/pi-provider test:compat`

Expected: PASS for official Pi `0.84.2` and OMP `17.3.7`; each real loader selects only its native entry, the official Pi loader/probe executes under Node (not Bun), concurrent processes share one rotation, a third fresh process infers with persisted rotated credentials without another old-token refresh, and crash-window loss fails closed with `aio-proxy login required`.

- [ ] **Step 5: Run package/repository checks**

Run: `bun run --filter @aio-proxy/pi-provider test:unit && bun run check`

Expected: PASS with no runtime host-package import in either artifact.

- [ ] **Step 6: Commit**

```bash
git add packages/pi-provider
git commit -m "test(pi): pin official Pi and OMP compatibility" -m "Co-authored-by: Codex <noreply@openai.com>"
```
