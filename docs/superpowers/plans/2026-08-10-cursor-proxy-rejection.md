# Cursor Proxy Rejection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cursor fail explicitly whenever an effective HTTP(S) provider proxy exists, while reporting every standard AI SDK generation setting that Cursor currently ignores.

**Architecture:** Add one optional `supportsProxy?: boolean` flag to the existing OAuth adapter contract and preserve it through registry validation. Core login and server runtime orchestration enforce `supportsProxy === false` using their existing config/effective-proxy inputs; Cursor never receives proxy URLs or credentials for this decision. Cursor generation keeps its current protobuf request and adds only AI SDK V4 unsupported warnings.

**Tech Stack:** Bun 1.3.14, TypeScript, Bun test, Zod, AI SDK Provider V4, Paraglide i18n, Changesets.

## Global Constraints

- Work only in `/Volumes/ExternalSSD/workspace/aio-proxy-pr119-fix` on `codex/cursor-oauth-spec`; do not rewrite or force-push history.
- This is temporary option C for PR #119: reject Cursor when an effective proxy exists. Do not implement HTTP CONNECT, TLS ALPN, HTTP/2 tunneling, raw sockets, or a new dependency.
- Provider proxy resolution is exact: a provider URL overrides global; omitted inherits global; `false` disables inheritance; mutation `null` clears the provider override and resumes inheritance.
- Existing adapters with no `supportsProxy` property retain current behavior. Only `supportsProxy === false` activates rejection.
- Rejection code is exactly `PROXY_UNSUPPORTED`, is non-retryable, and must not expose proxy URLs or proxy credentials in errors, diagnostics, or plugin inputs.
- Cursor must warn for supplied `maxOutputTokens`, `temperature`, `stopSequences`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `seed`, JSON `responseFormat`, and non-default `reasoning`.
- Preserve the existing `toolChoice: required` warning. Do not warn for text `responseFormat` or `reasoning: 'provider-default'`.
- Follow RED → GREEN for every behavior change. Use existing modules and test seams; do not add an abstraction or dependency for future full proxy support.
- Prefix every shell command with `rtk`.
- Do not reply to or resolve GitHub review threads in this implementation.
- Every commit must end with `Co-authored-by: Codex <noreply@openai.com>`.
- Before completion run focused affected tests, Cursor unit/build, `bun run check`, the complete unit suite, and `bun run preflight`.

---

## File Map

- `packages/plugin-sdk/src/oauth.ts`: public OAuth adapter proxy capability metadata.
- `packages/plugin-sdk/src/oauth.types.ts`: compile-time SDK contract examples and rejection of invalid metadata.
- `packages/core/src/plugins/registry.ts`: trust-boundary validation and preservation of `supportsProxy`.
- `packages/core/src/plugins/registry-adapter-validation.test.ts`: invalid metadata rejection and false-value preservation.
- `packages/types/src/plugin.ts` and `packages/types/src/plugin.test.ts`: stable `PROXY_UNSUPPORTED` diagnostic code.
- `packages/core/src/plugins/diagnostic/diagnostic.ts` and `packages/core/src/plugins/diagnostic/factory.test.ts`: localized, identifier-only runtime diagnostic.
- `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`: CLI login and runtime diagnostic copy.
- `packages/core/src/plugins/account-login/login/preflight.ts`: effective-proxy boolean resolution from authored config and mutation semantics.
- `packages/core/src/plugins/account-login/{errors.ts,index.ts,login.ts}`: typed login rejection before form rendering, authorization, and catalog discovery.
- `packages/core/src/plugins/account-login/test-support.ts` and new `proxy-unsupported.test.ts`: core login regressions for inherited, overridden, disabled, and cleared proxies.
- `packages/server/src/plugin-runtime/{materialize.ts,materialize.test.ts,test-support.ts}`: runtime unavailability before catalog job/runtime construction.
- `packages/server/src/oauth-login-session/manager.test.ts`: Dashboard session exposes the stable failure code.
- `packages/cli/src/plugin-commands/provider-login/{presentation.ts,presentation.test.ts}`: localized CLI presentation.
- `packages/plugins/cursor/src/{plugin.ts,plugin.test.ts}`: Cursor declares `supportsProxy: false`.
- `packages/plugins/cursor/src/runtime/{cursor-model.ts,cursor-model.test.ts}`: exact unsupported-setting warnings for stream and generate calls.
- `.changeset/real-ties-crash.md`: extend the existing PR release note; do not add another changeset.

