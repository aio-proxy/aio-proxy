# Configuration Sync — Host and SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backend-neutral, recoverable selective synchronization engine and public storage capability.

**Architecture:** The SDK defines storage sessions; core owns pure projection, per-object CAS protocols and SQLite recovery. Server integration consumes committed-state and activation ports; no transport or OAuth business policy is delegated to storage plugins.

**Tech Stack:** Bun 1.4.2+, TypeScript, Zod 4, Bun SQLite, Drizzle, existing es-toolkit and Bun test.

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

## Execution map

This is the entry plan. Read the spec first. Execute Tasks 1–8 in order. After Task 1, the native entitlement probe in [CloudKit plan](2026-09-08-config-sync-cloudkit.md) can run independently. The complete CloudKit backend and [OAuth plan](2026-09-08-config-sync-oauth.md) consume this plan's contracts. Run [integration and release](2026-09-08-config-sync-integration.md) after all three pass their deterministic tests.

Do not start implementation merely because these documents exist. Native signing/account access and live OAuth validation need their actual execution inputs. A failed live gate produces a recorded result and disabled capability, not a fabricated passing certificate.

## File structure

All paths are relative to repository root.

| Path | Responsibility |
| --- | --- |
| packages/plugin-sdk/src/sync/index.ts, sync.ts | Public backend/session/error contracts. |
| packages/plugin-sdk/src/testing/index.ts, sync-conformance.ts | Public, runner-neutral storage conformance exercise. |
| packages/core/src/plugins/registry/sync.ts | Structural validation of sync backend definitions. |
| packages/core/src/sync/protocol/ | Wire schemas, deterministic keys and pure head/revision transitions. |
| packages/core/src/sync/repository/ | Durable binding, selection, commit/outbox and result-journal persistence. |
| packages/core/src/sync/projection/ | Raw authored config projection and local overlays. |
| packages/core/src/sync/publication/ | Reserve, stage, publish and uncertain-result reconciliation. |
| packages/core/src/sync/cleanup/ | History expiry, deletion, restore and recoverable purge. |
| packages/core/src/sync/local-commit/ | Logical file/account commit capture and recovery ports. |
| packages/core/src/sync/engine/ | Reconcile/poll/watch scheduling, incoming desired state and binding fences. |
| packages/core/src/sync/test-support.ts | Deterministic in-memory backend and local port for core tests only. |
| packages/core/src/db/schema/sync.ts | Five local SQLite tables. |
| packages/core/src/sync/index.ts | Export-only host API, without private collaborators/test helpers. |

Keep the existing 225-line registry.ts as the registry entry and put sync validation in the private registry/sync.ts collaborator. Keep the registry below the project size limit. The current config-file/index.ts contains implementation: when changed in Task 7, move implementation to config-file/config-file.ts and leave exports in index.ts.

### Task 1: Register lazy storage capabilities and enforce CAS contracts

**Files:**

- Create: packages/plugin-sdk/src/sync/index.ts, sync.ts, sync.test.ts.
- Create: packages/plugin-sdk/src/testing/index.ts, sync-conformance.ts.
- Modify: packages/plugin-sdk/src/index.ts, packages/plugin-sdk/src/plugin/plugin.ts, packages/plugin-sdk/package.json, packages/plugin-sdk/rslib.config.ts.
- Modify: packages/core/src/plugins/registry.ts, packages/core/src/plugins/registry.test.ts, packages/core/src/plugins/installed-package.ts.
- Create: packages/core/src/plugins/registry/sync.ts, packages/core/src/plugins/registry/sync.test.ts.
- Modify: packages/server/src/server-state/snapshot.ts (empty registry).
- Create: packages/core/src/sync/test-support.ts.

**Interfaces:**

- Produces all SDK interfaces in spec §5 verbatim plus SyncBackendError extends Error with readonly code: SyncFailureCode.
- Produces registry.resolveSync(plugin: string, capability: string): SyncBackendDefinition<unknown> | undefined and registry.syncCapabilities(): readonly { plugin: string; capability: string; backend: SyncBackendDefinition<unknown> }[].
- Produces exerciseSyncBackend(factory: () => Promise<{ a: SyncSession; b: SyncSession; cleanup(): Promise<void> }>): Promise<void>.
- Test-only createMemorySyncBackend(): MemorySyncBackend; connect(): SyncSession shares a Map across connections. readAll(): ReadonlyMap<string, SyncRead>; advance(ms: number): void; failNext(method: 'read' | 'compareAndSwap', mode: 'before' | 'after'): void; gateNext(method: 'read' | 'compareAndSwap'): { entered: Promise<void>; release(): void }.
- Consumes existing PluginApi, ConfigSpec, LocalizedText, validateConfigSpec and CapabilityIdSchema. Structural validation uses isRecord and binds class instance methods.

- [ ] **Step 1: Add lazy-registration and stale-write tests.**

~~~ts
import { expect, test } from 'bun:test';
import { createPluginRegistryHost } from '../registry';
import { createMemorySyncBackend } from '../../sync/test-support';

test('validation registers without connecting', () => {
  const host = createPluginRegistryHost();
  const stage = host.stage('@example/sync');
  let connections = 0;
  stage.api.sync.register({
    id: 'memory', displayName: 'Memory',
    options: { schema: z.object({}), form: [] },
    async connect() { connections++; return createMemorySyncBackend().connect(); },
  });
  stage.seal();
  stage.commit();
  expect(host.registry.resolveSync('@example/sync', 'memory')).toBeDefined();
  expect(connections).toBe(0);
});

