# Codex Live / Realtime Endpoint Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Codex Live / Realtime endpoint family as signaling passthrough — HTTP SDP offer/answer plus a relayed sideband WebSocket — pinned to the upstream account that created each call.

**Architecture:** A standalone route module (`packages/server/src/routes/realtime/`) owns its own provider-selection loop, an in-memory call store, and the WebSocket relay. Upstream URL knowledge stays in the `openai-chatgpt` plugin behind a new optional `realtime` runtime capability (`fetch` + `dial`) that the host materializes onto the runtime provider instance. No new `ProviderProtocol` value, no `defineProtocolAdapter()` implementation, no change to the generation pipeline.

**Tech Stack:** Bun 1.4.2 (`Bun.serve` `websocket`, client `WebSocket` with `proxy`), Hono 4.13 (`hono/bun` `upgradeWebSocket` / `websocket`), TypeScript, `bun test`, `es-toolkit`, Changesets.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `docs/superpowers/specs/2026-09-05-codex-realtime-endpoints-design.md`.

- Create body cap: **16 MiB**. Over the cap is `413`.
- Accepted create content types, exactly four: `application/sdp`, `text/plain`, `application/json`, `multipart/form-data`. Anything else is `415`.
- Call store capacity: **1024** records. TTL: **1 hour** from creation; a reserved (live) attachment does not expire.
- Create attempts: at most **2**.
- Sideband dial deadline: **10 s**.
- Pre-open relay buffer: at most **64 frames or 1 MiB**, whichever comes first.
- Backpressure ceiling: overflow past **1 MiB** queued in either direction closes with `1011`.
- Close reason truncation: **123 UTF-8 bytes**.
- `websocket.idleTimeout: 255` at the `Bun.serve` call site. The `websocket` handler's own default is **120 s** and `Bun.serve`'s `idleTimeout: 255` does not carry over to an upgraded socket. Never mutate Hono's exported `websocket` singleton — spread it.
- `engines.bun` stays `>=1.4.2`; `packageManager` stays `bun@1.4.2`. The dial-before-upgrade ordering is unsound on 1.4.0.
- Call ID pattern: `^[A-Za-z0-9_-]{1,128}$`.
- Model normalization target: `gpt-live-1-codex`. Direct WebSocket sends the **originally requested** model, defaulting to `gpt-realtime`.
- Every realtime error response body is `{"error":{"message","type","param":null,"code"}}`. `type` is one of `invalid_request_error`, `not_supported_error`, `api_error`. The core builders in `packages/core/src/protocol/errors.ts` do **not** produce this shape (no `param`, and `openAIUnsupported` emits `type: "unsupported_feature"`) and are private — the realtime module owns its own builder.
- SDP bodies, `Location` values, and credentials are never logged.
- New handwritten non-test implementation files stay under 500 lines; evaluate splitting at 400. `max-lines-per-function` is 160.
- Colocated tests in same-name directories: `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`.
- Import `isRecord` from `@aio-proxy/shared` for structural TS contracts in `@aio-proxy/server`; `@aio-proxy/plugin-openai-chatgpt` does **not** depend on `@aio-proxy/shared`, so use `isPlainObject` from `es-toolkit/predicate` there. Never put `isRecord` in `@aio-proxy/plugin-sdk` or `@aio-proxy/types`.

---

## File Structure

**New — `packages/server/src/routes/realtime/`:**

| File | Responsibility |
| --- | --- |
| `index.ts` | exports only: `createRealtimeRoutes`, `createRealtimeCallStore`, and the `RealtimeCallStore` / `RealtimeRouteSource` types |
| `source.ts` | the `RealtimeRouteSource` type alone, so `realtime.ts`, `signaling.ts`, `sideband.ts`, and `hangup.ts` can all depend on it without a cycle |
| `realtime.ts` | route registration; the unsupported set as a table-driven loop |
| `errors.ts` | the `{error:{message,type,param,code}}` builder and one named helper per row of the error table |
| `model.ts` | `CODEX_REALTIME_MODEL`, `normalizeRealtimeModel` |
| `call-store.ts` | records, reserve/release tokens, expiry, capacity, shutdown |
| `provider-select.ts` | realtime candidate eligibility and ordering |
| `create-body.ts` | create-request content-type handling, multipart→JSON, model rewrite |
| `signaling.ts` | create flow: attempts, retry policy, success validation, `Location` rewrite |
| `sideband.ts` | pre-upgrade validation, dial, upgrade, bidirectional relay |
| `close-code.ts` | close-code normalization and reason truncation |
| `hangup.ts` | pinned-account control request |

**New — `packages/server/src/caller-principal/`:** `index.ts`, `caller-principal.ts`, `caller-principal.test.ts` — the tagged caller principal shared by the auth middlewares and the realtime routes. It lives outside `routes/` so `server/api-key-auth` does not import from `routes/`.

**New — `packages/plugins/openai-chatgpt/src/runtime/realtime.ts`** — realtime endpoint map, `fetch`, and `dial`.

**Modified:**

| File | Change |
| --- | --- |
| `packages/plugin-sdk/src/runtime.ts` | `RealtimeStyle`, `RealtimeDialInput`, `RealtimeTransport`, `RealtimeDialError`; `OAuthRuntimeResult.realtime?` |
| `packages/plugin-sdk/src/oauth.ts` | `RuntimeContext.proxy?: string \| null` |
| `packages/server/src/runtime.ts` | `RuntimeProviderBase` gains `accountId?`, `runtimeRevision?`, `realtime?` |
| `packages/server/src/plugin-runtime/capabilities.ts` | validate + attach `result.realtime`; export `withAccountPin` |
| `packages/server/src/plugin-runtime/materialize.ts` | pass `proxy` into `createRuntime`; stamp the pin on all provider-yielding paths |
| `packages/plugins/openai-chatgpt/src/runtime/runtime.ts` | query-merge fix in `rewriteCodexUrl`; return `realtime` |
| `packages/plugins/openai-chatgpt/src/runtime/index.ts` | export the realtime helpers |
| `packages/server/src/server/api-key-auth/api-key-auth.ts` | set the caller principal |
| `packages/server/src/server/agent-auth/agent-auth.ts` | set the agent caller principal; `AgentEnv` gains `callerPrincipal?` |
| `packages/server/src/server-log.ts` | four realtime log types added to the `ServerLog` union |
| `packages/server/src/server-state/types.ts` | `ServerState.realtimeCalls` |
| `packages/server/src/server-state/index.ts` | construct the call store |
| `packages/server/src/server-state/lifecycle.ts` | `ServerStateParts.realtimeCalls`; close it in `close()` |
| `packages/server/src/server/server.ts` | mount the realtime routes; re-export `websocket` |
| `packages/server/src/server/index.ts`, `packages/server/src/index.ts` | re-export `websocket` |
| `packages/cli/src/run/run.ts` | `websocket: { ...websocket, idleTimeout: 255 }` |

`AGENTS.md:154` already carries the architecture exception ("A non-generation transport that carries no model-message conversion and no usage capture (realtime signaling) may own its own selection loop…"). No documentation change is needed. `CLAUDE.md` is a symlink to `AGENTS.md` — never edit it directly.

---

## Task 1: Realtime capability types in the plugin SDK

**Files:**
- Modify: `packages/plugin-sdk/src/runtime.ts:126-132` (append after `OAuthRuntimeResult`)
- Modify: `packages/plugin-sdk/src/oauth.ts:204-209` (`RuntimeContext`)
- Test: `packages/plugin-sdk/src/runtime.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `RealtimeStyle`, `RealtimeDialInput`, `RealtimeTransport`, `RealtimeDialErrorKind`, `RealtimeDialError` (class, `.kind` getter), `OAuthRuntimeResult.realtime?: RealtimeTransport`, `RuntimeContext.proxy?: string | null`. All re-exported from `@aio-proxy/plugin-sdk` because `src/index.ts` already does `export * from './runtime'` and `export * from './oauth'`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/src/runtime.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { RealtimeDialError } from './runtime';

test('RealtimeDialError carries a discriminable kind and a stable name', () => {
  const error = new RealtimeDialError('upstream refused the handshake', { kind: 'rejected' });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('RealtimeDialError');
  expect(error.kind).toBe('rejected');
  expect(error.message).toBe('upstream refused the handshake');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/plugin-sdk/src/runtime.test.ts
```

Expected: FAIL with `error: Export named 'RealtimeDialError' not found in module '.../packages/plugin-sdk/src/runtime.ts'`.

- [ ] **Step 3: Add the types and the error class**

Append to `packages/plugin-sdk/src/runtime.ts`:

```ts
export type RealtimeStyle = 'live' | 'realtime-calls' | 'realtime-query' | 'realtime-direct';

export type RealtimeDialInput = {
  readonly style: RealtimeStyle;
  readonly callId?: string;
  readonly model?: string;
  /** Inbound headers the plugin may forward selectively. Caller credentials are
   *  already stripped by the auth middleware; the plugin adds its own upstream
   *  auth and never forwards an inbound `authorization`. */
  readonly headers: Headers;
  readonly signal: AbortSignal;
};

export type RealtimeDialErrorKind = 'rejected' | 'unreachable' | 'aborted' | 'timeout';

/** A client `WebSocket` exposes no upstream HTTP status for a non-101 response,
 *  so a failed dial is only ever discriminable to these four kinds. */
export class RealtimeDialError extends Error {
  override readonly name = 'RealtimeDialError';
  constructor(
    message: string,
    readonly options: { readonly kind: RealtimeDialErrorKind },
  ) {
    super(message);
  }
  get kind(): RealtimeDialErrorKind {
    return this.options.kind;
  }
}

export type RealtimeTransport = {
  readonly models: readonly string[];
  readonly fetch: (request: Request) => Promise<Response>;
  /** Resolves only once the socket is OPEN. Rejects with a `RealtimeDialError`.
   *  Aborting `signal` abandons a pending dial and closes any socket that opens. */
  readonly dial: (input: RealtimeDialInput) => Promise<WebSocket>;
};
```

Then extend `OAuthRuntimeResult` in the same file:

```ts
export type OAuthRuntimeResult = {
  readonly provider: ProviderV4;
  readonly raw?: RawResolver;
  readonly tokenCount?: TokenCountCapability;
  readonly providerTools?: ProviderToolCapability;
  readonly realtime?: RealtimeTransport;
};
```

- [ ] **Step 4: Add the proxy to `RuntimeContext`**

In `packages/plugin-sdk/src/oauth.ts`, replace `RuntimeContext`:

```ts
export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
  readonly fetch: RuntimeFetch;
  /** Effective outbound proxy for this provider, or `null` for a direct connection.
   *  `fetch` already routes through it; a plugin-constructed `WebSocket` does not,
   *  so a transport that dials sockets must pass this to the constructor. */
  readonly proxy?: string | null;
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/plugin-sdk && bun run test:unit && bun run test:types
```

Expected: PASS, `0 fail`, and `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk/src/runtime.ts packages/plugin-sdk/src/runtime.test.ts packages/plugin-sdk/src/oauth.ts
git commit -m "feat(plugin-sdk): add the realtime transport capability and runtime proxy"
```

---

## Task 2: Materialize `realtime` and the account pin onto the runtime provider

**Files:**
- Modify: `packages/server/src/runtime.ts:86-99` (`RuntimeProviderBase`)
- Modify: `packages/server/src/plugin-runtime/capabilities.ts:123-197` and `:247-255`
- Modify: `packages/server/src/plugin-runtime/materialize.ts:101-152`, `:279-298`
- Test: `packages/server/src/plugin-runtime/capabilities.test.ts` (extend)

**Interfaces:**
- Consumes: `RealtimeTransport` from Task 1.
- Produces: `RuntimeProviderInstance.realtime?: RealtimeTransport`, `.accountId?: string`, `.runtimeRevision?: number`; `withAccountPin(provider, { accountId, runtimeRevision })` exported from `packages/server/src/plugin-runtime/capabilities.ts`. `createRuntimeProvider` and `withAccountPin` are **not** on the `plugin-runtime` barrel — tests import them from `'./capabilities'`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/plugin-runtime/capabilities.test.ts`:

The file already imports `withRoutingConfig` from `'./capabilities'` and `catalog` from `'./test-support'`, and
defines `providerConfig` and `providerV4()` locally — reuse all four rather than adding duplicates. Widen the
first import to `import { createRuntimeProvider, withAccountPin, withRoutingConfig } from './capabilities';` and
append:

```ts
const realtimeTransport = {
  models: ['gpt-live-1-codex'],
  fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  dial: () => Promise.reject(new Error('not dialed in this test')),
};

const noModelsCatalog = { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };

test('materializes the realtime capability on a language-catalog provider', () => {
  const provider = createRuntimeProvider(
    providerConfig,
    { provider: providerV4(), realtime: realtimeTransport },
    catalog,
  );

  expect(provider.realtime?.models).toEqual(['gpt-live-1-codex']);
});

test('materializes the realtime capability on a raw-only provider', () => {
  const provider = createRuntimeProvider(
    providerConfig,
    {
      provider: providerV4(),
      raw: () => ({ invoke: () => Promise.resolve(new Response('ok')) }),
      realtime: realtimeTransport,
    },
    noModelsCatalog,
  );

  expect(provider.realtime?.models).toEqual(['gpt-live-1-codex']);
});

test('omits an absent realtime capability and rejects a malformed one', () => {
  const withoutRealtime = createRuntimeProvider(providerConfig, { provider: providerV4() }, catalog);
  expect('realtime' in withoutRealtime).toBe(false);

  expect(() =>
    createRuntimeProvider(
      providerConfig,
      { provider: providerV4(), realtime: { models: 'gpt-live-1-codex', fetch: () => {}, dial: () => {} } },
      catalog,
    ),
  ).toThrow('Invalid realtime capability');
});

test('withAccountPin stamps the account identity used to route a later sideband', () => {
  const provider = withAccountPin(createRuntimeProvider(providerConfig, { provider: providerV4() }, catalog), {
    accountId: 'person@example.com',
    runtimeRevision: 7,
  });

  expect(provider.accountId).toBe('person@example.com');
  expect(provider.runtimeRevision).toBe(7);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/plugin-runtime/capabilities.test.ts
```

Expected: FAIL — `withAccountPin` is not exported, and `provider.realtime` is `undefined`.

- [ ] **Step 3: Widen `RuntimeProviderBase`**

In `packages/server/src/runtime.ts`, add the import and the three fields:

```ts
import type {
  LogicalRequestContext,
  ProviderExecutedTool,
  RealtimeTransport,
  TokenCountCapability,
} from '@aio-proxy/plugin-sdk';
```

```ts
type RuntimeProviderBase = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly priority?: number;
  readonly weight?: number;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly upstreamMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  readonly plugin?: string;
  readonly capability?: string;
  readonly hasApiKey?: boolean;
  readonly tokenCount?: TokenCountCapability;
  /** Stable account fingerprint. A realtime call pins it so a re-login under the
   *  same Provider ID cannot silently move the call to another account. */
  readonly accountId?: string;
  /** Bumped by every credential write. Token refresh alone does not move it. */
  readonly runtimeRevision?: number;
  readonly realtime?: RealtimeTransport;
};
```

- [ ] **Step 4: Validate and attach `realtime`, and add `withAccountPin`**

In `packages/server/src/plugin-runtime/capabilities.ts`, add the validator next to `tokenCountCapability`:

```ts
function realtimeCapability(value: unknown): RealtimeTransport | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid realtime capability');
  const models = Reflect.get(value, 'models');
  const fetch = Reflect.get(value, 'fetch');
  const dial = Reflect.get(value, 'dial');
  if (!Array.isArray(models) || !models.every((model) => typeof model === 'string')) {
    throw new Error('Invalid realtime capability');
  }
  if (typeof fetch !== 'function' || typeof dial !== 'function') throw new Error('Invalid realtime capability');
  return {
    models,
    fetch: (request) => fetch.call(value, request),
    dial: (input) => dial.call(value, input),
  };
}
```

Add `RealtimeTransport` to the `@aio-proxy/plugin-sdk` type import at the top of the file. Then in `createRuntimeProvider`, read it alongside `tokenCount` and put it on `base` so it reaches **all four** return branches:

```ts
  const tokenCount = tokenCountCapability(Reflect.get(result, 'tokenCount'));
  const realtime = realtimeCapability(Reflect.get(result, 'realtime'));
```

```ts
  const base = {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    ...routingDefaults(config),
    models,
    capabilityIndex,
    ...(Object.keys(alias).length === 0 ? {} : { alias }),
    upstreamMetadata,
    plugin: config.plugin,
    capability: config.capability,
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(realtime === undefined ? {} : { realtime }),
  };
```

Add the pin helper below `withRoutingConfig`:

```ts
export type RuntimeAccountPin = { readonly accountId: string; readonly runtimeRevision: number };

/** `createRuntimeProvider` never sees the stored account, so the pin is stamped
 *  by the caller that does. `withRoutingConfig` spreads the previous provider,
 *  so a cache-reused instance keeps it — it is re-stamped anyway to keep the
 *  invariant local to one function. */
