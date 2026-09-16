# Configuration Sync — OAuth Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize eligible account state while making shared refresh and local detachment safe under concurrency and uncertain outcomes.

**Architecture:** Current account state is a single remotely conditional object; the host owns claims, durable result journals and activation policy. Existing CredentialPort callers retain their public API, with shared accounts delegated to a remote coordinator and never-shared accounts retaining local refresh.

**Tech Stack:** Bun 1.4.2+, TypeScript, Zod 4, Bun SQLite, existing OAuth adapters and the sync SDK storage contract.

**Spec:** [Selective Configuration Sync and CloudKit Design](../specs/2026-09-08-config-sync-design.md)

## Global Constraints

- Bun >= 1.4.2; packageManager is bun@1.4.2. Use TypeScript, Zod 4, Bun SQLite and existing workspace libraries.
- CloudKit requires macOS 14+ and the system iCloud account; other sync backends may support other platforms.
- One active backend and one default space per configuration directory; backend identity, authorization, range and overrides stay local.
- The host owns synchronization rules. Trusted in-process backend plugins provide storage through sync.register; installation validation must not connect.
- Do not require application-level end-to-end encryption, sync passwords or encryption-key sharing.
- New local Providers default to local-only. New cloud Providers join automatically unless an existing local exclusion or conflict prevents it.
- Required business plugin configuration and whole plugin-level business secret records follow selected Providers automatically; no separate shared-secret toggle.
- Never upload top-level proxy, Provider proxy, their credentials, environment files, expanded environment values or machine-specific settings.
- Preserve raw {{env.NAME}} references. API keys and management password are shared; backend connection authorization is local.
- Merge whole entities by successful cloud submission order. Persistent tombstones defeat stale edits; restoration is explicit.
- Cloud configuration history lasts 30 days; current state does not expire. Configuration rollback never replays old OAuth credentials.
- Shared OAuth refresh requires confirmed remote coordination. Uncertain exchange outcomes must not cause automatic refresh-token replay.
- Automatic multi-device OAuth activation and fully local credential detachment require adapter/version-specific verification.
- Export only committed local state. Remote import must not echo. File and SQLite commits require recovery rather than a claimed cross-resource transaction.
- Unknown protocol or credential formats are preserved and made read-only until compatible software is available.
- Keep routing semantics and the server generation candidate loop unchanged.
- Dashboard uses the typed Hono client, TanStack Query/Form and shared UI controls; add natural-language copy to en, zh-Hans, zh-Hant, ja and ko messages.
- Handwritten non-test implementation files must not exceed 500 lines; evaluate responsibility splits at 400 lines. Tested modules use foo/index.ts, foo/foo.ts and foo/foo.test.ts.
- Use existing native/Bun/es-toolkit utilities; shared dependencies use the root catalog. Use isRecord for structural SDK contracts and isPlainObject for JSON.
- Run bun run preflight before implementation completion; minimum fallback is bun run check plus affected package tests, with any skipped gate recorded.
- User-facing implementation Changesets include aio-proxy and/or @aio-proxy/plugin-sdk plus affected internal packages; product bump is at least the internal bump.
- Every implementation commit appends Co-authored-by: Codex <noreply@openai.com>.

---

## Dependencies

Requires core Tasks 1–3 and the object-store primitives from Task 5. Final two-device tests require core Task 8. Native CloudKit is not required for deterministic concurrency tests; repeat them on the signed backend at release.

The current oauth_account primary key is Provider ID. A plugin registering multiple OAuth capabilities does not imply a shared account pool. Do not use fingerprint as a cross-device account ID, and do not infer independence merely because two local account rows differ.

## File structure

