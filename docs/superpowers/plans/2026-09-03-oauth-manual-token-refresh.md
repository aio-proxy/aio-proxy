# OAuth Manual Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Refresh credential" item to the dashboard provider card's ⋯ menu for OAuth providers whose plugin can refresh, wired to a new control-plane endpoint that forces a token exchange regardless of expiry.

**Architecture:** A new optional `OAuthAdapter.refreshCredential` declares a *pure exchange* — the plugin turns a current credential into a new one; the framework owns the lease, single-flight, compare-and-swap and persistence via the existing `CredentialPort.refresh`. A new server service prepares a control-plane account context (extracted from the quota module so both features share one preparation path), drives the port, and — because `createCredentialPort` deliberately skips diagnostic-clearing and change callbacks in `control-plane` mode — clears `CREDENTIAL_REFRESH_FAILED` and triggers a snapshot rebuild itself. The adapter's declaration surfaces as a `canRefreshCredential` boolean on `DashboardProviderSummary`, mirroring the existing `hasQuota` capability flag, and the dashboard hides the menu item when it is false.

**Tech Stack:** Bun + Turborepo workspace, TypeScript, Zod v4 (`@aio-proxy/types`), Hono (server routes + typed `hc` client), React + TanStack Query (dashboard), `@aio-proxy/i18n` (Paraglide-style compiled messages), Changesets.

## Global Constraints