test('two clients cannot both create the same key', async () => {
  const backend = createMemorySyncBackend();
  const a = backend.connect(), b = backend.connect();
  const signal = new AbortController().signal;
  const value = new TextEncoder().encode('secret');
  const results = await Promise.all([
    a.compareAndSwap('k', null, value, signal),
    b.compareAndSwap('k', null, value, signal),
  ]);
  expect(results.filter((r) => r.kind === 'written')).toHaveLength(1);
  expect(results.filter((r) => r.kind === 'conflict')).toHaveLength(1);
});
~~~

Import z from zod. ConfigSpec requires both schema and form as shown. Add rollback-of-staging, sealed registration, class method binding, duplicate IDs, invalid session and old OAuth-only plugin cases.

- [ ] **Step 2: Run the failing tests.**

Run: rtk proxy bun test packages/core/src/plugins/registry/sync.test.ts
Expected: FAIL because sync capability and test backend do not exist.

- [ ] **Step 3: Add contracts, registration and the deterministic backend.**

Copy the spec's storage types exactly. Keep a separate stagedSync Map and committedSync Map; validate/commit both capability sets together. Never call connect from validation. Normalize options with validateConfigSpec, and validate the session when the host actually connects.

The in-memory CAS critical section must contain no await between checking and storing:

~~~ts
function casMemory(
  values: Map<string, Extract<SyncRead, { kind: 'present' }>>,
  key: string, expected: string | null, value: Uint8Array,
  nextVersion: () => string, modifiedAt: number,
): SyncCAS {
  const current = values.get(key);
  if ((current?.version ?? null) !== expected) return { kind: 'conflict' };
  const version = nextVersion();
  values.set(key, { kind: 'present', version, value: value.slice(), modifiedAt });
  return { kind: 'written', version, modifiedAt };
}
~~~

Use monotonically incremented test-only versions and a controllable test clock. Connect returns session wrappers over the same store; fault gates sit before the critical section, and "after" faults throw outcome-unknown after persisting. Deep-copy byte arrays on reads. Dispose aborts only that connection; remaining connections keep working. The conformance exercise uses unique keys, asserts one winning create, stale version rejection, read-back bytes, pagination completeness, conditional remove and disposal, then calls cleanup in finally. Add ./testing to package exports and build entries so third-party backend authors can run it without importing private host code.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/plugins/registry/sync.test.ts packages/core/src/plugins/registry.test.ts
Run: rtk proxy bun run --filter @aio-proxy/plugin-sdk test
Expected: PASS; legacy registry tests stay green. Add the sync capability to emptyPluginSnapshot so server mocks satisfy the registry.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugin-sdk packages/core/src/plugins/registry.ts packages/core/src/plugins/registry packages/core/src/plugins/registry.test.ts packages/core/src/plugins/installed-package.ts packages/core/src/sync/test-support.ts packages/server/src/server-state/snapshot.ts
rtk git commit -m "feat(plugin-sdk): add lazy sync storage capabilities" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 2: Define versioned heads, revisions and pure transitions

**Files:**

- Create: packages/core/src/sync/protocol/index.ts, protocol.ts, schemas.ts, transitions.ts, protocol.test.ts.
- Create: packages/core/src/sync/index.ts.
- Modify: packages/core/src/index.ts.

**Interfaces:**

~~~ts
import type { JsonValue } from '@aio-proxy/plugin-sdk';
export type { JsonValue } from '@aio-proxy/plugin-sdk';
export type EntityKind =
  'provider' | 'model-rule' | 'plugin-business' | 'service-access' | 'routing-defaults';
export interface Dependency { objectId: string; packageName: string; version: string }
export interface EntityBody {
  kind: EntityKind; logicalKey: string; value: JsonValue; dependencies: Dependency[];
}
export interface EntityHead {
  protocol: 1; objectId: string; kind: EntityKind; logicalKey: string;
  epoch: number; sequence: number;
  state: 'active' | 'deleted' | 'purging' | 'purged';
  current: string | null; history: string[]; reserved: string[]; cancelling: string[];
  receipts: Record<string, number>;
  cleanupComplete: boolean;
}
export type RevisionRecord =
  | { protocol: 1; state: 'payload'; objectId: string; epoch: number;
      operationId: string; body: EntityBody; publishedSequence: number | null;
      writtenAt: number | null }
  | { protocol: 1; state: 'erased'; objectId: string; epoch: number;
      operationId: string; publishedSequence: number | null;
      reason: 'expired' | 'purged' | 'abandoned' };
export interface DeletedAccount {
  protocol: 1; phase: 'deleted'; objectId: string; epoch: number;
}
export function entityKey(objectId: string): string;
export function revisionKey(objectId: string, operationId: string): string;
export function accountKey(objectId: string): string;
export function encode(value: unknown): Uint8Array;
export function decodeHead(bytes: Uint8Array): EntityHead;
export function decodeRevision(bytes: Uint8Array): RevisionRecord;
export function reserve(head: EntityHead, operationId: string, epoch: number): EntityHead;
export function publish(head: EntityHead, operationId: string, epoch: number): EntityHead;
export function beginPurge(head: EntityHead): EntityHead;
export function newHead(objectId: string, body: EntityBody): EntityHead;
export class SyncProtocolError extends Error {
  readonly code: 'upgrade-required' | 'deleted' | 'epoch-mismatch' | 'invalid-data';
}
~~~