export function withAccountPin(provider: RuntimeProviderInstance, pin: RuntimeAccountPin): RuntimeProviderInstance {
  return { ...provider, accountId: pin.accountId, runtimeRevision: pin.runtimeRevision };
}
```

- [ ] **Step 5: Run the capability tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/plugin-runtime/capabilities.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 6: Thread the proxy and the pin through `materialize.ts`**

`packages/server/src/server-state/snapshot.ts:88-96` already resolves the effective proxy and passes `effectiveProxy` into `materializePluginProvider`, so no new plumbing is needed above this file.

Change the `createRuntimeMaterialization` signature to take a pin and a proxy instead of growing another two positional parameters — replace the `accountSummary`/`canRefreshCredential` tail with a single trailing options object:

```ts
async function createRuntimeMaterialization(
  options: MaterializePluginProviderOptions,
  adapter: PreparedOAuthPluginAccount['adapter'],
  accountOptions: unknown,
  storedCatalog: StoredCatalog,
  identity: RuntimeIdentityKey,
  credentials: CredentialPort<unknown>,
  catalogJob: CatalogJobDescriptor,
  state: PluginProviderMaterialization['state'],
  persistedSummary: PersistedSummary,
  accountSummary: PreparedOAuthPluginAccount['accountSummary'],
  canRefreshCredential: boolean,
  runtime: { readonly pin: RuntimeAccountPin; readonly proxy: string | null },
): Promise<PluginProviderMaterialization> {
```

Inside it, pass the proxy to the adapter and stamp the pin:

```ts
    const result = await runtimeDeadline(
      Promise.resolve().then(() =>
        adapter.createRuntime({
          credentials: credentials as never,
          options: accountOptions,
          catalog: storedCatalog.catalog,
          fetch,
          proxy: runtime.proxy,
        }),
      ),
    );
    const provider = withAccountPin(
      createRuntimeProvider(
        config,
        result,
        storedCatalog.catalog,
        pluginDefaultAliases(adapter, storedCatalog.catalog),
      ),
      runtime.pin,
    );
```

Import `withAccountPin` and its type: `import { createRuntimeProvider, type RuntimeAccountPin, withAccountPin, withRoutingConfig } from './capabilities';`.

In `materializePluginProvider`, build the pin once after `prepared` is destructured:

```ts
  const pin: RuntimeAccountPin = { accountId: account.fingerprint, runtimeRevision: account.runtimeRevision };
```

Stamp it on the two `withRoutingConfig` paths as well, so every provider-yielding return carries it:

```ts
  if (!config.enabled) {
    const cacheEntry =
      options.previous?.identity === identity
        ? {
            ...options.previous,
            provider: withAccountPin(
              withRoutingConfig(options.previous.provider, config, storedCatalog.catalog, defaults),
              pin,
            ),
          }
        : undefined;
```

```ts
  if (options.previous?.identity === identity) {
    const provider = withAccountPin(
      withRoutingConfig(options.previous.provider, config, storedCatalog.catalog, defaults),
      pin,
    );
    const cacheEntry = { ...options.previous, provider };
    return { provider, summary: persistedSummary(provider, storedCatalog), state, catalogJob, cacheEntry };
  }
```

And pass the new argument at the tail call:

```ts
  return createRuntimeMaterialization(
    options,
    adapter,
    accountOptions,
    storedCatalog,
    identity,
    credentials,
    catalogJob,
    state,
    persistedSummary,
    accountSummary,
    canRefreshCredential,
    { pin, proxy: proxyIdentity },
  );
```

- [ ] **Step 7: Write the materialize test**

Append to `packages/server/src/plugin-runtime/materialize.test.ts`. `runtimeFixture` seeds the account with
`fingerprint: 'person@example.com'`, and `fixture.repository.readAccount('person')` returns the stored account so the
test reads `runtimeRevision` from the repository rather than hard-coding it:

```ts
test('stamps the account pin and hands the effective proxy to the plugin runtime', async () => {
  const seen: { proxy?: string | null } = {};
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime(context: { readonly proxy?: string | null }) {
        seen.proxy = context.proxy;
        return {
          provider: {
            specificationVersion: 'v4' as const,
            languageModel() {
              throw new Error('not called');
            },
            imageModel() {
              throw new Error('not called');
            },
            embeddingModel() {
              throw new Error('not called');
            },
          },
        } as never;
      },
    },
  );

  const result = await materializePluginProvider({
    config: { id: 'person', kind: ProviderKind.OAuth, enabled: true, plugin: '@example/oauth', capability: 'default' },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: 'http://127.0.0.1:8123',
  });

  const account = fixture.repository.readAccount('person');
  expect(seen.proxy).toBe('http://127.0.0.1:8123');
  expect(result.provider?.accountId).toBe('person@example.com');
  expect(result.provider?.runtimeRevision).toBe(account?.runtimeRevision);
});
```

- [ ] **Step 8: Run the plugin-runtime tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/plugin-runtime
```

Expected: PASS, `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/runtime.ts packages/server/src/plugin-runtime/capabilities.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/plugin-runtime/materialize.ts packages/server/src/plugin-runtime/materialize.test.ts
git commit -m "feat(server): materialize the realtime capability and the account pin"
```

---
## Task 3: Realtime transport in the `openai-chatgpt` plugin

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/realtime.ts`
- Create: `packages/plugins/openai-chatgpt/src/runtime/realtime.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts:151-172` (the `rewriteCodexUrl` query-merge fix) and `:21-49` (return `realtime`)
- Modify: `packages/plugins/openai-chatgpt/src/runtime/index.ts`
- Test: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts` (extend with the query-merge regression)

**Interfaces:**
- Consumes: `RealtimeDialError`, `RealtimeDialInput`, `RealtimeStyle`, `RealtimeTransport`, `RuntimeContext.proxy` from Task 1.
- Produces: `createOpenAIChatGPTRealtime(credentials, { fetch, proxy })` returning a `RealtimeTransport`; `CODEX_REALTIME_MODELS` (`readonly ['gpt-live-1-codex']`); `realtimeEndpointFor(pathname)` returning `string | undefined`; `mergeEndpointQuery(endpoint, inbound)` returning a `URL`. `createOpenAIChatGPTRuntime` now returns `realtime` on its `OAuthRuntimeResult`. Task 5 consumes only `provider.realtime` (the host-side capability), never these names directly.

- [ ] **Step 1: Write the failing endpoint-map test**

Create `packages/plugins/openai-chatgpt/src/runtime/realtime.test.ts`. It reuses the same helper shapes as
`runtime.test.ts` — copy `credential`, `staticCredentialPort`, and `captureFetch` into this file rather than
exporting them from a test file:

```ts
import { expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { ChatGPTCredential } from '../schema';
import { createOpenAIChatGPTRealtime, realtimeEndpointFor } from './realtime';

test('every accepted realtime fetch path maps to an exact upstream endpoint', () => {
  expect(realtimeEndpointFor('/v1/live')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime/calls')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc/hangup')).toBe(
    'https://api.openai.com/v1/realtime/calls/call_abc/hangup',
  );

  // Exact match, not endsWith: these are prefixes or neighbors of the accepted set.
  expect(realtimeEndpointFor('/v1/realtime/sessions')).toBeUndefined();
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc')).toBeUndefined();
  expect(realtimeEndpointFor('/prefix/v1/live')).toBeUndefined();
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc/accept')).toBeUndefined();
});

test('the endpoint-owned query survives an inbound request that carries none', async () => {
  const calls: string[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch(calls),
    proxy: null,
  });

  await realtime.fetch(new Request('http://127.0.0.1:8787/v1/live', { method: 'POST', body: 'v=0' }));

  expect(calls[0]).toBe('https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
});

test('an unmapped realtime path fails closed instead of looping back into the proxy', async () => {
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
  });

  await expect(
    realtime.fetch(new Request('http://127.0.0.1:8787/v1/realtime/sessions', { method: 'POST', body: '{}' })),
  ).rejects.toThrow('Unmapped realtime path');
});

test('the realtime transport injects Codex credentials and never forwards a caller credential', async () => {
  const headers: Headers[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: async (input, init) => {
      headers.push(new Headers(new Request(input, init).headers));
      return new Response('v=0', { status: 200, headers: { location: '/v1/realtime/calls/call_abc' } });
    },
    proxy: null,
  });

  const response = await realtime.fetch(
    new Request('http://127.0.0.1:8787/v1/live', {
      method: 'POST',
      body: 'v=0',
      headers: { authorization: 'Bearer caller-key', 'content-type': 'application/sdp' },
    }),
  );

  const sent = headers[0];
  expect(response.status).toBe(200);
  expect(sent?.get('authorization')).toBe('Bearer access-token');
  expect(sent?.get('ChatGPT-Account-Id')).toBe('acct-123');
  expect(sent?.get('Originator')).toBe('codex-tui');
  expect(sent?.get('User-Agent')).toBe(CHATGPT_USER_AGENT);
  expect(sent?.get('session-id')).toMatch(/^[0-9a-f-]{36}$/u);
  expect(sent?.get('content-type')).toBe('application/sdp');
});

test('realtime models advertise only the Codex realtime model', () => {
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
  });

  expect(realtime.models).toEqual(['gpt-live-1-codex']);
});

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

function captureFetch(urls: string[]): typeof fetch {
  return async (input, init) => {
    urls.push(new Request(input, init).url);
    return new Response('v=0', { status: 200, headers: { location: '/v1/realtime/calls/call_abc' } });
  };
}
```

Add `CHATGPT_USER_AGENT` to the import block at the top of the file:

```ts
import { CHATGPT_USER_AGENT } from '../codex-client';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts src/runtime/realtime.test.ts
```

Expected: FAIL with `Cannot find module './realtime'`.

- [ ] **Step 3: Write the realtime endpoint map and `fetch`**

Create `packages/plugins/openai-chatgpt/src/runtime/realtime.ts`:

```ts
import type {
  CredentialPort,
  RealtimeDialInput,
  RealtimeStyle,
  RealtimeTransport,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { RealtimeDialError } from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT } from '../codex-client';
import type { ChatGPTCredential } from '../schema';
import { currentCredential } from './runtime';

const CODEX_REALTIME_CREATE_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas' as const;
const OPENAI_REALTIME_WS_BASE = 'wss://api.openai.com/v1' as const;
const OPENAI_REALTIME_HANGUP_BASE = 'https://api.openai.com/v1/realtime/calls' as const;

/** The only model this transport serves. Selection normalizes to it upstream. */
export const CODEX_REALTIME_MODELS: readonly string[] = ['gpt-live-1-codex'];

const HANGUP_PATH = /^\/v1\/realtime\/calls\/([A-Za-z0-9_-]{1,128})\/hangup$/u;

/** Exact pathname matching, unlike the `endsWith` mapping the Responses and image
 *  endpoints use: `/v1/realtime` and `/v1/realtime/calls` are prefixes of other
 *  realtime paths and a suffix test would collide. Returns `undefined` for
 *  everything else so the caller can fail closed. */
export function realtimeEndpointFor(pathname: string): string | undefined {
  if (pathname === '/v1/live' || pathname === '/v1/realtime' || pathname === '/v1/realtime/calls') {
    return CODEX_REALTIME_CREATE_ENDPOINT;
  }
  const hangup = HANGUP_PATH.exec(pathname);
  if (hangup?.[1] !== undefined) return `${OPENAI_REALTIME_HANGUP_BASE}/${hangup[1]}/hangup`;
  return undefined;
}

/** The endpoint constant owns `intent` and `architecture`. Assigning
 *  `endpoint.search = inbound.search` — what `rewriteCodexUrl` does today — erases
 *  them for an inbound request with no query. Inbound parameters merge on top. */
export function mergeEndpointQuery(endpoint: string, inbound: URL): URL {
  const merged = new URL(endpoint);
  for (const [key, value] of inbound.searchParams) merged.searchParams.set(key, value);
  return merged;
}

export type RealtimeTransportOptions = {
  readonly fetch: RuntimeFetch;
  readonly proxy: string | null;
};

export function createOpenAIChatGPTRealtime(
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): RealtimeTransport {
  return {
    models: CODEX_REALTIME_MODELS,
    fetch: (request) => realtimeFetch(request, credentials, options),
    dial: (input) => realtimeDial(input, credentials, options),
  };
}

async function realtimeFetch(
  request: Request,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): Promise<Response> {
  const inbound = new URL(request.url);
  const endpoint = realtimeEndpointFor(inbound.pathname);
  if (endpoint === undefined) throw new Error(`Unmapped realtime path: ${inbound.pathname}`);
  const url = mergeEndpointQuery(endpoint, inbound);
  const credential = await currentCredential(credentials, options.fetch);
  const headers = realtimeHeaders(request.headers, credential);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return await options.fetch(url.toString(), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: request.signal,
    redirect: 'manual',
  });
}

/** Caller credentials are already stripped by the auth middleware; this deletes
 *  them again so a direct unit call cannot leak one, then adds Codex auth. */
function realtimeHeaders(inbound: Headers, credential: ChatGPTCredential): Headers {
  const headers = new Headers();
  const contentType = inbound.get('content-type');
  const accept = inbound.get('accept');
  if (contentType !== null) headers.set('content-type', contentType);
  if (accept !== null) headers.set('accept', accept);
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  headers.set('ChatGPT-Account-Id', credential.accountId);
  headers.set('Originator', 'codex-tui');
  headers.set('User-Agent', CHATGPT_USER_AGENT);
  headers.set('session-id', crypto.randomUUID());
  return headers;
}
```

- [ ] **Step 4: Run the fetch-path tests**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts src/runtime/realtime.test.ts
```

Expected: PASS for the endpoint-map, query-survival, fail-closed, credential-injection, and models tests. `dial`
is not yet implemented; nothing calls it in this test file.

- [ ] **Step 5: Write the failing dial test**

Append to `packages/plugins/openai-chatgpt/src/runtime/realtime.test.ts`:

```ts
test('dial builds the sideband URL per style and resolves only once the socket is open', async () => {
  const seen: { url?: string; proxy?: unknown } = {};
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: 'http://127.0.0.1:8123',
    createWebSocket: (url, init) => {
      seen.url = url;
      seen.proxy = init.proxy;
      return openSocketStub();
    },
  });

  const socket = await realtime.dial({
    style: 'realtime-calls',
    callId: 'call_abc',
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  expect(seen.url).toBe('wss://api.openai.com/v1/realtime/calls/call_abc');
  expect(seen.proxy).toBe('http://127.0.0.1:8123');
  expect(socket.readyState).toBe(1);
});

test('dial builds the live, query, and direct styles', async () => {
  const urls: string[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: (url) => {
      urls.push(url);
      return openSocketStub();
    },
  });
  const base = { headers: new Headers(), signal: new AbortController().signal };

  await realtime.dial({ ...base, style: 'live', callId: 'call_abc' });
  await realtime.dial({ ...base, style: 'realtime-query', callId: 'call_abc' });
  await realtime.dial({ ...base, style: 'realtime-direct', model: 'gpt-realtime' });

  expect(urls).toEqual([
    'wss://api.openai.com/v1/live/call_abc',
    'wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=call_abc',
    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
  ]);
});

test('a non-101 upstream handshake rejects with kind "rejected" and a refused connect with "unreachable"', async () => {
  const closeWith = (code: number, reason: string) => (): WebSocket => {
    const socket = socketStub();
    queueMicrotask(() => socket.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: false })));
    return socket;
  };

  const rejected = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: closeWith(1002, 'Expected 101 status code'),
  });
  const unreachable = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: closeWith(1006, 'Failed to connect'),
  });
  const base = { callId: 'call_abc', headers: new Headers(), signal: new AbortController().signal } as const;

  const rejectedError = await realtime_dialError(rejected, base);
  const unreachableError = await realtime_dialError(unreachable, base);

  expect(rejectedError).toBeInstanceOf(RealtimeDialError);
  expect(rejectedError.kind).toBe('rejected');
  expect(unreachableError.kind).toBe('unreachable');
});

test('an aborted dial rejects with kind "aborted" and closes a socket that opens late', async () => {
  const closed: number[] = [];
  const controller = new AbortController();
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: () => {
      const socket = socketStub();
      socket.close = (code?: number) => closed.push(code ?? 1000);
      return socket;
    },
  });

  const pending = realtime.dial({
    style: 'realtime-calls',
    callId: 'call_abc',
    headers: new Headers(),
    signal: controller.signal,
  });
  controller.abort();

  const error = await pending.catch((cause: unknown) => cause);
  expect((error as RealtimeDialError).kind).toBe('aborted');
  expect(closed).toEqual([1001]);
});

async function realtime_dialError(
  realtime: RealtimeTransport,
  input: Omit<RealtimeDialInput, 'style'>,
): Promise<RealtimeDialError> {
  const error = await realtime.dial({ ...input, style: 'realtime-calls' }).catch((cause: unknown) => cause);
  if (!(error instanceof RealtimeDialError)) throw new Error(`expected a RealtimeDialError, got ${String(error)}`);
  return error;
}

/** A minimal `EventTarget`-backed stand-in: `dial` only ever reads `readyState`,
 *  registers `open`/`close`/`error`, and calls `close`. */
function socketStub(): WebSocket {
  const target = new EventTarget() as EventTarget & { readyState: number; close: (code?: number) => void };
  target.readyState = 0;
  target.close = () => {
    target.readyState = 3;
  };
  return target as unknown as WebSocket;
}

function openSocketStub(): WebSocket {
  const socket = socketStub() as WebSocket & { readyState: number };
  queueMicrotask(() => {
    socket.readyState = 1;
    socket.dispatchEvent(new Event('open'));
  });
  return socket;
}
```

Widen the file's imports:

```ts
import { RealtimeDialError, type RealtimeDialInput, type RealtimeTransport } from '@aio-proxy/plugin-sdk';
```

- [ ] **Step 6: Run the dial tests to verify they fail**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts src/runtime/realtime.test.ts
```

Expected: FAIL — `createWebSocket` is not a known option and `realtime.dial` is not implemented.

- [ ] **Step 7: Implement `dial`**

Append to `packages/plugins/openai-chatgpt/src/runtime/realtime.ts` and widen `RealtimeTransportOptions`:

```ts
const DIAL_DEADLINE_MS = 10_000;

export type RealtimeWebSocketFactory = (
  url: string,
  init: { readonly proxy?: string; readonly headers: Record<string, string> },
) => WebSocket;

export type RealtimeTransportOptions = {
  readonly fetch: RuntimeFetch;
  readonly proxy: string | null;
  /** Seam for tests. Production passes Bun's global `WebSocket`, whose `proxy`
   *  option issues a `CONNECT` — a plugin-constructed socket inherits nothing
   *  from `createProxyFetch`, so the proxy must be passed here explicitly. */
  readonly createWebSocket?: RealtimeWebSocketFactory;
};
```