- Run `bun run preflight` (oxlint + oxfmt check + all unit tests) before considering the change complete; at minimum `bun run check` plus each touched package's tests.
- Domain language: **Provider ID**, **Provider priority**, **Provider weight**. Never "provider name/key/order/rank".
- Use `es-toolkit` (narrow imports) over hand-written generic utilities. `isPlainObject` from `es-toolkit/predicate` for plain data only; `isRecord` from `@aio-proxy/shared` for structural TS contracts.
- Colocate tests with source in a same-name directory (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`). Never add files to legacy `_test/` directories.
- Handwritten non-test implementation files: hard limit 500 lines, evaluate splitting at 400.
- `foo/index.ts` is export-only. Private modules in `foo/` must not be imported from outside `foo/`.
- i18n: add every key to all five `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json` **before** using it, then run `bun run i18n:compile`.
- Changesets must target a product package (`aio-proxy` and/or `@aio-proxy/plugin-sdk`) alongside any internal package, at the same bump level.
- Control-plane errors stay deliberately opaque: a caller must not learn whether the account exists, its options parsed, or its credential decrypted.
- Plugin errors reaching logs go through `redactPluginError(error, { secretValues })`.

---

## File Structure

**Create:**

- `packages/server/src/oauth-account-context/index.ts` — export-only barrel.
- `packages/server/src/oauth-account-context/oauth-account-context.ts` — capability-agnostic control-plane account preparation (moved out of `plugin-quota/context.ts`).
- `packages/server/src/oauth-account-context/errors.ts` — `OAuthAccountUnavailableError`.
- `packages/server/src/credential-refresh/index.ts` — export-only barrel.
- `packages/server/src/credential-refresh/credential-refresh.ts` — `createOAuthCredentialRefresher`.
- `packages/server/src/credential-refresh/errors.ts` — `OAuthCredentialRefreshError`.
- `packages/server/src/credential-refresh/credential-refresh.test.ts` — service behavior tests.
- `packages/server/src/dashboard-routes/provider-credential-refresh/index.ts` — export-only barrel.
- `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.ts` — the route.
- `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.test.ts` — route integration tests.
- `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/index.ts` — export-only barrel.
- `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/provider-credential-refresh-service.ts` — typed endpoint call.
- `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/index.ts` — export-only barrel.
- `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/use-provider-credential-refresh.ts` — mutation + toast + invalidate.
- `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.test.tsx` — menu gating tests.

**Modify:**

- `packages/plugin-sdk/src/oauth.ts` — add `OAuthCredentialRefreshContext`, `OAuthCredentialRefreshResult`, `OAuthAdapter.refreshCredential?`.
- `packages/server/src/plugin-quota/context.ts` — becomes a thin quota-specific wrapper over the shared context.
- `packages/server/src/plugin-quota/read.ts` — take the selected quota capability as a parameter.
- `packages/server/src/plugin-quota/reset.ts` — same.
- `packages/types/src/dashboard/dashboard.ts` — add `canRefreshCredential: z.boolean()`.
- `packages/server/src/plugin-account.ts` — carry `canRefreshCredential` on the preparation error.
- `packages/server/src/plugin-runtime/catalog.ts` — thread the flag through `summary()` / `failure()`.
- `packages/server/src/plugin-runtime/materialize.ts` — pass `adapter.refreshCredential !== undefined` at all call sites.
- `packages/server/src/server-state/snapshot.ts` — `canRefreshCredential: false` for invalid providers.
- `packages/server/src/provider-runtime/materialize.ts` — `canRefreshCredential: false` for non-OAuth providers.
- `packages/server/src/server-state/types.ts` / `index.ts` / `lifecycle.ts` — construct and expose `oauthCredentialRefresh`.
- `packages/server/src/dashboard-routes/config.ts` — mount the route.
- `packages/plugins/{cursor,github-copilot,google-antigravity,kimi-code,openai-chatgpt,xai-grok}/src/**/plugin.ts` — declare `refreshCredential`.
- `packages/dashboard/src/modules/providers/lib/provider-fixtures.ts` — add `canRefreshCredential: false` to the stub.
- `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.tsx` — the menu item.
- `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json` — three new keys each.
- `packages/server/src/model-routing/inventory.test.ts` — add the flag to its summary literal.

---

### Task 1: SDK refresh contract

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OAuthCredentialRefreshContext<Credential, AccountOptions>`, `OAuthCredentialRefreshResult<Credential>`, and `OAuthAdapter.refreshCredential?: (context: OAuthCredentialRefreshContext<Credential, AccountOptions>) => Promise<OAuthCredentialRefreshResult<Credential>>`. Re-exported by `packages/plugin-sdk/src/index.ts` via the existing `export * from './oauth';`.

This task adds types only. Per the repo testing rule, a test that merely restates a type declaration is not worth writing — the contract is exercised by Tasks 3, 6 and 7.

- [ ] **Step 1: Add the refresh context and result types**

In `packages/plugin-sdk/src/oauth.ts`, immediately after the `OAuthQuotaCapability` declaration (which ends with `readonly reset?: (context: AccountContext<AccountOptions, Credential>) => Promise<void>;`), insert:

```ts
/**
 * A manual credential refresh. The framework owns the distributed lease, single-flight dedupe,
 * revision compare-and-swap, and persistence; the adapter only performs the upstream exchange.
 * It is called even when the credential has not expired, so it must not short-circuit on expiry.
 */
export type OAuthCredentialRefreshContext<Credential, AccountOptions> = {
  readonly credential: Credential;
  readonly options: AccountOptions;
  readonly signal: AbortSignal;
  readonly fetch?: RuntimeFetch;
};

export type OAuthCredentialRefreshResult<Credential> = {
  readonly value: Credential;
  readonly metadata?: { readonly accountLabel?: string; readonly expiresAt?: number };
};
```

- [ ] **Step 2: Declare the adapter capability**

In the same file, in the `OAuthAdapter` type, add the field directly after `readonly quota?: OAuthQuotaCapability<AccountOptions, Credential>;`:

```ts
  readonly refreshCredential?: (
    context: OAuthCredentialRefreshContext<Credential, AccountOptions>,
  ) => Promise<OAuthCredentialRefreshResult<Credential>>;
```

- [ ] **Step 3: Verify the package still type-checks and tests pass**

Run: `bun run --filter @aio-proxy/plugin-sdk test`
Expected: PASS (both `test:unit` and `test:types`).

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-sdk/src/oauth.ts
git commit -m "feat(plugin-sdk): declare an optional OAuth credential refresh capability"
```

---

### Task 2: Extract a capability-agnostic control-plane account context

**Files:**
- Create: `packages/server/src/oauth-account-context/errors.ts`
- Create: `packages/server/src/oauth-account-context/oauth-account-context.ts`
- Create: `packages/server/src/oauth-account-context/index.ts`
- Modify: `packages/server/src/plugin-quota/context.ts`
- Modify: `packages/server/src/plugin-quota/read.ts`
- Modify: `packages/server/src/plugin-quota/reset.ts`

**Interfaces:**
- Consumes: `prepareOAuthPluginAccount` from `../plugin-account`, `createRuntimeFetch` from `../plugin-runtime`, `effectiveProxy` from `../provider-runtime`.
- Produces:
  - `OAuthAccountContextDependencies = { acquireSnapshot: () => ProviderSnapshotLease; repository: PluginRepository; diagnostics: DiagnosticFactory; logger: PluginLogSink; onDiagnosticChanged: () => void }`
  - `PreparedOAuthAccountContext = { adapter: OAuthAdapter; accountContext: AccountContext<unknown, unknown>; plugin: string; capability: string; providerId: string; secretValues: Set<string> }`
  - `OAuthAccountUnavailableError` with `code = 'OAUTH_ACCOUNT_UNAVAILABLE'` and `readonly permanent: boolean`
  - `withOAuthAccountContext<Capability, T>(dependencies, request: { providerId: string; signal: AbortSignal; select: (adapter: OAuthAdapter) => Capability | undefined }, operation: (prepared: PreparedOAuthAccountContext, capability: Capability) => Promise<T>): Promise<T>`
- `plugin-quota` keeps its existing public surface: `OAuthQuotaServiceDependencies`, `withOAuthQuotaContext`, `OAuthQuotaCapabilityUnavailableError`. Its three existing tests in `packages/server/src/plugin-quota/credential-refresh.test.ts` must keep passing unchanged.

- [ ] **Step 1: Run the existing quota tests to establish the green baseline**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/plugin-quota`
Expected: PASS. This is a pure refactor; these tests are the regression gate.

- [ ] **Step 2: Create the shared error**

Create `packages/server/src/oauth-account-context/errors.ts`:

```ts
export class OAuthAccountUnavailableError extends Error {
  readonly code = 'OAUTH_ACCOUNT_UNAVAILABLE';

  /**
   * `true` only when the plugin genuinely does not expose the requested capability, or the Provider
   * is not an OAuth Provider at all — neither can change without a config or plugin change. Every
   * other preparation failure (bad credentials, unreadable secrets, invalid account options)
   * surfaces as the same error so callers cannot probe the account, but stays transient.
   */
  constructor(readonly permanent = false) {
    super('OAuth account is unavailable');
    this.name = 'OAuthAccountUnavailableError';
  }
}
```

- [ ] **Step 3: Move the preparation logic into the shared module**

Create `packages/server/src/oauth-account-context/oauth-account-context.ts`. This is the body of the current `packages/server/src/plugin-quota/context.ts` with the quota-specific gate replaced by the `select` callback:

```ts
import {
  collectSecretStrings,
  createProxyFetch,
  type DiagnosticFactory,
  type PluginLogSink,
  type PluginRepository,
  withAbort,
} from '@aio-proxy/core';
import type { AccountContext, CredentialPort, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { type OAuthProvider, ProviderKind } from '@aio-proxy/types';

import { prepareOAuthPluginAccount } from '../plugin-account';
import { createRuntimeFetch } from '../plugin-runtime';
import { effectiveProxy } from '../provider-runtime';
import type { ProviderSnapshotLease } from '../runtime';
import type { Snapshot } from '../server-state/snapshot';
import { OAuthAccountUnavailableError } from './errors';

export type OAuthAccountContextDependencies = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PreparedOAuthAccountContext = {
  readonly adapter: OAuthAdapter;
  readonly accountContext: AccountContext<unknown, unknown>;
  readonly plugin: string;
  readonly capability: string;
  readonly providerId: string;
  readonly secretValues: Set<string>;
};

export type OAuthAccountContextRequest<Capability> = {
  readonly providerId: string;
  readonly signal: AbortSignal;
  /** Returning `undefined` means the plugin does not expose this capability: a permanent failure. */
  readonly select: (adapter: OAuthAdapter) => Capability | undefined;
};

function trackSecrets(secrets: Set<string>, value: unknown): void {
  for (const secret of collectSecretStrings(value)) secrets.add(secret);
}

function createTrackingCredentialPort(
  credentials: CredentialPort<unknown>,
  secrets: Set<string>,
): CredentialPort<unknown> {
  return {
    async read() {
      const snapshot = await credentials.read();
      trackSecrets(secrets, snapshot.value);
      return snapshot;
    },
    async refresh(expectedRevision, exchange) {
      const result = await credentials.refresh(expectedRevision, async (current, signal) => {
        trackSecrets(secrets, current.value);
        const exchanged = await exchange(current, signal);
        trackSecrets(secrets, exchanged.value);
        return exchanged;
      });
      trackSecrets(secrets, result.snapshot.value);
      return result;
    },
  };
}

function controlPlaneFetch(snapshot: Partial<Snapshot>, provider: OAuthProvider) {
  const cached = snapshot.runtimeCache?.get(provider.id)?.fetch;
  if (cached !== undefined) return cached;
  const control = createProxyFetch(effectiveProxy(snapshot.config?.proxy, provider.proxy));
  return createRuntimeFetch({ control, model: control });
}

async function prepareContext<Capability>(
  dependencies: OAuthAccountContextDependencies,
  lease: ProviderSnapshotLease,
  request: OAuthAccountContextRequest<Capability>,
): Promise<{ readonly prepared: PreparedOAuthAccountContext; readonly capability: Capability }> {
  const { providerId, signal } = request;
  try {
    const provider = lease.snapshot.config?.providers.find(({ id }) => id === providerId);
    if (provider?.kind !== ProviderKind.OAuth) {
      throw new OAuthAccountUnavailableError(true);
    }
    const pluginSecretValues = collectSecretStrings(dependencies.repository.readPluginSecret(provider.plugin)?.value);
    const prepared = await prepareOAuthPluginAccount({
      config: provider,
      plugins: lease.snapshot.plugins,
      repository: dependencies.repository,
      diagnostics: dependencies.diagnostics,
      logger: dependencies.logger,
      credentialMode: 'control-plane',
      onDiagnosticChanged: dependencies.onDiagnosticChanged,
      pluginSecretValues,
    });
    const capability = request.select(prepared.adapter);
    if (capability === undefined) {
      throw new OAuthAccountUnavailableError(true);
    }
    const secretValues = new Set(prepared.secretValues);
    const runtimeFetch = controlPlaneFetch(lease.snapshot as Partial<Snapshot>, provider);
    return {
      capability,
      prepared: {
        adapter: prepared.adapter,
        accountContext: {
          credentials: createTrackingCredentialPort(prepared.createCredentials(), secretValues),
          options: prepared.accountOptions,
          signal,
          fetch: runtimeFetch,
        },
        plugin: provider.plugin,
        capability: provider.capability,
        providerId,
        secretValues,
      },
    };
  } catch (error) {
    // Deliberately opaque: a caller must not learn whether the account exists, its options parsed,
    // or its credential decrypted. `permanent` is preserved so callers can still tell a plugin with
    // no such capability apart from an account that merely needs reauthentication.
    throw new OAuthAccountUnavailableError(error instanceof OAuthAccountUnavailableError && error.permanent);
  }
}

export async function withOAuthAccountContext<Capability, T>(
  dependencies: OAuthAccountContextDependencies,
  request: OAuthAccountContextRequest<Capability>,
  operation: (prepared: PreparedOAuthAccountContext, capability: Capability) => Promise<T>,
): Promise<T> {
  const lease = dependencies.acquireSnapshot();
  try {
    // The signal handed to the plugin is advisory, and both halves of this are plugin-controlled: the
    // account-options and credential schemas run through the plugin's own `safeParseAsync` during
    // preparation, then the operation itself. Either can stay pending forever, and `lease.release()`
    // hangs off whatever this awaits, so the race has to cover both or a hung plugin leaks the lease.
    return await withAbort(request.signal, async () => {
      const { prepared, capability } = await prepareContext(dependencies, lease, request);
      return await operation(prepared, capability);
    });
  } finally {
    lease.release();
  }
}
```

- [ ] **Step 4: Add the barrel**

Create `packages/server/src/oauth-account-context/index.ts`:

```ts
export * from './errors';
export * from './oauth-account-context';
```

- [ ] **Step 5: Reduce the quota context to a thin wrapper**

Replace the entire contents of `packages/server/src/plugin-quota/context.ts` with:

```ts
import type { OAuthAdapter, OAuthQuotaCapability } from '@aio-proxy/plugin-sdk';

import {
  OAuthAccountUnavailableError,
  type OAuthAccountContextDependencies,
  type PreparedOAuthAccountContext,
  withOAuthAccountContext,
} from '../oauth-account-context';
import { OAuthQuotaCapabilityUnavailableError } from './errors';

export type OAuthQuotaServiceDependencies = OAuthAccountContextDependencies;
export type PreparedOAuthQuotaContext = PreparedOAuthAccountContext;
export type OAuthQuotaCapabilityHandle = NonNullable<OAuthAdapter['quota']>;

export async function withOAuthQuotaContext<T>(
  dependencies: OAuthQuotaServiceDependencies,
  providerId: string,
  signal: AbortSignal,
  operation: (prepared: PreparedOAuthQuotaContext, quota: OAuthQuotaCapabilityHandle) => Promise<T>,
): Promise<T> {
  try {
    return await withOAuthAccountContext(
      dependencies,
      { providerId, signal, select: (adapter: OAuthAdapter) => adapter.quota },
      operation,
    );
  } catch (error) {
    // Preserve the quota module's own error identity — the cache latches on `permanent`.
    if (error instanceof OAuthAccountUnavailableError) {
      throw new OAuthQuotaCapabilityUnavailableError(error.permanent);
    }
    throw error;
  }
}

export type { OAuthQuotaCapability };
```

- [ ] **Step 6: Thread the selected capability through the quota reader**

In `packages/server/src/plugin-quota/read.ts`, change `readValidatedQuota` to take the capability and update the reader:

```ts
export async function readValidatedQuota(
  dependencies: OAuthQuotaServiceDependencies,
  prepared: PreparedOAuthQuotaContext,
  quota: OAuthQuotaCapabilityHandle,
  event: string,
): Promise<OAuthQuotaSnapshot> {
  try {
    const snapshot = await quota.read(prepared.accountContext);
    return validateOAuthQuotaSnapshot(snapshot);
  } catch (error) {
```

(the rest of the `catch` body is unchanged), and:

```ts
export function createOAuthQuotaReader(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaReader {
  return {
    read: (providerId, signal) =>
      withOAuthQuotaContext(dependencies, providerId, signal, (prepared, quota) =>
        readValidatedQuota(dependencies, prepared, quota, 'plugin.quota.read.failed'),
      ),
  };
}
```

Update the import line to `import { type OAuthQuotaCapabilityHandle, type OAuthQuotaServiceDependencies, type PreparedOAuthQuotaContext, withOAuthQuotaContext } from './context';`.

- [ ] **Step 7: Thread the selected capability through the quota resetter**

In `packages/server/src/plugin-quota/reset.ts`, replace the body of the `withOAuthQuotaContext` callback so it uses the handed-in capability instead of `prepared.adapter.quota`:

```ts
        withOAuthQuotaContext(dependencies, providerId, signal, async (prepared, quota) => {
          const reset = quota.reset?.bind(quota);
          if (reset === undefined) throw new OAuthQuotaResetUnsupportedError();
          const snapshot = await readValidatedQuota(dependencies, prepared, quota, 'plugin.quota.reset.preflight.failed');
```

The remainder of the callback (the `resetCredits` check, `signal.throwIfAborted()`, the `try`/`catch` around `reset(prepared.accountContext)`) is unchanged.

- [ ] **Step 8: Run the quota tests to verify the refactor is behavior-preserving**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/plugin-quota`
Expected: PASS, same test count as Step 1. In particular the three tests in `credential-refresh.test.ts` that assert `fixture.changed()` stays `0` must still pass.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/oauth-account-context packages/server/src/plugin-quota
git commit -m "refactor(server): extract a capability-agnostic control-plane OAuth account context"
```

---

### Task 3: Credential refresh service

**Files:**
- Create: `packages/server/src/credential-refresh/errors.ts`
- Create: `packages/server/src/credential-refresh/credential-refresh.ts`
- Create: `packages/server/src/credential-refresh/index.ts`
- Create: `packages/server/src/credential-refresh/credential-refresh.test.ts`

**Interfaces:**
- Consumes: `withOAuthAccountContext`, `OAuthAccountContextDependencies`, `OAuthAccountUnavailableError` (Task 2); `OAuthAdapter.refreshCredential` (Task 1).
- Produces:
  - `OAuthCredentialRefreshError` with `code = 'OAUTH_CREDENTIAL_REFRESH_FAILED'`
  - `OAuthCredentialRefreshOperations = { readonly refresh: (providerId: string, signal: AbortSignal) => Promise<void> }`
  - `createOAuthCredentialRefresher(dependencies: OAuthAccountContextDependencies): OAuthCredentialRefreshOperations`

Why the service clears the diagnostic itself: `packages/core/src/plugins/credential-port.ts:283` skips diagnostic-clearing and `onCredentialChanged()` whenever `mode === 'control-plane'`. A control-plane refresh that succeeded would otherwise leave a stale `CREDENTIAL_REFRESH_FAILED` on the Provider and never rebuild the snapshot, so the dashboard's re-fetched summary would show the old `accountLabel`/`expiresAt`. Doing it here keeps runtime semantics — and the three tests pinning them — untouched.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/credential-refresh/credential-refresh.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { createQuotaFixture, PROVIDER_ID, quotaSignal } from '../plugin-quota/test-support';
import { createOAuthCredentialRefresher } from './credential-refresh';
import { OAuthCredentialRefreshError } from './errors';
import { OAuthAccountUnavailableError } from '../oauth-account-context';

test('a manual refresh persists the exchanged credential and rebuilds the snapshot', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' }, metadata: { accountLabel: 'new@example.com' } }),
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: 'rotated' });
  expect(fixture.repository.readAccount(PROVIDER_ID)?.label).toBe('new@example.com');
  // The control-plane credential port skips its own change callback, so the service must fire one
  // or the dashboard's refetched summary would still carry the previous account label.
  expect(fixture.changed()).toBeGreaterThan(0);
});