---

### Task 1: Add the SDK, registry, diagnostic, and localization contract

**Files:**

- Modify: `packages/plugin-sdk/src/oauth.ts`
- Modify: `packages/plugin-sdk/src/oauth.types.ts`
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/registry-adapter-validation.test.ts`
- Modify: `packages/types/src/plugin.ts`
- Modify: `packages/types/src/plugin.test.ts`
- Modify: `packages/core/src/plugins/diagnostic/diagnostic.ts`
- Modify: `packages/core/src/plugins/diagnostic/factory.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`

**Interfaces:**

- Consumes: existing `OAuthAdapter`, `DiagnosticCodeSchema`, and `DiagnosticFactory` contracts.
- Produces: `OAuthAdapter.supportsProxy?: boolean`; `DiagnosticCode` accepts `PROXY_UNSUPPORTED`; `createPluginDiagnosticFactory` produces a localized provider-only summary for that code.

- [ ] **Step 1: Write compile-time and runtime contract regressions**

In `packages/plugin-sdk/src/oauth.types.ts`, add one valid false declaration and one invalid declaration:

```ts
const proxyUnsupportedAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  ...quotaAdapter,
  id: 'proxy-unsupported',
  supportsProxy: false,
};
api.oauth.register(proxyUnsupportedAdapter);