```ts
function sidebandUrl(input: RealtimeDialInput): string {
  const style: RealtimeStyle = input.style;
  if (style === 'live') return `${OPENAI_REALTIME_WS_BASE}/live/${input.callId ?? ''}`;
  if (style === 'realtime-calls') return `${OPENAI_REALTIME_WS_BASE}/realtime/calls/${input.callId ?? ''}`;
  if (style === 'realtime-query') {
    return `${OPENAI_REALTIME_WS_BASE}/realtime?intent=quicksilver&call_id=${encodeURIComponent(input.callId ?? '')}`;
  }
  // `realtime-direct` sends the originally requested model, not the normalized
  // one: substituting `gpt-live-1-codex` here would diverge from the reference.
  return `${OPENAI_REALTIME_WS_BASE}/realtime?model=${encodeURIComponent(input.model ?? 'gpt-realtime')}`;
}

async function realtimeDial(
  input: RealtimeDialInput,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): Promise<WebSocket> {
  if (input.signal.aborted) throw new RealtimeDialError('dial aborted before connecting', { kind: 'aborted' });
  const credential = await currentCredential(credentials, options.fetch);
  const create = options.createWebSocket ?? defaultWebSocketFactory;
  const socket = create(sidebandUrl(input), {
    ...(options.proxy === null ? {} : { proxy: options.proxy }),
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      Originator: 'codex-tui',
      'User-Agent': CHATGPT_USER_AGENT,
      'session-id': crypto.randomUUID(),
    },
  });

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      outcome();
    };
    const abandon = (error: RealtimeDialError): void => {
      finish(() => {
        try {
          socket.close(1001);
        } catch {}
        reject(error);
      });
    };
    const onOpen = (): void => finish(() => resolve(socket));
    // A client `WebSocket` exposes no upstream status: `401`, `404`, `429`, `500`,
    // and `501` all arrive as `1002` "Expected 101 status code". `1006` is the
    // only distinguishable case, and it means the connect itself failed.
    const onClose = (event: Event): void => {
      const code = (event as CloseEvent).code;
      const kind = code === 1006 ? 'unreachable' : 'rejected';
      finish(() => reject(new RealtimeDialError(`sideband dial failed with close code ${code}`, { kind })));
    };
    const onError = (): void => {
      // `error` carries no status either, and Bun always follows it with `close`.
      // Waiting for `close` keeps the `rejected`/`unreachable` split intact.
    };
    const onAbort = (): void => abandon(new RealtimeDialError('dial aborted', { kind: 'aborted' }));
    const timer = setTimeout(
      () => abandon(new RealtimeDialError('dial deadline exceeded', { kind: 'timeout' })),
      DIAL_DEADLINE_MS,
    );

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (socket.readyState === 1) onOpen();
  });
}

function defaultWebSocketFactory(
  url: string,
  init: { readonly proxy?: string; readonly headers: Record<string, string> },
): WebSocket {
  return new WebSocket(url, init) as unknown as WebSocket;
}
```

- [ ] **Step 8: Run the realtime tests**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts src/runtime/realtime.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 9: Fix the `rewriteCodexUrl` query erasure and add the regression**

In `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`, replace `rewriteCodexUrl` so it merges instead of
assigning. None of the four existing Codex endpoint constants carry a query today, so this is behavior-preserving
for them and correct for any that gains one:

```ts
function rewriteCodexUrl(input: string): string {
  const target = new URL(input);
  const codexEndpoint = codexEndpointFor(target.pathname);
  if (codexEndpoint === undefined) return target.toString();
  return mergeEndpointQuery(codexEndpoint, target).toString();
}
```

Import the helper at the top of `runtime.ts`:

```ts
import { createOpenAIChatGPTRealtime, mergeEndpointQuery } from './realtime';
```

Append the regression to `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`, inside the existing
`describe('OpenAI ChatGPT runtime', …)` block:

```ts
  test('an endpoint-owned query parameter is not erased by an inbound request without one', async () => {
    const calls: FetchCall[] = [];
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(
      staticCredentialPort(credential()),
      captureFetch(calls),
    );

    await dynamicFetch('https://api.openai.com/v1/responses/compact', { method: 'POST', body: '{}' });
    await dynamicFetch('https://api.openai.com/v1/responses/compact?trace=1', { method: 'POST', body: '{}' });

    expect(requiredCall(calls, 0).url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(requiredCall(calls, 1).url).toBe('https://chatgpt.com/backend-api/codex/responses/compact?trace=1');
  });
```

- [ ] **Step 10: Return `realtime` from the runtime factory**

In `createOpenAIChatGPTRuntime`, add the capability to the returned `OAuthRuntimeResult`:

```ts
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openAI.languageModel(modelId),
      embeddingModel: (modelId) => openAI.embeddingModel(modelId),
      imageModel: (modelId) => openAI.imageModel(modelId),
    },
    realtime: createOpenAIChatGPTRealtime(context.credentials, {
      fetch: context.fetch ?? globalThis.fetch,
      proxy: context.proxy ?? null,
    }),
    // Defensive: image dispatch resolves with `capability` absent, so this guard
    // exists to keep an embedding request off the responses/image passthrough
    // rather than to gate image routing.
    raw: ({ protocol, capability }) =>
      capability === 'embedding'
        ? undefined
        : protocol === 'openai-response' || protocol === 'openai-image'
          ? { invoke: (request, _context, options) => dynamicFetch(request, undefined, options) }
          : undefined,
  };
```

And export the helpers from `packages/plugins/openai-chatgpt/src/runtime/index.ts`:

```ts
export { CHATGPT_USER_AGENT } from '../codex-client';
export {
  CODEX_REALTIME_MODELS,
  createOpenAIChatGPTRealtime,
  mergeEndpointQuery,
  realtimeEndpointFor,
} from './realtime';
export { createOpenAIChatGPTDynamicFetch, createOpenAIChatGPTRuntime, currentCredential } from './runtime';
```

- [ ] **Step 11: Run the plugin's whole suite**

```bash
cd packages/plugins/openai-chatgpt && bun run test:unit
```

Expected: PASS, `0 fail`.

- [ ] **Step 12: Commit**

```bash
git add packages/plugins/openai-chatgpt/src/runtime
git commit -m "feat(plugin-openai-chatgpt): add the realtime signaling transport"
```

---

## Task 4: The in-memory call store

**Files:**
- Create: `packages/server/src/routes/realtime/call-store.ts`
- Create: `packages/server/src/routes/realtime/call-store.test.ts`
- Create: `packages/server/src/routes/realtime/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `packages/server/src/routes/realtime/index.ts`:
  - `CallerPrincipal` is **not** defined here — it comes from Task 6. To keep Task 4 independently testable, the store
    types the owner as an opaque `RealtimeCallOwner = { readonly kind: string; readonly id?: string }` and compares it
    with `sameCallerPrincipal`, which Task 6's module also satisfies structurally.
  - `RealtimeCallRecord = { readonly callId: string; readonly providerId: string; readonly accountId: string; readonly runtimeRevision: number; readonly model: string; readonly requestedModel: string; readonly style: RealtimeStyle; readonly owner: RealtimeCallOwner; readonly createdAt: number }`
  - `RealtimeCallStore` with `insert(record): void`, `lookup(callId): RealtimeCallRecord | undefined`, `reserve(callId): RealtimeAttachment | undefined`, `release(token): void`, `attachment(callId): RealtimeAttachment | undefined`, `closeAttachment(callId, code): boolean`, `remove(callId): void`, `hasCapacity(): boolean`, `size(): number`, `close(): void`
  - `RealtimeAttachment = { readonly callId: string; readonly token: number; readonly onClose: (close: (code: number) => void) => void }` — the teardown takes the close code so shutdown can use `1001` and a 2xx hangup can use `1000`
  - `createRealtimeCallStore(options?: { readonly now?: () => number; readonly capacity?: number; readonly ttlMs?: number }): RealtimeCallStore`
  - `REALTIME_CALL_CAPACITY = 1024`, `REALTIME_CALL_TTL_MS = 3_600_000`
  - `sameCallerPrincipal(left, right): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/routes/realtime/call-store.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { createRealtimeCallStore, type RealtimeCallRecord, REALTIME_CALL_TTL_MS } from './call-store';

test('a reservation is exclusive and released reservations are reusable', () => {
  const store = createRealtimeCallStore();
  store.insert(record());

  const first = store.reserve('call_abc');
  expect(first).toBeDefined();
  expect(store.reserve('call_abc')).toBeUndefined();

  store.release(first!.token);
  const second = store.reserve('call_abc');
  expect(second).toBeDefined();
  expect(second?.token).not.toBe(first?.token);
});

test('a superseded reservation cannot release a newer one', () => {
  const store = createRealtimeCallStore();
  store.insert(record());

  const first = store.reserve('call_abc')!;
  store.release(first.token);
  const second = store.reserve('call_abc')!;

  store.release(first.token);

  expect(store.attachment('call_abc')?.token).toBe(second.token);
  expect(store.reserve('call_abc')).toBeUndefined();
});

test('a record expires on lookup with no intervening insert, and a live attachment does not', () => {
  let clock = 1_000;
  const store = createRealtimeCallStore({ now: () => clock });
  store.insert({ ...record(), createdAt: clock });

  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.lookup('call_abc')).toBeUndefined();
  expect(store.size()).toBe(0);

  clock = 1_000;
  store.insert({ ...record({ callId: 'call_live' }), createdAt: clock });
  store.reserve('call_live');
  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.lookup('call_live')?.callId).toBe('call_live');
});

test('capacity counts only unexpired records', () => {
  let clock = 1_000;
  const store = createRealtimeCallStore({ capacity: 2, now: () => clock });
  store.insert({ ...record({ callId: 'call_1' }), createdAt: clock });
  store.insert({ ...record({ callId: 'call_2' }), createdAt: clock });
  expect(store.hasCapacity()).toBe(false);

  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.hasCapacity()).toBe(true);
  expect(store.size()).toBe(0);
});

test('close runs every live attachment teardown once with 1001 and empties the store', () => {
  const store = createRealtimeCallStore();
  store.insert(record());
  const attachment = store.reserve('call_abc')!;
  const codes: number[] = [];
  attachment.onClose((code) => codes.push(code));

  store.close();
  store.close();

  expect(codes).toEqual([1001]);
  expect(store.size()).toBe(0);
});

test('closeAttachment tears down a live socket with the given code and reports whether one existed', () => {
  const store = createRealtimeCallStore();
  store.insert(record());
  const codes: number[] = [];
  store.reserve('call_abc')!.onClose((code) => codes.push(code));

  expect(store.closeAttachment('call_abc', 1000)).toBe(true);
  expect(codes).toEqual([1000]);
  expect(store.closeAttachment('call_abc', 1000)).toBe(false);
  expect(store.closeAttachment('call_missing', 1000)).toBe(false);
});

function record(overrides: Partial<RealtimeCallRecord> = {}): RealtimeCallRecord {
  return {
    callId: 'call_abc',
    providerId: 'codex',
    accountId: 'person@example.com',
    runtimeRevision: 3,
    model: 'gpt-live-1-codex',
    requestedModel: 'gpt-realtime',
    style: 'live',
    owner: { kind: 'anonymous' },
    createdAt: Date.now(),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/call-store.test.ts
```

Expected: FAIL with `Cannot find module './call-store'`.

- [ ] **Step 3: Implement the store**

Create `packages/server/src/routes/realtime/call-store.ts`:

```ts
import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';

export const REALTIME_CALL_CAPACITY = 1024;
export const REALTIME_CALL_TTL_MS = 3_600_000;

/** Structurally satisfied by Task 6's `CallerPrincipal`. Typed loosely here so the
 *  store carries no dependency on the auth middleware. */
export type RealtimeCallOwner = { readonly kind: string; readonly id?: string };

export type RealtimeCallRecord = {
  readonly callId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly runtimeRevision: number;
  readonly model: string;
  readonly requestedModel: string;
  readonly style: RealtimeStyle;
  readonly owner: RealtimeCallOwner;
  readonly createdAt: number;
};

export type RealtimeAttachment = {
  readonly callId: string;
  readonly token: number;
  /** Registers the teardown the store runs on `closeAttachment()` and `close()`.
   *  It receives the close code so shutdown uses `1001` and a 2xx hangup `1000`. */
  readonly onClose: (close: (code: number) => void) => void;
};

export type RealtimeCallStore = {
  readonly insert: (record: RealtimeCallRecord) => void;
  readonly lookup: (callId: string) => RealtimeCallRecord | undefined;
  readonly reserve: (callId: string) => RealtimeAttachment | undefined;
  readonly release: (token: number) => void;
  readonly attachment: (callId: string) => RealtimeAttachment | undefined;
  /** Runs a live attachment's teardown with `code` and clears the reservation.
   *  Returns false when there was nothing attached. */
  readonly closeAttachment: (callId: string, code: number) => boolean;
  readonly remove: (callId: string) => void;
  readonly hasCapacity: () => boolean;
  readonly size: () => number;
  readonly close: () => void;
};

export function sameCallerPrincipal(left: RealtimeCallOwner, right: RealtimeCallOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

type Entry = {
  readonly record: RealtimeCallRecord;
  attachment: { readonly token: number; close: ((code: number) => void) | undefined } | undefined;
};

export function createRealtimeCallStore(
  options: { readonly now?: () => number; readonly capacity?: number; readonly ttlMs?: number } = {},
): RealtimeCallStore {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? REALTIME_CALL_CAPACITY;
  const ttlMs = options.ttlMs ?? REALTIME_CALL_TTL_MS;
  const entries = new Map<string, Entry>();
  let nextToken = 1;
  let closed = false;

  // A live attachment never expires: the call is in use, and dropping its routing
  // mid-session would 503 a working sideband.
  const expired = (entry: Entry): boolean => entry.attachment === undefined && now() - entry.record.createdAt > ttlMs;
  const sweep = (): void => {
    for (const [callId, entry] of entries) if (expired(entry)) entries.delete(callId);
  };
  const live = (callId: string): Entry | undefined => {
    const entry = entries.get(callId);
    if (entry === undefined) return undefined;
    if (!expired(entry)) return entry;
    entries.delete(callId);
    return undefined;
  };

  return {
    insert(record) {
      if (closed) return;
      entries.set(record.callId, { record, attachment: undefined });
    },
    lookup(callId) {
      return live(callId)?.record;
    },
    reserve(callId) {
      const entry = live(callId);
      if (entry === undefined || entry.attachment !== undefined) return undefined;
      const token = nextToken;
      nextToken += 1;
      const attachment = { token, close: undefined as ((code: number) => void) | undefined };
      entry.attachment = attachment;
      return {
        callId,
        token,
        onClose(close) {
          attachment.close = close;
        },
      };
    },
    // Token-scoped so a superseded socket's late `close` cannot free a newer
    // attachment: the store only clears the reservation it still holds.
    release(token) {
      for (const entry of entries.values()) {
        if (entry.attachment?.token === token) {
          entry.attachment = undefined;
          return;
        }
      }
    },
    attachment(callId) {
      const entry = live(callId);
      const held = entry?.attachment;
      if (entry === undefined || held === undefined) return undefined;
      return {
        callId,
        token: held.token,
        onClose(close) {
          held.close = close;
        },
      };
    },
    remove(callId) {
      entries.delete(callId);
    },
    closeAttachment(callId, code) {
      const entry = live(callId);
      const held = entry?.attachment;
      if (entry === undefined || held === undefined) return false;
      entry.attachment = undefined;
      if (held.close !== undefined) {
        try {
          held.close(code);
        } catch {}
      }
      return true;
    },
    hasCapacity() {
      sweep();
      return entries.size < capacity;
    },
    size() {
      sweep();
      return entries.size;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) {
        const close = entry.attachment?.close;
        entry.attachment = undefined;
        if (close !== undefined) {
          try {
            close(1001);
          } catch {}
        }
      }
      entries.clear();
    },
  };
}
```

- [ ] **Step 4: Create the barrel**

Create `packages/server/src/routes/realtime/index.ts`:

```ts
export type {
  RealtimeAttachment,
  RealtimeCallOwner,
  RealtimeCallRecord,
  RealtimeCallStore,
} from './call-store';
export {
  createRealtimeCallStore,
  REALTIME_CALL_CAPACITY,
  REALTIME_CALL_TTL_MS,
  sameCallerPrincipal,
} from './call-store';
```

- [ ] **Step 5: Run the store tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/call-store.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 6: Wire the store into `ServerState`**

`packages/server/src/server-state/types.ts` — add the import and the field:

```ts
import type { RealtimeCallStore } from '../routes/realtime';
```

```ts
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly realtimeCalls: RealtimeCallStore;
  readonly traceStore: TraceStore;
};
```

`packages/server/src/server-state/index.ts` — construct it next to the cooldown store:

```ts
  const cooldown = new ProviderCooldownStore();
  const realtimeCalls = createRealtimeCallStore();
```

Add the import (`import { createRealtimeCallStore } from '../routes/realtime';`) and pass it in the
`assembleServerState` parts object, alphabetically beside `quotaCache`:

```ts
    quotaCache,
    realtimeCalls,
```

`packages/server/src/server-state/lifecycle.ts` — add `'realtimeCalls'` to the `Pick<ServerState, …>` list in
`ServerStateParts`, put the shutdown in the `close()` thunk array **before** `dbHandle.close()` so a relayed socket
is closed while the process still has its database, and return the field from `assembleServerState`:

```ts
      for (const close of [
        () => parts.watcher?.close(),
        () => runtime.scheduler.close(),
        parts.closeRecovery,
        () => parts.oauthLoginSessions.close(),
        () => parts.realtimeCalls.close(),
        () => events.close(),
        () => dbHandle.close(),
        parts.databaseOwnership.release,
      ]) {
```

```ts
    quotaCache: parts.quotaCache,
    realtimeCalls: parts.realtimeCalls,
```

- [ ] **Step 7: Run the server-state tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/server-state
```

Expected: PASS, `0 fail`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/routes/realtime packages/server/src/server-state
git commit -m "feat(server): add the realtime call store to server state"
```

---

## Task 5: Realtime model normalization and candidate selection

**Files:**
- Create: `packages/server/src/routes/realtime/model.ts`
- Create: `packages/server/src/routes/realtime/model.test.ts`
- Create: `packages/server/src/routes/realtime/provider-select.ts`
- Create: `packages/server/src/routes/realtime/provider-select.test.ts`
- Modify: `packages/server/src/routes/realtime/index.ts`

**Interfaces:**
- Consumes: `RuntimeProviderInstance.realtime` / `.accountId` / `.runtimeRevision` from Task 2.
- Produces:
  - `CODEX_REALTIME_MODEL = 'gpt-live-1-codex'`; `normalizeRealtimeModel(requested: string | undefined): string`
  - `RealtimeCandidate = { readonly provider: RuntimeProviderInstance; readonly realtime: RealtimeTransport; readonly priority: number; readonly weight: number }`
  - `selectRealtimeCandidates(snapshot: ProviderRouteSnapshot, models: { readonly requested: string; readonly normalized: string }): readonly RealtimeCandidate[]`
  - `pinnedRealtimeCandidate(snapshot, pin: { readonly providerId: string; readonly accountId: string; readonly runtimeRevision: number }): RealtimeCandidate | undefined`

- [ ] **Step 1: Write the failing normalization test**

Create `packages/server/src/routes/realtime/model.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { CODEX_REALTIME_MODEL, normalizeRealtimeModel } from './model';

test('every realtime alias the client may send normalizes to the Codex realtime model', () => {
  for (const requested of [
    undefined,
    '',
    'gpt-realtime',
    'gpt-realtime-2026-01-01',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-realtime-preview-2024-12-17',
  ]) {
    expect(normalizeRealtimeModel(requested)).toBe(CODEX_REALTIME_MODEL);
  }
});

test('an unrelated model id passes through so a future realtime provider can serve it', () => {
  expect(normalizeRealtimeModel('gpt-live-1-codex')).toBe('gpt-live-1-codex');
  expect(normalizeRealtimeModel('some-other-live-model')).toBe('some-other-live-model');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/model.test.ts
```

Expected: FAIL with `Cannot find module './model'`.

- [ ] **Step 3: Implement normalization**

Create `packages/server/src/routes/realtime/model.ts`:

```ts
export const CODEX_REALTIME_MODEL = 'gpt-live-1-codex';

/** Mirrors the reference's `codexRealtimeModel`. Applies to **selection** only:
 *  signaling rewrites the upstream model field, while a direct WebSocket sends the
 *  originally requested id. */
export function normalizeRealtimeModel(requested: string | undefined): string {
  const model = requested?.trim() ?? '';
  if (model.length === 0) return CODEX_REALTIME_MODEL;
  if (model === 'gpt-realtime' || model.startsWith('gpt-realtime-')) return CODEX_REALTIME_MODEL;
  if (model.includes('realtime-preview')) return CODEX_REALTIME_MODEL;
  return model;
}
```

- [ ] **Step 4: Write the failing selection test**

Create `packages/server/src/routes/realtime/provider-select.test.ts`:

```ts
import type { RealtimeTransport } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from 'bun:test';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';

test('ordering is priority descending, then weight descending, then provider id', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'c', priority: 1, weight: 5 }),
    realtimeProvider({ id: 'a', priority: 9, weight: 1 }),
    realtimeProvider({ id: 'b', priority: 9, weight: 4 }),
    realtimeProvider({ id: 'd', priority: 9, weight: 4 }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['b', 'd', 'a', 'c']);
});

test('ineligible providers are skipped', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'disabled', enabled: false }),
    realtimeProvider({ id: 'zero-weight', weight: 0 }),
    realtimeProvider({ id: 'rounds-to-zero', weight: 0.4 }),
    realtimeProvider({ id: 'wrong-model', models: ['gpt-audio'] }),
    { ...realtimeProvider({ id: 'no-realtime' }), realtime: undefined },
    realtimeProvider({ id: 'eligible' }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['eligible']);
});