test('a manual refresh clears a stale credential refresh diagnostic', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' } }),
  });
  fixture.repository.writeDiagnostic(
    PROVIDER_ID,
    fixture.dependencies.diagnostics('CREDENTIAL_REFRESH_FAILED', { providerId: PROVIDER_ID, retryable: false }),
  );
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  expect(
    fixture.repository.readDiagnostics(PROVIDER_ID).some((entry) => entry.code === 'CREDENTIAL_REFRESH_FAILED'),
  ).toBe(false);
});

test('a plugin without the refresh capability is a permanent failure', async () => {
  const fixture = createQuotaFixture();
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const error = await refresher.refresh(PROVIDER_ID, quotaSignal()).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(OAuthAccountUnavailableError);
  expect((error as OAuthAccountUnavailableError).permanent).toBe(true);
});

test('an upstream exchange failure is redacted and surfaced as a refresh error', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => {
      throw new Error('upstream rejected token stored-credential');
    },
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const error = await refresher.refresh(PROVIDER_ID, quotaSignal()).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(OAuthCredentialRefreshError);
  expect(JSON.stringify(fixture.logs)).not.toContain('stored-credential');
});
```

Also extend the fixture so it can register the capability. In `packages/server/src/plugin-quota/test-support.ts`:

1. Add to `QuotaFixtureOptions`:

```ts
  readonly refreshCredential?: (context: {
    readonly credential: unknown;
    readonly options: unknown;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly value: unknown; readonly metadata?: { readonly accountLabel?: string; readonly expiresAt?: number } }>;
```

2. In `buildQuotaAdapter`, after the `quota` spread, add:

```ts
    ...(options.refreshCredential === undefined ? {} : { refreshCredential: options.refreshCredential }),
```

3. Make the `credentials` schema tolerate the rotated value — the default `zod.object({ token: zod.string() })` already does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/credential-refresh`
Expected: FAIL — `Cannot find module './credential-refresh'`.

- [ ] **Step 3: Write the error type**

Create `packages/server/src/credential-refresh/errors.ts`:

```ts
export class OAuthCredentialRefreshError extends Error {
  readonly code = 'OAUTH_CREDENTIAL_REFRESH_FAILED';

  constructor() {
    super('OAuth credential refresh failed');
    this.name = 'OAuthCredentialRefreshError';
  }
}
```

- [ ] **Step 4: Write the service**

Create `packages/server/src/credential-refresh/credential-refresh.ts`:

```ts
import { redactPluginError } from '@aio-proxy/core';
import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import {
  type OAuthAccountContextDependencies,
  type PreparedOAuthAccountContext,
  withOAuthAccountContext,
} from '../oauth-account-context';
import { OAuthCredentialRefreshError } from './errors';

export type OAuthCredentialRefreshOperations = {
  readonly refresh: (providerId: string, signal: AbortSignal) => Promise<void>;
};

type RefreshCapability = NonNullable<OAuthAdapter['refreshCredential']>;

/**
 * Serializes manual refreshes per Provider. `CredentialPort.refresh` already dedupes concurrent
 * callers, but a queued second request would race the first one's revision and come back
 * `superseded`; queueing here means each click observes the credential the previous one wrote.
 */
function createKeyedSerialExecutor(): <T>(key: string, operation: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

async function exchange(
  dependencies: OAuthAccountContextDependencies,
  prepared: PreparedOAuthAccountContext,
  refreshCredential: RefreshCapability,
): Promise<void> {
  const { accountContext } = prepared;
  const current = await accountContext.credentials.read();
  const result = await accountContext.credentials.refresh(current.revision, async (snapshot, signal) => {
    const refreshed = await refreshCredential({
      credential: snapshot.value,
      options: accountContext.options,
      signal,
      ...(accountContext.fetch === undefined ? {} : { fetch: accountContext.fetch }),
    });
    return refreshed;
  });
  // `superseded` means a concurrent refresh already replaced the credential — the account now holds
  // a fresher token than the one the caller asked to replace, which is the outcome they wanted.
  if (result.status === 'updated' || result.status === 'superseded') {
    // `createCredentialPort` skips both of these in `control-plane` mode so a background quota read
    // cannot mutate routing state. A user-initiated refresh must do them: otherwise a stale
    // `CREDENTIAL_REFRESH_FAILED` survives a successful refresh and the summary is never rebuilt.
    try {
      dependencies.repository.clearDiagnostic(prepared.providerId, 'CREDENTIAL_REFRESH_FAILED');
    } catch {}
    dependencies.onDiagnosticChanged();
  }
}

export function createOAuthCredentialRefresher(
  dependencies: OAuthAccountContextDependencies,
): OAuthCredentialRefreshOperations {
  const execute = createKeyedSerialExecutor();
  return {
    refresh: (providerId, signal) =>
      execute(providerId, () =>
        withOAuthAccountContext(
          dependencies,
          { providerId, signal, select: (adapter) => adapter.refreshCredential },
          async (prepared, refreshCredential) => {
            try {
              await exchange(dependencies, prepared, refreshCredential);
            } catch (error) {
              if (prepared.accountContext.signal.aborted) throw prepared.accountContext.signal.reason;
              try {
                dependencies.logger({
                  event: 'plugin.credential.refresh.manual.failed',
                  code: 'CREDENTIAL_REFRESH_FAILED',
                  context: {
                    plugin: prepared.plugin,
                    capability: prepared.capability,
                    providerId: prepared.providerId,
                  },
                  error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
                });
              } catch {}
              throw new OAuthCredentialRefreshError();
            }
          },
        ),
      ),
  };
}
```

- [ ] **Step 5: Add the barrel**

Create `packages/server/src/credential-refresh/index.ts`:

```ts
export * from './credential-refresh';
export * from './errors';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/credential-refresh src/plugin-quota`
Expected: PASS. The quota suite must stay green — the shared fixture gained an optional field only.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/credential-refresh packages/server/src/plugin-quota/test-support.ts
git commit -m "feat(server): add a manual OAuth credential refresh service"
```

---

### Task 4: `canRefreshCredential` capability flag

**Files:**
- Modify: `packages/types/src/dashboard/dashboard.ts:30`
- Modify: `packages/server/src/plugin-account.ts`
- Modify: `packages/server/src/plugin-runtime/catalog.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/server-state/snapshot.ts:230`
- Modify: `packages/server/src/provider-runtime/materialize.ts:317,370`
- Modify: `packages/server/src/model-routing/inventory.test.ts:133`
- Modify: `packages/dashboard/src/modules/providers/lib/provider-fixtures.ts`
- Test: `packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts`

**Interfaces:**
- Consumes: `OAuthAdapter.refreshCredential` (Task 1).
- Produces: `DashboardProviderSummary.canRefreshCredential: boolean` — always present, mirroring `hasQuota`. `summary()` gains a fifth positional parameter `canRefreshCredential = false`; `failure()` gains a seventh positional parameter `canRefreshCredential = false`; `OAuthPluginAccountPreparationError` gains a fifth constructor parameter `canRefreshCredential = false`.

- [ ] **Step 1: Write the failing route tests**

In `packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts`, extend the fixture options and adapter, then add two tests.

Change the `createQuotaFixture` signature to accept `refreshable`:

```ts
async function createQuotaFixture(
  options: {
    read?: () => Promise<OAuthQuotaSnapshot>;
    breakRuntime?: boolean;
    breakCredential?: boolean;
    refreshable?: boolean;
  } = {},
) {
  const { read, breakRuntime = false, breakCredential = false, refreshable = false } = options;
```

In the `api.oauth.register({ ... })` object, after the `quota` property, add:

```ts
      ...(refreshable
        ? {
            refreshCredential: async () => ({ value: { accessToken: 'rotated-credential' } }),
          }
        : {}),
```

Add the tests after the existing `keeps reporting the quota capability when the provider runtime is unavailable` test:

```ts
test('reports the credential refresh capability on the provider summary', async () => {
  const fixture = await createQuotaFixture({ refreshable: true });
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.canRefreshCredential).toBe(true);
    expect(providers.find((provider: { id: string }) => provider.id === 'plain')?.canRefreshCredential).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('reports no credential refresh capability when the plugin does not declare one', async () => {
  const fixture = await createQuotaFixture();
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.canRefreshCredential).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/provider-routes`
Expected: FAIL — `canRefreshCredential` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Add the field to the shared schema**

In `packages/types/src/dashboard/dashboard.ts`, directly after `hasQuota: z.boolean(),`:

```ts
  canRefreshCredential: z.boolean(),
```

- [ ] **Step 4: Carry the flag on the preparation error**

In `packages/server/src/plugin-account.ts`, add a fifth constructor parameter to `OAuthPluginAccountPreparationError`, after `hasQuota`:

```ts
    // Same reasoning as `hasQuota`: a Provider whose credential or options failed can still expose a
    // refresh capability, so the card must keep offering the menu item that fixes it.
    readonly canRefreshCredential = false,
```

Update the `unavailable` helper to accept and forward it:

```ts
function unavailable(
  code: DiagnosticCode,
  accountSummary: OAuthAccountSummary = {},
  suggestLogin = false,
  hasQuota = false,
  canRefreshCredential = false,
): OAuthPluginAccountPreparationError {
  return new OAuthPluginAccountPreparationError(code, accountSummary, suggestLogin, hasQuota, canRefreshCredential);
}
```

Add the derivation next to `const hasQuota = adapter.quota !== undefined;`:

```ts
  const canRefreshCredential = adapter.refreshCredential !== undefined;
```

Then append `, canRefreshCredential` to each of the six `unavailable(...)` calls that already pass `hasQuota` (the `readAccount` catch, the `account === null` branch, the `ACCOUNT_OPTIONS_INVALID` branch, the `PLUGIN_LOAD_FAILED` branch, and the `!parsedCredential.ok` branch). The two calls that fire before the adapter resolves (`PLUGIN_NOT_INSTALLED` / `CAPABILITY_MISSING`) stay as-is and default to `false`.

- [ ] **Step 5: Thread the flag through the summary builders**

In `packages/server/src/plugin-runtime/catalog.ts`, add a fifth parameter to `summary`:

```ts
export function summary(
  config: OAuthProvider,
  provider: RuntimeProviderInstance | undefined,
  persisted?: {
    readonly accountLabel?: string;
    readonly expiresAt?: number;
    readonly catalogLastSuccessAt?: string;
  },
  hasQuota = false,
  canRefreshCredential = false,
): Omit<DashboardProviderSummary, 'state'> {
```

and emit it directly after `hasQuota,`:

```ts
    canRefreshCredential,
```

Add a seventh parameter to `failure`:

```ts
  hasQuota = false,
  // Refresh lives on the adapter, not the runtime: the menu item that repairs a broken credential
  // must still be reachable on an unavailable card.
  canRefreshCredential = false,
): PluginProviderMaterialization {
```

and forward it:

```ts
    summary: summary(options.config, undefined, persisted, hasQuota, canRefreshCredential),
```

- [ ] **Step 6: Pass the flag at every materialization call site**

In `packages/server/src/plugin-runtime/materialize.ts`:

- `createRuntimeMaterialization` gains a parameter. Change its signature's last line from `accountSummary: PreparedOAuthPluginAccount['accountSummary'],` to:

```ts
  accountSummary: PreparedOAuthPluginAccount['accountSummary'],
  canRefreshCredential: boolean,
```

and its `failure` call to:

```ts
    return failure(
      options,
      'RUNTIME_CREATE_FAILED',
      true,
      undefined,
      accountSummary,
      adapter.quota !== undefined,
      canRefreshCredential,
    );
```

- In `materializePluginProvider`, add after the destructuring of `prepared`:

```ts
  const canRefreshCredential = adapter.refreshCredential !== undefined;
```

- The `OAuthPluginAccountPreparationError` catch becomes:

```ts
    return failure(
      options,
      error.code,
      false,
      error.suggestLogin ? providerLoginCommand(options.config.id) : undefined,
      error.accountSummary,
      error.hasQuota,
      error.canRefreshCredential,
    );
```

- The `PROXY_UNSUPPORTED` failure becomes:

```ts
    return failure(options, 'PROXY_UNSUPPORTED', false, undefined, accountSummary, adapter.quota !== undefined, canRefreshCredential);
```

- The `readDiagnostics` catch failure becomes:

```ts
    return failure(
      options,
      'CREDENTIALS_MISSING_OR_INVALID',
      false,
      providerLoginCommand(config.id),
      accountSummary,
      adapter.quota !== undefined,
      canRefreshCredential,
    );
```

- The `refreshFailure` early return becomes:

```ts
      summary: summary(config, undefined, accountSummary, adapter.quota !== undefined, canRefreshCredential),
```

- `persistedSummary` becomes:

```ts
  const persistedSummary = (provider: Parameters<typeof summary>[1], catalog: typeof storedCatalog) =>
    summary(
      config,
      provider,
      {
        ...accountSummary,
        ...(catalog === null ? {} : { catalogLastSuccessAt: new Date(catalog.refreshedAt).toISOString() }),
      },
      adapter.quota !== undefined,
      canRefreshCredential,
    );
```

- The final `createRuntimeMaterialization(...)` call gains `canRefreshCredential` as its last argument, after `accountSummary`.

- [ ] **Step 7: Cover the non-OAuth and invalid-provider literals**

In `packages/server/src/server-state/snapshot.ts`, in the `config.invalidProviders.map` literal, after `hasQuota: false,`:

```ts
          canRefreshCredential: false,
```

In `packages/server/src/provider-runtime/materialize.ts`, in `providerSummary` after the `hasQuota: false,` line (and its existing comment), add:

```ts
    // Same: only OAuth plugin providers can expose a credential refresh capability.
    canRefreshCredential: false,
```

and in `providerConfigSummary` after `hasQuota: false,`:

```ts
    canRefreshCredential: false,
```

- [ ] **Step 8: Update the fixtures that build summaries by hand**

In `packages/dashboard/src/modules/providers/lib/provider-fixtures.ts`, after `hasQuota: false,`:

```ts
  canRefreshCredential: false,
```

In `packages/server/src/model-routing/inventory.test.ts:133`, add `canRefreshCredential: false,` next to the existing `hasQuota: false,`.

- [ ] **Step 9: Run the affected suites**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src __tests__`
Expected: PASS, including the two new tests from Step 1.

Run: `bun run --filter @aio-proxy/types test`
Expected: PASS. If `packages/types/src/dashboard/dashboard.test.ts` or `packages/types/__tests__/dashboard.test.ts` builds a summary literal, add `canRefreshCredential: false` to it.

Run: `bun run --filter @aio-proxy/cli test`
Expected: PASS. If `packages/cli/__tests__/provider-commands.dashboard.test.ts` builds a summary literal, add `canRefreshCredential: false` to it.

- [ ] **Step 10: Commit**

```bash
git add packages/types packages/server packages/cli packages/dashboard/src/modules/providers/lib/provider-fixtures.ts
git commit -m "feat(server): report the OAuth credential refresh capability on provider summaries"
```

---

### Task 5: Dashboard route and server state wiring

**Files:**
- Create: `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.ts`
- Create: `packages/server/src/dashboard-routes/provider-credential-refresh/index.ts`
- Create: `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.test.ts`
- Modify: `packages/server/src/server-state/types.ts`
- Modify: `packages/server/src/server-state/lifecycle.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`

**Interfaces:**
- Consumes: `createOAuthCredentialRefresher`, `OAuthCredentialRefreshError` (Task 3); `OAuthAccountUnavailableError` (Task 2); `canRefreshCredential` on the summary (Task 4).
- Produces:
  - `ServerState.oauthCredentialRefresh: OAuthCredentialRefreshOperations`
  - `POST /providers/:id/credential/refresh` → `200 { provider: DashboardProviderSummary }`, `404 { error }` when the Provider is unknown or its plugin declares no refresh capability, `502 { error }` otherwise.

- [ ] **Step 1: Write the failing route tests**

Create `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

async function createRefreshFixture(options: { refreshable?: boolean; fail?: boolean } = {}) {
  const { refreshable = true, fail = false } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-credential-refresh-'));
  const handle = openDb({ home: dir });
  const repository = createPluginRepository(handle.sqlite);
  const pending = repository.stageAccountOperation({
    kind: 'create',
    targetDigest: 'seed',
    account: {
      providerId: 'person',
      plugin: '@example/oauth',
      capability: 'default',
      fingerprint: 'person@example.com',
      options: { tenant: 'work' },
      secrets: {},
      credential: { accessToken: 'stored-credential' },
      label: 'person@example.com',
      catalog: {
        kind: 'replace',
        value: {
          refreshedAt: Date.now(),
          catalog: {
            language: [{ id: 'model-1' }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
        },
      },
    },
  });
  repository.completeAccountOperation(pending.operationId);
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: { options: { schema: zod.object({ tenant: zod.string() }), form: [] } },
      credentials: zod.object({ accessToken: zod.string() }),
      async login() {
        throw new Error('not used');
      },
      catalog: {
        policy: { kind: 'static' },
        async discover() {
          throw new Error('not used');
        },
      },
      ...(refreshable
        ? {
            refreshCredential: async () => {
              if (fail) throw new Error('upstream rejected');
              return { value: { accessToken: 'rotated' }, metadata: { accountLabel: 'rotated@example.com' } };
            },
          }
        : {}),
      async createRuntime() {
        return {
          provider: {
            specificationVersion: 'v4',
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
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      plugins: ['@example/oauth'],
      providers: {
        person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', options: { tenant: 'work' } },
        plain: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com' },
      },
    }),
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    repository,
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const refresh = (routes: Awaited<ReturnType<typeof createRefreshFixture>>['routes'], id: string) =>
  routes.request(`/providers/${id}/credential/refresh`, { method: 'POST' });

test('a manual refresh returns the rebuilt summary with the new account label', async () => {
  const fixture = await createRefreshFixture();
  try {
    const response = await refresh(fixture.routes, 'person');
    expect(response.status).toBe(200);
    const { provider } = await response.json();
    expect(provider.accountLabel).toBe('rotated@example.com');
    expect(fixture.repository.readAccount('person')?.credential).toEqual({ accessToken: 'rotated' });
  } finally {
    fixture.cleanup();
  }
});

test('a plugin with no refresh capability answers 404', async () => {
  const fixture = await createRefreshFixture({ refreshable: false });
  try {
    expect((await refresh(fixture.routes, 'person')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('a non-OAuth or unknown provider answers 404', async () => {
  const fixture = await createRefreshFixture();
  try {
    expect((await refresh(fixture.routes, 'plain')).status).toBe(404);
    expect((await refresh(fixture.routes, 'missing')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('a failed upstream exchange answers 502', async () => {
  const fixture = await createRefreshFixture({ fail: true });
  try {
    const response = await refresh(fixture.routes, 'person');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAUTH_CREDENTIAL_REFRESH_FAILED' });
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/provider-credential-refresh`
Expected: FAIL — the route 404s because it is not mounted.

- [ ] **Step 3: Expose the service on `ServerState`**

In `packages/server/src/server-state/types.ts`, add the import:

```ts
import type { OAuthCredentialRefreshOperations } from '../credential-refresh';
```

and add to the `ServerState` type, next to `oauthQuota`:

```ts
  readonly oauthCredentialRefresh: OAuthCredentialRefreshOperations;
```

In `packages/server/src/server-state/lifecycle.ts`, add `| 'oauthCredentialRefresh'` to the `Pick<ServerState, ...>` union in `ServerStateParts` (line 128, next to the existing `| 'oauthQuota'`), and in `assembleServerState`'s returned object, next to `oauthQuota: parts.oauthQuota,` (line 196):

```ts
    oauthCredentialRefresh: parts.oauthCredentialRefresh,
```

In `packages/server/src/server-state/index.ts`, add the import:

```ts
import { createOAuthCredentialRefresher } from '../credential-refresh';
```

then construct it inside `createQuotaServices` (which already owns the shared control-plane dependency object) and return it:

```ts
function createQuotaServices(runtime: ServerRuntime, manager: SnapshotManager) {
  const dependencies = {
    acquireSnapshot: manager.acquire,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    onDiagnosticChanged: () => queueRebuild(runtime),
  };
  const oauthQuota = createOAuthQuotaOperations(dependencies);
  const oauthCredentialRefresh = createOAuthCredentialRefresher(dependencies);
  const quotaCache = createOAuthQuotaCache(oauthQuota);
  runtime.quotaCache = quotaCache;
  runtime.quotaIdentity = createQuotaIdentityTracker(quotaCache, manager.current() as Snapshot);
  return { oauthQuota, oauthCredentialRefresh, quotaCache };
}
```

Update its call site to destructure the new value:

```ts
  const { oauthQuota, oauthCredentialRefresh, quotaCache } = createQuotaServices(runtime, manager);
```

and add `oauthCredentialRefresh,` to the object passed to `assembleServerState` (next to `oauthQuota,`).

- [ ] **Step 4: Write the route**

Create `packages/server/src/dashboard-routes/provider-credential-refresh/provider-credential-refresh.ts`:

```ts
import { Hono } from 'hono';

import { OAuthCredentialRefreshError } from '../../credential-refresh';
import { OAuthAccountUnavailableError } from '../../oauth-account-context';
import type { ServerState } from '../../server-state';

export const createDashboardProviderCredentialRefreshRoute = (state: ServerState) =>
  new Hono().post('/providers/:id/credential/refresh', async (context) => {
    const id = context.req.param('id');
    try {
      await state.oauthCredentialRefresh.refresh(id, context.req.raw.signal);
    } catch (error) {
      // An unknown Provider, a non-OAuth Provider, and a plugin with no refresh capability are all
      // permanent: the dashboard should stop offering the action, not retry. Everything else — a bad
      // credential, unreadable secrets — is transient and wears the same opaque error by design.
      if (error instanceof OAuthAccountUnavailableError) {
        return context.json({ error: error.code }, error.permanent ? 404 : 502);
      }
      if (error instanceof OAuthCredentialRefreshError) {
        return context.json({ error: error.code }, 502);
      }
      throw error;
    }
    const provider = (await state.providerSummaries({ filter: id, probe: false })).find((summary) => summary.id === id);
    if (provider === undefined) {
      return context.json({ error: 'provider summary not found' }, 500);
    }
    return context.json({ provider });
  });
```

- [ ] **Step 5: Add the barrel and mount the route**

Create `packages/server/src/dashboard-routes/provider-credential-refresh/index.ts`:

```ts
export { createDashboardProviderCredentialRefreshRoute } from './provider-credential-refresh';
```

In `packages/server/src/dashboard-routes/config.ts`, add the import:

```ts
import { createDashboardProviderCredentialRefreshRoute } from './provider-credential-refresh';
```

and mount it after `.route('/', createDashboardProviderWriteRoutes(state))`:

```ts
    .route('/', createDashboardProviderCredentialRefreshRoute(state))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes`
Expected: PASS.

Note on the 200 case: `onDiagnosticChanged` calls `queueRebuild`, which commits a new snapshot asynchronously. The route reads the summary *after* the refresh resolves, and the account label comes from the repository via the fresh snapshot's `accountSummary`; if the assertion on `accountLabel` proves flaky because the rebuild has not landed, keep the assertion on `repository.readAccount('person')` and change the summary assertion to `expect(provider.id).toBe('person')`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/dashboard-routes packages/server/src/server-state
git commit -m "feat(server): expose a manual OAuth credential refresh endpoint"
```

---

### Task 6: Declare `refreshCredential` on the six OAuth plugins

**Files:**
- Modify: `packages/plugins/cursor/src/plugin/plugin.ts`
- Modify: `packages/plugins/kimi-code/src/plugin.ts`
- Modify: `packages/plugins/xai-grok/src/plugin.ts`
- Modify: `packages/plugins/google-antigravity/src/plugin.ts`
- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts`
- Modify: `packages/plugins/github-copilot/src/plugin.ts`

**Interfaces:**
- Consumes: `OAuthCredentialRefreshContext` / `OAuthCredentialRefreshResult` (Task 1).
- Produces: nothing consumed by later tasks — this task makes the capability real for shipped plugins.

Each plugin already owns a pure exchange function; `refreshCredential` is a thin adapter over it. **Do not** route through the plugins' `currentXCredential()` helpers: every one of them short-circuits on a not-yet-expired token, which is exactly the behavior a manual refresh must bypass.

No new plugin tests: each `refreshCredential` is a two-line delegation to an exchange function that already has its own coverage, and Task 5's route test exercises the wiring end-to-end. Adding six near-identical delegation tests would restate implementation literals.

- [ ] **Step 1: cursor**

In `packages/plugins/cursor/src/plugin/plugin.ts`, add `refreshCursorCredential` to the existing import from the plugin's oauth module (verify the exact specifier used for `loginCursor`; `refreshCursorCredential` is exported from `../oauth/credential`). Add to the adapter object, directly after `catalog: { ... },`:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshCursorCredential(credential, {
        ...dependencies,
        signal,
        ...(dependencies.fetch === undefined && fetch !== undefined ? { fetch } : {}),
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
        },
      };
    },
```

- [ ] **Step 2: kimi-code**

In `packages/plugins/kimi-code/src/plugin.ts`, import `refreshKimiCredential` from `./oauth/credential` and add after the `quota` property:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshKimiCredential(credential, {
        ...dependencies,
        signal,
        ...(dependencies.fetch === undefined && fetch !== undefined ? { fetch } : {}),
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
        },
      };
    },
```

- [ ] **Step 3: xai-grok**

In `packages/plugins/xai-grok/src/plugin.ts`, import `refreshXAIGrokCredential` from `./oauth` and add after the `quota` property:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshXAIGrokCredential(credential, {
        ...dependencies,
        signal,
        ...(dependencies.fetch === undefined && fetch !== undefined ? { fetch } : {}),
      });
      return { value: refreshed, metadata: { expiresAt: refreshed.expiresAt } };
    },
```

- [ ] **Step 4: google-antigravity**

In `packages/plugins/google-antigravity/src/plugin.ts`, import `refreshGoogleCredential` from `./oauth/refresh` (alongside the existing `exchangeGoogleRefreshToken` import) and add after the `catalog` property:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshGoogleCredential(credential, {
        fetch: dependencies.fetch ?? fetch,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        signal,
      });
      return { value: refreshed, metadata: { accountLabel: refreshed.email, expiresAt: refreshed.expiresAt } };
    },
```

- [ ] **Step 5: openai-chatgpt**

In `packages/plugins/openai-chatgpt/src/plugin.ts`, import `refreshAccessToken` from `./oauth-flow` (the module already exports `exchangeCodeForTokens`, used by `login`) and add after the `catalog` property:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshAccessToken(credential.refreshToken, {
        ...(fetch === undefined ? {} : { fetch }),
        signal,
        ...(credential.email === undefined ? {} : { email: credential.email }),
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
        },
      };
    },