Keys use the exact namespace in spec §6. UUIDs are validated at external boundaries. newHead begins active/epoch 0/sequence 0 with null current, empty history/reserved/cancelling arrays, an empty receipts map and cleanupComplete true. Error constructors accept the code above and a non-secret message. Reuse the SDK's existing readonly JsonValue type instead of defining another JSON utility type.

- [ ] **Step 1: Add behavior tests.**

~~~ts
import { expect, test } from 'bun:test';
import { beginPurge, newHead, publish, reserve } from '.';

test('a reserved stale edit cannot publish after purge starts', () => {
  const initial = newHead(crypto.randomUUID(), {
    kind: 'provider', logicalKey: 'work', value: { kind: 'api' }, dependencies: [],
  });
  const staged = reserve(initial, 'operation-a', 0);
  const purging = beginPurge(staged);
  expect(() => publish(purging, 'operation-a', 0)).toThrow('deleted');
  expect(purging.reserved).toEqual(['operation-a']);
});

test('publication orders complete entities and keeps prior history', () => {
  let head = newHead(crypto.randomUUID(), {
    kind: 'provider', logicalKey: 'work', value: {}, dependencies: [],
  });
  head = publish(reserve(head, 'a', 0), 'a', 0);
  head = publish(reserve(head, 'b', 0), 'b', 0);
  expect(head).toMatchObject({ current: 'b', history: ['a'], sequence: 2 });
});
~~~

Operation strings in pure reducer tests are fixture identifiers; use UUIDs in encoded protocol tests. Test protocol 2 rejection and preservation of original bytes by callers.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/protocol/protocol.test.ts
Expected: FAIL missing protocol exports.

- [ ] **Step 3: Implement schemas and reducers.**

~~~ts
export function publish(head: EntityHead, operationId: string, epoch: number): EntityHead {
  if (head.state !== 'active') throw new SyncProtocolError('deleted', 'deleted');
  if (head.epoch !== epoch) throw new SyncProtocolError('epoch-mismatch', 'epoch-mismatch');
  if (head.current === operationId || head.history.includes(operationId)) return head;
  if (!head.reserved.includes(operationId))
    throw new SyncProtocolError('invalid-data', 'operation was not reserved');
  return {
    ...head, sequence: head.sequence + 1, current: operationId,
    receipts: { ...head.receipts, [operationId]: head.sequence + 1 },
    history: head.current === null ? head.history : [...head.history, head.current],
    reserved: head.reserved.filter((id) => id !== operationId),
  };
}
~~~

reserve performs the same state/epoch checks, rejects a cancelling operation and is idempotent. beginPurge preserves every current/history/reserved/cancelling ID and only changes state/cleanupComplete. Zod decoders discriminate protocol before parsing; unknown versions throw upgrade-required without exposing payload content. encode uses TextEncoder and JSON.stringify, rejects non-finite/non-JSON values and checks session limits at the caller. No clock participates in reducers.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/protocol/protocol.test.ts
Expected: PASS for whole-entity ordering, duplicate operations, epoch fencing and unknown versions.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/protocol packages/core/src/sync/index.ts packages/core/src/index.ts
rtk git commit -m "feat(core): define sync object protocol and transitions" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 3: Persist local binding, identities, outbox and recovery state

**Files:**

- Create: packages/core/src/db/schema/sync.ts.
- Modify: packages/core/src/db/schema/index.ts.
- Create: packages/core/src/sync/repository/index.ts, repository.ts, rows.ts, repository.test.ts.
- Generate: packages/core/src/db/migrations/0008_config_sync.sql, packages/core/src/db/migrations/meta/0008_snapshot.json and meta/_journal.json.
- Regenerate: packages/core/src/db/migrations.manifest.ts with the existing generator.

**Interfaces:**

~~~ts
export interface LocalBinding {
  id: string; plugin: string; capability: string; pluginVersion: string;
  identityId: string; spaceId: 'default'; deviceId: string;
  sessionGeneration: number; options: JsonValue;
}
export interface LocalOverride { path: string[]; value: JsonValue | undefined }
export interface LocalEntity {
  objectId: string; logicalKey: string; kind: EntityKind;
  mode: 'included' | 'excluded'; epoch: number; desired: EntityBody | null;
  baseline: string | null; overrides: LocalOverride[]; pendingReason: string | null;
}
export interface OutboxOperation {
  operationId: string; objectId: string; epoch: number;
  kind: 'put' | 'delete'; body: EntityBody | null; commitId: string;
}
export interface CommitIntent {
  commitId: string; origin: 'local' | 'remote'; beforeDigest: string; afterDigest: string;
  rawAfter: JsonValue; accountOperationIds: string[]; phase: 'prepared' | 'confirmed';
  remoteOperations?: { objectId: string; operationId: string }[];
  sourceRevisions?: Record<string, number>;
}
export interface OAuthJournalRow {
  operationId: string; objectId: string; epoch: number; baseGeneration: number;
  phase: 'started' | 'result' | 'complete'; payload: JsonValue | null;
}
export interface SyncRepository {
  readBinding(): LocalBinding | null;
  writeBinding(binding: LocalBinding): void;
  entities(bindingId: string): LocalEntity[];
  putEntity(bindingId: string, entity: LocalEntity): void;
  prepare(bindingId: string, intent: CommitIntent): void;
  readCommit(bindingId: string, commitId: string): CommitIntent | null;
  latestConfirmedCommit(bindingId: string): CommitIntent | null;
  pendingCommits(bindingId: string): CommitIntent[];
  confirm(bindingId: string, commitId: string, operations: OutboxOperation[],
    sourceRevisions?: Record<string, number>): void;
  discard(bindingId: string, commitId: string): void;
  outbox(bindingId: string): OutboxOperation[];
  acknowledge(bindingId: string, operationId: string): void;
  writeOAuthJournal(bindingId: string, row: OAuthJournalRow): void;
  oauthJournals(bindingId: string): OAuthJournalRow[];
}
export function createSyncRepository(sqlite: Database): SyncRepository;
~~~