test('a model override replaces the provider weight and can make a candidate ineligible', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex', weight: 7 })], {
    'gpt-live-1-codex': { providers: { codex: { weight: 0 } } },
  });

  expect(
    selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' }),
  ).toHaveLength(0);
});

test('an effective weight above the routing maximum is clamped rather than sorted ahead', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'clamped', weight: 99_999 }),
    realtimeProvider({ id: 'ceiling', weight: 10_000 }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.weight)).toEqual([10_000, 10_000]);
  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['ceiling', 'clamped']);
});

test('exclusion matches on both the requested and the normalized model id', () => {
  const provider = realtimeProvider({ id: 'codex' });
  const excludedRequested = snapshotOf([provider], {}, [{ id: 'codex', excludedModels: ['gpt-realtime'] }]);
  const excludedNormalized = snapshotOf([provider], {}, [{ id: 'codex', excludedModels: ['gpt-live-1-codex'] }]);
  const models = { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' };

  expect(selectRealtimeCandidates(excludedRequested, models)).toHaveLength(0);
  expect(selectRealtimeCandidates(excludedNormalized, models)).toHaveLength(0);
  // Exclusions live in config, so a snapshot without config excludes nothing.
  expect(selectRealtimeCandidates(snapshotOf([provider]), models)).toHaveLength(1);
});

test('a pin resolves only when the provider id, account, and runtime revision all still match', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex' })]);
  const pin = { providerId: 'codex', accountId: 'person@example.com', runtimeRevision: 3 };

  expect(pinnedRealtimeCandidate(snapshot, pin)?.provider.id).toBe('codex');
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, runtimeRevision: 4 })).toBeUndefined();
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, accountId: 'other@example.com' })).toBeUndefined();
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, providerId: 'missing' })).toBeUndefined();
});

test('a pin to a now-disabled provider does not resolve', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex', enabled: false })]);

  expect(
    pinnedRealtimeCandidate(snapshot, {
      providerId: 'codex',
      accountId: 'person@example.com',
      runtimeRevision: 3,
    }),
  ).toBeUndefined();
});

const transport: RealtimeTransport = {
  models: ['gpt-live-1-codex'],
  fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  dial: () => Promise.reject(new Error('not dialed in this test')),
};

function realtimeProvider(overrides: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly weight?: number;
  readonly models?: readonly string[];
}): RuntimeProviderInstance {
  const { id, models, ...routing } = overrides;
  return {
    id,
    kind: ProviderKind.OAuth,
    enabled: routing.enabled ?? true,
    priority: routing.priority ?? 0,
    weight: routing.weight ?? 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: ['gpt-5.5'],
    raw: { resolve: () => undefined },
    realtime: { ...transport, models: [...(models ?? ['gpt-live-1-codex'])] },
  } as unknown as RuntimeProviderInstance;
}

function snapshotOf(
  providers: readonly RuntimeProviderInstance[],
  models: Record<string, { readonly providers: Record<string, { readonly weight?: number }> }> = {},
  configProviders: readonly { readonly id: string; readonly excludedModels?: readonly string[] }[] = [],
): ProviderRouteSnapshot {
  return {
    providers,
    config: { router: { models }, providers: configProviders },
  } as unknown as ProviderRouteSnapshot;
}
```

- [ ] **Step 5: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/provider-select.test.ts
```

Expected: FAIL with `Cannot find module './provider-select'`.

- [ ] **Step 6: Implement selection**

Create `packages/server/src/routes/realtime/provider-select.ts`. `clampRoutingValue` is private to
`packages/types/src/provider.ts`, so the clamp is inlined against the exported `ROUTING_VALUE_MAX`:

```ts
import type { RealtimeTransport } from '@aio-proxy/plugin-sdk';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';

const DEFAULT_PRIORITY = 0;
const DEFAULT_WEIGHT = 1;

export type RealtimeCandidate = {
  readonly provider: RuntimeProviderInstance;
  readonly realtime: RealtimeTransport;
  readonly priority: number;
  readonly weight: number;
};

export type RealtimeModelPair = { readonly requested: string; readonly normalized: string };

export type RealtimeCallPin = {
  readonly providerId: string;
  readonly accountId: string;
  readonly runtimeRevision: number;
};

export function selectRealtimeCandidates(
  snapshot: ProviderRouteSnapshot,
  models: RealtimeModelPair,
): readonly RealtimeCandidate[] {
  const candidates: RealtimeCandidate[] = [];
  for (const provider of snapshot.providers) {
    const candidate = eligibleCandidate(snapshot, provider, models);
    if (candidate !== undefined) candidates.push(candidate);
  }
  // Deterministic in this phase: no weighted draw. Weight still orders, and a
  // zero effective weight still removes a candidate — that is eligibility, not
  // distribution.
  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.weight !== right.weight) return right.weight - left.weight;
    return left.provider.id < right.provider.id ? -1 : left.provider.id > right.provider.id ? 1 : 0;
  });
}

export function pinnedRealtimeCandidate(
  snapshot: ProviderRouteSnapshot,
  pin: RealtimeCallPin,
): RealtimeCandidate | undefined {
  const provider = snapshot.providers.find(({ id }) => id === pin.providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  if (provider.accountId !== pin.accountId || provider.runtimeRevision !== pin.runtimeRevision) return undefined;
  const realtime = provider.realtime;
  if (realtime === undefined) return undefined;
  return { provider, realtime, priority: provider.priority ?? DEFAULT_PRIORITY, weight: effectiveWeight(snapshot, provider, undefined) };
}

function eligibleCandidate(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  models: RealtimeModelPair,
): RealtimeCandidate | undefined {
  if (provider.enabled === false) return undefined;
  const realtime = provider.realtime;
  if (realtime === undefined || !realtime.models.includes(models.normalized)) return undefined;
  if (isExcluded(snapshot, provider, models)) return undefined;
  const weight = effectiveWeight(snapshot, provider, models.normalized);
  if (weight <= 0) return undefined;
  return { provider, realtime, priority: provider.priority ?? DEFAULT_PRIORITY, weight };
}

// `excludedModels` is authored on the config `OAuthProvider`
// (`packages/types/src/provider.ts:112`) and is NOT copied onto
// `RuntimeProviderBase`, so it must be read back out of the snapshot's config.
// Both ids are checked because they differ: excluding `gpt-realtime` must take
// effect even though selection matches on `gpt-live-1-codex`.
function isExcluded(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  models: RealtimeModelPair,
): boolean {
  const configured = snapshot.config?.providers.find(({ id }) => id === provider.id);
  const excluded = configured !== undefined && 'excludedModels' in configured ? configured.excludedModels : undefined;
  if (excluded === undefined || excluded.length === 0) return false;
  return excluded.includes(models.requested) || excluded.includes(models.normalized);
}

// Same rule as the router: authored weight defaults to 1, a model override
// replaces it wholesale, then `Math.round` and clamp to 0..ROUTING_VALUE_MAX.
function effectiveWeight(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  model: string | undefined,
): number {
  const authored = provider.weight ?? DEFAULT_WEIGHT;
  const override =
    model === undefined ? undefined : snapshot.config?.router.models[model]?.providers[provider.id]?.weight;
  const value = override ?? authored;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), ROUTING_VALUE_MAX);
}
```

- [ ] **Step 7: Widen the barrel**

Append to `packages/server/src/routes/realtime/index.ts`:

```ts
export { CODEX_REALTIME_MODEL, normalizeRealtimeModel } from './model';
export type { RealtimeCallPin, RealtimeCandidate, RealtimeModelPair } from './provider-select';
export { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
```

- [ ] **Step 8: Run both test files**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime
```

Expected: PASS, `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/routes/realtime
git commit -m "feat(server): add realtime model normalization and candidate selection"
```

---
## Task 6: The caller principal

**Files:**
- Create: `packages/server/src/caller-principal/index.ts`
- Create: `packages/server/src/caller-principal/caller-principal.ts`
- Create: `packages/server/src/caller-principal/caller-principal.test.ts`
- Modify: `packages/server/src/server/api-key-auth/api-key-auth.ts:29-35`, `:59-65`
- Modify: `packages/server/src/server/agent-auth/agent-auth.ts:12-16`, `:31`
- Test: `packages/server/src/server/agent-auth/agent-auth.test.ts` (extend if it exists; otherwise the middleware behavior is covered by the route tests in Task 10 and the unit test below)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `CallerPrincipal = { readonly kind: 'agent' | 'key' | 'anonymous'; readonly id?: string }`
  - `ANONYMOUS_CALLER: CallerPrincipal` (frozen `{ kind: 'anonymous' }`)
  - `agentCallerPrincipal(installationId: string): CallerPrincipal`
  - `staticKeyCallerPrincipal(key: string): CallerPrincipal`
  - `callerPrincipal(context): CallerPrincipal` — reads `context.get('callerPrincipal')`, falling back to `ANONYMOUS_CALLER`
  - `CallerPrincipalEnv = { Variables: { callerPrincipal?: CallerPrincipal } }`
  - `AgentEnv` gains `callerPrincipal?: CallerPrincipal`
- It lives outside `routes/` so `server/api-key-auth` never imports from `routes/`. Task 4's `sameCallerPrincipal` compares two of these structurally.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/caller-principal/caller-principal.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { sameCallerPrincipal } from '../routes/realtime';
import { agentCallerPrincipal, ANONYMOUS_CALLER, staticKeyCallerPrincipal } from './caller-principal';

test('a static key principal is a digest, never the key itself', () => {
  const principal = staticKeyCallerPrincipal('sk-super-secret-value');

  expect(principal.kind).toBe('key');
  expect(principal.id).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(principal)).not.toContain('sk-super-secret-value');
});

test('the same key yields the same principal and different keys do not collide', () => {
  expect(sameCallerPrincipal(staticKeyCallerPrincipal('key-a'), staticKeyCallerPrincipal('key-a'))).toBe(true);
  expect(sameCallerPrincipal(staticKeyCallerPrincipal('key-a'), staticKeyCallerPrincipal('key-b'))).toBe(false);
});

test('an agent principal is keyed on the installation, which survives a token refresh', () => {
  expect(sameCallerPrincipal(agentCallerPrincipal('install-1'), agentCallerPrincipal('install-1'))).toBe(true);
  expect(sameCallerPrincipal(agentCallerPrincipal('install-1'), agentCallerPrincipal('install-2'))).toBe(false);
});

test('an agent and a static key never match, and anonymous matches only anonymous', () => {
  expect(sameCallerPrincipal(agentCallerPrincipal('x'), staticKeyCallerPrincipal('x'))).toBe(false);
  expect(sameCallerPrincipal(ANONYMOUS_CALLER, ANONYMOUS_CALLER)).toBe(true);
  expect(sameCallerPrincipal(ANONYMOUS_CALLER, agentCallerPrincipal('x'))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/caller-principal
```

Expected: FAIL with `Cannot find module './caller-principal'`.

- [ ] **Step 3: Implement the principal**

Create `packages/server/src/caller-principal/caller-principal.ts`:

```ts
import type { Context } from 'hono';

/** `/v1/*` authentication proves a caller may use the proxy, not that it owns a
 *  given realtime call. Ownership needs a stable identity captured at create time,
 *  because `stripCallerCredentials` deletes the credential before the route runs. */
export type CallerPrincipal = {
  readonly kind: 'agent' | 'key' | 'anonymous';
  readonly id?: string;
};

export type CallerPrincipalEnv = { Variables: { callerPrincipal?: CallerPrincipal } };

/** With no configured keys the proxy has no notion of distinct callers, so every
 *  caller is this one principal and ownership checks pass. Rejecting the single
 *  legitimate client would be worse than not distinguishing callers. */
export const ANONYMOUS_CALLER: CallerPrincipal = Object.freeze({ kind: 'anonymous' });

/** `AgentAccessGrant.tokenHash` rotates on every refresh and would 403 the same
 *  client mid-call; `installationId` is the stable identity. */
export function agentCallerPrincipal(installationId: string): CallerPrincipal {
  return { kind: 'agent', id: installationId };
}

export function staticKeyCallerPrincipal(key: string): CallerPrincipal {
  return { kind: 'key', id: `sha256:${new Bun.CryptoHasher('sha256').update(key).digest('hex')}` };
}

export function callerPrincipal(context: Context<CallerPrincipalEnv>): CallerPrincipal {
  return context.get('callerPrincipal') ?? ANONYMOUS_CALLER;
}
```

Create `packages/server/src/caller-principal/index.ts`:

```ts
export type { CallerPrincipal, CallerPrincipalEnv } from './caller-principal';
export {
  agentCallerPrincipal,
  ANONYMOUS_CALLER,
  callerPrincipal,
  staticKeyCallerPrincipal,
} from './caller-principal';
```

- [ ] **Step 4: Set the principal in the static-key middleware**

`matchesConfiguredKey` currently returns only a boolean, so the matched key is unrecoverable. Change it to return
the matched entry and set the principal in `packages/server/src/server/api-key-auth/api-key-auth.ts`:

```ts
import { type CallerPrincipal, type CallerPrincipalEnv, staticKeyCallerPrincipal } from '../../caller-principal';
```

```ts
export async function authenticateStaticOrAnonymous(
  context: Context<CallerPrincipalEnv>,
  next: () => Promise<void>,
  configuredKeys: readonly ApiKeyEntry[],
): Promise<Response | void> {
  if (configuredKeys.length === 0) {
    await next();
    return;
  }

  const candidates = [
    bearerToken(context.req.header('authorization')),
    context.req.header('x-api-key'),
    context.req.header('x-goog-api-key'),
    context.req.query('key'),
    context.req.query('auth_token'),
  ];
  let matched: ApiKeyEntry | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    matched = matchedConfiguredKey(candidate, configuredKeys);
    if (matched !== undefined) break;
  }
  if (matched === undefined) return authenticationError(context);

  context.set('callerPrincipal', staticKeyCallerPrincipal(matched.key));
  stripCallerCredentials(context);
  await next();
}
```

```ts
function matchedConfiguredKey(candidate: string, configuredKeys: readonly ApiKeyEntry[]): ApiKeyEntry | undefined {
  const candidateBytes = Buffer.from(candidate);
  return configuredKeys.find(({ key }) => {
    const keyBytes = Buffer.from(key);
    return keyBytes.byteLength === candidateBytes.byteLength && timingSafeEqual(keyBytes, candidateBytes);
  });
}
```

`stripCallerCredentials` keeps its `Context` parameter type. `CallerPrincipal` is imported for the
`Context<CallerPrincipalEnv>` annotation; if `oxlint` flags the value import as unused, keep only the two type
imports and `staticKeyCallerPrincipal`.

- [ ] **Step 5: Set the principal in the agent middleware**

In `packages/server/src/server/agent-auth/agent-auth.ts`:

```ts
import { agentCallerPrincipal, type CallerPrincipal } from '../../caller-principal';
```

```ts
export type AgentEnv = {
  Variables: {
    agentGrant?: AgentAccessGrant;
    callerPrincipal?: CallerPrincipal;
  };
};
```

```ts
      context.set('agentGrant', result.grant);
      context.set('callerPrincipal', agentCallerPrincipal(result.grant.installationId));
      stripCallerCredentials(context);
```

- [ ] **Step 6: Run the auth and caller-principal tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/caller-principal src/server
```