```

- [ ] **Step 6: github-copilot**

This plugin has no exported pure exchange: `refreshGitHubCopilotCredential` is module-private and short-circuits internally on an unexpired token. Compose the exported primitives instead. In `packages/plugins/github-copilot/src/plugin.ts`, import `fetchCopilotToken`, `getGitHubCopilotBaseURL` and `githubApiBase` from the plugin's `github-api` module, then add after the `catalog` property:

```ts
    refreshCredential: async ({ credential, signal, fetch }) => {
      const copilot = await fetchCopilotToken(
        githubApiBase(credential.enterpriseURL),
        credential.githubToken,
        signal,
        fetch,
      );
      const value = {
        ...credential,
        copilotToken: copilot.access,
        expiresAt: copilot.expires,
        baseURL: getGitHubCopilotBaseURL(copilot.access, credential.enterpriseURL),
      };
      return { value, metadata: { expiresAt: value.expiresAt } };
    },
```

If `fetchCopilotToken`, `getGitHubCopilotBaseURL` or `githubApiBase` are not re-exported from the module `plugin.ts` already imports, add them to that module's barrel rather than reaching into a private file.

- [ ] **Step 7: Run every plugin's tests**

```bash
bun run --filter '@aio-proxy/plugin-*' test
```

Expected: PASS. If the filter does not match the plugins' package names, run each package's own `test` script (`cursor` and `xai-grok` use `bun test`; `github-copilot`, `google-antigravity`, `kimi-code`, `openai-chatgpt` use `bun test --preload=./test/setup.ts`).

- [ ] **Step 8: Commit**

```bash
git add packages/plugins
git commit -m "feat(plugins): declare the OAuth credential refresh capability on every OAuth plugin"
```

---

### Task 7: Dashboard service, hook, and i18n keys

**Files:**
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Create: `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/provider-credential-refresh-service.ts`
- Create: `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/index.ts`
- Create: `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/use-provider-credential-refresh.ts`
- Create: `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/index.ts`

**Interfaces:**
- Consumes: `POST /providers/:id/credential/refresh` (Task 5).
- Produces:
  - `refreshProviderCredential(id: string): Promise<ProviderCredentialRefreshResult>` where `ProviderCredentialRefreshResult = InferResponseType<typeof credentialRefreshEndpoint, 200>`
  - `useProviderCredentialRefresh(): UseMutationResult<ProviderCredentialRefreshResult, Error, string>` — `mutate(providerId)`, toasts on both outcomes and invalidates `queryKeys.providers` on success.

- [ ] **Step 1: Add the i18n keys to all five locales**

Add to `dashboard.providers.actions` in each file:

| locale | `refresh_credential` |
| --- | --- |
| en | `Refresh Credential` |
| ja | `認証情報を更新` |
| ko | `자격 증명 갱신` |
| zh-Hans | `刷新凭据` |
| zh-Hant | `重新整理憑證` |

Add to `dashboard.providers.toast` in each file:

| locale | `credential_refreshed` | `credential_refresh_failed` |
| --- | --- | --- |
| en | `Credential refreshed` | `Failed to refresh credential` |
| ja | `認証情報を更新しました` | `認証情報の更新に失敗しました` |
| ko | `자격 증명이 갱신되었습니다` | `자격 증명 갱신에 실패했습니다` |
| zh-Hans | `凭据已刷新` | `刷新凭据失败` |
| zh-Hant | `憑證已重新整理` | `重新整理憑證失敗` |

- [ ] **Step 2: Compile the messages**

Run: `bun run i18n:compile`
Expected: succeeds; `m['dashboard.providers.actions.refresh_credential']` and both toast keys now type-check.

- [ ] **Step 3: Write the service**

Create `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/provider-credential-refresh-service.ts`:

```ts
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';