Store range/override/desired/baseline in sync_entity keyed (binding_id, object_id), intents in sync_commit, and unique operations in sync_outbox/sync_oauth_journal. sync_binding stores active status with a uniqueness constraint allowing one active connection. Preserve old binding rows and journals during switches. options is entirely local and redacted from DTOs. Add a repository transaction wrapper internally; confirm marks the intent, persists sourceRevisions, inserts outbox and advances any remoteOperations baselines in one SQLite transaction. sourceRevisions maps local account/secret row identifiers to their committed SQLite revisions; it stays local and is compared alongside raw config digest to suppress repeat capture. Keep a local monotonic confirmed-commit counter for latestConfirmedCommit; it is never a cloud order or identity.

- [ ] **Step 1: Test persistence and origin rules.**

~~~ts
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createSyncRepository } from './repository';
import { migrateSyncTestDb } from '../test-support';

test('confirmed remote imports do not enter the outbox after restart', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', {
    commitId: 'c', origin: 'remote', beforeDigest: 'before', afterDigest: 'after',
    rawAfter: { providers: {} }, accountOperationIds: [], phase: 'prepared',
  });
  repo.confirm('b', 'c', []);
  expect(createSyncRepository(db).outbox('b')).toEqual([]);
  expect(repo.pendingCommits('b')).toEqual([]);
  db.close();
});
~~~

Define migrateSyncTestDb(sqlite: Database): void in test-support by applying the real MIGRATIONS SQL in order, with the same hash/version assertions as db/open-db.ts; do not maintain a separate test-only schema. Add a real temporary on-disk reopen test and a failed confirm transaction test proving neither intent nor partial outbox becomes visible.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/repository/repository.test.ts
Expected: FAIL missing tables/repository.

- [ ] **Step 3: Add schema and transactions.**

Representative table definitions:

~~~ts
export const syncOutbox = sqliteTable('sync_outbox', {
  bindingId: text('binding_id').notNull(),
  operationId: text('operation_id').notNull(),
  payload: text('payload_json').notNull(),
}, (table) => [primaryKey({ columns: [table.bindingId, table.operationId] })]);

export const syncOAuthJournal = sqliteTable('sync_oauth_journal', {
  bindingId: text('binding_id').notNull(),
  operationId: text('operation_id').notNull(),
  payload: text('payload_json').notNull(),
}, (table) => [primaryKey({ columns: [table.bindingId, table.operationId] })]);
~~~

Import sqliteTable/text/primaryKey from drizzle-orm/sqlite-core. Use equivalent compound keys for entity/commit, and a checked active integer/partial unique index for bindings. Parse JSON rows through versioned schemas before use. For prepared commits, confirm reads the saved origin and rejects non-empty operations for remote origin. Prepared intent, confirmed transition and outbox insertion are idempotent by commit/operation ID.

Run in packages/core: rtk proxy bunx drizzle-kit generate --name config_sync
Then at repository root: rtk proxy bun run build:migrations
The next migration is 0008 at the researched baseline. If another migration lands first, use the generator's next ordinal and update this task's artifact paths; never overwrite an existing migration.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/repository/repository.test.ts packages/core/src/db/migrations/migrations.test.ts
Expected: PASS for fresh and existing databases. Check SQLite synchronous=FULL is set before result-journal transactions once shared credentials are enabled; never change that pragma inside a transaction.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/db packages/core/src/sync/repository packages/core/src/sync/test-support.ts
rtk git commit -m "feat(core): persist sync operations and recovery journals" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 4: Project selected raw config and carry plugin dependencies

**Files:**

- Create: packages/core/src/sync/projection/index.ts, projection.ts, model-overlays.ts, local-overrides.ts, projection.test.ts.
- Modify: packages/core/src/sync/index.ts.

**Interfaces:**

~~~ts
export interface CommittedSource {
  raw: Record<string, JsonValue>;
  accounts: ReadonlyMap<string, StoredAccount>;
  pluginSecrets: ReadonlyMap<string, unknown>;
  pluginVersions: ReadonlyMap<string, string>;
  sourceRevisions?: Readonly<Record<string, number>>;
}
export interface Projection {
  entities: Map<string, EntityBody>;
  accounts: Map<string, StoredAccount>;
  local: Record<string, JsonValue>;
}
export function projectCommitted(
  source: CommittedSource, entities: readonly LocalEntity[],
): Projection;
export function overlayLocal(
  sharedRaw: Record<string, JsonValue>, localRaw: Record<string, JsonValue>,
  entities: readonly LocalEntity[],
): Record<string, JsonValue>;
~~~