Expected: PASS, `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/caller-principal packages/server/src/server/api-key-auth/api-key-auth.ts packages/server/src/server/agent-auth/agent-auth.ts
git commit -m "feat(server): capture a tagged caller principal during authentication"
```

---

## Task 7: Realtime error bodies and create-body normalization

**Files:**
- Create: `packages/server/src/routes/realtime/errors.ts`
- Create: `packages/server/src/routes/realtime/errors.test.ts`
- Create: `packages/server/src/routes/realtime/create-body.ts`
- Create: `packages/server/src/routes/realtime/create-body.test.ts`
- Modify: `packages/server/src/routes/realtime/index.ts`

**Interfaces:**
- Consumes: `CODEX_REALTIME_MODEL`, `normalizeRealtimeModel` from Task 5.
- Produces:
  - `REALTIME_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u`; `isValidCallId(value: string | undefined): value is string`
  - `realtimeError(status, type, code, message): Response` plus one named helper per row of the spec's error table: `invalidCallId()`, `realtimeInvalidOffer(message)`, `realtimeCallScopeMismatch()`, `realtimeCallNotFound()`, `realtimeCallBusy()`, `realtimeBodyTooLarge()`, `realtimeUnsupportedMediaType()`, `websocketUpgradeRequired()`, `realtimeCapabilityNotSupported()`, `realtimeDialFailed()`, `codexAuthUnavailable()`, `realtimeUpstreamUnavailable()`
  - `REALTIME_CREATE_BODY_LIMIT = 16_777_216`
  - `RealtimeCreateBody = { readonly body: Uint8Array; readonly contentType: string; readonly requestedModel: string }`
  - `readRealtimeCreateBody(request: Request): Promise<RealtimeCreateBody | Response>` — a `Response` is the terminal error
  - `withUpstreamModel(body: RealtimeCreateBody, normalized: string): RealtimeCreateBody`

- [ ] **Step 1: Write the failing error test**

Create `packages/server/src/routes/realtime/errors.test.ts`:

```ts
import { expect, test } from 'bun:test';

import {
  isValidCallId,
  realtimeCallBusy,
  realtimeCapabilityNotSupported,
  realtimeDialFailed,
  realtimeUpstreamUnavailable,
} from './errors';

test('every realtime error body carries the four-field OpenAI error shape', async () => {
  const response = realtimeCallBusy();

  expect(response.status).toBe(409);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({
    error: {
      message: 'A sideband attachment is already active for this call.',
      type: 'invalid_request_error',
      param: null,
      code: 'realtime_call_busy',
    },
  });
});

test('the status, type, and code of each distinct failure class stay pinned', async () => {
  const rows = [
    [realtimeCapabilityNotSupported(), 501, 'not_supported_error', 'realtime_capability_not_supported'],
    [realtimeDialFailed(), 502, 'api_error', 'realtime_dial_failed'],
    [realtimeUpstreamUnavailable(), 503, 'api_error', 'realtime_upstream_unavailable'],
  ] as const;

  for (const [response, status, type, code] of rows) {
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: { type: string; code: string; param: null } };
    expect(body.error.type).toBe(type);
    expect(body.error.code).toBe(code);
    expect(body.error.param).toBeNull();
  }
});

test('the call id pattern rejects path traversal, oversize, and empty ids', () => {
  expect(isValidCallId('call_abc-123')).toBe(true);
  expect(isValidCallId('a'.repeat(128))).toBe(true);
  expect(isValidCallId('a'.repeat(129))).toBe(false);
  expect(isValidCallId('')).toBe(false);
  expect(isValidCallId(undefined)).toBe(false);
  expect(isValidCallId('../secrets')).toBe(false);
  expect(isValidCallId('call abc')).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/errors.test.ts
```

Expected: FAIL with `Cannot find module './errors'`.

- [ ] **Step 3: Implement the error builders**

Create `packages/server/src/routes/realtime/errors.ts`. The core builders in
`packages/core/src/protocol/errors.ts` emit no `param` and use `type: "unsupported_feature"`, and they are private
to that module, so realtime owns this one:

```ts
export const REALTIME_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isValidCallId(value: string | undefined): value is string {
  return value !== undefined && REALTIME_CALL_ID_PATTERN.test(value);
}

type RealtimeErrorType = 'invalid_request_error' | 'not_supported_error' | 'api_error';

export function realtimeError(status: number, type: RealtimeErrorType, code: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code } }, { status });
}

export function invalidCallId(): Response {
  return realtimeError(400, 'invalid_request_error', 'invalid_call_id', 'The call_id is not a valid identifier.');
}

export function realtimeInvalidOffer(message: string): Response {
  return realtimeError(400, 'invalid_request_error', 'realtime_invalid_offer', message);
}

export function realtimeCallScopeMismatch(): Response {
  return realtimeError(
    403,
    'invalid_request_error',
    'realtime_call_scope_mismatch',
    'This call belongs to a different caller.',
  );
}

export function realtimeCallNotFound(): Response {
  return realtimeError(
    404,
    'invalid_request_error',
    'realtime_call_not_found',
    'No active realtime call matches this call_id.',
  );
}

export function realtimeCallBusy(): Response {
  return realtimeError(
    409,
    'invalid_request_error',
    'realtime_call_busy',
    'A sideband attachment is already active for this call.',
  );
}

export function realtimeBodyTooLarge(): Response {
  return realtimeError(
    413,
    'invalid_request_error',
    'realtime_body_too_large',
    'The realtime offer exceeds the 16 MiB limit.',
  );
}

export function realtimeUnsupportedMediaType(): Response {
  return realtimeError(
    415,
    'invalid_request_error',
    'realtime_unsupported_media_type',
    'A realtime offer must be application/sdp, text/plain, application/json, or multipart/form-data.',
  );
}

export function websocketUpgradeRequired(): Response {
  const response = realtimeError(
    426,
    'invalid_request_error',
    'websocket_upgrade_required',
    'This endpoint requires a WebSocket upgrade.',
  );
  response.headers.set('upgrade', 'websocket');
  return response;
}

export function realtimeCapabilityNotSupported(): Response {
  return realtimeError(
    501,
    'not_supported_error',
    'realtime_capability_not_supported',
    'This realtime capability is not available through the configured upstream.',
  );
}

/** The upstream handshake status is unobservable from a client `WebSocket`, so a
 *  rejected dial is always this one error — never a mapped upstream 404 or 501. */
export function realtimeDialFailed(): Response {
  return realtimeError(502, 'api_error', 'realtime_dial_failed', 'The upstream refused the sideband handshake.');
}

export function codexAuthUnavailable(): Response {
  return realtimeError(
    503,
    'api_error',
    'codex_auth_unavailable',
    'The account that created this call is no longer available.',
  );
}

export function realtimeUpstreamUnavailable(): Response {
  return realtimeError(
    503,
    'api_error',
    'realtime_upstream_unavailable',
    'No realtime upstream is currently available.',
  );
}
```

- [ ] **Step 4: Run the error tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/errors.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 5: Write the failing create-body test**

Create `packages/server/src/routes/realtime/create-body.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { readRealtimeCreateBody, withUpstreamModel } from './create-body';

test('a multipart offer becomes JSON and takes its requested model from the session part', async () => {
  const form = new FormData();
  form.set('sdp', 'v=0\r\n');
  form.set('session', JSON.stringify({ model: 'gpt-realtime', voice: 'cedar' }));

  const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  expect(result.contentType).toBe('application/json');
  expect(result.requestedModel).toBe('gpt-realtime');
  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
    sdp: 'v=0\r\n',
    session: { model: 'gpt-realtime', voice: 'cedar' },
  });
});

test('a multipart offer missing sdp, or with an unparseable session, is 400 realtime_invalid_offer', async () => {
  const missingSdp = new FormData();
  missingSdp.set('session', '{}');
  const badSession = new FormData();
  badSession.set('sdp', 'v=0\r\n');
  badSession.set('session', 'not json');

  for (const form of [missingSdp, badSession]) {
    const result = await readRealtimeCreateBody(new Request('http://x/v1/live', { method: 'POST', body: form }));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_invalid_offer');
  }
});

test('raw SDP and text/plain offers are forwarded verbatim with the normalized model', async () => {
  const result = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n',
      headers: { 'content-type': 'application/sdp' },
    }),
  );
  if (result instanceof Response) throw new Error(`expected a normalized body, got ${result.status}`);

  expect(result.contentType).toBe('application/sdp');
  expect(new TextDecoder().decode(result.body)).toBe('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n');
  expect(result.requestedModel).toBe('gpt-live-1-codex');
});

test('a JSON offer reads model, then falls back to session.model', async () => {
  const topLevel = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', model: 'gpt-realtime' }));
  const nested = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0', session: { model: 'gpt-4o-realtime-preview' } }));
  const absent = await readRealtimeCreateBody(jsonRequest({ sdp: 'v=0' }));

  expect((topLevel as { requestedModel: string }).requestedModel).toBe('gpt-realtime');
  expect((nested as { requestedModel: string }).requestedModel).toBe('gpt-4o-realtime-preview');
  expect((absent as { requestedModel: string }).requestedModel).toBe('gpt-live-1-codex');
});

test('an unaccepted content type is 415 and an oversize body is 413', async () => {
  const wrongType = await readRealtimeCreateBody(
    new Request('http://x/v1/live', { method: 'POST', body: 'x', headers: { 'content-type': 'application/xml' } }),
  );
  expect((wrongType as Response).status).toBe(415);

  const oversize = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v'.repeat(16 * 1024 * 1024 + 1),
      headers: { 'content-type': 'application/sdp' },
    }),
  );
  expect((oversize as Response).status).toBe(413);
});

test('withUpstreamModel rewrites both model fields for JSON and leaves SDP untouched', async () => {
  const json = await readRealtimeCreateBody(
    jsonRequest({ sdp: 'v=0', model: 'gpt-realtime', session: { model: 'gpt-realtime', voice: 'cedar' } }),
  );
  const sdp = await readRealtimeCreateBody(
    new Request('http://x/v1/live', {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'application/sdp' },
    }),
  );

  const rewritten = withUpstreamModel(json as never, 'gpt-live-1-codex');
  expect(JSON.parse(new TextDecoder().decode(rewritten.body))).toEqual({
    sdp: 'v=0',
    model: 'gpt-live-1-codex',
    session: { model: 'gpt-live-1-codex', voice: 'cedar' },
  });

  const untouched = withUpstreamModel(sdp as never, 'gpt-live-1-codex');
  expect(new TextDecoder().decode(untouched.body)).toBe('v=0\r\n');
  expect(untouched.contentType).toBe('application/sdp');
});

function jsonRequest(body: unknown): Request {
  return new Request('http://x/v1/live', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/create-body.test.ts
```

Expected: FAIL with `Cannot find module './create-body'`.

- [ ] **Step 7: Implement create-body normalization**

Create `packages/server/src/routes/realtime/create-body.ts`:

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import { CODEX_REALTIME_MODEL } from './model';
import { realtimeBodyTooLarge, realtimeInvalidOffer, realtimeUnsupportedMediaType } from './errors';

/** The reference's `maxBodySize`. The server-wide `MAX_REQUEST_BODY_SIZE` is sized
 *  for image-edit multipart (~851 MB); buffering that for an SDP fallback would be
 *  a memory bomb. */
export const REALTIME_CREATE_BODY_LIMIT = 16_777_216;

export type RealtimeCreateBody = {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly requestedModel: string;
};

const ACCEPTED = ['application/sdp', 'text/plain', 'application/json', 'multipart/form-data'] as const;

export async function readRealtimeCreateBody(request: Request): Promise<RealtimeCreateBody | Response> {
  const contentType = (request.headers.get('content-type') ?? 'application/sdp').split(';')[0]?.trim() ?? '';
  if (!ACCEPTED.includes(contentType as (typeof ACCEPTED)[number])) return realtimeUnsupportedMediaType();

  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > REALTIME_CREATE_BODY_LIMIT) return realtimeBodyTooLarge();

  if (contentType === 'multipart/form-data') return await readMultipart(request);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > REALTIME_CREATE_BODY_LIMIT) return realtimeBodyTooLarge();
  if (contentType !== 'application/json') {
    return { body: bytes, contentType, requestedModel: CODEX_REALTIME_MODEL };
  }
  return {
    body: bytes,
    contentType,
    requestedModel: jsonRequestedModel(parseJson(new TextDecoder().decode(bytes))),
  };
}

async function readMultipart(request: Request): Promise<RealtimeCreateBody | Response> {
  const form = await request.formData();
  const sdp = form.get('sdp');
  if (typeof sdp !== 'string' || sdp.length === 0) {
    return realtimeInvalidOffer('A multipart realtime offer must carry a non-empty sdp part.');
  }
  const rawSession = form.get('session');
  let session: unknown;
  if (typeof rawSession === 'string' && rawSession.length > 0) {
    session = parseJson(rawSession);
    if (session === undefined) return realtimeInvalidOffer('The multipart session part is not valid JSON.');
  }
  const payload = session === undefined ? { sdp } : { sdp, session };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.byteLength > REALTIME_CREATE_BODY_LIMIT) return realtimeBodyTooLarge();
  return { body, contentType: 'application/json', requestedModel: jsonRequestedModel(payload) };
}

/** Normalization applies to selection; the wire body still needs the upstream model
 *  written into it. SDP and text bodies carry no model field, so they pass through. */
export function withUpstreamModel(body: RealtimeCreateBody, normalized: string): RealtimeCreateBody {
  if (body.contentType !== 'application/json') return body;
  const payload = parseJson(new TextDecoder().decode(body.body));
  if (!isPlainObject(payload)) return body;
  const session = payload['session'];
  const rewritten = {
    ...payload,
    ...(Object.hasOwn(payload, 'model') ? { model: normalized } : {}),
    ...(isPlainObject(session) ? { session: { ...session, model: normalized } } : {}),
  };
  return { ...body, body: new TextEncoder().encode(JSON.stringify(rewritten)) };
}