const credentialRefreshEndpoint = dashboardClient.dashboard.api.providers[':id'].credential.refresh.$post;

export type ProviderCredentialRefreshResult = InferResponseType<typeof credentialRefreshEndpoint, 200>;

export class DashboardProviderCredentialRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider credential refresh failed with status ${status}`);
    this.name = 'DashboardProviderCredentialRefreshError';
  }
}

export const refreshProviderCredential = async (id: string): Promise<ProviderCredentialRefreshResult> => {
  const response = await credentialRefreshEndpoint({ param: { id } });
  if (!response.ok) throw new DashboardProviderCredentialRefreshError(response.status);
  return await response.json();
};
```

Note: `provider-quota-service` imports `dashboardClient` from `@/lib/dashboard-client` while `providers-service` calls `createDashboardClient()`. Match whichever form `@/lib/dashboard-client` actually exports as a ready instance; if only the factory is exported, use `const dashboardClient = createDashboardClient();` here as `providers-service.ts` does.

- [ ] **Step 4: Add the service barrel**

Create `packages/dashboard/src/modules/providers/services/provider-credential-refresh-service/index.ts`:

```ts
export * from './provider-credential-refresh-service';
```

- [ ] **Step 5: Write the hook**

Create `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/use-provider-credential-refresh.ts`:

```ts
import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { refreshProviderCredential } from '../../services/provider-credential-refresh-service';

/**
 * Invalidates the Provider list rather than seeding it: a refresh rewrites `accountLabel` and
 * `expiresAt` on the server-side summary, and the response is one Provider out of the list's shape.
 */
export const useProviderCredentialRefresh = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => refreshProviderCredential(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({ type: 'success', title: m['dashboard.providers.toast.credential_refreshed']() });
    },
    onError: () => {
      toast.add({ type: 'error', title: m['dashboard.providers.toast.credential_refresh_failed']() });
    },
  });
};
```

- [ ] **Step 6: Add the hook barrel**

Create `packages/dashboard/src/modules/providers/hooks/use-provider-credential-refresh/index.ts`:

```ts
export { useProviderCredentialRefresh } from './use-provider-credential-refresh';
```

- [ ] **Step 7: Verify the dashboard type-checks**

Run: `bun run --filter @aio-proxy/dashboard check` (or `bun run check` if the package has no `check` script of its own).
Expected: PASS. A failure on `.credential.refresh.$post` means the route from Task 5 is not reachable through `AppType` — confirm it is mounted in `dashboard-routes/config.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/i18n packages/dashboard/src/modules/providers/services packages/dashboard/src/modules/providers/hooks
git commit -m "feat(dashboard): add a provider credential refresh service and mutation hook"
```

