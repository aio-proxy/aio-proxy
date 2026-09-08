# Configuration Sync — Product Integration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose selective sync through the background service, Dashboard and CLI, then release only verified capabilities.

**Architecture:** One server-owned control plane binds the engine and OAuth coordinator to committed config, local activation and existing authentication. UI and CLI consume the same redacted previews and mutation contracts; the background service owns the native lifetime.

**Tech Stack:** Bun 1.4.2+, Hono 4, Zod 4, React 19, TanStack Query/Form/Router, shared UI, Rstest, Changesets and macOS release tooling.

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

Requires all deterministic tests in the core, CloudKit and OAuth plans. Native/live adapter gates are checked again in Task 6. This plan does not change generation routing, Provider priority or Provider weight.

## File structure

| Path | Responsibility |
| --- | --- |
| packages/server/src/sync-control-plane/ | Binding, activation, previews, operations and status. |
| packages/server/src/server-state/ | Startup/recovery/ownership and awaited shutdown integration. |
| packages/server/src/config-store/ | Finalized mutation hooks composed with existing account recovery. |
| packages/types/src/sync/ | Shared redacted DTOs and Zod request/response schemas. |
| packages/server/src/dashboard-routes/sync/ | Hono routes delegating to the control plane. |
| packages/dashboard/src/lib/sync/ | Shared typed client/query/mutation code for both Settings and Providers. |
| packages/dashboard/src/modules/settings/components/sync-settings-group/ | Connection/history/pending/purge controls. |
| packages/dashboard/src/modules/settings/components/sync-preview-dialog/ | Entity diff, dependency disclosure and explicit decisions. |
| packages/dashboard/src/modules/providers/components/provider-sync-control/ | Per-Provider range and detachment status. |
| packages/cli/src/sync/ | Commands that call the running service. |
| packages/i18n/messages/*.json | All product copy, including CLI output. |

Do not import one Dashboard module from another. Shared synchronization code belongs in src/lib/sync; Settings owns its components and Providers owns its controls. Use one React component per TSX and shared @aio-proxy/ui controls.

### Task 1: Integrate committed capture, startup recovery and shutdown

**Files:**

- Create: packages/server/src/sync-control-plane/index.ts, lifecycle.ts, local-port.ts, lifecycle.test.ts, test-support.ts.
- Move: packages/server/src/config-store.ts to config-store/config-store.ts; create export-only config-store/index.ts.
- Create: packages/server/src/config-store/sync-commit.test.ts.
- Modify: packages/server/src/server-state/index.ts, lifecycle.ts, types.ts, snapshot.ts, recovery.ts.
- Modify: packages/server/src/server/server.ts.
- Modify: packages/core/src/plugins/account-login/login/stage.ts, packages/core/src/plugins/repository/plugin-state.ts.
- Modify: packages/server/src/plugin-control-plane/index.ts.
- Modify: packages/cli/src/run/run.ts (shutdownProxyServer), packages/cli/src/run/run.test.ts.
- Create: packages/server/src/sync-control-plane/activation.ts, activation.test.ts.

**Interfaces:**

~~~ts
export interface ServerSyncLifecycle {
  start(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
  onCommitted(input: { commitId: string; origin: 'local' | 'remote' }): Promise<void>;
}
export function createServerSyncLifecycle(input: {
  configPath: string; repo: SyncRepository; accounts: PluginRepository;
  registry(): PluginRegistry; enqueue: FifoQueue;
  applyCandidate(raw: Record<string, JsonValue>, origin: 'local' | 'remote'): Promise<void>;
}): ServerSyncLifecycle;
// ServerState and CreateServer return value add:
closeAsync(): Promise<void>;
~~~

ServerState.sync is the control plane from Task 2; this lifecycle's local port implements LocalSyncPort from core Task 8. At startup pass a local connection dataDirectory under the config directory to the plugin connect context, and never synchronize it.

- [ ] **Step 1: Add lifecycle and rejected-commit tests.**

~~~ts
import { expect, test } from 'bun:test';
import { withServerSyncFixture } from './test-support';

test('plugin snapshot rebuild does not duplicate sync sessions and close drains before DB close', async () => {
  await withServerSyncFixture(async (f) => {
    await f.start();
    await f.state.reload();
    await f.state.reload();
    expect(f.connectCount()).toBe(1);
    await f.state.closeAsync();
    expect(f.events()).toEqual(['connected', 'aborted', 'disposed', 'database-closed']);
  });
});
~~~

Define withServerSyncFixture(run): Promise<void> using the existing server test lifecycle/openDb and a registered fake SyncBackendDefinition. The fixture supplies start(), state, connectCount(), events(), controlled commit rejection and restart hooks; it closes any surviving state in finally. Observe real disposal/database closure, not callbacks whose ordering is preprogrammed.

Add tests for failed raw config verification, OAuth account compensation, plugin_secret update, settings mutation, manual file reload and remote import. Inspect the real outbox: only finalized local changes appear.

- [ ] **Step 2: Run.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane/lifecycle.test.ts src/config-store/sync-commit.test.ts
Expected: FAIL missing lifecycle/closeAsync or missing capture hooks.

- [ ] **Step 3: Wire recovery before runtime and capture after finalization.**

~~~ts
let closePromise: Promise<void> | undefined;
function closeAsync(): Promise<void> {
  if (closePromise) return closePromise;
  sync.abort();
  closePromise = sync.close().finally(() => closeRemainingResources());
  return closePromise;
}
~~~

Define closeRemainingResources(): void by moving the existing non-sync resource cleanup order from assembleServerState; retain exactly-once database lock release. close(): void starts immediate cancellation and initiates the same cleanup promise, reporting errors through the existing logger. When no sync resources exist preserve the existing synchronous close path. CLI run/shutdown and startup-error unwinding await closeAsync when available, so result journals finish before DB close.

Startup sequence: acquire DB ownership → migrate/open → reconcile existing pending account/config operations → recover sync commit/result journals and ownership → build snapshots with ownership-aware CredentialPorts → connect the selected backend → instantiate coordinator/engine → start polling. Do not run the engine from plugin setup or on each snapshot rebuild.

Config-store mutations prepare a sync intent under the same FIFO/config ownership fence, compose existing beforeCommit/afterCommit account hooks, and confirm only once all local account operations are settled. For external file edits, capture after successful reload under that fence, without recursively acquiring a lock already held by a mutation. Remote apply passes origin remote end-to-end, including reload watcher suppression/baseline.

Plugin-secret writes become part of a logical commit only after the actual secret write and runtime validation/finalization. Login/import/removal uses the account-operation journal's completion point. Automatic shared credential updates go through the OAuth coordinator and do not generate config-history entries.

- [ ] **Step 4: Add dependency-aware activation.**

~~~ts
export async function activateDesired(input: ActivationInput): Promise<ActivationResult> {
  const pending = await checkPrerequisites(input);
  if (pending !== undefined) return { applied: false, pending };
  await input.apply(input.raw, 'remote');
  return { applied: true };
}
~~~

Define ActivationInput = { raw: Record<string, JsonValue>; body: EntityBody; apply(raw: Record<string, JsonValue>, origin: 'remote'): Promise<void>; dependencies: { installedPackages: ReadonlyMap<string, string>; missingEnv: readonly string[]; oauthVerified: boolean; credentialValid: boolean } }. checkPrerequisites(input): Promise<PendingReason | undefined> checks exact plugin version, env references, credential validation, same Provider ID/global identity collision and incoming OAuth evidence. Local-origin existing OAuth accounts can continue coordinated use without claiming new multi-device certification; remote copies require it.

Preserve desired state before attempting activation. Keep unaffected runtime Providers and valid auth on invalid imports. Deleted/purged accounts or required plugin dependencies disable affected usage even if an old snapshot exists. Install a missing plugin only through the existing local confirmation flow.

- [ ] **Step 5: Verify and commit.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane src/config-store
Run: rtk proxy bun run --filter @aio-proxy/cli test
Expected: PASS startup failure paths, restart, synchronous legacy close and awaited shared-session shutdown.

~~~sh
rtk git add packages/server/src packages/core/src/plugins/account-login/login/stage.ts packages/core/src/plugins/repository/plugin-state.ts packages/cli/src/run
rtk git commit -m "feat(server): own sync lifecycle and committed activation" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 2: Implement redacted previews and the shared control plane

**Files:**

- Create: packages/types/src/sync/index.ts, sync.ts, sync.test.ts; modify packages/types/src/index.ts.
- Create: packages/server/src/sync-control-plane/control-plane.ts, preview.ts, preview.test.ts, operations.ts, status.ts.
- Modify: packages/server/src/sync-control-plane/index.ts, packages/server/src/server-state/types.ts.

**Interfaces:**

~~~ts
export type SyncConnectionState =
  'disconnected' | 'connecting' | 'preview-required' | 'syncing' | 'idle' |
  'offline' | 'quota' | 'identity-changed' | 'upgrade-required' | 'error';
export interface ProviderSyncView {
  providerId: string; objectId: string; included: boolean;
  credentialState: 'local' | 'shared' | 'unverified' | 'refresh-deferred' |
    'result-uncertain' | 'login-required' | 'detach-pending' | 'independent';
  pendingReason: string | null;
}
export interface SyncStatus {
  state: SyncConnectionState;
  backend: { plugin: string; capability: string; spaceId: string } | null;
  providers: ProviderSyncView[]; pendingOperations: number; lastSuccessAt: number | null;
}
export interface SyncBackendView {
  plugin: string; capability: string; displayName: DashboardLocalizedText;
  form: DashboardOAuthFormField[];
}
export type SyncPreviewInput =
  | { kind: 'connect'; plugin: string; capability: string; options: JsonValue }
  | { kind: 'join'; providerId: string }
  | { kind: 'restore'; objectId: string; operationId: string }
  | { kind: 'overrides'; objectId: string; paths: string[][] }
  | { kind: 'purge'; scope: 'provider' | 'plugin'; objectId: string };
export interface SyncPreviewRow {
  objectId: string; logicalKey: string; kind: string;
  change: 'add' | 'update' | 'delete' | 'conflict';
  local: JsonValue | null; cloud: JsonValue | null;
  secretChange: 'none' | 'added' | 'changed' | 'removed';
  dependencies: string[]; choices: ('local' | 'cloud' | 'restore')[];
}
export interface SyncPreview {
  previewId: string; kind: SyncPreviewInput['kind']; rows: SyncPreviewRow[];
  retainedSharedPlugins: string[]; expiresAt: number;
}
export interface SyncApplyInput {
  previewId: string;
  decisions: { objectId: string; choice: 'local' | 'cloud' | 'restore'; newProviderId?: string }[];
}
export interface SyncHistoryItem {
  operationId: string; objectId: string; writtenAt: number; current: boolean;
}
export interface SyncControlPlane {
  backends(): SyncBackendView[];
  status(): SyncStatus;
  preview(input: SyncPreviewInput): Promise<SyncPreview>;
  apply(input: SyncApplyInput): Promise<SyncStatus>;
  setRange(providerId: string, included: false): Promise<SyncStatus>;
  detach(providerId: string, loginSessionId: string): Promise<SyncStatus>;
  cancelDetach(providerId: string): Promise<SyncStatus>;
  history(objectId: string): Promise<SyncHistoryItem[]>;
  retry(): Promise<SyncStatus>;
  disconnect(): Promise<SyncStatus>;
}
~~~

Each DTO/request has a matching exported Zod schema. Reuse DashboardLocalizedText and DashboardOAuthFormField from their existing types modules for backend metadata; form entries expose configured flags only, never saved secret values. backends() maps registry.syncCapabilities() through the existing form localization/redaction rules. Inclusion uses preview/apply; setRange only accepts false to avoid bypassing rejoin review. A purge preview/apply uses no entity value decision; it still binds exact versions and scope. The token is random, one-use and local, expires in 10 minutes and is invalidated by process restart. It is not an authorization credential. Store secret-bearing preview candidates in a private in-memory map, not the returned rows.

- [ ] **Step 1: Test stale preview and secret redaction.**

~~~ts
import { expect, test } from 'bun:test';
import { withSyncControlFixture } from './test-support';

test('rejoin preview expires when either side changes and never returns token bytes', async () => {
  await withSyncControlFixture(async (f) => {
    const preview = await f.control.preview({ kind: 'join', providerId: 'work' });
    expect(JSON.stringify(preview)).not.toContain('work-refresh-secret');
    expect(JSON.stringify(preview)).not.toContain('plugin-secret');
    await f.changeRemoteProvider();
    await expect(f.control.apply({
      previewId: preview.previewId,
      decisions: preview.rows.map((r) => ({ objectId: r.objectId, choice: 'local' })),
    })).rejects.toMatchObject({ code: 'preview-stale' });
  });
});
~~~

withSyncControlFixture extends the real server fixture with control, changeRemoteProvider(), state inspection and seeded local/cloud differences. It uses real CAS objects and a token generator with injectable time for expiry tests.

- [ ] **Step 2: Run.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane/preview.test.ts
Expected: FAIL missing preview/state service.

- [ ] **Step 3: Implement exact preview baselines and operations.**

~~~ts
interface PreviewFence {
  bindingId: string; sessionGeneration: number; localCommitId: string;
  rangeRevision: number; remoteVersions: Record<string, string | null>;
}
function sameFence(a: PreviewFence, b: PreviewFence): boolean {
  return a.bindingId === b.bindingId
    && a.sessionGeneration === b.sessionGeneration
    && a.localCommitId === b.localCommitId
    && a.rangeRevision === b.rangeRevision
    && JSON.stringify(Object.entries(a.remoteVersions).sort())
      === JSON.stringify(Object.entries(b.remoteVersions).sort());
}
~~~

preview.ts captures the fence, redacts known config/API/password/account/plugin secret subtrees and all backend options, and stores unredacted candidates privately. Secret comparison is done locally; return only changed/presence flags, not raw values or hashes. For arbitrary secret form fields use existing ConfigSpec secret metadata; redact whole account credential/secrets and plugin secret records regardless of field names.

apply rereads remote versions and local fence before applying the chosen entities. A later racing cloud write is resolved through CAS; a failed preview version does not silently turn into an ordinary overwrite. Same-ID conflicts require newProviderId or explicit choosing one identity; validate structured model/account references under the new mapping. Remote tombstones require choice restore, never ordinary local. Rollback restores config only and uses current OAuth state.

Expose plugin dependency details automatically without an additional checkbox. Purge lists retained shared plugin records, computes current cloud dependents for plugin scope and uses core purgeEntity; status stays pending until verified. Independent local-only copies are not overwritten/deleted. Leaving range persists exclusion first; shared OAuth detachment is a separate pending transition using the login session result stored locally.

The overrides preview pins selected business option subtrees to their current raw local values, including an explicit missing value. Paths are segments relative to that entity, with arrays selected only at their root. Allow Provider/plugin business options; do not offer backend authorization, forced-local proxy fields or portions of the required whole plugin secret record as configurable sharing toggles. Removing a pinned path previews the resulting shared entity before applying it. Persist range/override changes locally and reproject through core Task 4. Pinning affects future projection and does not silently purge existing cloud history.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/types/src/sync
Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane
Expected: PASS first connection/rejoin, local exclusions, identity switch, same-ID conflict, stale previews, history restore and all purge boundaries.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/types/src/sync packages/types/src/index.ts packages/server/src/sync-control-plane packages/server/src/server-state/types.ts
rtk git commit -m "feat(server): add sync previews and operations" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 3: Expose authenticated typed routes without leaking secret state

**Files:**

- Create: packages/server/src/dashboard-routes/sync/index.ts, sync.ts, sync.test.ts.
- Modify: packages/server/src/dashboard-routes/config.ts.
- Modify: packages/server/src/dashboard-events.ts, packages/types/src/dashboard/dashboard.ts (DashboardEventSchema).
- Modify: packages/server/src/server/server.ts only where auth wiring/types require it.

**Interfaces:**

Routes under /dashboard/api/sync:

| Method/path | Request → response |
| --- | --- |
| GET / | no input → SyncStatus |
| GET /backends | no input → { backends: SyncBackendView[] } |
| POST /preview | SyncPreviewInput → SyncPreview |
| POST /apply | SyncApplyInput → SyncStatus |
| PUT /range | { providerId, included: false } → SyncStatus |
| POST /detach | { providerId, loginSessionId } → SyncStatus |
| POST /detach/cancel | { providerId } → SyncStatus |
| GET /history/:objectId | path objectId → { items: SyncHistoryItem[] } |
| POST /retry | no input → SyncStatus |
| POST /disconnect | no input → SyncStatus |

Errors: { ok: false, error: { code: 'preview-stale' | 'invalid-request' | 'not-connected' | 'dependency-in-use' | 'operation-pending' | 'upgrade-required' | 'backend-unavailable' } }, with 409 for stale/state conflict, 400 invalid input and 503 offline. Existing auth failures retain existing 401/403 behavior. Add sync.changed Dashboard event carrying status categories only; clients refetch typed status.

- [ ] **Step 1: Test the public route contract and access protection.**

~~~ts
import { expect, test } from 'bun:test';
import { withSyncRoutesFixture } from '../../sync-control-plane/test-support';

test('API requires existing dashboard auth and returns no backend secrets', async () => {
  await withSyncRoutesFixture(async (f) => {
    const denied = await f.request('/dashboard/api/sync', { authenticated: false });
    expect(denied.status).toBe(401);
    const allowed = await f.request('/dashboard/api/sync', { authenticated: true });
    expect(allowed.status).toBe(200);
    const body = await allowed.text();
    expect(body).not.toContain('backend-secret');
    expect(body).not.toContain('work-refresh-secret');
  });
});
~~~

withSyncRoutesFixture mounts the actual createServer route/auth stack, logs in with a test password and sends its bearer token. It also supports a password-disabled loopback case to test existing Host/Origin/DNS-rebinding protections. Do not test authorization solely against an isolated unprotected router.

- [ ] **Step 2: Run.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/dashboard-routes/sync/sync.test.ts
Expected: FAIL route absent.

- [ ] **Step 3: Add thin Hono handlers and typed validation.**

~~~ts
export const createSyncRoutes = (sync: SyncControlPlane) =>
  new Hono()
    .get('/', (c) => c.json(sync.status()))
    .post('/preview', validator('json', (raw, c) => {
      const parsed = SyncPreviewInputSchema.safeParse(raw);
      return parsed.success ? parsed.data
        : c.json({ ok: false, error: { code: 'invalid-request' } }, 400);
    }), async (c) => c.json(await sync.preview(c.req.valid('json'))));
~~~

Add the remaining routes using the schemas from Task 2; put exception-to-code mapping in one private handler wrapper. Never stringify raw thrown plugin/native errors into API responses. Register .route('/sync', createSyncRoutes(state.sync)) in createDashboardRoutes. Keep existing Dashboard bearer/loopback/Origin middleware in the parent; do not add an unauthenticated administrative shortcut for the CLI.

- [ ] **Step 4: Verify and commit.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/dashboard-routes/sync src/dashboard-auth
Expected: PASS for authorized calls, disabled-password loopback, wrong Origin/Host, secret redaction and all mutation error codes.

~~~sh
rtk git add packages/server/src/dashboard-routes packages/server/src/dashboard-events.ts packages/server/src/server/server.ts packages/types/src
rtk git commit -m "feat(server): expose typed sync management endpoints" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 4: Add Dashboard connection, Provider range and preview flows

**Files:**

- Create: packages/dashboard/src/lib/sync/index.ts, service.ts, hooks.ts, service.test.ts.
- Modify: packages/dashboard/src/lib/query-keys.ts.
- Create: packages/dashboard/src/modules/settings/components/sync-settings-group/index.ts, sync-settings-group.tsx, sync-settings-group.test.tsx.
- Create: packages/dashboard/src/modules/settings/components/sync-preview-dialog/index.ts, sync-preview-dialog.tsx, sync-preview-dialog.test.tsx.
- Create: packages/dashboard/src/modules/settings/components/sync-history-dialog/index.ts, sync-history-dialog.tsx.
- Create: packages/dashboard/src/modules/providers/components/provider-sync-control/index.ts, provider-sync-control.tsx, provider-sync-control.test.tsx.
- Modify: packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx.
- Modify: packages/dashboard/src/modules/providers/templates/provider-editor-page/provider-editor-page.tsx.
- Modify: packages/i18n/messages/en.json, zh-Hans.json, zh-Hant.json, ja.json, ko.json.

**Interfaces:**

~~~ts
export function syncQueryOptions(): ReturnType<typeof queryOptions<SyncStatus>>;
export function previewSync(input: SyncPreviewInput): Promise<SyncPreview>;
export function applySync(input: SyncApplyInput): Promise<SyncStatus>;
export function useSyncStatus(): UseQueryResult<SyncStatus>;
export interface ProviderSyncControlProps {
  state: ProviderSyncView;
  onEnable(): Promise<void>;
  onExclude(): Promise<void>;
  onDetach(): Promise<void>;
}
~~~

Service wrappers for every Task 3 route use createDashboardClient from @/lib/dashboard-client. hooks.ts exposes useMutation wrappers invalidating sync status and affected Provider/settings data after success; no component direct fetch. Add syncBackendsQueryOptions() for GET /sync/backends and render its normalized form metadata. If CloudKit is not installed, link to the existing Plugins management page with the package name @aio-proxy/plugin-cloudkit; installation stays an explicit local action. Do not send schema executable functions or saved authorization values.

- [ ] **Step 1: Test user-visible choice boundaries.**

~~~tsx
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProviderSyncControl } from './provider-sync-control';

test('excluding a Provider calls range change and never purges cloud data', () => {
  const onExclude = rs.fn().mockResolvedValue(undefined);
  render(<ProviderSyncControl
    state={{
      providerId: 'work', objectId: 'object-work', included: true,
      credentialState: 'shared', pendingReason: null,
    }}
    onEnable={rs.fn()} onExclude={onExclude} onDetach={rs.fn()}
  />);
  fireEvent.click(screen.getByRole('switch', { name: /Sync this Provider|同步此 Provider/u }));
  expect(onExclude).toHaveBeenCalledTimes(1);
});
~~~

Add preview tests for plugin-secret dependency disclosure without a second toggle, stale preview retry, no revealed secrets, same-ID rename resolution, missing plugin confirmation, pending OAuth verification/detachment and purge scope showing retained shared plugins. Test focus restoration and submit disablement during mutation.

Add a business-option local override editor in the preview dialog using TanStack Form and the overrides preview input. Test pinning a nested option, retaining it after an incoming change, and requiring a new preview when that pin is removed.

- [ ] **Step 2: Run.**

Run in packages/dashboard: rtk proxy bunx rstest run src/modules/providers/components/provider-sync-control src/modules/settings/components/sync-preview-dialog
Expected: FAIL missing components/service.

- [ ] **Step 3: Implement typed services, forms and status.**

~~~ts
export const syncQueryOptions = () => queryOptions({
  queryKey: ['sync'],
  queryFn: async (): Promise<SyncStatus> => {
    const response = await createDashboardClient().dashboard.api.sync.$get();
    if (!response.ok) throw new Error('SYNC_STATUS_FAILED');
    return response.json();
  },
});
export async function previewSync(input: SyncPreviewInput): Promise<SyncPreview> {
  const response = await createDashboardClient().dashboard.api.sync.preview.$post({ json: input });
  if (!response.ok) throw new Error('SYNC_PREVIEW_FAILED');
  return response.json();
}
~~~

Move query key into queryKeys.sync. Use TanStack Form with Zod for backend options, per-entity decisions and same-ID rename. Use shared Switch/Dialog/Alert/Button/Table controls; history table uses TanStack Table. ProviderSyncControl shows local-only initially, and onEnable opens the shared preview service from the parent. It never automatically checks shared plugin secret consent a second time. On exclusion, explain existing cloud copies remain; show detach-pending if credentials are still shared.

Add these exact message concepts in all five locales, translated naturally: sync this Provider; new local Providers stay local; required plugin settings and secrets are included; keep cloud copies when leaving; clear this Provider's cloud configuration/history/account; shared plugin data will remain; cloud changed, review again; credential copied, verification pending; refresh deferred while offline; result uncertain, login required; independent authorization not confirmed. Do not expose refresh-generation/CAS/IPC details in user flow copy.

- [ ] **Step 4: Verify Dashboard and i18n.**

~~~sh
rtk proxy bun run i18n:compile
rtk proxy bun run --filter @aio-proxy/dashboard test
rtk proxy bun run --filter @aio-proxy/dashboard build
~~~

Expected: PASS. Manually inspect Settings and Provider editor at desktop/narrow widths, keyboard-only preview/restore/purge, empty/offline/loading/error states and all locale fallback behavior. Do not edit generated routeTree.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/dashboard/src/lib packages/dashboard/src/modules/settings packages/dashboard/src/modules/providers packages/i18n
rtk git commit -m "feat(dashboard): add selective sync controls and previews" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 5: Add CLI commands against the existing service/authentication

**Files:**

- Create: packages/cli/src/sync/index.ts, commands.ts, client.ts, output.ts, commands.test.ts.
- Modify: packages/cli/src/main.ts, packages/cli/src/main.test.ts.
- Modify: packages/i18n/messages/en.json, zh-Hans.json, zh-Hant.json, ja.json, ko.json.
- Create: docs/config-sync.md.

**Interfaces:**

~~~ts
export function registerSyncCommands(program: Command, deps: SyncCliDeps): void;
export interface SyncCliDeps {
  endpoint(): Promise<string>;
  authenticate(): Promise<string | undefined>;
  request(path: string, init: RequestInit): Promise<Response>;
  write(value: string): void;
}
~~~

Use resolveControlAddress/controlBaseUrl for the running service. Reuse existing Dashboard login/bearer policy: when password-protected, obtain the password through a hidden terminal prompt or --password-stdin, exchange it for an in-memory token and never log/cache it in config. With auth disabled, preserve the existing allowed local/Origin rules. API keys for model clients are not Dashboard administration tokens. Do not add an unauthenticated /admin/sync route.

CLI surface:

- aio-proxy sync status [--json]
- aio-proxy sync connect --plugin PACKAGE --capability ID --options-file PATH
- aio-proxy sync join PROVIDER_ID
- aio-proxy sync leave PROVIDER_ID
- aio-proxy sync apply PREVIEW_ID --decisions-file PATH
- aio-proxy sync history OBJECT_ID
- aio-proxy sync restore OBJECT_ID OPERATION_ID
- aio-proxy sync overrides OBJECT_ID --paths-file PATH
- aio-proxy sync purge --provider PROVIDER_ID (or --plugin PACKAGE)
- aio-proxy sync detach PROVIDER_ID; aio-proxy sync detach-cancel PROVIDER_ID
- aio-proxy sync retry; aio-proxy sync disconnect

connect/join/restore/purge print a redacted preview and token. apply performs the concrete reviewed operation. Interactive mode may immediately show choices and apply; JSON mode never hides that two-step boundary. Backend secret options live only in the local options file/input and server binding.

- [ ] **Step 1: Test command behavior.**

~~~ts
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerSyncCommands } from './commands';

test('leave excludes the Provider without invoking cloud purge', async () => {
  const calls: string[] = [];
  const program = new Command();
  registerSyncCommands(program, {
    endpoint: async () => 'http://127.0.0.1:9317',
    authenticate: async () => undefined,
    request: async (path, init) => {
      calls.push(path + ' ' + String(init.body));
      return Response.json({ state: 'idle', backend: null, providers: [],
        pendingOperations: 0, lastSuccessAt: null });
    },
    write: () => undefined,
  });
  await program.parseAsync(['node', 'aio-proxy', 'sync', 'leave', 'work']);
  expect(calls).toEqual([
    '/dashboard/api/sync/range {"providerId":"work","included":false}',
  ]);
});
~~~

Add tests for status while service is stopped, password handling without echoed secrets, preview-stale, no local file mutations, detach login session handoff, JSON output and one engine in the existing server.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/cli/src/sync/commands.test.ts
Expected: FAIL missing commands.

- [ ] **Step 3: Implement delegation and readable output.**

~~~ts
program.command('sync').command('leave <providerId>').action(async (providerId: string) => {
  const response = await deps.request('/dashboard/api/sync/range', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, included: false }),
  });
  if (!response.ok) throw new Error('SYNC_RANGE_FAILED');
  deps.write(JSON.stringify(await response.json()));
});
~~~

Create the sync parent once, then register all subcommands. client.ts adds endpoint, same-host Origin and bearer authentication to requests, validates DTOs and maps errors to localized CLI messages. output.ts renders status/previews without raw credentials or native errors. Detach uses the existing OAuth login-session flow and passes only its local session ID to the control plane. A stopped service returns an actionable "start the service" message; CLI never opens the sync database to impersonate the engine.

The overrides command reads a JSON array of path-segment arrays and requests the overrides preview; it never writes SQLite directly. Document new-local default exclusion, automatic cloud discovery, env/local fields and explicit business-option overrides, plugin dependencies, rejoin choices, 30-day history, purge vs leave, backend switching and per-adapter OAuth limits. Include third-party backend author guidance linking SDK conformance.

- [ ] **Step 4: Verify and commit.**

Run: rtk proxy bun run --filter @aio-proxy/cli test
Run: rtk proxy bun run i18n:compile
Expected: PASS command parsing/localization/auth and existing main command tests.

~~~sh
rtk git add packages/cli/src/sync packages/cli/src/main.ts packages/cli/src/main.test.ts packages/i18n docs/config-sync.md
rtk git commit -m "feat(cli): manage sync through the running service" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 6: Integrate signed release artifacts and run the full acceptance matrix

**Files:**

- Modify: .github/workflows/release.yml, scripts/release.ts only where a native build prerequisite is needed.
- Create: packages/server/src/sync-control-plane/acceptance.test.ts.
- Modify: docs/config-sync.md, docs/testing/cloudkit-sync.md, docs/testing/oauth-sync.md.
- Generate with bun changeset: one feature note under .changeset/.
- Modify: .changeset/config.json if the CloudKit package has not already been added.

**Interfaces:**

- Native build/sign/notarize inputs are the exact CLOUDKIT_* names in the CloudKit plan.
- Release must produce the CloudKit native manifest/archive before its npm pack and verify its SDK peer matches the released lockstep SDK.
- Gate result has status pass/fail/blocked with actual command/evidence path. Never substitute a unit mock for native/live evidence.

- [ ] **Step 1: Add a product acceptance scenario.**

~~~ts
import { expect, test } from 'bun:test';
import { withTwoServerSyncFixtures } from './test-support';

test('selected Provider and plugin secrets synchronize; purge leaves an independent local copy', async () => {
  await withTwoServerSyncFixtures(async ({ a, b }) => {
    await a.createAndJoinProvider('work');
    await a.reconcile(); await b.reconcile();
    expect(await b.providerActive('work')).toBe(true);
    await b.excludeWithIndependentCredential('work');
    await a.purgeProvider('work');
    await a.reconcile(); await b.reconcile();
    expect(await a.cloudContainsProviderSecrets('work')).toBe(false);
    expect(await b.providerExists('work')).toBe(true);
    expect(await a.cloudContainsSharedPlugin()).toBe(true);
  });
});
~~~

Define withTwoServerSyncFixtures from two real createServerState instances with separate configuration directories and the shared memory backend. Fixture helpers drive the public control plane/route operations, not direct repo deletion. Use a synthetic adapter whose canDetach is backed by a test upstream issuing genuinely separate token families. Add restart between each acceptance step.

- [ ] **Step 2: Run the focused integration matrix.**

Run in packages/server: rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane/acceptance.test.ts
Expected: PASS with distinct config/account/local-only outcomes. Include committed export/no echo, late offline conflict, tombstone/restore, new cloud discovery, same-ID collision, local model references, expired history, unknown format, identity switch, plugin update failure and shared refresh outage.

- [ ] **Step 3: Wire protected signing into release.**

Add a macOS native artifact preparation step before the existing Changesets publish script, conditionally for an actual release that packages CloudKit. Keep private signing material in the CI credential store, import into a temporary keychain and clean it in an always step. Do not build/sign inside normal Linux/Bun unit tests. The package build verifies the artifact digest/native/plugin version and refuses production packing if native gates are missing.

The existing scripts/release.ts already discovers publishable workspace packages. Do not replace that publish/version pipeline. Add only the native-artifact prerequisite and lockstep artifact checks. Preserve original CLI ad hoc re-signing behavior for its own binary without applying it to the CloudKit bundle.

- [ ] **Step 4: Create the release note through Changesets.**

Run: rtk proxy bun changeset
Select aio-proxy and @aio-proxy/plugin-sdk with minor bumps, plus changed internal packages with matching bumps and the CloudKit package. Review existing unreleased notes for this feature and rewrite/consolidate instead of appending histories. Example body:

~~~text
Add selective configuration sync with an iCloud backend on macOS 14 and later, including required plugin settings, configuration history, and per-device local overrides. Synced OAuth accounts use coordinated refresh and remain pending on other devices until their adapter supports verified multi-device use. Plugin authors can register compatible sync backends through the SDK.
~~~

Use this wording only if the native gate passes and CloudKit ships. If native validation is blocked, the feature is not ready for the agreed release; record that gate instead of silently changing release scope. Do not run changeset version or publish manually.

- [ ] **Step 5: Run final verification and review artifacts.**

~~~sh
rtk proxy bun run preflight
rtk proxy bun run --filter @aio-proxy/dashboard build
rtk proxy bun test packages/plugins/cloudkit/build/artifact.test.ts
rtk proxy swift test --package-path packages/plugins/cloudkit/native
~~~

Expected: PASS. Re-run the CloudKit signed installed-path/two-Mac gate for the final native digest and each adapter's claimed live evidence for the final plugin version. Inspect the packed npm tarball, native signature/entitlements/provisioning, interruption-safe upgrade and service shutdown. Compile/ship i18n, check no secret-bearing test fixtures/evidence/logs have been committed.

If a required environment/test is unavailable, record the command, reason and capability affected as blocked; do not state implementation or native readiness is complete. Ordinary passing checks are not rerun without a changed artifact or unresolved concern.

- [ ] **Step 6: Commit the reviewed release-ready state.**

~~~sh
rtk git add .github/workflows/release.yml scripts/release.ts .changeset docs packages/server/src/sync-control-plane/acceptance.test.ts
rtk git commit -m "feat(sync): complete product integration and release gates" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

## Spec coverage and handoff

| Spec requirements | Implementation tasks |
| --- | --- |
| S01–S03, B01–B07 | Core 1–3/8; CloudKit 1–5; integration 1. |
| S04–S10 | Core 4/8; OAuth 1/4; integration 2/4/5. |
| S11–S14 | Core 6/8; OAuth 3/4; integration 2–5. |
| M01–M08 | Core 2/3/5/8; integration 1/2. |
| D01–D09 | Core 5/6; OAuth 3/4; integration 2/4/6. |
| L01–L08 | Core 3/7/8; OAuth 2/3; integration 1. |
| O01–O06 | OAuth 1/3/4/5; integration 1/4. |
| O07–O13 | OAuth 2–5; integration 1/2/6. |
| C01–C08 | CloudKit 1–5; integration 1/6. |
| Product control plane and acceptance | Integration 1–6, using all three earlier plans. |

After the plans are approved for execution, either use a fresh subagent per task with reviews or execute inline with checkpoints. Do not execute this document during the documentation-only task.