function jsonRequestedModel(payload: unknown): string {
  if (!isPlainObject(payload)) return CODEX_REALTIME_MODEL;
  const top = payload['model'];
  if (typeof top === 'string' && top.length > 0) return top;
  const session = payload['session'];
  if (isPlainObject(session)) {
    const nested = session['model'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return CODEX_REALTIME_MODEL;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 8: Widen the barrel and run both files**

Append to `packages/server/src/routes/realtime/index.ts`:

```ts
export type { RealtimeCreateBody } from './create-body';
export { readRealtimeCreateBody, REALTIME_CREATE_BODY_LIMIT, withUpstreamModel } from './create-body';
export { isValidCallId, REALTIME_CALL_ID_PATTERN, realtimeError } from './errors';
```

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime
```

Expected: PASS, `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/routes/realtime
git commit -m "feat(server): add realtime error bodies and create-body normalization"
```

---
## Task 8: Close-code normalization and the realtime log types

**Files:**
- Create: `packages/server/src/routes/realtime/close-code.ts`
- Create: `packages/server/src/routes/realtime/close-code.test.ts`
- Modify: `packages/server/src/server-log.ts:186-203` (add the four types, extend the union)
- Modify: `packages/server/src/routes/realtime/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `INTERNAL_CLOSE_CODE = 1011`, `SHUTDOWN_CLOSE_CODE = 1001`, `MAX_CLOSE_REASON_BYTES = 123`
  - `normalizeCloseCode(code: number | undefined): number`
  - `truncateCloseReason(reason: string | undefined): string | undefined`
  - `normalizedClose(code, reason): { readonly code: number; readonly reason?: string }`
  - `RealtimeCallCreatedLog`, `RealtimeCallFailedLog`, `RealtimeSidebandOpenedLog`, `RealtimeSidebandClosedLog` in `server-log.ts`, each added to the `ServerLog` union

- [ ] **Step 1: Write the failing close-code test**

Create `packages/server/src/routes/realtime/close-code.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { normalizedClose, normalizeCloseCode, truncateCloseReason } from './close-code';

test('codes the client WebSocket accepts pass through unchanged', () => {
  for (const code of [1000, 1001, 1002, 1003, 1007, 1010, 1011, 1014, 3000, 4000, 4999]) {
    expect(normalizeCloseCode(code)).toBe(code);
  }
});

test('every code the client WebSocket would throw on becomes 1011', () => {
  // `WebSocket.close()` throws InvalidAccessError for these; the relay must never
  // forward one upstream, and it keeps a single table by normalizing both directions.
  for (const code of [undefined, 999, 1004, 1005, 1006, 1015, 2999, 5000, 0, -1]) {
    expect(normalizeCloseCode(code)).toBe(1011);
  }
});

test('a reason longer than 123 UTF-8 bytes is truncated on a code-point boundary', () => {
  const ascii = 'a'.repeat(200);
  const truncatedAscii = truncateCloseReason(ascii)!;
  expect(new TextEncoder().encode(truncatedAscii).byteLength).toBe(123);

  // 3 bytes each: a naive slice(0, 123) would cut mid-sequence and produce U+FFFD.
  const multibyte = '好'.repeat(200);
  const truncatedMultibyte = truncateCloseReason(multibyte)!;
  expect(new TextEncoder().encode(truncatedMultibyte).byteLength).toBeLessThanOrEqual(123);
  expect(truncatedMultibyte).toBe('好'.repeat(41));
  expect(truncatedMultibyte).not.toContain('�');
});

test('a short reason and an absent reason are left alone', () => {
  expect(truncateCloseReason('going away')).toBe('going away');
  expect(truncateCloseReason(undefined)).toBeUndefined();
  expect(truncateCloseReason('')).toBeUndefined();
});

test('a normalized code drops its reason, while a passed-through code keeps a truncated one', () => {
  expect(normalizedClose(1006, 'Failed to connect')).toEqual({ code: 1011 });
  expect(normalizedClose(4001, 'session ended')).toEqual({ code: 4001, reason: 'session ended' });
  expect(normalizedClose(1000, 'a'.repeat(200)).reason).toHaveLength(123);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/close-code.test.ts
```

Expected: FAIL with `Cannot find module './close-code'`.

- [ ] **Step 3: Implement close-code normalization**

Create `packages/server/src/routes/realtime/close-code.ts`:

```ts
export const INTERNAL_CLOSE_CODE = 1011;
export const SHUTDOWN_CLOSE_CODE = 1001;
export const MAX_CLOSE_REASON_BYTES = 123;

/** Measured on Bun 1.4.2: `ServerWebSocket.close()` accepts everything, but the
 *  client `WebSocket.close()` throws `InvalidAccessError` outside these ranges.
 *  Normalizing to the narrower set in both directions keeps one code path. */
function acceptedByClient(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (code >= 1000 && code <= 1003) return true;
  if (code >= 1007 && code <= 1014) return true;
  return code >= 3000 && code <= 4999;
}

export function normalizeCloseCode(code: number | undefined): number {
  return code !== undefined && acceptedByClient(code) ? code : INTERNAL_CLOSE_CODE;
}

/** A reason over 123 UTF-8 bytes throws `SyntaxError` on both sides. Truncation
 *  walks code points so a multi-byte sequence is never cut in half. */
export function truncateCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason.length === 0) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let bytes = 0;
  let result = '';
  for (const codePoint of reason) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > MAX_CLOSE_REASON_BYTES) break;
    bytes += size;
    result += codePoint;
  }
  return result.length === 0 ? undefined : result;
}

/** A code that had to be normalized carries no meaningful reason, so the reason is
 *  dropped rather than paired with a code the origin never sent. */
export function normalizedClose(
  code: number | undefined,
  reason: string | undefined,
): { readonly code: number; readonly reason?: string } {
  const normalized = normalizeCloseCode(code);
  if (normalized !== code) return { code: normalized };
  const truncated = truncateCloseReason(reason);
  return truncated === undefined ? { code: normalized } : { code: normalized, reason: truncated };
}
```

- [ ] **Step 4: Run the close-code test**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/close-code.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 5: Add the four log types**

`ServerLog` in `packages/server/src/server-log.ts` is a closed union, so the realtime
`logServerEvent` calls do not type-check until these exist. Insert the four types immediately before
`export type ServerLog =`:

```ts
export type RealtimeCallCreatedLog = {
  readonly event: 'realtime.call_created';
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly style: string;
  readonly attemptCount: number;
};

export type RealtimeCallFailedLog = {
  readonly event: 'realtime.call_failed';
  readonly providerId?: string;
  readonly model: string;
  readonly style: string;
  readonly attemptCount: number;
  readonly statusCode: number;
  readonly errorCode: string;
};

export type RealtimeSidebandOpenedLog = {
  readonly event: 'realtime.sideband_opened';
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly style: string;
};

export type RealtimeSidebandClosedLog = {
  readonly event: 'realtime.sideband_closed';
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly style: string;
  /** Already run through `normalizeCloseCode`, so it is always a code the client
   *  side accepts — never a raw `1006`. */
  readonly closeCode: number;
  readonly origin: 'downstream' | 'upstream' | 'proxy';
};
```

Extend the union, keeping its existing alphabetical-ish grouping:

```ts
export type ServerLog =
  | ConfigOAuthLeftoverModelsLog
  | ConfigReloadLog
  | DashboardAuthUnavailableLog
  | RealtimeCallCreatedLog
  | RealtimeCallFailedLog
  | RealtimeSidebandClosedLog
  | RealtimeSidebandOpenedLog
  | RequestBodyChunkLog
  | RequestBodyTerminalLog
  | RequestFailedLog
  | RequestFeatureDowngradedLog
  | RequestInboundSnapshotLog
  | RequestProviderAttemptFailedLog
  | RequestRecorderInvariantLog
  | RequestRejectedLog
  | TracePersistenceFailedLog
  | UsageAccountingDroppedLog
  | RequestUpstreamResultLog
  | RequestUpstreamSnapshotLog;
```

No SDP body, `Location` value, or credential appears in any of these four shapes; that is the
allowlist, and Task 10's route tests assert it on real log output.

- [ ] **Step 6: Widen the barrel and typecheck**

Append to `packages/server/src/routes/realtime/index.ts`:

```ts
export {
  INTERNAL_CLOSE_CODE,
  MAX_CLOSE_REASON_BYTES,
  normalizeCloseCode,
  normalizedClose,
  SHUTDOWN_CLOSE_CODE,
  truncateCloseReason,
} from './close-code';
```

```bash
bun run check
```

Expected: `oxlint` and `tsc` both clean; `0 warnings, 0 errors`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/realtime packages/server/src/server-log.ts
git commit -m "feat(server): normalize realtime close codes and add realtime log types"
```

---

## Task 9: The realtime route module

**Files:**
- Create: `packages/server/src/routes/realtime/source.ts`
- Create: `packages/server/src/routes/realtime/signaling.ts`
- Create: `packages/server/src/routes/realtime/signaling.test.ts`
- Create: `packages/server/src/routes/realtime/sideband.ts`
- Create: `packages/server/src/routes/realtime/hangup.ts`
- Create: `packages/server/src/routes/realtime/realtime.ts`
- Modify: `packages/server/src/routes/realtime/index.ts`
- Modify: `packages/server/src/server/server.ts:340-383` (construct and mount)

**Interfaces:**
- Consumes: Task 1's `RealtimeDialError`/`RealtimeStyle`/`RealtimeTransport`; Task 4's store;
  Task 5's `normalizeRealtimeModel`, `pinnedRealtimeCandidate`, `selectRealtimeCandidates`;
  Task 6's `callerPrincipal`; Task 7's `readRealtimeCreateBody`, `withUpstreamModel`, `isValidCallId`,
  and every error helper; Task 8's `normalizedClose` and log types.
- Produces:
  - `source.ts`: `RealtimeRouteSource = { readonly acquireProviderSnapshot: ProviderRouteSource['acquireProviderSnapshot']; readonly logger: ServerLogSink; readonly realtimeCalls: RealtimeCallStore }`
  - `signaling.ts`: `MAX_CREATE_ATTEMPTS = 2`, `handleRealtimeCreate(context, source, style): Promise<Response>`, `callIdFromLocation(location): string | undefined`, `rewriteLocation(callId, style): string`
  - `sideband.ts`: `PRE_OPEN_FRAME_LIMIT = 64`, `PRE_OPEN_BYTE_LIMIT = 1_048_576`, `BACKPRESSURE_LIMIT = 1_048_576`, `DIRECT_DEFAULT_MODEL = 'gpt-realtime'`, `handleRealtimeSideband(context, source, style): Promise<Response>`
  - `hangup.ts`: `handleRealtimeHangup(context, source): Promise<Response>`
  - `realtime.ts`: `createRealtimeRoutes(source: RealtimeRouteSource)`, `UNSUPPORTED_REALTIME_ROUTES`

- [ ] **Step 1: Write the source type**

Create `packages/server/src/routes/realtime/source.ts`. It exists as its own file so `signaling.ts`,
`sideband.ts`, `hangup.ts`, and `realtime.ts` can all import the type without a cycle through the
barrel:

```ts
import type { ProviderRouteSource } from '../../runtime';
import type { ServerLogSink } from '../../server-log';
import type { RealtimeCallStore } from './call-store';

/** Deliberately narrower than `ProviderRouteSource`: realtime has no usage capture,
 *  no request recorder, and no cooldown store, so it must not be handed them. */
export type RealtimeRouteSource = {
  readonly acquireProviderSnapshot: ProviderRouteSource['acquireProviderSnapshot'];
  readonly logger: ServerLogSink;
  readonly realtimeCalls: RealtimeCallStore;
};
```

- [ ] **Step 2: Write the failing signaling test**

Create `packages/server/src/routes/realtime/signaling.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';
import { Hono } from 'hono';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import type { ServerLog } from '../../server-log';
import { createRealtimeCallStore } from './call-store';
import { callIdFromLocation, handleRealtimeCreate, rewriteLocation } from './signaling';
import type { RealtimeRouteSource } from './source';

test('a call id is recovered from an absolute, a relative, and a query-parameter Location', () => {
  expect(callIdFromLocation('https://api.openai.com/v1/realtime/calls/call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime/calls/call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime?call_id=call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime/calls/call_abc?foo=1')).toBe('call_abc');
});

test('a Location with no extractable, or an invalid, call id yields undefined', () => {
  expect(callIdFromLocation(undefined)).toBeUndefined();
  expect(callIdFromLocation('')).toBeUndefined();
  expect(callIdFromLocation('/v1/realtime/calls/')).toBeUndefined();
  expect(callIdFromLocation('/v1/realtime/calls/not%20valid')).toBeUndefined();
  expect(callIdFromLocation(`/v1/realtime/calls/${'a'.repeat(129)}`)).toBeUndefined();
});

test('Location is rewritten to the inbound style, never the upstream host', () => {
  expect(rewriteLocation('call_abc', 'live')).toBe('/v1/live/call_abc');
  expect(rewriteLocation('call_abc', 'realtime-calls')).toBe('/v1/realtime/calls/call_abc');
  // POST /v1/realtime deliberately advertises the /calls/ GET route: no GET
  // exists at /v1/realtime/<callId>.
  expect(rewriteLocation('call_abc', 'realtime-query')).toBe('/v1/realtime/calls/call_abc');
});

test('a successful create records the call, rewrites Location, and returns the body verbatim', async () => {
  const store = createRealtimeCallStore();
  const source = sourceWith([realtimeProvider({ id: 'codex', answer: sdpAnswer('call_abc') })], store);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toBe('/v1/live/call_abc');
  expect(await response.text()).toBe('v=0\r\na=answer\r\n');
  expect(store.lookup('call_abc')).toMatchObject({
    providerId: 'codex',
    accountId: 'person@example.com',
    runtimeRevision: 3,
    model: 'gpt-live-1-codex',
    style: 'live',
  });
});

test('a JSON-wrapped answer is returned without unwrapping', async () => {
  const answer = JSON.stringify({ sdp: 'v=0\r\na=answer\r\n', type: 'answer' });
  const source = sourceWith([
    realtimeProvider({
      id: 'codex',
      answer: () =>
        new Response(answer, {
          status: 200,
          headers: { 'content-type': 'application/json', location: '/v1/realtime/calls/call_abc' },
        }),
    }),
  ]);

  const response = await post(source, 'realtime-calls', 'v=0\r\n', 'application/sdp');

  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.text()).toBe(answer);
});

test('a 5xx falls back to the next provider and replays the buffered body', async () => {
  const bodies: string[] = [];
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: async (request) => {
        bodies.push(await request.text());
        return new Response('boom', { status: 502 });
      },
    }),
    realtimeProvider({
      id: 'b',
      answer: async (request) => {
        bodies.push(await request.text());
        return sdpAnswer('call_abc')();
      },
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\nfallback\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect(bodies).toEqual(['v=0\r\nfallback\r\n', 'v=0\r\nfallback\r\n']);
});

test('a non-401 non-429 4xx is returned as the upstream sent it, without a second attempt', async () => {
  let calls = 0;
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: () => {
        calls += 1;
        return new Response('bad offer', { status: 400 });
      },
    }),
    realtimeProvider({ id: 'b', answer: sdpAnswer('call_abc') }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(calls).toBe(1);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe('bad offer');
});

test('401 and 429 do fall through to the next credential', async () => {
  for (const status of [401, 429]) {
    const source = sourceWith([
      realtimeProvider({ id: 'a', priority: 10, answer: () => new Response('', { status }) }),
      realtimeProvider({ id: 'b', answer: sdpAnswer('call_abc') }),
    ]);

    expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(201);
  }
});

test('attempts stop at two even with three eligible providers', async () => {
  const attempted: string[] = [];
  const source = sourceWith(
    ['a', 'b', 'c'].map((id, index) =>
      realtimeProvider({
        id,
        priority: 10 - index,
        answer: () => {
          attempted.push(id);
          return new Response('', { status: 503 });
        },
      }),
    ),
  );

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(attempted).toEqual(['a', 'b']);
  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_upstream_unavailable');
});

test('a 2xx with an empty body or an unusable Location is a failed attempt', async () => {
  for (const answer of [
    () => new Response(null, { status: 204, headers: { location: '/v1/live/call_abc' } }),
    () => new Response('v=0\r\n', { status: 200 }),
    () => new Response('v=0\r\n', { status: 200, headers: { location: 'not a url at all ///' } }),
  ]) {
    const source = sourceWith([realtimeProvider({ id: 'codex', answer })]);
    const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');
    expect(response.status).toBe(503);
  }
});

test('no eligible candidate answers 503 without dialing, and a full store answers 503 too', async () => {
  const empty = sourceWith([]);
  expect((await post(empty, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(503);

  let attempted = false;
  const full = createRealtimeCallStore({ capacity: 0 });
  const source = sourceWith(
    [
      realtimeProvider({
        id: 'codex',
        answer: () => {
          attempted = true;
          return sdpAnswer('call_abc')();
        },
      }),
    ],
    full,
  );

  expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(503);
  expect(attempted).toBe(false);
});

test('the create logs carry no SDP, no Location, and no credential', async () => {
  const logs: ServerLog[] = [];
  const source = sourceWith([realtimeProvider({ id: 'codex', answer: sdpAnswer('call_abc') })], undefined, logs);

  await post(source, 'live', 'v=0\r\na=secret-ice-candidate\r\n', 'application/sdp');

  const created = logs.find((entry) => entry.event === 'realtime.call_created');
  expect(created).toMatchObject({ callId: 'call_abc', providerId: 'codex', model: 'gpt-live-1-codex' });
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('secret-ice-candidate');
  expect(serialized).not.toContain('v=0');
  expect(serialized).not.toContain('api.openai.com');
});

function sdpAnswer(callId: string): () => Response {
  return () =>
    new Response('v=0\r\na=answer\r\n', {
      status: 201,
      headers: { 'content-type': 'application/sdp', location: `https://api.openai.com/v1/realtime/calls/${callId}` },
    });
}

async function post(
  source: RealtimeRouteSource,
  style: RealtimeStyle,
  body: string,
  contentType: string,
): Promise<Response> {
  const app = new Hono().post('/create', (context) => handleRealtimeCreate(context, source, style));
  return await app.request('/create', { method: 'POST', body, headers: { 'content-type': contentType } });
}

function realtimeProvider(overrides: {
  readonly id: string;
  readonly priority?: number;
  readonly answer: (request: Request) => Response | Promise<Response>;
}): RuntimeProviderInstance {
  return {
    id: overrides.id,
    kind: ProviderKind.OAuth,
    enabled: true,
    priority: overrides.priority ?? 0,
    weight: 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: ['gpt-5.5'],
    raw: { resolve: () => undefined },
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: (request: Request) => Promise.resolve(overrides.answer(request)).then((value) => value),
      dial: () => Promise.reject(new Error('not dialed in this test')),
    },
  } as unknown as RuntimeProviderInstance;
}

function sourceWith(
  providers: readonly RuntimeProviderInstance[],
  store = createRealtimeCallStore(),
  logs: ServerLog[] = [],
): RealtimeRouteSource {
  const snapshot = { providers, config: { router: { models: {} }, providers: [] } } as unknown as ProviderRouteSnapshot;
  return {
    acquireProviderSnapshot: () => ({ snapshot, release: () => {} }),
    logger: (entry) => logs.push(entry),
    realtimeCalls: store,
  };
}
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/signaling.test.ts
```

Expected: FAIL with `Cannot find module './signaling'`.

- [ ] **Step 4: Implement signaling**

Create `packages/server/src/routes/realtime/signaling.ts`:

```ts
import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { logServerEvent } from '../../server-log';
import { readRealtimeCreateBody, withUpstreamModel } from './create-body';
import { isValidCallId, realtimeUpstreamUnavailable, REALTIME_CALL_ID_PATTERN } from './errors';
import { normalizeRealtimeModel } from './model';
import { type RealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import type { RealtimeRouteSource } from './source';

export const MAX_CREATE_ATTEMPTS = 2;

export async function handleRealtimeCreate(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Promise<Response> {
  const parsed = await readRealtimeCreateBody(context.req.raw);
  if (parsed instanceof Response) return parsed;

  const normalized = normalizeRealtimeModel(parsed.requestedModel);
  const upstreamBody = withUpstreamModel(parsed, normalized);
  const models = { requested: parsed.requestedModel, normalized };
  const lease = source.acquireProviderSnapshot();
  try {
    const candidates = selectRealtimeCandidates(lease.snapshot, models).slice(0, MAX_CREATE_ATTEMPTS);
    // Capacity is checked before the first attempt: a 503 after a successful
    // upstream create would leave an allocated call the proxy cannot route.
    if (candidates.length === 0 || !source.realtimeCalls.hasCapacity()) {
      return failed(source, { model: normalized, style, attemptCount: 0 }, realtimeUpstreamUnavailable());
    }
    return await attemptCandidates(context, source, { candidates, models, style, body: upstreamBody });
  } finally {
    lease.release();
  }
}

type AttemptInput = {
  readonly candidates: readonly RealtimeCandidate[];
  readonly models: { readonly requested: string; readonly normalized: string };
  readonly style: RealtimeStyle;
  readonly body: { readonly body: Uint8Array; readonly contentType: string };
};

async function attemptCandidates(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  input: AttemptInput,
): Promise<Response> {
  const signal = context.req.raw.signal;
  let attemptCount = 0;
  for (const candidate of input.candidates) {
    if (signal.aborted) break;
    attemptCount += 1;
    let response: Response;
    try {
      // A fetch body is single-use, so each attempt gets a fresh Request built
      // from the buffered bytes. No inbound Host, Content-Length, Connection, or
      // Accept-Encoding, and the auth middleware already deleted every caller
      // credential; the plugin adds its own upstream auth.
      response = await candidate.realtime.fetch(
        new Request(context.req.raw.url, {
          method: 'POST',
          body: input.body.body,
          headers: { 'content-type': input.body.contentType, accept: '*/*' },
          signal,
        }),
      );
    } catch (error) {
      if (isInboundAbort(error, signal)) return new Response(null, { status: 499 });
      // Transport failure: try the next candidate.
      continue;
    }

    if (response.ok) {
      const callId = callIdFromLocation(response.headers.get('location') ?? undefined);
      const body = await response.arrayBuffer();
      if (callId !== undefined && body.byteLength > 0) {
        return commit(context, source, { ...input, callId, candidate, attemptCount, response, body });
      }
      continue;
    }

    // A 4xx means this offer or credential was rejected; replaying a bad SDP onto
    // every other provider multiplies the damage. 401/429 are per-credential.
    if (response.status < 500 && response.status !== 401 && response.status !== 429) {
      logFailure(source, { model: input.models.normalized, style: input.style, attemptCount }, response.status, 'upstream_rejected', candidate.provider.id);
      return response;
    }
    await response.body?.cancel();
  }
  return failed(source, { model: input.models.normalized, style: input.style, attemptCount }, realtimeUpstreamUnavailable());
}

function commit(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  input: AttemptInput & {
    readonly callId: string;
    readonly candidate: RealtimeCandidate;
    readonly attemptCount: number;
    readonly response: Response;
    readonly body: ArrayBuffer;
  },
): Response {
  source.realtimeCalls.insert({
    callId: input.callId,
    providerId: input.candidate.provider.id,
    accountId: input.candidate.provider.accountId ?? '',
    runtimeRevision: input.candidate.provider.runtimeRevision ?? 0,
    model: input.models.normalized,
    requestedModel: input.models.requested,
    style: input.style,
    owner: callerPrincipal(context),
    createdAt: Date.now(),
  });
  logServerEvent(source.logger, {
    event: 'realtime.call_created',
    callId: input.callId,
    providerId: input.candidate.provider.id,
    model: input.models.normalized,
    style: input.style,
    attemptCount: input.attemptCount,
  });

  const headers = new Headers();
  const contentType = input.response.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);
  // The upstream host is never advertised to the caller, and it is never a future
  // connection target: sideband and hangup URLs come from the plugin.
  headers.set('location', rewriteLocation(input.callId, input.style));
  return new Response(input.body, { status: input.response.status, headers });
}

function failed(
  source: RealtimeRouteSource,
  meta: { readonly model: string; readonly style: RealtimeStyle; readonly attemptCount: number },
  response: Response,
): Response {
  logFailure(source, meta, response.status, 'realtime_upstream_unavailable', undefined);
  return response;
}

function logFailure(
  source: RealtimeRouteSource,
  meta: { readonly model: string; readonly style: RealtimeStyle; readonly attemptCount: number },
  statusCode: number,
  errorCode: string,
  providerId: string | undefined,
): void {
  logServerEvent(source.logger, {
    event: 'realtime.call_failed',
    ...(providerId === undefined ? {} : { providerId }),
    model: meta.model,
    style: meta.style,
    attemptCount: meta.attemptCount,
    statusCode,
    errorCode,
  });
}

/** Parsed as a URL or a relative reference, including the query-parameter form.
 *  The host is deliberately discarded. */
export function callIdFromLocation(location: string | undefined): string | undefined {
  if (location === undefined || location.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(location, 'http://proxy.invalid');
  } catch {
    return undefined;
  }
  const fromQuery = url.searchParams.get('call_id');
  if (fromQuery !== null) return isValidCallId(fromQuery) ? fromQuery : undefined;
  const last = url.pathname.split('/').filter((segment) => segment.length > 0).at(-1);
  const decoded = last === undefined ? undefined : safeDecode(last);
  return decoded !== undefined && REALTIME_CALL_ID_PATTERN.test(decoded) ? decoded : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function rewriteLocation(callId: string, style: RealtimeStyle): string {
  // `realtime-query` advertises the /calls/ GET route deliberately: no GET route
  // exists at /v1/realtime/<callId>.
  return style === 'live' ? `/v1/live/${callId}` : `/v1/realtime/calls/${callId}`;
}
```

- [ ] **Step 5: Run the signaling tests**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/signaling.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 6: Commit signaling**

```bash
git add packages/server/src/routes/realtime
git commit -m "feat(server): add the realtime create signaling flow"
```

- [ ] **Step 7: Implement the sideband relay**

Create `packages/server/src/routes/realtime/sideband.ts`. The dial completes before the upgrade is
committed, which is what makes structured HTTP errors possible at all — after a 101 there is no way
to answer `401`, `501`, or `503`. This uses `upgradeWebSocket`'s direct `(context, events)` overload:
it returns the 101 `Response` and throws `Error('Failed to upgrade WebSocket')` when `server.upgrade`
refuses. The other overload, `(createEvents) => MiddlewareHandler`, would swallow that refusal into
`next()` and answer 404 instead:

```ts
import { RealtimeDialError, type RealtimeStyle, type RealtimeTransport } from '@aio-proxy/plugin-sdk';
import { upgradeWebSocket } from 'hono/bun';
import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { logServerEvent } from '../../server-log';
import { type RealtimeAttachment, sameCallerPrincipal } from './call-store';
import { INTERNAL_CLOSE_CODE, normalizedClose } from './close-code';
import {
  codexAuthUnavailable,
  invalidCallId,
  isValidCallId,
  realtimeCallBusy,
  realtimeCallNotFound,
  realtimeCallScopeMismatch,
  realtimeDialFailed,
  realtimeUpstreamUnavailable,
  websocketUpgradeRequired,
} from './errors';
import { CODEX_REALTIME_MODEL } from './model';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import type { RealtimeRouteSource } from './source';

export const PRE_OPEN_FRAME_LIMIT = 64;
export const PRE_OPEN_BYTE_LIMIT = 1_048_576;
export const BACKPRESSURE_LIMIT = 1_048_576;
/** What `/v1/realtime` without a `model` query sends upstream. A direct connection
 *  carries no call record, so there is no recorded model to reuse. */
export const DIRECT_DEFAULT_MODEL = 'gpt-realtime';

export async function handleRealtimeSideband(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Promise<Response> {
  if (context.req.header('upgrade')?.toLowerCase() !== 'websocket') return websocketUpgradeRequired();

  const prepared = prepare(context, source, style);
  if (prepared instanceof Response) return prepared;

  // Every failing path after this point must release the reservation.
  let dialed: WebSocket;
  try {
    dialed = await prepared.realtime.dial({
      style,
      ...(prepared.callId === undefined ? {} : { callId: prepared.callId }),
      model: prepared.model,
      headers: context.req.raw.headers,
      signal: context.req.raw.signal,
    });
  } catch (error) {
    releaseAttachment(source, prepared);
    const kind = error instanceof RealtimeDialError ? error.kind : 'rejected';
    if (kind === 'aborted') return new Response(null, { status: 499 });
    return kind === 'rejected' ? realtimeDialFailed() : realtimeUpstreamUnavailable();
  }

  if (context.req.raw.signal.aborted) {
    // The downstream went away during the dial; close what just opened.
    closeQuietly(dialed, 1001);
    releaseAttachment(source, prepared);
    return new Response(null, { status: 499 });
  }

  try {
    // The direct `(context, events)` overload of `upgradeWebSocket`, which returns
    // the 101 Response and throws when `server.upgrade` refuses. The middleware
    // overload would instead fall through to `next()` and answer 404.
    return await upgradeWebSocket(context, relayEvents(source, { ...prepared, style, upstream: dialed }));
  } catch {
    // The upgrade did not happen, so nothing will ever tear the upstream down.
    closeQuietly(dialed, INTERNAL_CLOSE_CODE);
    releaseAttachment(source, prepared);
    return realtimeUpstreamUnavailable();
  }
}

function releaseAttachment(source: RealtimeRouteSource, prepared: Prepared): void {
  if (prepared.attachment !== undefined) source.realtimeCalls.release(prepared.attachment.token);
}

type Prepared = {
  readonly callId: string | undefined;
  readonly providerId: string;
  readonly model: string;
  readonly realtime: RealtimeTransport;
  readonly attachment: RealtimeAttachment | undefined;
};

/** All non-mutating validation runs before the reservation, so a rejected request
 *  never leaves a reservation behind. */
function prepare(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Prepared | Response {
  if (style === 'realtime-direct') return prepareDirect(context, source);

  const callId = context.req.param('call_id') ?? context.req.query('call_id');
  // A malformed call_id on /v1/realtime is an error, never a silent
  // fall-through to a direct connection.
  if (!isValidCallId(callId)) return invalidCallId();
  const record = source.realtimeCalls.lookup(callId);
  if (record === undefined) return realtimeCallNotFound();
  if (!sameCallerPrincipal(record.owner, callerPrincipal(context))) return realtimeCallScopeMismatch();

  const lease = source.acquireProviderSnapshot();
  let realtime: RealtimeTransport;
  try {
    const candidate = pinnedRealtimeCandidate(lease.snapshot, {
      providerId: record.providerId,
      accountId: record.accountId,
      runtimeRevision: record.runtimeRevision,
    });
    if (candidate === undefined) return codexAuthUnavailable();
    realtime = candidate.realtime;
  } finally {
    lease.release();
  }

  // Reserve last: a synchronous check-and-set in one Bun isolate needs no mutex.
  const attachment = source.realtimeCalls.reserve(callId);
  if (attachment === undefined) return realtimeCallBusy();
  return { callId, providerId: record.providerId, model: record.model, realtime, attachment };
}

/** A direct connection has no call record, so nothing is reserved and nothing is
 *  pinned: selection is the ordinary candidate order. */
function prepareDirect(context: Context<CallerPrincipalEnv>, source: RealtimeRouteSource): Prepared | Response {
  const requested = context.req.query('model');
  const lease = source.acquireProviderSnapshot();
  try {
    // Selection still matches on the normalized model, but `realtime-direct`
    // sends the ORIGINALLY REQUESTED model upstream, defaulting to
    // `gpt-realtime`. Substituting the Codex model would diverge from Codex.
    const [candidate] = selectRealtimeCandidates(lease.snapshot, {
      requested: requested ?? DIRECT_DEFAULT_MODEL,
      normalized: CODEX_REALTIME_MODEL,
    });
    if (candidate === undefined) return realtimeUpstreamUnavailable();
    return {
      callId: undefined,
      providerId: candidate.provider.id,
      model: requested === undefined || requested.length === 0 ? DIRECT_DEFAULT_MODEL : requested,
      realtime: candidate.realtime,
      attachment: undefined,
    };
  } finally {
    lease.release();
  }
}
```

Then the relay itself, in the same file:

```ts
type RelayInput = Prepared & { readonly style: RealtimeStyle; readonly upstream: WebSocket };

function relayEvents(source: RealtimeRouteSource, input: RelayInput): WSEvents {
  const upstream = input.upstream;
  upstream.binaryType = 'arraybuffer';
  const pending: (string | ArrayBuffer)[] = [];
  let pendingBytes = 0;
  let downstream: WSContext | undefined;
  let torndown = false;

  // One teardown, safe from either side's close, from shutdown, and from hangup.
  const teardown = (code: number, reason?: string, origin: 'downstream' | 'upstream' | 'proxy' = 'proxy'): void => {
    if (torndown) return;
    torndown = true;
    const normalized = normalizedClose(code, reason);
    closeQuietly(upstream, normalized.code, normalized.reason);
    try {
      downstream?.close(normalized.code, normalized.reason);
    } catch {}
    if (input.attachment !== undefined) {
      source.realtimeCalls.release(input.attachment.token);
      // A sideband close ends the call; a *failed attach* does not, so only this
      // path removes the record.
      if (input.callId !== undefined) source.realtimeCalls.remove(input.callId);
    }
    logServerEvent(source.logger, {
      event: 'realtime.sideband_closed',
      callId: input.callId ?? '',
      providerId: input.providerId,
      model: input.model,
      style: input.style,
      closeCode: normalized.code,
      origin,
    });
  };

  input.attachment?.onClose((code) => teardown(code, undefined, 'proxy'));

  upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    const data = event.data;
    if (downstream === undefined) {
      // Pre-open buffer: 64 frames or 1 MiB, whichever comes first.
      pendingBytes += typeof data === 'string' ? data.length : data.byteLength;
      if (pending.length >= PRE_OPEN_FRAME_LIMIT || pendingBytes > PRE_OPEN_BYTE_LIMIT) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'upstream');
        return;
      }
      pending.push(data);
      return;
    }
    sendDownstream(downstream, data, teardown);
  });
  upstream.addEventListener('close', (event: CloseEvent) => teardown(event.code, event.reason, 'upstream'));
  // Bun always follows `error` with `close`, so the close handler is the single
  // teardown trigger and this listener only prevents an unhandled event.
  upstream.addEventListener('error', () => {});

  return {
    onOpen(_event: Event, ws: WSContext) {
      downstream = ws;
      if (torndown) {
        try {
          ws.close(INTERNAL_CLOSE_CODE);
        } catch {}
        return;
      }
      logServerEvent(source.logger, {
        event: 'realtime.sideband_opened',
        callId: input.callId ?? '',
        providerId: input.providerId,
        model: input.model,
        style: input.style,
      });
      for (const data of pending.splice(0)) sendDownstream(ws, data, teardown);
      pendingBytes = 0;
    },
    onMessage(event: MessageEvent<WSMessageReceive>) {
      const data = event.data;
      // Hono's Bun adapter already normalized a binary frame to `message.buffer`,
      // an exclusive Buffer on Bun 1.4.2. Forward it as-is: copying would be the
      // fix only if Bun ever shared a receive buffer, and Task 11's byte-length
      // test is what would catch that.
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
        return;
      }
      if (upstream.bufferedAmount > BACKPRESSURE_LIMIT) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
        return;
      }
      try {
        upstream.send(data);
      } catch {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
      }
    },
    onClose(event: CloseEvent) {
      teardown(event.code, event.reason, 'downstream');
    },
  };
}

/** `WSContext.send` discards Bun's backpressure result and exposes no `drain`, so
 *  the real queued byte count comes from the underlying `ServerWebSocket`. */
function sendDownstream(ws: WSContext, data: string | ArrayBuffer, teardown: (code: number) => void): void {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  if ((raw?.getBufferedAmount?.() ?? 0) > BACKPRESSURE_LIMIT) {
    teardown(INTERNAL_CLOSE_CODE);
    return;
  }
  try {
    ws.send(data);
  } catch {
    teardown(INTERNAL_CLOSE_CODE);
  }
}

function closeQuietly(socket: WebSocket, code: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}
```

- [ ] **Step 8: Implement hangup**

Create `packages/server/src/routes/realtime/hangup.ts`:

```ts
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { sameCallerPrincipal } from './call-store';
import {
  codexAuthUnavailable,
  invalidCallId,
  isValidCallId,
  realtimeCallNotFound,
  realtimeCallScopeMismatch,
  realtimeUpstreamUnavailable,
} from './errors';
import { pinnedRealtimeCandidate } from './provider-select';
import type { RealtimeRouteSource } from './source';

export async function handleRealtimeHangup(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
): Promise<Response> {
  const callId = context.req.param('call_id');
  if (!isValidCallId(callId)) return invalidCallId();
  const record = source.realtimeCalls.lookup(callId);
  if (record === undefined) return realtimeCallNotFound();
  if (!sameCallerPrincipal(record.owner, callerPrincipal(context))) return realtimeCallScopeMismatch();

  const lease = source.acquireProviderSnapshot();
  let response: Response;
  try {
    // Hangup uses the call's pinned account, never the current best candidate.
    const candidate = pinnedRealtimeCandidate(lease.snapshot, {
      providerId: record.providerId,
      accountId: record.accountId,
      runtimeRevision: record.runtimeRevision,
    });
    if (candidate === undefined) return codexAuthUnavailable();
    response = await candidate.realtime.fetch(
      new Request(context.req.raw.url, { method: 'POST', signal: context.req.raw.signal }),
    );
  } catch (error) {
    if (isInboundAbort(error, context.req.raw.signal)) return new Response(null, { status: 499 });
    return realtimeUpstreamUnavailable();
  } finally {
    lease.release();
  }

  // Hangup stays available while a sideband is live; a 2xx closes it with 1000
  // and deletes the record. A non-2xx leaves both untouched.
  if (response.ok) {
    source.realtimeCalls.closeAttachment(callId, 1000);
    source.realtimeCalls.remove(callId);
  }
  return response;
}
```

- [ ] **Step 9: Register the routes**

Create `packages/server/src/routes/realtime/realtime.ts`:

```ts
import { Hono } from 'hono';

import type { CallerPrincipalEnv } from '../../caller-principal';
import { realtimeCapabilityNotSupported } from './errors';
import { handleRealtimeHangup } from './hangup';
import { handleRealtimeSideband } from './sideband';
import { handleRealtimeCreate } from './signaling';
import type { RealtimeRouteSource } from './source';

/** The ChatGPT/Codex OAuth upstream has no equivalent capability. Registering
 *  these converts a confusing 404 into a diagnosable 501. */
export const UNSUPPORTED_REALTIME_ROUTES = [
  { method: 'post', path: '/v1/realtime/client_secrets' },
  { method: 'post', path: '/v1/realtime/sessions' },
  { method: 'post', path: '/v1/realtime/transcription_sessions' },
  { method: 'get', path: '/v1/realtime/translations' },
  { method: 'post', path: '/v1/realtime/translations' },
  { method: 'post', path: '/v1/realtime/translations/client_secrets' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/accept' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/reject' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/refer' },
] as const;

export function createRealtimeRoutes(source: RealtimeRouteSource) {
  const app = new Hono<CallerPrincipalEnv>();

  // Registered before the create/sideband routes so `/v1/realtime/translations`
  // cannot be shadowed by a broader realtime pattern.
  for (const route of UNSUPPORTED_REALTIME_ROUTES) {
    app[route.method](route.path, () => realtimeCapabilityNotSupported());
  }

  app.post('/v1/realtime/calls/:call_id/hangup', (context) => handleRealtimeHangup(context, source));

  app.post('/v1/live', (context) => handleRealtimeCreate(context, source, 'live'));
  app.post('/v1/realtime', (context) => handleRealtimeCreate(context, source, 'realtime-query'));
  app.post('/v1/realtime/calls', (context) => handleRealtimeCreate(context, source, 'realtime-calls'));

  app.get('/v1/live/:call_id', (context) => handleRealtimeSideband(context, source, 'live'));
  app.get('/v1/realtime/calls/:call_id', (context) => handleRealtimeSideband(context, source, 'realtime-calls'));
  // With `call_id` this is a sideband attach; without it, a direct connection.
  app.get('/v1/realtime', (context) =>
    handleRealtimeSideband(
      context,
      source,
      context.req.query('call_id') === undefined ? 'realtime-direct' : 'realtime-query',
    ),
  );

  return app;
}
```

Rewrite `packages/server/src/routes/realtime/index.ts` so it is exports only, as the barrel rule
requires:

```ts
export type { RealtimeAttachment, RealtimeCallOwner, RealtimeCallRecord, RealtimeCallStore } from './call-store';
export {
  createRealtimeCallStore,
  REALTIME_CALL_CAPACITY,
  REALTIME_CALL_TTL_MS,
  sameCallerPrincipal,
} from './call-store';
export {
  INTERNAL_CLOSE_CODE,
  MAX_CLOSE_REASON_BYTES,
  normalizeCloseCode,
  normalizedClose,
  SHUTDOWN_CLOSE_CODE,
  truncateCloseReason,
} from './close-code';
export type { RealtimeCreateBody } from './create-body';
export { readRealtimeCreateBody, REALTIME_CREATE_BODY_LIMIT, withUpstreamModel } from './create-body';
export { isValidCallId, REALTIME_CALL_ID_PATTERN, realtimeError } from './errors';
export { CODEX_REALTIME_MODEL, normalizeRealtimeModel } from './model';
export type { RealtimeCallPin, RealtimeCandidate, RealtimeModelPair } from './provider-select';
export { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
export { createRealtimeRoutes, UNSUPPORTED_REALTIME_ROUTES } from './realtime';
export type { RealtimeRouteSource } from './source';
```

- [ ] **Step 10: Mount the routes in the server**

In `packages/server/src/server/server.ts`, add the import:

```ts
import { createRealtimeRoutes } from '../routes/realtime';
```

Construct it alongside the other route factories, immediately after `openAIImagesRoutes`:

```ts
  const openAIImagesRoutes = createOpenAIImagesRoutes(state);
  const realtimeRoutes = createRealtimeRoutes({
    acquireProviderSnapshot: state.acquireProviderSnapshot,
    logger: state.logger,
    realtimeCalls: state.realtimeCalls,
  });
```

and mount it in the `.route('/')` chain after `openAIImagesRoutes`:

```ts
    .route('/', openAIImagesRoutes)
    .route('/', realtimeRoutes)
```

- [ ] **Step 11: Run the realtime tests and the typecheck**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime
```

Expected: PASS, `0 fail`.

```bash
bun run check
```

Expected: `oxlint` and `tsc` clean. If `oxlint` reports `max-lines-per-function` on `relayEvents`,
extract the upstream listener registration into a `bindUpstream(upstream, …)` helper in the same
file — the 160-line ceiling is a hard rule, not a suggestion.

- [ ] **Step 12: Commit**

```bash
git add packages/server/src/routes/realtime packages/server/src/server/server.ts
git commit -m "feat(server): serve the realtime signaling, sideband, and hangup routes"
```

---

## Task 10: Route-level behavior through the real app

**Files:**
- Create: `packages/server/src/routes/realtime/realtime.test.ts`

**Interfaces:**
- Consumes: `createServer` from `#server-test-lifecycle`, and every module from Tasks 4–9.
- Produces: no new exports. This task proves the composed behavior that unit tests cannot: the
  unsupported set, the caller-ownership 403, the anonymous-mode pass, and the 426.

- [ ] **Step 1: Write the failing route test**

Create `packages/server/src/routes/realtime/realtime.test.ts`. `createServer({ providerInstances })`
injects a fake `RuntimeProviderInstance` carrying a `realtime` capability, so no plugin machinery,
OAuth account, or credential store is involved:

```ts
import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { cleanupServerTestLifecycle, createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInput } from '../../runtime';

afterEach(cleanupServerTestLifecycle);

test('every unsupported realtime endpoint answers 501 not_supported_error', async () => {
  const app = await createServer({ config: { providers: {} } });
  const paths = [
    ['POST', '/v1/realtime/client_secrets'],
    ['POST', '/v1/realtime/sessions'],
    ['POST', '/v1/realtime/transcription_sessions'],
    ['GET', '/v1/realtime/translations'],
    ['POST', '/v1/realtime/translations'],
    ['POST', '/v1/realtime/translations/client_secrets'],
    ['POST', '/v1/realtime/calls/call_abc/accept'],
    ['POST', '/v1/realtime/calls/call_abc/reject'],
    ['POST', '/v1/realtime/calls/call_abc/refer'],
  ] as const;

  for (const [method, path] of paths) {
    const response = await app.request(path, { method });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('not_supported_error');
    expect(body.error.code).toBe('realtime_capability_not_supported');
  }
});

test('a sideband path reached without an upgrade header answers 426 with Upgrade: websocket', async () => {
  const app = await createServer({ config: { providers: {} }, providerInstances: [realtimeProvider()] });
  await create(app);

  const response = await app.request('/v1/live/call_abc');

  expect(response.status).toBe(426);
  expect(response.headers.get('upgrade')).toBe('websocket');
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('websocket_upgrade_required');
});

test('a malformed call id is 400, never a silent fall-through to a direct connection', async () => {
  const app = await createServer({ config: { providers: {} }, providerInstances: [realtimeProvider()] });

  const response = await app.request('/v1/realtime?call_id=..%2Fsecrets', {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });

  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_call_id');
});

test('a different static key cannot attach to or hang up another caller’s call', async () => {
  const app = await createServer({
    config: { providers: {}, server: { apiKeys: [{ key: 'key-owner' }, { key: 'key-other' }] } },
    providerInstances: [realtimeProvider()],
  });
  await create(app, 'key-owner');

  const attach = await app.request('/v1/live/call_abc', {
    headers: { authorization: 'Bearer key-other', upgrade: 'websocket', connection: 'Upgrade' },
  });
  const hangup = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: 'Bearer key-other' },
  });

  expect(attach.status).toBe(403);
  expect(hangup.status).toBe(403);
  expect(((await hangup.json()) as { error: { code: string } }).error.code).toBe('realtime_call_scope_mismatch');
});

test('the creating key is not 403ed, and anonymous mode does not 403 its only caller', async () => {
  const keyed = await createServer({
    config: { providers: {}, server: { apiKeys: [{ key: 'key-owner' }] } },
    providerInstances: [realtimeProvider()],
  });
  await create(keyed, 'key-owner');
  const keyedHangup = await keyed.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: 'Bearer key-owner' },
  });

  const anonymous = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
  });
  await create(anonymous);
  const anonymousHangup = await anonymous.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });

  expect(keyedHangup.status).toBe(200);
  expect(anonymousHangup.status).toBe(200);
});

test('a hangup for an unknown call is 404 and a 2xx hangup deletes the record', async () => {
  const app = await createServer({ config: { providers: {} }, providerInstances: [realtimeProvider()] });
  await create(app);

  const first = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });
  const second = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });

  expect(first.status).toBe(200);
  expect(second.status).toBe(404);
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe('realtime_call_not_found');
});

async function create(app: Awaited<ReturnType<typeof createServer>>, key?: string): Promise<void> {
  const response = await app.request('/v1/live', {
    method: 'POST',
    body: 'v=0\r\n',
    headers: {
      'content-type': 'application/sdp',
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
  });
  if (response.status !== 201) throw new Error(`create failed with ${response.status}`);
}

function realtimeProvider(): RuntimeProviderInput {
  return {
    id: 'codex',
    kind: ProviderKind.OAuth,
    enabled: true,
    priority: 0,
    weight: 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: [],
    raw: { resolve: () => undefined },
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: (request: Request) =>
        Promise.resolve(
          new URL(request.url).pathname.endsWith('/hangup')
            ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response('v=0\r\na=answer\r\n', {
                status: 201,
                headers: {
                  'content-type': 'application/sdp',
                  location: 'https://api.openai.com/v1/realtime/calls/call_abc',
                },
              }),
        ),
      dial: () => Promise.reject(new Error('not dialed in this test')),
    },
  } as unknown as RuntimeProviderInput;
}
```

- [ ] **Step 2: Run it**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/realtime.test.ts
```

Expected: PASS, `0 fail`. If the `apiKeys` config shape rejects `[{ key }]`, read
`packages/types/src/config/server.ts` for the authored shape and use it verbatim — do not weaken the
test to skip authentication.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/realtime/realtime.test.ts
git commit -m "test(server): cover realtime route composition, ownership, and the unsupported set"
```

---

## Task 11: Production WebSocket wiring and the byte-exact relay proof

**Files:**
- Modify: `packages/server/src/server/server.ts` (re-export `websocket`)
- Modify: `packages/server/src/server/index.ts:1-2`
- Modify: `packages/server/src/index.ts:1-6`
- Modify: `packages/cli/src/run/run.ts:161-169`
- Create: `packages/server/src/routes/realtime/sideband.upgrade.test.ts`

**Interfaces:**
- Consumes: everything from Task 9; `websocket` from `hono/bun`.
- Produces: `websocket` re-exported from `@aio-proxy/server`. `createServer` returns
  `Object.assign(routes, { close })`, so `websocket` cannot ride on the app object — it is a separate
  module-level export.

- [ ] **Step 1: Write the failing upgrade test**

`app.request()` never goes through `server.upgrade`, so only a real `Bun.serve` can prove the
production path. Create `packages/server/src/routes/realtime/sideband.upgrade.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { cleanupServerTestLifecycle, createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInput } from '../../runtime';
import { websocket } from '../../server';

afterEach(cleanupServerTestLifecycle);

test('a real Bun.serve upgrade relays every framing at exact byte length', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open: (ws) => ws.send('greeting'),
      // Echo the exact byte length back so the assertion is on the wire, not on
      // our own bookkeeping.
      message: (ws, message) => ws.send(typeof message === 'string' ? message : `bytes:${message.byteLength}`),
    },
  });

  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider(`ws://localhost:${upstream.port}`)],
  });
  const proxy = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket: { ...websocket, idleTimeout: 255 },
  });

  try {
    const create = await fetch(`http://localhost:${proxy.port}/v1/live`, {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'application/sdp' },
    });
    expect(create.status).toBe(201);
    expect(create.headers.get('location')).toBe('/v1/live/call_abc');

    const client = new WebSocket(`ws://localhost:${proxy.port}/v1/live/call_abc`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('error', () => reject(new Error('the proxy refused the upgrade')));
      client.addEventListener('message', (event: MessageEvent<string>) => {
        received.push(event.data);
        if (received.length === 5) resolve();
      });
      client.addEventListener('open', () => {
        client.send('text frame');
        // One frame per write, then many frames in a single write, then a large
        // frame. All three must arrive with their exact byte length.
        client.send(new Uint8Array(7));
        client.send(new Uint8Array(3));
        client.send(new Uint8Array(200_000));
      });
      setTimeout(() => reject(new Error(`only received ${received.length} frames: ${received.join(', ')}`)), 5_000);
    });

    expect(received).toEqual(['greeting', 'text frame', 'bytes:7', 'bytes:3', 'bytes:200000']);
    client.close(1000);
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});