// @ts-expect-error supportsProxy only accepts booleans
const invalidProxySupport: OAuthAdapter<MyOptions, MyCredential> = { ...quotaAdapter, supportsProxy: 'false' };
void invalidProxySupport;
```

In the invalid table in `packages/core/src/plugins/registry-adapter-validation.test.ts`, add:

```ts
['non-boolean proxy support', fakeAdapter('proxy-support-invalid', { supportsProxy: 'false' })],
```

Then add this preservation test to the same file:

```ts
test('preserves an explicit false proxy capability', async () => {
  const packageName = '@example/proxy-support';
  const snapshot = await loadPluginRegistry({
    ...base,
    builtIns: [
      {
        packageName,
        version: '1.0.0',
        descriptor: definePlugin((api) => api.oauth.register(fakeAdapter('default', { supportsProxy: false }))),
      },
    ],
    enablements: [{ packageName }],
    importPackage: async () => {
      throw new Error('must not import');
    },
  });

  expect(snapshot.registry.resolveOAuth(packageName, 'default')?.supportsProxy).toBe(false);
});
```

Add `'PROXY_UNSUPPORTED'` immediately before `'RUNTIME_CREATE_FAILED'` in the `diagnosticCodes` tuple in `packages/types/src/plugin.test.ts`.

Add this test to `packages/core/src/plugins/diagnostic/factory.test.ts`:

```ts
test('renders proxy rejection with the provider ID only', () => {
  const diagnostic = createPluginDiagnosticFactory(() => 123)('PROXY_UNSUPPORTED', {
    plugin: '@aio-proxy/plugin-cursor',
    capability: 'default',
    providerId: 'cursor-personal',
    retryable: false,
  });

  expect(diagnostic).toEqual({
    code: 'PROXY_UNSUPPORTED',
    occurredAt: new Date(123).toISOString(),
    retryable: false,
    summary: 'Provider cursor-personal does not support the configured proxy',
  });
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun test packages/core/src/plugins/registry-adapter-validation.test.ts packages/types/src/plugin.test.ts packages/core/src/plugins/diagnostic/factory.test.ts
```

Expected:

- SDK type test fails because `supportsProxy` is not an `OAuthAdapter` property.
- Registry preservation fails because validation currently drops the property; the invalid-string case is currently accepted.
- Types rejects `PROXY_UNSUPPORTED`.
- Diagnostic factory has no switch branch/localized message for `PROXY_UNSUPPORTED`.

- [ ] **Step 3: Add the minimal SDK and registry implementation**

Add this optional field after `description` in `OAuthAdapter` in `packages/plugin-sdk/src/oauth.ts`:

```ts
readonly supportsProxy?: boolean;
```

In `validateAdapter` in `packages/core/src/plugins/registry.ts`, destructure the field, validate it in the existing trust-boundary branch, and preserve it without inventing a default:

```ts
const {
  id: rawId,
  displayName,
  description,
  supportsProxy,
  account,
  credentials,
  login,
  createRuntime,
  catalog,
  quota,
} = value;
if (supportsProxy !== undefined && typeof supportsProxy !== 'boolean') throw new Error('Invalid OAuth adapter');
```

Add the property to the bound adapter object beside `description`:

```ts
...(supportsProxy === undefined ? {} : { supportsProxy }),
```

- [ ] **Step 4: Add the stable diagnostic and exact translations**

Add `'PROXY_UNSUPPORTED'` immediately before `'RUNTIME_CREATE_FAILED'` in `DiagnosticCodeSchema` in `packages/types/src/plugin.ts`.

Add this switch branch in `packages/core/src/plugins/diagnostic/diagnostic.ts`:

```ts
case 'PROXY_UNSUPPORTED':
  return m['cli.plugin.diagnostic_proxy_unsupported']({ provider });
```

Add the following exact keys in all five locale files:

| Locale | `cli.provider.login.error_proxy_unsupported` | `cli.plugin.diagnostic_proxy_unsupported` |
| --- | --- | --- |
| `en` | `OAuth capability {reference} does not support the configured proxy` | `Provider {provider} does not support the configured proxy` |
| `zh-Hans` | `OAuth 能力 {reference} 不支持当前配置的代理` | `提供商 {provider} 不支持当前配置的代理` |
| `zh-Hant` | `OAuth 能力 {reference} 不支援目前設定的代理` | `提供商 {provider} 不支援目前設定的代理` |
| `ja` | `OAuth ケイパビリティ {reference} は設定されたプロキシをサポートしていません` | `プロバイダー {provider} は設定されたプロキシをサポートしていません` |
| `ko` | `OAuth 기능 {reference}은(는) 구성된 프록시를 지원하지 않습니다` | `프로바이더 {provider}은(는) 구성된 프록시를 지원하지 않습니다` |

Place the login key beside `error_capability_unavailable` and the diagnostic key beside `diagnostic_runtime_create_failed`. Do not edit generated `packages/i18n/src/paraglide/*`; the directory is generated and ignored.

- [ ] **Step 5: Compile i18n and confirm GREEN**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/plugin-sdk test:types
rtk bun test packages/core/src/plugins/registry-adapter-validation.test.ts packages/types/src/plugin.test.ts packages/core/src/plugins/diagnostic/factory.test.ts
```

Expected: all commands pass; generated Paraglide files remain ignored.

- [ ] **Step 6: Commit the contract**

Run:

```bash
rtk git add packages/plugin-sdk/src/oauth.ts packages/plugin-sdk/src/oauth.types.ts packages/core/src/plugins/registry.ts packages/core/src/plugins/registry-adapter-validation.test.ts packages/types/src/plugin.ts packages/types/src/plugin.test.ts packages/core/src/plugins/diagnostic/diagnostic.ts packages/core/src/plugins/diagnostic/factory.test.ts packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/messages/zh-Hant.json packages/i18n/messages/ja.json packages/i18n/messages/ko.json
rtk git commit -m "feat(plugin-sdk): declare OAuth proxy support" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Reject proxy-unsupported adapters in login and runtime orchestration

**Files:**

- Modify: `packages/core/src/plugins/account-login/errors.ts`
- Modify: `packages/core/src/plugins/account-login/index.ts`
- Modify: `packages/core/src/plugins/account-login/login/preflight.ts`
- Modify: `packages/core/src/plugins/account-login/login.ts`
- Modify: `packages/core/src/plugins/account-login/test-support.ts`
- Create: `packages/core/src/plugins/account-login/proxy-unsupported.test.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/plugin-runtime/test-support.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.test.ts`
- Modify: `packages/server/src/oauth-login-session/manager.test.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/presentation.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/presentation.test.ts`
- Modify: `packages/plugins/cursor/src/plugin.ts`
- Modify: `packages/plugins/cursor/src/plugin.test.ts`

**Interfaces:**

- Consumes: `OAuthAdapter.supportsProxy?: boolean` and diagnostic code `PROXY_UNSUPPORTED` from Task 1; existing `MaterializePluginProviderOptions.effectiveProxy?: string | null`.
- Produces: `OAuthProxyUnsupportedError` with message `PROXY_UNSUPPORTED`; login `Preflight.hasEffectiveProxy: boolean`; Cursor declares `supportsProxy: false`; runtime returns `ProviderState { status: 'unavailable' }` with a non-retryable diagnostic and no catalog job/runtime.

- [ ] **Step 1: Extend only the existing test fixtures needed by the regressions**

In `packages/core/src/plugins/account-login/test-support.ts`, extend `AdapterControls` and the registered adapter:

```ts
readonly supportsProxy?: boolean;
```

```ts
...(controls.supportsProxy === undefined ? {} : { supportsProxy: controls.supportsProxy }),
```

In `packages/server/src/plugin-runtime/test-support.ts`, add these optional overrides:

```ts
readonly supportsProxy?: boolean;
readonly discover?: OAuthAdapter['catalog']['discover'];
```

Preserve them in the registered adapter without changing defaults:

```ts
...(overrides.supportsProxy === undefined ? {} : { supportsProxy: overrides.supportsProxy }),
```

```ts
discover: overrides.discover ?? (async () => fixtureCatalog ?? catalog),
```

- [ ] **Step 2: Write core login proxy-resolution regressions**

Create `packages/core/src/plugins/account-login/proxy-unsupported.test.ts` with these tests:

```ts
import { OAuthProxyUnsupportedError } from '.';
import {
  authorization,
  createAccount,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  registry,
  test,
} from './test-support';

type ProxySetup = { readonly global?: string; readonly provider?: string | false };

async function configureProxy(state: ReturnType<typeof fixture>, setup: ProxySetup): Promise<void> {
  await state.config.replace((current) => {
    const providers = current['providers'] as Record<string, Record<string, unknown>>;
    const person = { ...providers['person'] };
    if (setup.provider === undefined) delete person['proxy'];
    else person['proxy'] = setup.provider;
    const next: Record<string, unknown> = { ...current, providers: { ...providers, person } };
    if (setup.global !== undefined) next['proxy'] = setup.global;
    return next;
  });
}

test.each([
  ['an inherited global proxy', { global: 'https://global.example:8443' }, undefined],
  ['a provider proxy', { provider: 'https://provider.example:8443' }, undefined],
  ['a cleared false override that resumes inheritance', { global: 'https://global.example:8443', provider: false }, null],
] as const)('rejects %s before form, authorization, login, or catalog work', async (_name, setup, patchProxy) => {
  const state = fixture();
  await createAccount(state);
  await configureProxy(state, setup);
  const calls = { render: 0, authorization: 0, login: 0, discover: 0 };
  const attempt = loginOAuthAccount(
    options(state, {
      targetProviderId: 'person',
      capability: undefined,
      registry: registry({
        supportsProxy: false,
        login: async () => {
          calls.login++;
          throw new Error('login must not run');
        },
        discover: async () => {
          calls.discover++;
          return emptyCatalog();
        },
      }),
      renderAccountOptions: async () => {
        calls.render++;
        return { publicValues: {}, secrets: {} };
      },
      createAuthorization: () => {
        calls.authorization++;
        return authorization;
      },
      ...(patchProxy === undefined
        ? {}
        : {
            providerPatch: {
              name: undefined,
              enabled: true,
              weight: undefined,
              proxy: patchProxy,
              alias: undefined,
            },
          }),
    }),
  );

  await expect(attempt).rejects.toBeInstanceOf(OAuthProxyUnsupportedError);
  await expect(attempt).rejects.toThrow('PROXY_UNSUPPORTED');
  expect(calls).toEqual({ render: 0, authorization: 0, login: 0, discover: 0 });
});

test('proxy false disables inherited global proxy and permits login', async () => {
  const state = fixture();
  await createAccount(state);
  await configureProxy(state, { global: 'https://global.example:8443', provider: false });
  const calls = { login: 0, discover: 0 };

  const result = await loginOAuthAccount(
    options(state, {
      targetProviderId: 'person',
      capability: undefined,
      registry: registry({
        supportsProxy: false,
        login: async () => {
          calls.login++;
          return { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: { token: 'new' } };
        },
        discover: async () => {
          calls.discover++;
          return emptyCatalog();
        },
      }),
    }),
  );

  expect(result).toEqual({ providerId: 'person' });
  expect(calls).toEqual({ login: 1, discover: 1 });
});
```

- [ ] **Step 3: Write runtime, Dashboard, CLI, and Cursor declaration regressions**

Add this test to `packages/server/src/plugin-runtime/materialize.test.ts`:

```ts
test('a proxy-unsupported adapter is unavailable before catalog or runtime work', async () => {
  let discoveries = 0;
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: null,
      supportsProxy: false,
      discover: async () => {
        discoveries++;
        throw new Error('catalog discovery must not run');
      },
    },
  );
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: 'https://proxy-user:proxy-password@proxy.example:8443',
  });

  expect(result.provider).toBeUndefined();
  expect(result.catalogJob).toBeUndefined();
  expect(result.state).toMatchObject({
    status: 'unavailable',
    diagnostic: { code: 'PROXY_UNSUPPORTED', retryable: false },
  });
  expect(fixture.createCalls()).toBe(0);
  expect(discoveries).toBe(0);
  expect(JSON.stringify(result)).not.toContain('proxy-password');
  expect(JSON.stringify(result)).not.toContain('proxy.example');
});

test('a proxy-unsupported adapter remains available without an effective proxy', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { supportsProxy: false });
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: null,
  });

  expect(result.state).toMatchObject({ status: 'ready' });
  expect(result.provider).toBeDefined();
  expect(fixture.createCalls()).toBe(1);
});
```

Append this Dashboard-session test to `packages/server/src/oauth-login-session/manager.test.ts`:

```ts
test('a proxy-unsupported adapter fails a Dashboard session with the stable code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-proxy-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ proxy: 'https://proxy.example:8443', plugins: [], providers: {} }));
  const database = openDb({ home: dir });
  const repository = createPluginRepository(database.sqlite);
  const host = createPluginRegistryHost();
  const staging = host.stage('@example/oauth');
  let loginCalls = 0;
  staging.api.oauth.register({
    id: 'default',
    displayName: 'Example OAuth',
    supportsProxy: false,
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      loginCalls++;
      throw new Error('login must not run');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        throw new Error('catalog must not run');
      },
    },
    async createRuntime() {
      throw new Error('runtime must not run');
    },
  });
  staging.seal();
  staging.commit();
  const finished = Promise.withResolvers<void>();
  const manager = createOAuthLoginSessionManager({
    configFile: new AtomicConfigFile(configPath),
    repository,
    acquireRegistry: () => ({ registry: host.registry, release: () => finished.resolve() }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    coordinateProviderCommit: (_capability, commit) => commit(),
    validateProviderCommit: () => {},
    reload: async () => {},
  });

  try {
    const session = manager.start({
      capability: { plugin: '@example/oauth', capability: 'default' },
      publicValues: {},
      secrets: {},
      clearSecrets: [],
    });
    await finished.promise;
    expect(manager.get(session.id)).toMatchObject({ status: 'failed', code: 'PROXY_UNSUPPORTED' });
    expect(loginCalls).toBe(0);
  } finally {
    manager.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

In `packages/cli/src/plugin-commands/provider-login/presentation.test.ts`, import `OAuthProxyUnsupportedError` and add:

```ts
test('localizes proxy rejection without exposing a proxy URL', async () => {
  const state = scope.fixture();
  state.deps = {
    ...state.deps,
    login: async () => {
      throw new OAuthProxyUnsupportedError('@a/one', 'unique');
    },
  };

  await expect(providerLogin('unique', {}, state.deps)).rejects.toThrow(
    'OAuth capability @a/one#unique does not support the configured proxy',
  );
});
```

In the existing Cursor descriptor test in `packages/plugins/cursor/src/plugin.test.ts`, add:

```ts
expect(adapter.supportsProxy).toBe(false);
```

- [ ] **Step 4: Run the focused tests and confirm RED**

Run:

```bash
rtk bun run i18n:compile
rtk bun test packages/core/src/plugins/account-login/proxy-unsupported.test.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/oauth-login-session/manager.test.ts packages/cli/src/plugin-commands/provider-login/presentation.test.ts packages/plugins/cursor/src/plugin.test.ts
```

Expected: tests fail because `OAuthProxyUnsupportedError`, login/runtime guards, CLI presentation, and Cursor metadata do not exist.

- [ ] **Step 5: Add the typed login error and effective-proxy boolean**

Add this class to `packages/core/src/plugins/account-login/errors.ts` and export it from `packages/core/src/plugins/account-login/index.ts`:

```ts
export class OAuthProxyUnsupportedError extends Error {
  override readonly name = 'OAuthProxyUnsupportedError';
  constructor(
    readonly plugin: string,
    readonly capability: string,
  ) {
    super('PROXY_UNSUPPORTED');
  }
}
```

Add `OAuthProxyUnsupportedError` to the existing `./errors` import in `packages/core/src/plugins/account-login/login.ts`.

In `packages/core/src/plugins/account-login/login/preflight.ts`, add the private resolver:

```ts
function hasEffectiveProxy(
  current: Readonly<Record<string, unknown>>,
  entry: Readonly<Record<string, unknown>> | null,
  patch: LoginOAuthAccountOptions['providerPatch'],
): boolean {
  const configuredProxy = entry?.['proxy'];
  const providerProxy = patch?.proxy === null ? undefined : (patch?.proxy ?? configuredProxy);
  if (providerProxy === false) return false;
  return typeof providerProxy === 'string' || typeof current['proxy'] === 'string';
}
```

Add this field to `Preflight`:

```ts
readonly hasEffectiveProxy: boolean;
```

For a new provider, read the config before returning so global/patch proxy state is known:

```ts
const current = await options.config.read();
signal.throwIfAborted();
return {
  capability: options.capability,
  hasEffectiveProxy: hasEffectiveProxy(current, null, options.providerPatch),
  publicOptions: {},
  secrets: {},
};
```

For a target provider, include this property in the existing transaction result after `entry` is validated:

```ts
hasEffectiveProxy: hasEffectiveProxy(current, entry, options.providerPatch),
```

Immediately after resolving the adapter in `packages/core/src/plugins/account-login/login.ts`, reject before form rendering and authorization:

```ts
if (adapter.supportsProxy === false && initial.hasEffectiveProxy) {
  throw new OAuthProxyUnsupportedError(initial.capability.plugin, initial.capability.capability);
}
```

- [ ] **Step 6: Add the runtime guard and Cursor declaration**

In `packages/server/src/plugin-runtime/materialize.ts`, move the existing proxy-identity resolution to immediately after account preparation:

```ts
let proxyIdentity = options.effectiveProxy;
if (proxyIdentity === undefined) proxyIdentity = config.proxy === false ? null : (config.proxy ?? null);
if (adapter.supportsProxy === false && proxyIdentity !== null) {
  return failure(options, 'PROXY_UNSUPPORTED', false, undefined, accountSummary);
}
```

Delete the old duplicate proxy-resolution lines near `runtimeIdentity`, and keep passing the already-resolved `proxyIdentity` to `digest`. This placement must occur before diagnostics/catalog reads, catalog-job construction, credential creation, and runtime creation.

Add this property beside `displayName` in `packages/plugins/cursor/src/plugin.ts`:

```ts
supportsProxy: false,
```

- [ ] **Step 7: Add CLI presentation**

Import `OAuthProxyUnsupportedError` in `packages/cli/src/plugin-commands/provider-login/presentation.ts` and add this branch before the generic capability-unavailable branch:

```ts
} else if (error instanceof OAuthProxyUnsupportedError) {
  const reference = safeCapability(error);
  return reference === null
    ? null
    : presentationError(m['cli.provider.login.error_proxy_unsupported']({ reference: canonical(reference) }));
```

No Dashboard production branch is needed: `OAuthProxyUnsupportedError.message` is the stable code and the existing session manager already publishes safe all-caps error messages.

- [ ] **Step 8: Run the focused tests and confirm GREEN**

Run:

```bash
rtk bun run i18n:compile
rtk bun test packages/core/src/plugins/account-login/proxy-unsupported.test.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/oauth-login-session/manager.test.ts packages/cli/src/plugin-commands/provider-login/presentation.test.ts packages/plugins/cursor/src/plugin.test.ts
rtk bun run check
```

Expected: all commands pass. The rejection tests prove no form, authorization, catalog, or runtime work starts and no proxy URL appears in output.

- [ ] **Step 9: Commit orchestration enforcement**

Run:

```bash
rtk git add packages/core/src/plugins/account-login/errors.ts packages/core/src/plugins/account-login/index.ts packages/core/src/plugins/account-login/login/preflight.ts packages/core/src/plugins/account-login/login.ts packages/core/src/plugins/account-login/test-support.ts packages/core/src/plugins/account-login/proxy-unsupported.test.ts packages/server/src/plugin-runtime/materialize.ts packages/server/src/plugin-runtime/test-support.ts packages/server/src/plugin-runtime/materialize.test.ts packages/server/src/oauth-login-session/manager.test.ts packages/cli/src/plugin-commands/provider-login/presentation.ts packages/cli/src/plugin-commands/provider-login/presentation.test.ts packages/plugins/cursor/src/plugin.ts packages/plugins/cursor/src/plugin.test.ts
rtk git commit -m "fix(cursor): reject configured proxies" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Report ignored Cursor generation settings and update the existing release note

**Files:**

- Modify: `packages/plugins/cursor/src/runtime/cursor-model.ts`
- Modify: `packages/plugins/cursor/src/runtime/cursor-model.test.ts`
- Modify: `.changeset/real-ties-crash.md`

**Interfaces:**

- Consumes: AI SDK `LanguageModelV4CallOptions` and `SharedV4Warning`.
- Produces: deterministic unsupported warnings in option-list order, followed by JSON response format, non-default reasoning, and existing required-tool-choice warnings. Stream and generate calls expose the same array.

- [ ] **Step 1: Write exact warning regressions**

Add this test to `packages/plugins/cursor/src/runtime/cursor-model.test.ts`:

```ts
test('reports every supplied standard setting that Cursor ignores', async () => {
  const { transport } = makeTransport();
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, new CursorSessionStore()));
  const options = callOptions();
  Object.assign(options, {
    maxOutputTokens: 123,
    temperature: 0,
    stopSequences: ['END'],
    topP: 0.8,
    topK: 20,
    presencePenalty: 0,
    frequencyPenalty: 0,
    seed: 0,
    responseFormat: { type: 'json', schema: { type: 'object' } },
    reasoning: 'high',
    tools: [{ type: 'function', name: 'search', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'required' },
  } satisfies Partial<LanguageModelV4CallOptions>);
  const expected = [
    { type: 'unsupported', feature: 'maxOutputTokens' },
    { type: 'unsupported', feature: 'temperature' },
    { type: 'unsupported', feature: 'stopSequences' },
    { type: 'unsupported', feature: 'topP' },
    { type: 'unsupported', feature: 'topK' },
    { type: 'unsupported', feature: 'presencePenalty' },
    { type: 'unsupported', feature: 'frequencyPenalty' },
    { type: 'unsupported', feature: 'seed' },
    { type: 'unsupported', feature: 'responseFormat' },
    { type: 'unsupported', feature: 'reasoning' },
    { type: 'unsupported', feature: 'toolChoice: required' },
  ];

  const streamed = await model.doStream(options);
  const first = await streamed.stream.getReader().read();
  expect(first.value).toMatchObject({ type: 'stream-start', warnings: expected });

  const generated = await model.doGenerate(options);
  expect(generated.warnings).toEqual(expected);
});
```

Add the default-preservation test:

```ts
test('does not warn for text format or provider-default reasoning', async () => {
  const { transport } = makeTransport();
  const model = createCursorLanguageModel('claude-4.5-sonnet', runtimeWith(transport, new CursorSessionStore()));
  const options = callOptions();
  options.responseFormat = { type: 'text' };
  options.reasoning = 'provider-default';

  const generated = await model.doGenerate(options);

  expect(generated.warnings).toEqual([]);
});
```

Keep the existing required-tool-choice test unchanged so its established warning remains independently protected.

- [ ] **Step 2: Run the Cursor model test and confirm RED**

Run:

```bash
rtk bun test packages/plugins/cursor/src/runtime/cursor-model.test.ts
```

Expected: the all-settings test receives only the existing `toolChoice: required` warning.

- [ ] **Step 3: Generate warnings without changing Cursor request behavior**

Import `LanguageModelV4CallOptions` in `packages/plugins/cursor/src/runtime/cursor-model.ts`, then add:

```ts
const unsupportedSettings = [
  'maxOutputTokens',
  'temperature',
  'stopSequences',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
] as const satisfies readonly (keyof LanguageModelV4CallOptions)[];

function unsupportedWarnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const feature of unsupportedSettings) {
    if (options[feature] !== undefined) warnings.push({ type: 'unsupported', feature });
  }
  if (options.responseFormat?.type === 'json') warnings.push({ type: 'unsupported', feature: 'responseFormat' });
  if (options.reasoning !== undefined && options.reasoning !== 'provider-default') {
    warnings.push({ type: 'unsupported', feature: 'reasoning' });
  }
  if (options.toolChoice?.type === 'required') {
    warnings.push({ type: 'unsupported', feature: 'toolChoice: required' });
  }
  return warnings;
}
```

Replace the current one-condition warning initialization in `doStream` with:

```ts
const warnings = unsupportedWarnings(options);
```

Do not map, clamp, emulate, or add the ignored settings to `buildCursorRunRequestBytes`.

- [ ] **Step 4: Confirm Cursor warning GREEN**

Run:

```bash
rtk bun test packages/plugins/cursor/src/runtime/cursor-model.test.ts
rtk bun run --filter @aio-proxy/plugin-cursor test:unit
rtk bun run --filter @aio-proxy/plugin-cursor build
```

Expected: all commands pass and both `doStream` and `doGenerate` return the exact warning list.

- [ ] **Step 5: Update the existing changeset instead of adding another one**

Replace `.changeset/real-ties-crash.md` with:

```md
---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/types': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/plugin-cursor': minor
---

Add Cursor account OAuth and provider support to the CLI, including embedded binary distribution, and expose SDK authorization-URL presentation and proxy-support capability metadata. Cursor now refuses configured proxies instead of bypassing them and reports ignored standard generation settings through AI SDK warnings.
```

Run:

```bash
rtk bun changeset status
```

Expected: Changesets accepts one lockstep minor release entry; no second changeset file is created.

- [ ] **Step 6: Commit warnings and release note**

Run:

```bash
rtk git add packages/plugins/cursor/src/runtime/cursor-model.ts packages/plugins/cursor/src/runtime/cursor-model.test.ts .changeset/real-ties-crash.md
rtk git commit -m "fix(cursor): report ignored generation settings" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Final Verification

- [ ] Compile generated local i18n output and run the public SDK tests:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/plugin-sdk test
```

- [ ] Run all affected package tests and Cursor build:

```bash
rtk bun run --filter @aio-proxy/plugin-cursor test:unit
rtk bun run --filter @aio-proxy/plugin-cursor build
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/cli test:unit
```

- [ ] Run repository checks and the complete unit suite:

```bash
rtk bun run check
rtk bun run test:unit
```

- [ ] Run the required release-grade preflight and inspect branch state:

```bash
rtk bun run preflight
rtk git status --short --branch
rtk git log -5 --oneline --decorate
```

Expected: all checks pass; the worktree is clean; the new commits are ahead of `origin/codex/cursor-oauth-spec`. Do not push until the implementation review has passed.

- [ ] After implementation review passes, update PR #119 with a normal push:

```bash
rtk git push origin codex/cursor-oauth-spec
```

Expected: `origin/codex/cursor-oauth-spec` advances without force-pushing. Do not reply to or resolve review threads.