The map key is global objectId; account input lookup is Provider ID. Allocate/persist plugin-business, service-access, routing-defaults and model-rule identities before projection through the repository. Missing dependency identity/version is an explicit pending condition, never a fresh unstable ID allocated inside this pure function. For tests, all identity rows are supplied.

The production committedSource reader supplies sourceRevisions from account.revision and readPluginSecret(...).revision. Pure projection tests may omit it. The local commit bridge passes a copy to repo.confirm and never serializes it into a cloud entity.

- [ ] **Step 1: Add a concrete projection regression.**

~~~ts
import { expect, test } from 'bun:test';
import { projectCommitted } from './projection';
import { includedEntity, storedAccount } from '../test-support';

test('includes required plugin secrets without excluded account or proxies', () => {
  const work = includedEntity('p-work', 'provider', 'work');
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  const result = projectCommitted({
    raw: {
      proxy: 'http://user:proxy-secret@localhost:8080',
      plugins: [['@example/business', { endpoint: '{{env.ENDPOINT}}' }]],
      providers: {
        work: { kind: 'oauth', plugin: '@example/business', capability: 'first',
          proxy: 'http://user:provider-proxy@localhost:8080' },
        personal: { kind: 'oauth', plugin: '@example/business', capability: 'second' },
      },
    },
    accounts: new Map([
      ['work', storedAccount('work', 'work-token')],
      ['personal', storedAccount('personal', 'personal-token')],
    ]),
    pluginSecrets: new Map([['@example/business', { token: 'plugin-secret' }]]),
    pluginVersions: new Map([['@example/business', '1.0.0']]),
  }, [work, plugin]);
  const uploaded = JSON.stringify([...result.entities.values(), ...result.accounts.values()]);
  expect(uploaded).toContain('plugin-secret');
  expect(uploaded).toContain('work-token');
  expect(uploaded).toContain('{{env.ENDPOINT}}');
  expect(uploaded).not.toContain('personal-token');
  expect(uploaded).not.toContain('proxy-secret');
  expect(uploaded).not.toContain('provider-proxy');
});
~~~

Add test-support implementations: includedEntity(objectId, kind, logicalKey): LocalEntity returns mode included, epoch 0, null desired/baseline/pendingReason, no overrides. storedAccount(providerId, token): StoredAccount returns the real fields from repository/types.ts with plugin @example/business, capability first, credential { token }, empty options/secrets, revision/runtimeRevision 1, fingerprint providerId, updatedAt 0.

Add model-policy tests preserving personal references while updating work, raw env in server.apiKeys, API Provider direct keys, nested local overrides, local-only creation and no deletion from filtering.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/projection/projection.test.ts
Expected: FAIL missing projection.

- [ ] **Step 3: Implement structured projection.**

~~~ts
function sharedProvider(raw: Record<string, JsonValue>): Record<string, JsonValue> {
  const { proxy: _proxy, ...business } = raw;
  return business;
}
function selectedReferences(
  providers: Record<string, JsonValue>, selected: ReadonlySet<string>,
): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(providers).filter(([id]) => selected.has(id)));
}
~~~

Use the raw config schema's actual locations: providers[Provider ID], router.models[model].providers, plugins tuples/strings, server.apiKeys/password/retry. Keep fixed local settings and excluded model references in Projection.local. Overlay restores those subtrees before validating imported runtime config. Explicit local deletion of an overlay uses value undefined and removes the shared path on local import. Distinguish that from not having an override.

For plugin dependencies, visit selected OAuth plugin references and selected ai-sdk package dependencies, collect enabled business plugin config and plugin_secret at package granularity, and add dependency descriptors. AI SDK executable packages have no plugin_secret unless they are also actual enabled business plugins. Share other explicitly configured business plugins as their own entities; exclude backend-only connection settings by their dedicated local storage, not package-name guesses. Ensure all JSON-bound unknown secret values are validated as JSON before encoding.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/projection/projection.test.ts
Expected: PASS; inspect recorded upload bytes in tests rather than only asserting the projected object's shape.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/projection packages/core/src/sync/index.ts packages/core/src/sync/test-support.ts
rtk git commit -m "feat(core): project selected config and local overlays" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 5: Publish reserved revisions and recover unknown CAS results

**Files:**

- Create: packages/core/src/sync/publication/index.ts, publication.ts, receipts.ts, publication.test.ts.
- Modify: packages/core/src/sync/index.ts.

**Interfaces:**

~~~ts
export interface PublishedRevision { operationId: string; sequence: number }
export interface SyncObjectStore {
  session: SyncSession;
  readHead(objectId: string, signal: AbortSignal):
    Promise<{ head: EntityHead; version: string; modifiedAt: number } | null>;
}
export function createSyncObjectStore(session: SyncSession): SyncObjectStore;
export function publishEntity(store: SyncObjectStore, operation: OutboxOperation,
  signal: AbortSignal): Promise<PublishedRevision>;
export function finalizeReceipt(store: SyncObjectStore, head: EntityHead,
  operationId: string, signal: AbortSignal): Promise<void>;
~~~

publishEntity handles kind put only; explicit delete routes to Task 6. It creates newHead by create-only when absent, or validates the existing head's object/logical identity. It never replaces a tombstone. finalizeReceipt preserves immutable body, takes the successful sequence from head.receipts[operationId], and stores writtenAt from the revision's original modifiedAt when writtenAt is null. Config data never goes into an account object.