function realtimeProvider(base: string): RuntimeProviderInput {
  return {
    id: 'codex',
    kind: ProviderKind.OAuth,
    enabled: true,
    priority: 0,
    weight: 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: [],
    raw: { resolve: () => undefined },
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: () =>
        Promise.resolve(
          new Response('v=0\r\na=answer\r\n', {
            status: 201,
            headers: {
              'content-type': 'application/sdp',
              location: 'https://api.openai.com/v1/realtime/calls/call_abc',
            },
          }),
        ),
      dial: () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(base);
          socket.addEventListener('open', () => resolve(socket));
          socket.addEventListener('error', () => reject(new Error('dial failed')));
        }),
    },
  } as unknown as RuntimeProviderInput;
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/sideband.upgrade.test.ts
```

Expected: FAIL — `websocket` is not exported from `../../server`.

- [ ] **Step 3: Re-export `websocket`**

Add to `packages/server/src/server/server.ts`, near the other imports:

```ts
export { websocket } from 'hono/bun';
```

`createServer` returns `Object.assign(routes, { close() {…} })`, so this must be a module-level
re-export rather than a field on the app. Note that Hono's exported `websocket` is a module singleton
shared by every importer — never mutate it.

`packages/server/src/server/index.ts`:

```ts
export type { AppType, CreateServerOptions } from './server';
export { createServer, serverDefaults, websocket } from './server';
```

`packages/server/src/index.ts`:

```ts
export type { DashboardAssets } from './dashboard-assets';
export { directoryDashboardAssets } from './dashboard-assets';
export type { AppType, CreateServerOptions } from './server';
export { createServer, serverDefaults, websocket } from './server';
export type { ServerLog, ServerLogSink } from './server-log';
export { redactSecrets } from './dashboard-routes/provider-secrets';
```

- [ ] **Step 4: Run the upgrade test**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/realtime/sideband.upgrade.test.ts
```