| Path | Responsibility |
| --- | --- |
| packages/plugin-sdk/src/oauth.ts | Optional credentialSync metadata on OAuthAdapter. |
| packages/core/src/plugins/registry.ts | Metadata normalization/validation preserving legacy adapters. |
| packages/core/src/sync/oauth/protocol.ts | Versioned current-account/claim/ownership contracts. |
| packages/core/src/sync/oauth/coordinator/ | Shared refresh state machine and journal recovery. |
| packages/core/src/sync/oauth/account-import/ | Local account replacement with sync generation and recovery. |
| packages/core/src/sync/oauth/sharing/ | First-share, relogin and independent detachment gates. |
| packages/core/src/plugins/credential-port/ | Existing local implementation plus runtime delegation seam. |
| packages/server/src/plugin-account.ts | Supplies current shared-ownership resolver to every account context. |
| packages/plugins/*/src/ | Per-adapter metadata and version-specific verification. |
| docs/testing/oauth-sync.md | Adapter matrix, live procedure and evidence format. |

### Task 1: Add credential version and activation evidence contracts

**Files:**

- Modify: packages/plugin-sdk/src/oauth.ts, packages/plugin-sdk/src/oauth.types.ts.
- Modify: packages/core/src/plugins/registry.ts, packages/core/src/plugins/registry-adapter-validation.test.ts.
- Create: packages/core/src/sync/oauth/index.ts, protocol.ts, protocol.test.ts.
- Modify: packages/core/src/sync/repository/rows.ts, packages/core/src/sync/index.ts.
- Create: docs/testing/oauth-sync.md.

**Interfaces:**

Add OAuthAdapter.credentialSync exactly as specified in spec §8.1. The credential format is separate from the host protocol and package version.

~~~ts
export interface AccountPayload {
  credential: JsonValue; options: JsonValue; secrets: JsonValue;
  fingerprint: string; label?: string; expiresAt?: number;
}
export interface RefreshClaim {
  operationId: string; ownerDeviceId: string; baseGeneration: number;
}
export interface LiveAccount {
  protocol: 1; objectId: string; epoch: number;
  plugin: string; capability: string; pluginVersion: string; formatVersion: number;
  generation: number; phase: 'ready' | 'refreshing' | 'uncertain' | 'login-required';
  payload: AccountPayload; claim: RefreshClaim | null;
  lastCompletedOperationId: string | null;
}
export type AccountRecord = LiveAccount | DeletedAccount;
export interface OAuthOwnership {
  mode: 'shared' | 'detach-pending' | 'independent';
  epoch: number; generation: number; localRevision: number;
  pluginVersion: string; formatVersion: number;
}
export function decodeAccount(bytes: Uint8Array): AccountRecord;
export function canActivateSyncedAccount(
  adapter: OAuthAdapter, pluginVersion: string, account: LiveAccount,
): boolean;
~~~

Extend LocalEntity with oauth?: OAuthOwnership; absence means never shared. Preserve this field through projection/range updates. DeletedAccount is the core protocol type, not a second incompatible tombstone. canActivateSyncedAccount requires matching plugin/capability/version/format, ready state and nonempty evidenceId. Credential schema validation still runs separately.

- [ ] **Step 1: Test unverified copies without runtime activation.**

~~~ts
import { expect, test } from 'bun:test';
import { canActivateSyncedAccount } from './protocol';
import { oauthAdapterFixture, liveAccountFixture } from './test-support';

test('format metadata permits storage while missing evidence blocks activation', () => {
  const adapter = oauthAdapterFixture({ credentialSync: { formatVersion: 1 } });
  const account = liveAccountFixture();
  expect(adapter.credentialSync?.formatVersion).toBe(1);
  expect(canActivateSyncedAccount(adapter, account.pluginVersion, account)).toBe(false);
});
~~~

Create oauth/test-support.ts with oauthAdapterFixture(overrides: Partial<OAuthAdapter>): OAuthAdapter and liveAccountFixture(overrides?: Partial<LiveAccount>): LiveAccount. Use real definePlugin/OAuth test patterns, a Zod { token: string } credential, static empty catalog, a no-network login fixture and a trivial runtime. liveAccountFixture uses Provider object UUID, test plugin/capability, version 1.0.0/format 1/generation 0/ready/no claim, lastCompletedOperationId null and token old. The fixture is never production evidence.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/oauth/protocol.test.ts
Expected: FAIL missing metadata/contracts.

- [ ] **Step 3: Implement version/phase checks and metadata validation.**

~~~ts
export function canActivateSyncedAccount(
  adapter: OAuthAdapter, pluginVersion: string, account: LiveAccount,
): boolean {
  const sync = adapter.credentialSync;
  return account.phase === 'ready'
    && sync !== undefined
    && sync.formatVersion === account.formatVersion
    && pluginVersion === account.pluginVersion
    && (sync.multiDevice?.evidenceId.length ?? 0) > 0;
}
~~~

The caller resolves the adapter by the exact account plugin/capability; compare those identities before invoking this function. Registry validation requires a positive integer formatVersion, nonempty evidenceId if multiDevice is present and a function if canDetach is present; bind it to the original adapter object. Do not require metadata from old local-only plugins. decodeAccount rejects unknown protocol/format for writing and preserves bytes at the caller; absent format metadata is pending-plugin-update rather than assumed compatibility.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/oauth/protocol.test.ts packages/core/src/plugins/registry-adapter-validation.test.ts
Run: rtk proxy bun run --filter @aio-proxy/plugin-sdk test
Expected: PASS with legacy adapters unchanged and unsupported remote versions read-only.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugin-sdk/src/oauth.ts packages/plugin-sdk/src/oauth.types.ts packages/core/src/plugins/registry.ts packages/core/src/plugins/registry-adapter-validation.test.ts packages/core/src/sync docs/testing/oauth-sync.md
rtk git commit -m "feat(plugin-sdk): describe OAuth credential sync compatibility" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 2: Coordinate refresh with one account CAS and durable result recovery

**Files:**

- Create: packages/core/src/sync/oauth/coordinator/index.ts, coordinator.ts, refresh.ts, recovery.ts, coordinator.test.ts.
- Modify: packages/core/src/sync/oauth/protocol.ts, packages/core/src/sync/oauth/index.ts, packages/core/src/sync/oauth/test-support.ts.
- Modify: packages/core/src/sync/repository/repository.ts, repository.test.ts.

**Interfaces:**

~~~ts
export type ExchangeResult<C> = {
  value: C; metadata?: { accountLabel?: string; expiresAt?: number };
};
export interface SharedRefreshInput<C> {
  objectId: string; epoch: number; generation: number;
  exchange(current: C, signal: AbortSignal): Promise<ExchangeResult<C>>;
  validate(value: unknown): Promise<C>;
}
export type SharedRefreshResult<C> = {
  status: 'updated' | 'superseded'; account: LiveAccount; value: C;
};
export interface SharedOAuthCoordinator {
  refresh<C>(input: SharedRefreshInput<C>, signal: AbortSignal): Promise<SharedRefreshResult<C>>;
  recover(objectId: string, signal: AbortSignal): Promise<LiveAccount | null>;
}
export function createSharedOAuthCoordinator(input: {
  binding: LocalBinding; store: SyncObjectStore; repo: SyncRepository;
}): SharedOAuthCoordinator;
export class SyncOAuthError extends Error {
  readonly code: 'refresh-deferred' | 'result-uncertain' | 'login-required'
    | 'deleted' | 'upgrade-required' | 'unverified' | 'detach-pending';
}
~~~

Private collaborators have these contracts:
readCurrent(objectId, signal): Promise<{ account: AccountRecord; version: string }>;
claimReady(current: LiveAccount, version: string, signal): Promise<{ account: LiveAccount; version: string } | null>;
publishResult(current: LiveAccount, version: string, journal: OAuthJournalRow, signal): Promise<LiveAccount>;
recoverResult(objectId: string, signal): Promise<LiveAccount | null>.
Each is a method/closure over the coordinator input; their object/epoch/claim checks follow spec §8.2. A missing account cannot be seeded by refresh; seeding belongs to Task 4.

- [ ] **Step 1: Test two devices and interrupted publication.**

~~~ts
import { expect, test } from 'bun:test';
import { withSharedOAuthDevices } from '../test-support';

test('two devices exchange once and a lost cloud reply does not replay old credentials', async () => {
  await withSharedOAuthDevices(async (f) => {
    let exchanges = 0;
    const exchange = async () => { exchanges++; return { value: { token: 'new' } }; };
    const input = {
      objectId: f.objectId, epoch: 0, generation: 0,
      exchange, validate: async (value: unknown) => f.schema.parse(value),
    };
    const result = await Promise.allSettled([
      f.a.refresh(input, f.signal), f.b.refresh(input, f.signal),
    ]);
    expect(exchanges).toBe(1);
    expect(result.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await f.a.recover(f.objectId, f.signal))?.generation).toBe(1);
  });
});
~~~

Define withSharedOAuthDevices(run): Promise<void> in oauth/test-support.ts. It creates two independent real sync repositories and bindings on one memory backend, create-only seeds liveAccountFixture under accountKey, and returns coordinators a/b, objectId, schema, signal, backend, repoA/repoB. It exposes injectAfterExchange(fn: () => void) through a test hook only when required by journal crash tests; production code does not receive a fake journal.

Add separate tests for failure before claim, unknown claim reply, process exit after claim/before exchange, timeout during exchange, successful result journal then failed publication, late result, validation failure after journal, restart with result, stale result after purge/relogin, journal-write failure and a remote phase that never becomes ready. No test advances a clock and then expects refresh-token reuse.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/oauth/coordinator/coordinator.test.ts
Expected: FAIL missing coordinator.

- [ ] **Step 3: Implement claim → exchange → journal → publish.**

~~~ts
const operationId = crypto.randomUUID();
const claim: RefreshClaim = {
  operationId, ownerDeviceId: binding.deviceId, baseGeneration: current.account.generation,
};
const claimed: LiveAccount = { ...current.account, phase: 'refreshing', claim };
const accepted = await store.session.compareAndSwap(
  accountKey(input.objectId), current.version, encode(claimed), signal,
);
if (accepted.kind === 'conflict') return refreshAfterReread(input, signal);

repo.writeOAuthJournal(binding.id, {
  operationId, objectId: input.objectId, epoch: claimed.epoch,
  baseGeneration: claimed.generation, phase: 'started', payload: null,
});
const result = await input.exchange(await input.validate(claimed.payload.credential), signal);
repo.writeOAuthJournal(binding.id, {
  operationId, objectId: input.objectId, epoch: claimed.epoch,
  baseGeneration: claimed.generation, phase: 'result',
  payload: toJsonExchangeResult(result),
});
const value = await input.validate(result.value);
~~~

Define refreshAfterReread with the same generic signature as refresh; it may return superseded/new state or refresh-deferred for an existing claim, and only attempts a claim for a still-ready account. Define toJsonExchangeResult<C>(result: ExchangeResult<C>): JsonValue using validated JSON encoding; OAuth credentials are required to be serializable, as the existing database already requires. The result journal write precedes schema validation or cloud mutation.

Validate the original credential before claiming when possible, then revalidate matching current state without any upstream call. Once the claim is acknowledged, do not release it to ready on an ambiguous exchange failure. Record uncertain while preserving claim/payload. A backend conflict never authorizes sending the exchange with a stale token.

publishResult rereads the account, checks identical object/epoch/operation/baseGeneration, validates a journaled result, CASes ready/generation+1, clears claim and sets lastCompletedOperationId. If a later ready generation already contains that operation's result, treat it as resolved; otherwise do not overwrite it. Use lastCompletedOperationId to resolve lost publication acknowledgements without comparing raw token bytes. A newer generation from another operation is superseded and is imported before completing the older local journal.

Set SQLite synchronous=FULL outside transactions while shared result durability is needed. If journaling fails after a known upstream success, hold the result in memory, stop further refresh and retry journal persistence while alive; do not mark success or publish without durability. If the process is lost before durable recording, the affected account requires login. Do not use Promise.race to abandon a callback whose eventual success could rotate credentials; late success handlers persist while DB remains open.

- [ ] **Step 4: Verify all durable boundaries.**

Run: rtk proxy bun test packages/core/src/sync/oauth/coordinator/coordinator.test.ts packages/core/src/sync/repository/repository.test.ts
Expected: PASS. Verify journal contents survive an on-disk reopen and contain only the current recovery result, not config-history snapshots. Complete/remove transient results only after confirmed publication and local application.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/oauth packages/core/src/sync/repository
rtk git commit -m "feat(core): coordinate shared OAuth refresh and recovery" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 3: Route every shared credential caller through the coordinator

**Files:**

- Move: packages/core/src/plugins/credential-port.ts into credential-port/credential-port.ts; create export-only credential-port/index.ts.
- Create: packages/core/src/plugins/credential-port/shared.test.ts.
- Modify: packages/core/src/plugins/credential-port/test-support.ts and existing colocated refresh tests.
- Create: packages/core/src/sync/oauth/account-import/index.ts, account-import.ts, account-import.test.ts.
- Modify: packages/core/src/plugins/repository/types.ts, accounts.ts and account operation transaction implementation.
- Modify: packages/server/src/plugin-account.ts, packages/server/src/credential-refresh/credential-refresh.ts.
- Modify: packages/types/src/plugin.ts (diagnostic codes), packages/server/src/server-state/types.ts.

**Interfaces:**

~~~ts
// Add to CreateCredentialPortOptions<Credential>:
resolveShared?: () => CredentialPort<Credential> | undefined;

// Host adapter:
export function createSharedCredentialPort<C>(input: {
  providerId: string; objectId: string; binding: LocalBinding;
  coordinator: SharedOAuthCoordinator; repo: SyncRepository;
  accounts: PluginRepository; schema: ZodType<C>;
}): CredentialPort<C>;

export function applySyncedAccount(input: {
  binding: LocalBinding; account: LiveAccount; providerId: string;
  repo: SyncRepository; accounts: PluginRepository;
}): StoredAccount;
~~~

applySyncedAccount runs account write/finalization and the LocalEntity.oauth generation/localRevision update in one SQLite transaction. Reuse existing account staging/compensation code through an internal transaction entry rather than a second hand-written account schema. Extend PluginRepository with withAccountTransaction<T>(run: () => T): T, backed by the same SQLite connection; ensure nested existing transactions use savepoints or restructure private collaborators to keep one transaction. Account/config file import still uses the logical commit bridge, not a claimed cross-resource transaction.

- [ ] **Step 1: Add shared/local behavior tests.**

~~~ts
import { expect, test } from 'bun:test';
import { createCredentialPort } from './credential-port';
import { credentialPortOptions } from './test-support';

test('shared refresh bypasses local lease acquisition', async () => {
  const base = credentialPortOptions();
  let sharedCalls = 0, localLeaseCalls = 0;
  const options = {
    ...base,
    repository: {
      ...base.repository,
      tryAcquireRefreshLease: (...args: Parameters<PluginRepository['tryAcquireRefreshLease']>) => {
        localLeaseCalls++; return base.repository.tryAcquireRefreshLease(...args);
      },
    },
  };
  const port = createCredentialPort({
    ...options,
    resolveShared: () => ({
      read: async () => ({ value: { token: 'old' }, revision: 1 }),
      refresh: async () => {
        sharedCalls++;
        return { status: 'updated', snapshot: { value: { token: 'new' }, revision: 2 } };
      },
    }),
  });
  await port.refresh(1, async () => ({ value: { token: 'unused' } }));
  expect(sharedCalls).toBe(1);
  expect(localLeaseCalls).toBe(0);
});
~~~

Import PluginRepository as a type from the existing repository entry. The copied repository wrapper preserves readonly production contracts. Define credentialPortOptions(): CreateCredentialPortOptions<{ token: string }> using the existing credential-port/test-support real account fixture, and add a counterpart with no shared resolver proving local lease behavior remains intact.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/plugins/credential-port/shared.test.ts
Expected: FAIL because resolveShared is ignored or not defined.

- [ ] **Step 3: Add a dynamic ownership check at use time.**

~~~ts
async function refresh(
  expectedRevision: number,
  exchange: Parameters<CredentialPort<Credential>['refresh']>[1],
) {
  const shared = options.resolveShared?.();
  if (shared !== undefined) return shared.refresh(expectedRevision, exchange);
  return refreshLocal(expectedRevision, exchange);
}
~~~

Extract the existing refresh body as private refreshLocal, unchanged for never-shared/verified-independent ownership. Make the same ownership decision for read, since remotely revoked/purged accounts cannot keep serving through stale snapshots. The resolver returns a blocking shared port for disconnected or detach-pending accounts; undefined is permitted only for never-shared or positively verified-independent ownership.

createSharedCredentialPort reads the local account revision and persisted generation, imports any newer remote state and maps coordinator results back to the existing CredentialPort updated/superseded shape. If expected local revision has changed, return superseded before exchange. A resolved cloud generation is not a SQLite revision. Treat local import failure after cloud publication as recoverable, never as a reason to exchange again.

Wire resolveShared in plugin-account.ts for runtime and control-plane contexts so catalog/quota/manual refresh reuse it. Audit every credentials.refresh call and built-in direct refresh request. Disable internal adapter transport retries that could replay an uncertain rotating refresh token; their error propagation must reach the coordinator. Do not alter model request retries or routing candidate behavior.

- [ ] **Step 4: Verify across existing callers.**

Run: rtk proxy bun test packages/core/src/plugins/credential-port packages/core/src/sync/oauth/account-import
Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/credential-refresh
Expected: PASS for mixed runtime/control-plane use, diagnostics/redaction and all old local lease tests. Add an integration test where a shared account is purged while an old Provider snapshot still exists; the stale port must refuse refresh.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/plugins/credential-port.ts packages/core/src/plugins/credential-port packages/core/src/plugins/repository packages/core/src/sync/oauth/account-import packages/server/src/plugin-account.ts packages/server/src/credential-refresh packages/server/src/server-state/types.ts packages/types/src/plugin.ts
rtk git commit -m "feat(core): route shared account refresh through sync coordination" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 4: Serialize first-share, relogin and verified local detachment

**Files:**

- Create: packages/core/src/sync/oauth/sharing/index.ts, sharing.ts, detach.ts, sharing.test.ts.
- Modify: packages/core/src/plugins/account-login/login.ts, packages/core/src/plugins/account-login/login/stage.ts, packages/core/src/plugins/account-login/recovery.ts.
- Modify: packages/server/src/oauth-login-session/manager.ts, packages/server/src/plugin-account.ts.
- Modify: packages/core/src/sync/oauth/index.ts.

**Interfaces:**

~~~ts
export interface OAuthSharingService {
  share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'>;
  replaceShared(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void>;
  detach(providerId: string, candidate: AccountWrite, signal: AbortSignal):
    Promise<'independent' | 'pending'>;
  cancelDetach(providerId: string): void;
}
export function createOAuthSharingService(input: {
  binding: LocalBinding; repo: SyncRepository; accounts: PluginRepository;
  store: SyncObjectStore;
  resolveAdapter(providerId: string): { adapter: OAuthAdapter; pluginVersion: string };
  withProviderGate<T>(providerId: string, run: () => Promise<T>): Promise<T>;
}): OAuthSharingService;
~~~

withProviderGate serializes local runtime/control-plane refresh and login/removal/first-share for that Provider. It waits for an existing local exchange to finish, including late result persistence; switching state must not leave a local refresher running against newly shared credentials. Cross-device first-share/replace still uses account CAS.

- [ ] **Step 1: Test non-independent login and sharing handoff.**

~~~ts
import { expect, test } from 'bun:test';
import { withOAuthSharingFixture } from '../test-support';

test('different token strings do not complete independent detachment', async () => {
  await withOAuthSharingFixture(async (f) => {
    f.replaceAdapter({ ...f.adapter, credentialSync: { formatVersion: 1, canDetach: async () => false } });
    const candidate = { ...f.accountWrite, credential: { token: 'different-token' } };
    expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
    expect(f.ownership().mode).toBe('detach-pending');
    expect(f.currentCredential()).toEqual({ token: 'shared-token' });
  });
});
~~~

Use an adapter returned from a fixture resolver instead of assigning readonly adapter metadata. withOAuthSharingFixture supplies a replaceAdapter(adapter) method, a real repository/account write, the service/gate and ownership/currentCredential accessors. Its network exchanges are controlled promises. Add a test that begins local refresh, requests share, resolves the rotation and confirms that only the new credential is seeded remotely.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/oauth/sharing/sharing.test.ts
Expected: FAIL missing sharing transitions.

- [ ] **Step 3: Implement guarded transitions.**

~~~ts
const verified = adapter.credentialSync?.canDetach === undefined
  ? false
  : await adapter.credentialSync.canDetach({
      shared: sharedCredential, candidate: candidate.credential, signal,
    });
if (!verified) return 'pending';
~~~

Only after verified succeeds and the local gate confirms no active exchange may detach commit the independent account and ownership marker atomically. Store candidate credentials in a local pending journal with 0600 protection while verification is pending; never replace the shared current row prematurely. cancelDetach erases that candidate and keeps shared coordination. Configuration exclusion may already be active independently.

share validates metadata/schema, reads the exact current local account under the gate, CAS creates the remote object at generation 0, journals unknown outcomes and then records shared ownership before releasing the gate. A remote existing account triggers preview/reconciliation, never last-writer-wins credential seeding.

replaceShared is an explicit login/import operation. Coordinate against current refresh state; unknown in-flight rotation keeps it pending until safely resolved or the adapter-specific new authorization evidence permits replacement. Publish the new account generation by CAS and recover local application. Preserve old local rollback/account-operation behavior. A backend switch cannot seed a copy of the same credential into two independently refreshing spaces: either continue old coordination while pending or obtain verified independent authorization for the new binding.

- [ ] **Step 4: Verify transitions and failures.**

Run: rtk proxy bun test packages/core/src/sync/oauth/sharing/sharing.test.ts packages/core/src/plugins/account-login
Expected: PASS for share race, failed cloud acknowledgement, backend switch, login failure, cancellation, independent detachment, purge and crash/reopen. Local-only copies retain configuration without being silently permitted to rotate shared tokens.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/oauth packages/core/src/plugins/account-login packages/server/src/oauth-login-session/manager.ts packages/server/src/plugin-account.ts
rtk git commit -m "feat(core): verify OAuth sharing and local detachment" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 5: Add adapter metadata and verify only supported multi-device claims

**Files:**

- Modify: packages/plugins/claude-code/src/plugin/plugin.ts.
- Modify: packages/plugins/cursor/src/plugin/plugin.ts.
- Modify: packages/plugins/google-antigravity/src/plugin.ts.
- Modify: packages/plugins/kimi-code/src/plugin.ts.
- Modify: packages/plugins/openai-chatgpt/src/plugin/plugin.ts.
- Modify: packages/plugins/xai-grok/src/plugin.ts.
- Modify: packages/plugins/github-copilot/src/plugin.ts.
- Modify: packages/plugins/openrouter/src/plugin/plugin.ts.
- Modify: packages/plugins/muse-code/src/plugin/plugin.ts.
- Create: packages/core/src/sync/oauth/adapter-conformance.ts, adapter-conformance.test.ts.
- Create: scripts/verify-oauth-sync.ts.
- Modify: docs/testing/oauth-sync.md.
- Create at execution time: docs/testing/evidence/oauth-sync.json.

**Interfaces:**

~~~ts
export interface OAuthSyncEvidence {
  plugin: string; pluginVersion: string; capability: string; formatVersion: number;
  testedAt: string; upstream: string;
  copiedUse: 'pass' | 'fail' | 'blocked';
  rotation: 'pass' | 'fail' | 'not-applicable' | 'blocked';
  uncertainRecovery: 'pass' | 'fail' | 'blocked';
  deviceBinding: 'pass' | 'fail' | 'blocked';
  loginEffects: 'pass' | 'fail' | 'blocked';
  independentDetach: 'pass' | 'fail' | 'blocked';
}
export function evaluateOAuthEvidence(evidence: OAuthSyncEvidence):
  { multiDevice: boolean; independentDetach: boolean };
~~~

These are the verified adapter declaration/registration sites. Update each adapter declaration; its index.ts only reexports the package entry. All nine built-ins initially declare credentialSync: { formatVersion: 1 }; only actual passed evidence adds multiDevice.evidenceId or canDetach.

- [ ] **Step 1: Test evidence does not overclaim.**

~~~ts
import { expect, test } from 'bun:test';
import { evaluateOAuthEvidence } from './adapter-conformance';

test('copied credential success alone does not verify a rotating adapter', () => {
  expect(evaluateOAuthEvidence({
    plugin: '@example/oauth', pluginVersion: '1.0.0', capability: 'oauth', formatVersion: 1,
    testedAt: '2026-09-08T00:00:00Z', upstream: 'fixture',
    copiedUse: 'pass', rotation: 'blocked', uncertainRecovery: 'blocked',
    deviceBinding: 'blocked', loginEffects: 'blocked', independentDetach: 'blocked',
  })).toEqual({ multiDevice: false, independentDetach: false });
});
~~~

This test protects the product activation gate, not static metadata literals.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/oauth/adapter-conformance.test.ts
Expected: FAIL missing evidence evaluator.

- [ ] **Step 3: Implement gating and an explicit live runner.**

~~~ts
export function evaluateOAuthEvidence(e: OAuthSyncEvidence) {
  const multiDevice = e.copiedUse === 'pass'
    && (e.rotation === 'pass' || e.rotation === 'not-applicable')
    && e.uncertainRecovery === 'pass'
    && e.deviceBinding === 'pass'
    && e.loginEffects === 'pass';
  return { multiDevice, independentDetach: multiDevice && e.independentDetach === 'pass' };
}
~~~

verify-oauth-sync.ts requires --plugin and --live, reads local test-account credentials through the existing account repository without printing them, uses two isolated local configurations sharing the same remote test account object, and writes redacted evidence. Do not use real user's production token rotation as an implicit test.

For each adapter: authenticate a dedicated test account, copy eligible current state, use it on both devices, force/simulate expiry, concurrently request refresh, interrupt after upstream exchange, recover a journaled result, then test login and revocation effects. Kimi must separately prove deviceId portability. Copilot tests long-lived GitHub authorization plus derived short-lived token behavior. OpenRouter/Muse have no refresh function, so rotation is not-applicable but copied use/revocation/login/independence still require verification.

A deterministic fake endpoint proves the host's concurrency handling; it cannot certify an upstream's rotation or revocation policy. Record blocked/live failures and keep those versions pending activation. Update metadata only for evidence matching exact package/version/format. Do not invent an independence checker that compares token strings.

- [ ] **Step 4: Verify all core and adapter tests.**

Run: rtk proxy bun test packages/core/src/sync/oauth packages/core/src/plugins/credential-port
Run: rtk proxy bun run test:unit
Expected: PASS deterministic tests. For each claimed supported adapter, run the live runner and record actual evidence. Release may include copying for unverified adapters with explicit pending activation, but must not advertise them as automatically usable on another device.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugin-sdk packages/core/src/sync/oauth packages/plugins scripts/verify-oauth-sync.ts docs/testing/oauth-sync.md docs/testing/evidence/oauth-sync.json
rtk git commit -m "feat(plugins): gate multi-device OAuth on adapter evidence" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

## Handoff

Shared refresh safety is complete only when runtime/control-plane callers, first-share, relogin, detachment and restart all pass together. Adapter readiness remains per version. Carry failed/blocked live checks to the release checklist instead of silently relaxing the coordinator.