- [ ] **Step 1: Test lost acknowledgement and duplicate publication.**

~~~ts
import { expect, test } from 'bun:test';
import { createMemorySyncBackend } from '../test-support';
import { createSyncObjectStore, publishEntity } from './publication';

test('unknown CAS result retries the same operation without another revision', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const signal = new AbortController().signal;
  const operation = {
    operationId: crypto.randomUUID(), objectId: crypto.randomUUID(), epoch: 0,
    kind: 'put' as const, commitId: 'commit-1',
    body: { kind: 'provider' as const, logicalKey: 'work', value: { apiKey: 'k' }, dependencies: [] },
  };
  backend.failNext('compareAndSwap', 'after');
  await publishEntity(store, operation, signal).catch(() => undefined);
  const first = await publishEntity(store, operation, signal);
  const retried = await publishEntity(store, operation, signal);
  expect(retried).toEqual(first);
  expect((await store.readHead(operation.objectId, signal))?.head.sequence).toBe(1);
});
~~~

Add two clients editing different/full same entities, a paused older offline submission winning after a newer submission, out-of-order acknowledgements, oversized payload, missing dependency and erased receipt cases.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/publication/publication.test.ts
Expected: FAIL missing publication.

- [ ] **Step 3: Implement the reservation protocol.**

The central head update loops on confirmed conflicts and rereads after outcome-unknown:

~~~ts
async function casHead(
  store: SyncObjectStore, objectId: string,
  change: (head: EntityHead) => EntityHead, signal: AbortSignal,
): Promise<EntityHead> {
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(objectId, signal);
    if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
    const next = change(current.head);
    const bytes = encode(next);
    if (bytes.byteLength > store.session.maxValueBytes)
      throw new SyncBackendError('quota', 'sync object exceeds backend limit');
    const result = await store.session.compareAndSwap(
      entityKey(objectId), current.version, bytes, signal,
    );
    if (result.kind === 'written') return next;
  }
}
~~~

Keep this helper private within publication/ and use it for metadata-only reservation updates. Publication needs the additional payload check on every attempt: read head, read revision, verify body/op/epoch/state and reservation, then CAS using that head version. On conflict repeat both reads, not only the head reducer. In publishEntity: create/validate head; resolve existing publication receipt; CAS reserve; create-only payload with writtenAt null; CAS publish using that checked sequence; finalize receipt. Recover outcome-unknown by rerunning those exact steps using the same op ID. On a receipt already published or erased with publishedSequence, return its prior sequence rather than overwrite a newer entity. An abandoned/purged marker without publication forbids the operation.

Before every publication CAS, recheck revision is a payload and the previously read head still contains the reservation; cleanup moves reservations to cancelling by head CAS before erasing their payloads. Never add a current pointer to an erased revision. For concurrent cleanup/publication the head CAS is the arbitration point. Add a race test where cleanup finishes and a duplicate old writer attempts to reserve the same operation again.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/publication/publication.test.ts
Expected: PASS including pause points before/after each remote CAS. Unknown outcomes remain retryable, offline/quota do not enter a tight retry loop.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/publication packages/core/src/sync/index.ts
rtk git commit -m "feat(core): publish recoverable sync revisions with CAS" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 6: Retain history and make delete/purge resist paused writers

**Files:**

- Create: packages/core/src/sync/cleanup/index.ts, cleanup.ts, purge.ts, history.ts, cleanup.test.ts.
- Modify: packages/core/src/sync/index.ts.

**Interfaces:**

~~~ts
export function deleteEntity(store: SyncObjectStore, objectId: string,
  epoch: number, signal: AbortSignal): Promise<void>;
export function purgeEntity(store: SyncObjectStore, objectId: string,
  signal: AbortSignal): Promise<void>;
export function collectHistory(store: SyncObjectStore, objectId: string,
  serverNow: number, signal: AbortSignal): Promise<void>;
export function restoreEntity(store: SyncObjectStore, objectId: string,
  body: EntityBody, operationId: string, signal: AbortSignal): Promise<PublishedRevision>;
export function readServerTime(store: SyncObjectStore, signal: AbortSignal): Promise<number>;
~~~

readServerTime CAS-writes a non-secret maintenance nonce in s/v1/default/space and uses the confirmed modifiedAt. A competing maintenance write is retried; this runs for maintenance, never for merge ordering or OAuth locking. deleteEntity scrubs the deterministic account key immediately and cancels reserved writes while retaining committed config history. It marks cleanupComplete only after those cancellations. restoreEntity requires that flag and a deleted/purged head.

- [ ] **Step 1: Test the delayed-create purge race.**

~~~ts
import { expect, test } from 'bun:test';
import { createMemorySyncBackend } from '../test-support';
import { createSyncObjectStore } from '../publication';
import { encode, entityKey, newHead, reserve, revisionKey } from '../protocol';
import { purgeEntity } from './cleanup';

test('purge fills absent reserved keys so a paused uploader cannot recreate secrets', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect(), signal = new AbortController().signal;
  const objectId = crypto.randomUUID(), operationId = crypto.randomUUID();
  const body = { kind: 'provider' as const, logicalKey: 'work', value: {}, dependencies: [] };
  const head = reserve(newHead(objectId, body), operationId, 0);
  await session.compareAndSwap(entityKey(objectId), null, encode(head), signal);
  await purgeEntity(createSyncObjectStore(session), objectId, signal);
  const late = await session.compareAndSwap(
    revisionKey(objectId, operationId), null, encode({ apiKey: 'late-secret' }), signal,
  );
  expect(late.kind).toBe('conflict');
  const records = [...backend.readAll().values()].flatMap((r) =>
    r.kind === 'present' ? [new TextDecoder().decode(r.value)] : []);
  expect(records.join('\n')).not.toContain('late-secret');
});
~~~