Expected: PASS, `0 fail`.

- [ ] **Step 5: Pass the handler to the production `Bun.serve`**

In `packages/cli/src/run/run.ts`, add the import:

```ts
import { websocket } from '@aio-proxy/server';
```

and extend the `Bun.serve` call. `fetch: app.fetch` must keep receiving Bun's second argument —
`upgradeWebSocket` reaches the server through `c.env`, so a wrapper that forwards only the request
would break every upgrade:

```ts
    server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 255,
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
      fetch: app.fetch,
      // The websocket handler has its OWN idleTimeout, defaulting to 120s, and
      // `idleTimeout: 255` above does not carry over to an upgraded socket. Hono's
      // `websocket` is a shared module singleton, so it is spread rather than
      // mutated. `sendPings` stays at its default `true` so keepalive resets it.
      websocket: { ...websocket, idleTimeout: 255 },
    });
```

- [ ] **Step 6: Verify the CLI still builds and its tests pass**

```bash
cd packages/cli && bun run test:unit
```

Expected: PASS, `0 fail`.

```bash
bun run check
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server/server.ts packages/server/src/server/index.ts packages/server/src/index.ts packages/server/src/routes/realtime/sideband.upgrade.test.ts packages/cli/src/run/run.ts
git commit -m "feat(cli): pass the Bun websocket handler to the production server"
```

---

## Task 12: Proxy-aware dial coverage and the changeset

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/realtime.proxy.test.ts`
- Create: `.changeset/codex-realtime-endpoints.md`

**Interfaces:**
- Consumes: `createOpenAIChatGPTRealtime` from Task 3.
- Produces: no new exports.

- [ ] **Step 1: Write the failing proxy test**

A silently ignored `proxy` option would send sideband traffic direct while signaling went through the
configured proxy — exactly the leak the design exists to prevent. Create
`packages/plugins/openai-chatgpt/src/runtime/realtime.proxy.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { createOpenAIChatGPTRealtime } from './realtime';

test('a dial through a configured proxy issues CONNECT rather than connecting direct', async () => {
  const connects: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
    websocket: { open: (ws) => ws.send('ok'), message: () => {} },
  });

  // A minimal CONNECT proxy: record the target, then splice the two sockets.
  const proxy = Bun.listen<{ upstream?: import('bun').Socket }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: async (socket, chunk) => {
        const pending = socket.data.upstream;
        if (pending !== undefined) {
          pending.write(chunk);
          return;
        }
        const head = chunk.toString('utf8');
        const target = /^CONNECT (\S+)/u.exec(head)?.[1];
        if (target === undefined) {
          socket.end();
          return;
        }
        connects.push(target);
        const [host, port] = target.split(':');
        socket.data.upstream = await Bun.connect({
          hostname: host!,
          port: Number(port),
          socket: { data: (_upstream, response) => socket.write(response), close: () => socket.end() },
        });
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      },
      close: (socket) => socket.data.upstream?.end(),
      open: () => {},
    },
  });

  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: globalThis.fetch,
    proxy: `http://127.0.0.1:${proxy.port}`,
    createWebSocket: (url, options) => new WebSocket(url.replace('wss://', 'ws://'), options),
    baseUrl: `ws://localhost:${upstream.port}`,
  });

  try {
    const socket = await realtime.dial({
      style: 'live',
      callId: 'call_abc',
      headers: new Headers(),
      signal: new AbortController().signal,
    });
    expect(socket.readyState).toBe(1);
    socket.close(1000);
    expect(connects).toEqual([`localhost:${upstream.port}`]);
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});
```

Task 3's `RealtimeTransportOptions` already carries `createWebSocket?`; add a `baseUrl?: string`
field to it in this task if it is not there yet, defaulting to `OPENAI_REALTIME_WS_BASE`, and copy
`credential()` and `staticCredentialPort()` from `realtime.test.ts` into this file — a shared fixture
module is not worth one extra import for two five-line helpers.

- [ ] **Step 2: Run it**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts src/runtime/realtime.proxy.test.ts
```

Expected: PASS once `baseUrl` is threaded. If Bun ever drops `WebSocketOptions.proxy`, this test
fails loudly instead of the traffic quietly going direct — that is the whole point of it.

- [ ] **Step 3: Write the changeset**

A changeset targeting only internal packages produces an empty `aio-proxy` CHANGELOG entry and its
GitHub Release notes silently vanish, so the two product packages are listed first. Create
`.changeset/codex-realtime-endpoints.md`:

```markdown
---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/core': minor
'@aio-proxy/plugin-openai-chatgpt': minor
---

Serve the Codex Live / Realtime endpoint family as signaling passthrough. `POST /v1/live`,
`POST /v1/realtime`, and `POST /v1/realtime/calls` forward an SDP offer to the ChatGPT Codex
realtime upstream and answer with the upstream's SDP, with `Location` rewritten to a proxy path.
`GET /v1/live/:call_id`, `GET /v1/realtime/calls/:call_id`, and `GET /v1/realtime` relay the
sideband WebSocket, and `POST /v1/realtime/calls/:call_id/hangup` ends a call through the same
upstream account that created it. WebRTC media is not relayed — the media plane stays a direct
client-to-upstream connection.

Plugins can now expose an optional `realtime` runtime capability (`models`, `fetch`, `dial`) and
receive the effective outbound proxy on their `RuntimeContext`, so a sideband dial honors the same
proxy configuration as ordinary requests. Realtime endpoints the ChatGPT upstream has no equivalent
for (`client_secrets`, `sessions`, `transcription_sessions`, `translations`, `accept`, `reject`,
`refer`) answer `501` with a diagnosable error code instead of `404`.
```

- [ ] **Step 4: Run the full preflight**

```bash
bun run preflight
```

Expected: `oxlint`, `oxfmt --check`, and every package's unit tests pass. `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/openai-chatgpt/src/runtime .changeset/codex-realtime-endpoints.md
git commit -m "test(plugin-openai-chatgpt): assert the realtime dial honors the outbound proxy"
```