---

### Task 8: The ⋯ menu item

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.test.tsx`

**Interfaces:**
- Consumes: `useProviderCredentialRefresh` (Task 7); `DashboardProviderSummary.canRefreshCredential` (Task 4); `providerStub` from `../../lib/provider-fixtures`.
- Produces: no new exports — `ProviderMoreMenu`'s props are unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.test.tsx`:

```tsx
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderMoreMenu } from './provider-more-menu';

const mocks = rs.hoisted(() => ({ mutate: rs.fn(), isPending: false }));

rs.mock('../../hooks/use-provider-credential-refresh', () => ({
  useProviderCredentialRefresh: () => ({ mutate: mocks.mutate, isPending: mocks.isPending }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#">{children}</a>,
}));

afterEach(() => {
  mocks.mutate.mockReset();
  mocks.isPending = false;
});

test('offers a credential refresh only when the plugin declares the capability', () => {
  const { rerender } = render(
    <ProviderMoreMenu provider={providerStub({ canRefreshCredential: false })} onDelete={rs.fn()} />,
  );
  fireEvent.click(screen.getByRole('button'));
  expect(screen.queryByTestId('provider-refresh-credential')).toBeNull();

  rerender(<ProviderMoreMenu provider={providerStub({ canRefreshCredential: true })} onDelete={rs.fn()} />);
  expect(screen.getByTestId('provider-refresh-credential')).not.toBeNull();
});

test('a credential refresh targets the provider the menu belongs to', () => {
  render(
    <ProviderMoreMenu
      provider={providerStub({ id: 'carpool', canRefreshCredential: true })}
      onDelete={rs.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByTestId('provider-refresh-credential'));

  expect(mocks.mutate).toHaveBeenCalledWith('carpool');
});
```