Add cases for pause after payload upload/before publish; after purge marker/before account scrub; purge restart; lost final acknowledgement; 29/31-day history; current older than 30 days; expired operation retry; explicit restore/new epoch; ordinary deletion retaining history; independent plugin secrets retained.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/cleanup/cleanup.test.ts
Expected: FAIL missing cleanup.

- [ ] **Step 3: Implement tombstone replacement, never blind removal.**

~~~ts
async function eraseRevision(
  session: SyncSession, key: string, marker: RevisionRecord, signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const current = await session.read(key, signal);
    if (current.kind === 'present' && decodeRevision(current.value).state === 'erased') return;
    const result = await session.compareAndSwap(
      key, current.kind === 'absent' ? null : current.version, encode(marker), signal,
    );
    if (result.kind === 'written') return;
  }
}
~~~

For existing payloads preserve publishedSequence in the marker, using head.receipts to finalize an interrupted publication first. For unknown versions stop with upgrade-required. purgeEntity CASes purging, freezes the union of current/history/reserved/cancelling IDs, replaces the account record and each revision, then rereads markers before the final purged CAS. A second client resumes the same remote head; no device-specific owner is required. Re-read after unknown write results.

History collection first confirms publication receipts. Move abandoned reservations to cancelling by head CAS, erase/create their receipt markers, then remove cancelling entries. Retention excludes current and pending references. Expire only confirmed history records whose stored original writtenAt is older than 30 days, then unlink them and their head receipt entries while preserving permanent receipt markers. Account state never enters historical snapshots. For refresh record scrubbing, decode its protocol/epoch but never log payload.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/cleanup/cleanup.test.ts packages/core/src/sync/publication/publication.test.ts
Expected: PASS. Tests inspect remote bytes after completion and after resuming every paused writer.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/cleanup packages/core/src/sync/index.ts
rtk git commit -m "feat(core): retain history and fence cloud deletion" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 7: Capture logical commits without exporting rollback candidates

**Files:**

- Create: packages/core/src/sync/local-commit/index.ts, local-commit.ts, local-commit.test.ts.
- Move: packages/core/src/plugins/config-file/index.ts implementation to config-file/config-file.ts; retain export-only index.ts.
- Modify: packages/core/src/plugins/config-file/transaction.test.ts.
- Modify: packages/core/src/sync/index.ts.

**Interfaces:**

~~~ts
export interface LocalCommitPort {
  withFence<T>(run: () => Promise<T>): Promise<T>;
  rawDigest(): Promise<string>;
  accountOperationsSettled(ids: readonly string[]): boolean;
  committedSource(): Promise<CommittedSource>;
}
export function recoverLocalCommits(
  repo: SyncRepository, bindingId: string, port: LocalCommitPort,
): Promise<void>;
export function confirmLocalCommit(repo: SyncRepository, bindingId: string,
  commitId: string, port: LocalCommitPort): Promise<void>;
export function prepareLocalCommit(repo: SyncRepository, bindingId: string,
  input: Omit<CommitIntent, 'phase'>): void;
~~~

The server adapter in the integration plan supplies the actual FIFO/config ownership fence and committed repository reads. confirmLocalCommit projects only after matching rawDigest and settled account operations; it reads the prepared origin, allocates stable op IDs once and calls repo.confirm. For remote origin, it advances baseline with an empty outbox. BeforeDigest/afterDigest are local recovery comparisons, not cloud identities.

- [ ] **Step 1: Test rollback/uncertain state using the real file transaction.**

~~~ts
import { expect, test } from 'bun:test';
import { AtomicConfigFile } from '../../plugins/config-file';
import { withSyncCommitFixture } from '../test-support';
import { prepareLocalCommit, recoverLocalCommits } from './local-commit';

test('a candidate rejected by verify never becomes an outgoing commit', async () => {
  await withSyncCommitFixture(async (f) => {
    const file = new AtomicConfigFile(f.configPath);
    prepareLocalCommit(f.repo, f.bindingId, f.intent);
    await expect(file.replace(() => f.intent.rawAfter as Record<string, unknown>, {
      verify: async () => { throw new Error('invalid runtime'); },
    })).rejects.toThrow('invalid runtime');
    await recoverLocalCommits(f.repo, f.bindingId, f.port);
    expect(f.repo.outbox(f.bindingId)).toEqual([]);
    expect(f.repo.pendingCommits(f.bindingId)).toEqual([]);
  });
});
~~~

Define withSyncCommitFixture(run): Promise<void> in test-support. It creates a temporary config with providers {}, real openDb/createSyncRepository, SHA-256 before/after digests using the existing canonical config serializer, an intended api Provider edit, and a LocalCommitPort reading those real resources. It supplies configPath, repo, bindingId, intent and port; it closes DB/removes temp files in finally. No mock callback that unconditionally declares commit success.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/local-commit/local-commit.test.ts
Expected: FAIL missing bridge and fixture.

- [ ] **Step 3: Implement recovery decisions.**

~~~ts
export async function recoverLocalCommits(
  repo: SyncRepository, bindingId: string, port: LocalCommitPort,
): Promise<void> {
  await port.withFence(async () => {
    for (const intent of repo.pendingCommits(bindingId)) {
      if (!port.accountOperationsSettled(intent.accountOperationIds)) continue;
      const digest = await port.rawDigest();
      if (digest === intent.beforeDigest) repo.discard(bindingId, intent.commitId);
      else if (digest === intent.afterDigest)
        await confirmLocalCommitUnderFence(repo, bindingId, intent.commitId, port);
    }
  });
}
~~~

Define private confirmLocalCommitUnderFence with the exact confirmLocalCommit signature; the public function acquires the fence once and calls it. Never recursively acquire the FIFO/config lock. Unknown digests stay pending. Use the existing AtomicConfigFile afterCommit hook, composed with account finalization; do not capture from verify. On remote apply record remoteOperations so baseline advancement and confirmation are atomic. Compare with latestConfirmedCommit before capturing a watcher reload; the same raw digest and account revisions are a no-op even after restart. Capture account/secret revision changes explicitly so an unchanged config file does not hide a real credential/business-secret update. Integration must compose existing account before/after hooks without replacing them.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync/local-commit/local-commit.test.ts packages/core/src/plugins/config-file/transaction.test.ts
Expected: PASS for rollback, afterCommit exception, uncertain lock release, account compensation and crash/reopen boundaries.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync/local-commit packages/core/src/sync/test-support.ts packages/core/src/sync/index.ts packages/core/src/plugins/config-file
rtk git commit -m "feat(core): capture only confirmed sync changes" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 8: Reconcile desired state and run the backend-neutral engine

**Files:**

- Create: packages/core/src/sync/engine/index.ts, engine.ts, incoming.ts, scheduler.ts, engine.test.ts.
- Modify: packages/core/src/sync/index.ts.

**Interfaces:**

~~~ts
export type PendingReason =
  'missing-plugin' | 'missing-env' | 'incompatible-version' | 'invalid-config' |
  'invalid-credential' | 'provider-id-conflict' | 'oauth-unverified' | 'upgrade-required';
export interface ActivationResult { applied: boolean; pending?: PendingReason }
export interface LocalSyncPort extends LocalCommitPort {
  applyRemote(objectId: string, body: EntityBody | null, operationId: string):
    Promise<ActivationResult>;
}
export interface SyncEngine {
  reconcile(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}
export function createSyncEngine(input: {
  binding: LocalBinding; session: SyncSession; repo: SyncRepository; local: LocalSyncPort;
  onStatus(status: string): void; pollMs?: number;
}): SyncEngine;
~~~

Default polling is 60 seconds while online, with bounded jitter/backoff up to 5 minutes after offline/quota errors; watch requests a coalesced reconcile. Inject pollMs only for tests. Device-local exclusions are consulted before import, but account deletion signals still flow to the OAuth coordinator. The engine performs no OAuth refresh itself.

- [ ] **Step 1: Test selection and echo behavior with the real engine.**

~~~ts
import { expect, test } from 'bun:test';
import { withTwoSyncDevices } from '../test-support';

test('a cloud Provider joins the other device and import has no outgoing echo', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode)
      .toBe('included');
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});
~~~

Define withTwoSyncDevices(run): Promise<void> in core test-support by creating two real local repositories/LocalSyncPorts over one memory backend and two createSyncEngine instances. Each device exposes repo, binding, engine, signal and commitProvider(id: string, body: JsonValue, included: boolean): Promise<void>, which writes raw config through the commit fixture and capture bridge. applyRemote uses the remote-origin bridge, not direct outbox deletion.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/core/src/sync/engine/engine.test.ts
Expected: FAIL missing engine/fixture.

- [ ] **Step 3: Implement lifecycle and incoming reconciliation.**

~~~ts
let running: Promise<void> | undefined;
function coalescedReconcile(signal: AbortSignal): Promise<void> {
  if (running) return running;
  running = reconcileOnce(signal).finally(() => { running = undefined; });
  return running;
}
~~~

Define private reconcileOnce(signal): Promise<void> to: verify identity/space; recover local commits and remote purges; drain eligible outbox using Tasks 5–6; paginate heads; read/validate current revisions; persist desired data and exclusions; call applyRemote for included compatible entities; advance baseline; perform due maintenance. Capture sessionGeneration before work and check it before any local application or acknowledgement. On stop abort the owned controller, cancel timers/watch, await running, then dispose the session. Stop must tolerate repeated calls and initialization failure.

Add tests for new local default exclusion, pre-existing exclusion, same-ID conflict, pending dependency then activation, unknown format, stale old-session callbacks after switch, polling without watch, restart recovery and no extra connection during plugin snapshot rebuilds.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/core/src/sync
Run: rtk proxy bun run --filter @aio-proxy/core test
Run: rtk proxy bun run --filter @aio-proxy/plugin-sdk test
Expected: PASS. Native and live OAuth gates remain outside this plan.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/core/src/sync
rtk git commit -m "feat(core): reconcile selective configuration sync" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

## Handoff

Deliverable: the SDK capability and core engine run against a deterministic backend with recovery and selective scope tests. Continue with the CloudKit and OAuth plans, then product integration. User-facing implementation Changesets are consolidated in the release task; this documentation change itself does not require one.