If the `@tanstack/react-router` mock proves unnecessary (other colocated dashboard tests render `Link` without one), drop it — check a sibling test such as `packages/dashboard/src/modules/providers/components/provider-card/provider-card.test.tsx` for the established pattern before adding it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dashboard && bun x rstest run src/modules/providers/components/provider-more-menu`
Expected: FAIL — `provider-refresh-credential` is not in the document.

- [ ] **Step 3: Add the menu item**

Replace `packages/dashboard/src/modules/providers/components/provider-more-menu/provider-more-menu.tsx` with:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { Link } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type React from 'react';

import { useProviderCredentialRefresh } from '../../hooks/use-provider-credential-refresh';

interface ProviderMoreMenuProps {
  readonly provider: DashboardProviderSummary;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderMoreMenu: React.FC<ProviderMoreMenuProps> = ({ provider, onDelete }) => {
  const credentialRefresh = useProviderCredentialRefresh();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m['dashboard.providers.actions.open_menu']({ id: provider.id })}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<Link to="/providers/$id/edit" params={{ id: provider.id }} />}>
          <Pencil />
          {m['dashboard.providers.actions.edit']()}
        </DropdownMenuItem>
        {/* Hidden rather than disabled: a plugin that cannot refresh will never be able to, so an
            always-greyed row is dead weight. Same treatment as the quota ring's `hasQuota` gate. */}
        {provider.canRefreshCredential ? (
          <DropdownMenuItem
            data-testid="provider-refresh-credential"
            disabled={credentialRefresh.isPending}
            onClick={() => credentialRefresh.mutate(provider.id)}
          >
            <RefreshCw />
            {m['dashboard.providers.actions.refresh_credential']()}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(provider)}>
          <Trash2 />
          {m['dashboard.providers.actions.delete']()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dashboard && bun x rstest run src/modules/providers/components/provider-more-menu`
Expected: PASS.

- [ ] **Step 5: Run the whole dashboard suite**

Run: `bun run --filter @aio-proxy/dashboard test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/modules/providers/components/provider-more-menu
git commit -m "feat(dashboard): offer a credential refresh in the provider card menu"
```

---

### Task 9: Changeset and full verification

**Files:**
- Create: `.changeset/<generated-name>.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the release note.

- [ ] **Step 1: Run preflight**

Run: `bun run preflight`
Expected: PASS (oxlint + oxfmt check + every package's unit tests). Fix any formatting the check flags with `bun run format` (or the repo's equivalent write-mode script) and re-run.

- [ ] **Step 2: Author the changeset**

Run: `bun changeset`

Select **minor** for all of: `aio-proxy`, `@aio-proxy/plugin-sdk`, `@aio-proxy/core` is untouched so omit it, `@aio-proxy/server`, `@aio-proxy/types`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`, and each of the six plugin packages. Both product packages are present, so the note lands in a published Release.

Summary text:

```
dashboard: refresh an OAuth provider's token from the provider card menu

Adds an optional `refreshCredential` capability to `OAuthAdapter`. Plugins that declare it get a
"Refresh Credential" entry in the provider card's ⋯ menu, which forces an upstream token exchange
regardless of expiry and clears a stale credential-refresh diagnostic on success. All six bundled
OAuth plugins declare it; the menu entry stays hidden for plugins that do not.
```

- [ ] **Step 3: Verify the generated file targets a product package**

Read the generated `.changeset/*.md` and confirm its frontmatter lists `'aio-proxy'` and `'@aio-proxy/plugin-sdk'`. A changeset naming only internal packages produces an empty CHANGELOG entry and its Release note is silently skipped.

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: add a changeset for manual OAuth credential refresh"
```

---

## Self-Review Notes

**Spec coverage:** All eight decisions from brainstorming are covered — SDK contract as a pure exchange (Task 1), the control-plane silent-success trap (Task 3, Step 4), the shared account context (Task 2), the `canRefreshCredential` capability flag at every literal site (Task 4), the route (Task 5), all six plugins (Task 6), the frontend toast-plus-invalidate feedback (Task 7), hiding rather than disabling the menu item for plugins without the capability (Task 8), i18n in all five locales (Task 7, Step 1), and the changeset targeting both product packages (Task 9).

**Deliberately out of scope:** no per-provider opt-out for refresh-token rotation. All six plugins either reuse the original refresh token (openai-chatgpt) or fall back to it when the response omits a new one (`token.refreshToken ?? current.refreshToken` in cursor and kimi-code, `body.refresh_token?.trim() || credential.refreshToken` in xai-grok); none is a one-time or family-revoking token, and the existing single-flight plus distributed lease already prevent concurrent exchanges. Add an opt-out when a plugin whose upstream revokes the token family is introduced.
