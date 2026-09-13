# Selective Configuration Sync and CloudKit Design

Status: approved architecture from Q1–Q32 and the Q25 final review; this document makes the implementation contracts concrete.
Date: 2026-09-08.
This change set contains planning documents only. Native entitlement access, two-device CloudKit behavior and upstream OAuth portability have not been validated.

## 1. Outcome and boundaries

A macOS user can enable a CloudKit backend and select Providers whose usable configuration should follow them to another Mac. The background aio-proxy service performs synchronization; closing Dashboard has no effect. Third-party backends use the same storage contract in the first release.

The product distinguishes configuration stored in the cloud, the desired configuration on a device, and the configuration currently safe to run. Missing dependencies preserve received data in pending state. A received credential is not proof that its upstream service permits concurrent multi-device use.

This release does not synchronize the aio-proxy home directory, SQLite database/WAL, request logs, caches, service installation, environment files, agent-installation credentials, runtime-generated catalogs or plugin executable files. It has no multi-space management UI, generic field CRDT, mandatory encryption password or automatic plugin installation.

## 2. Global Constraints

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

## 3. Ownership and scope requirements

| ID | Requirement |
| --- | --- |
| S01 | Host owns selection, dependency projection, committed export, outbox, merge, history, deletion, validation, activation and OAuth recovery. Backend code owns transport/storage and native resources only. |
| S02 | Each configuration directory binds a local connection ID, backend package/capability/version, remote identity ID and space ID. Default space ID is "default". Two directories never share local journals implicitly. |
| S03 | Setup registers factories only. Runtime connects after startup recovery and explicit local binding. Shutdown aborts work and disposes the session. |
| S04 | Local Provider creation is excluded by default; discovering a new cloud object includes it unless that Provider ID/object has a local exclusion, identity collision or pending prerequisite. |
| S05 | Selection includes the complete Provider entity, its dedicated account row and account secrets, required business plugin config and the whole plugin business secret record. An excluded Provider's dedicated account row remains excluded. |
| S06 | Plugin selection is dependency based, not a fingerprint/account pool. Existing oauth_account rows are keyed by Provider ID; plugin_secret rows are keyed by plugin package. There is no reliable per-Provider split of plugin_secret. |
| S07 | Top-level proxy and Provider proxy are local, including URL credentials. Listen addresses/ports, paths, startup settings, logging/cache settings and backend connection options/secrets are local. |
| S08 | Share server.apiKeys, server.password, server.retry, router defaults, selected Providers, model policies and their selected structured Provider references. Persist raw authoring values rather than resolved runtime values. |
| S09 | Arbitrary business plugin/Provider options default to shared; explicit local JSON-pointer overrides can remove a subtree from export and overlay its local value on import. Treat an array override as the whole array; never guess paths from names. |
| S10 | Model policies are full entities after scope projection. Keep structured references to excluded Providers in a local overlay and reattach them on import. Local absence caused by filtering is not a delete. Provider IDs inside arbitrary user strings are not rewritten heuristically. |
| S11 | Leaving configuration sync stops outgoing edits and incoming application for that Provider, while retaining local and cloud current/history state. It does not create a tombstone. Shared OAuth coordination may still be needed until safe credential detachment finishes. |
| S12 | Rejoin and first attachment with content on both sides require a redacted entity preview and explicit per-entity choice. Same Provider ID with different global object IDs is a conflict, never a silent match. |
| S13 | A cloud purge deletes the Provider config/history and dedicated current account/secrets, propagates to included copies, and preserves independent local-only copies. Plugin shared data is a separate purge target with dependency checks. |
| S14 | Cloud identity/account/backend switch stops the old session, fences its callbacks, preserves local and old cloud data, and starts a fresh binding/preview. Previously shared OAuth credentials cannot silently use local refresh against an abandoned backend. |

Server logging is treated as a local operational setting. User-authored routing retry behavior is shared. Plugin sources and exact package versions are dependency descriptors; installation requires local confirmation, and executable bytes are not uploaded. Backend options use a dedicated local store even when one package registers both OAuth and sync capabilities. Business plugin secrets never double as the storage connection's authorization record.

## 4. Architecture

~~~mermaid
flowchart LR
  UI[Dashboard and CLI] --> Host[Host sync coordinator]
  File[Raw committed config] --> Journal[Local commit journal and outbox]
  DB[Committed plugin accounts and secrets] --> Journal
  Journal --> Host
  Host --> Desired[Desired state and pending activation]
  Desired --> Runtime[Validated runtime snapshot]
  Host --> SDK[sync.register storage session]
  SDK --> JS[CloudKit plugin]
  JS --> Swift[Signed Swift component over stdio]
  Swift --> CK[Private CloudKit custom zone]
~~~

Configuration changes and account refreshes use different state machines. They share the storage contract and local binding, but configuration history never includes current OAuth credentials.

No cryptographic isolation is claimed between the host and plugins. Both run trusted code. Payloads, IPC and local recovery journals may contain credentials and must not enter logs, command arguments or Dashboard DTOs.

## 5. Public storage contract

The SDK adds these types and exports them from its root. Existing plugin API version 1 remains supported; the capability is additive. A plugin using sync must declare a peer dependency on the first SDK release containing it. Existing OAuth-only plugins remain loadable.

~~~ts
export type SyncVersion = string;
export type SyncRead =
  | { kind: 'absent' }
  | { kind: 'present'; value: Uint8Array; version: SyncVersion; modifiedAt: number };
export type SyncCAS =
  | { kind: 'written'; version: SyncVersion; modifiedAt: number }
  | { kind: 'conflict' };
export type SyncFailureCode =
  | 'offline' | 'quota' | 'identity-changed' | 'cancelled'
  | 'unauthorized' | 'unsupported' | 'outcome-unknown' | 'invalid-data';

export interface SyncSession {
  readonly identityId: string;
  readonly spaceId: string;
  readonly maxValueBytes: number;
  read(key: string, signal: AbortSignal): Promise<SyncRead>;
  compareAndSwap(key: string, expected: SyncVersion | null,
    value: Uint8Array, signal: AbortSignal): Promise<SyncCAS>;
  list(input: { prefix: string; cursor?: string }, signal: AbortSignal):
    Promise<{ keys: readonly string[]; nextCursor?: string }>;
  remove(key: string, expected: SyncVersion, signal: AbortSignal):
    Promise<{ kind: 'removed' | 'conflict' }>;
  watch?(onHint: () => void): () => void;
  dispose(): Promise<void>;
}
export interface SyncBackendDefinition<Options> {
  readonly id: string;
  readonly displayName: LocalizedText;
  readonly options: ConfigSpec<Options>;
  connect(options: Options, context: { signal: AbortSignal; dataDirectory: string }): Promise<SyncSession>;
}
// Added to PluginApi:
sync: { register<Options>(backend: SyncBackendDefinition<Options>): void };
~~~

Contract rules:

| ID | Requirement |
| --- | --- |
| B01 | A version is opaque and scoped to a key/session identity. Expected null means create-only. A conflict is explicit and never becomes a blind overwrite. |
| B02 | Written means the server accepted that condition and value. A queued upload is not success. read must fetch a server-backed value for correctness-critical operations, not return an unverified local cache. |
| B03 | modifiedAt is storage-assigned UTC milliseconds for the returned version. It is used for history age, not winner selection or OAuth lock ownership. Backends must document and test their clock source. |
| B04 | list is paginated discovery, with duplicate-tolerant host consumption and eventual full discovery under stable data. It is not an atomic snapshot. watch is an unreliable hint; always reread and poll without it. |
| B05 | remove is conditional and only for expendable, unreferenced immutable objects. Never remove protocol control records, operation receipts or deletion markers. |
| B06 | Abort, identity change, quota, offline and unknown write outcome are distinguishable. After unknown outcome the host rereads the same key/operation; it does not issue a fresh operation ID. |
| B07 | A backend without real CAS cannot advertise sync. The conformance suite covers competing clients, create-only, stale writes, pagination, absence, uncertain results and disposal. |

The host checks encoded byte length before upload and reports a quota/size condition without truncating current config or protected history. CloudKit advertises 8 MiB per value, stored as a CKAsset. The stdio frame limit is 16 MiB including base64. Other backends may advertise a different limit. No multi-key atomic transaction is required by the SDK.

## 6. Cloud protocol and durable identity

Protocol version is 1. Object IDs, operation IDs and device IDs are random UUIDs created once and persisted. Provider ID is an authored logical key; it is not a global identity. Local revision, wall time, token bytes and OAuth fingerprint are not global identities.

Namespace:

| Key | Data and ownership |
| --- | --- |
| s/v1/default/entity/{objectId} | Conditional entity head, epoch, current revision pointer, retained history references, reserved writes and secret-free deletion state. |
| s/v1/default/revision/{objectId}/{operationId} | One entity's immutable config payload, publication receipt metadata or a permanent secret-free erased marker. |
| s/v1/default/account/{providerObjectId} | Current account credential/options/secrets plus refresh phase and generation, or a permanent deletion marker. |
| s/v1/default/space | Protocol/space metadata only. Never backend credentials. |

A head is one of active, deleted, purging or purged. It contains kind, logicalKey, objectId, epoch, sequence, current operation ID (or null), retained operation IDs, registered-but-not-resolved operation IDs, cancelling operation IDs and a receipt map from retained operation ID to its successful publication sequence. Payload values only occur in revision/account records, not heads or tombstones. dataDirectory in the connection context is a host-created, local 0700 directory scoped to this configuration directory and binding; plugins store native caches there.

Entity kinds are provider, model-rule, plugin-business, service-access and routing-defaults. Service access contains apiKeys/password; routing defaults contain retry and modelContextAggregation. Plugin-business contains package/version/options and its whole business secret value. OAuth account.options/secrets/credential stay in the separate account object, not config revisions.

Every revision payload includes protocol, objectId, epoch, operationId, entity kind, projected body and required dependency object IDs/versions. A revision owns exactly one entity; no whole-workspace snapshots that intermingle purge scopes. Credentials copied from oauth_account appear only in account records.

### 6.1 Publication algorithm

| ID | Requirement |
| --- | --- |
| M01 | Persist an outbox operation and its intended body from a confirmed local commit. Reuse the operation ID through every retry. |
| M02 | Read the entity head; verify protocol, epoch and non-deleted state. CAS-register the operation in reserved writes before creating its revision. |
| M03 | Create its revision with expected null. Existing matching payload/receipt is a retry; an erased marker prohibits publication. Never mutate a revision's payload. |
| M04 | CAS the latest eligible head to point at that revision, move the previous current into history, increment sequence, record that operation's sequence in receipts and remove the reservation. On every CAS attempt read the head before rechecking the revision payload, then use that head version. Reread/retry on contention with the same intended entity, so a later successful submission wins even for an old offline edit. |
| M05 | Publication metadata records the successful head sequence in the revision. On unknown outcome, inspect head/current/history, its outstanding reservation and revision receipt before retrying. History collection first finalizes publication receipts. |
| M06 | A missing entity in a filtered projection does not enqueue deletion. Deletion is an explicit authored remove of a previously included object. |
| M07 | Unknown object versions stop writes to that object and dependent activation. Preserve received bytes and show upgrade-required. Do not deserialize and rewrite lossy unknown data. |
| M08 | Dependency references may become visible before their payloads. Activation waits for all required exact compatible objects; retaining desired data never implies executing a missing plugin. |

Successful ordering is the head CAS sequence, not a timestamp. Same-entity updates replace the shared entity projection as a whole. Independent entities merge independently. Old retries cannot reapply a previously published operation after a newer edit: the revision's publication receipt, or its retained erased receipt, resolves it as already applied.

A crash after reservation leaves the exact revision key discoverable. Cleanup first CAS-moves that reservation to cancelling, which prohibits publication/re-reservation while cleanup runs. It then CASes the key, including expected absence, to an abandoned marker and removes the cancelling entry. A retried operation must reread its erased receipt before publication. This prevents a paused writer creating an orphan payload afterward. Revision receipt metadata is host controlled; immutability applies to the payload, not that metadata. Receipt finalization stores both the head's recorded publication sequence and the original payload write time; subsequent metadata writes do not reset history age.

### 6.2 History, tombstones, restore and purge

| ID | Requirement |
| --- | --- |
| D01 | Keep committed non-current configuration revisions for 30 days from their first storage-assigned payload write time. Current is always retained. Never classify a merely reserved/staged revision as history. |
| D02 | Host cleanup uses storage-assigned times; a conditional non-secret maintenance nonce on the space record supplies current server time. Receipt metadata preserves the first payload write time. Clocks do not decide merge winners. Cleanup replaces expired payload records with secret-free receipts before unlinking history references. |
| D03 | Ordinary deletion sets a permanent head tombstone, blocks new reservations/publication and disables included runtime copies. Retained configuration history remains available for 30 days. Scrub the dedicated account to a tombstone; rollback will not restore its tokens. |
| D04 | Explicit restore runs only after deletion cleanup completes, increments the entity epoch and creates a new operation in that epoch. A cloud purge cannot restore removed secret payloads; restore uses independently retained local/new input. |
| D05 | Purge first CAS-marks the head purging and freezes its exact known current/history/reserved/cancelling revision keys. CAS the deterministic account key to a secret-free tombstone even when the key is absent. |
| D06 | For every frozen revision key, CAS its payload or its absence to a permanent erased marker. Do not physically delete these marker records. Late create-only uploads and stale version writes then fail. |
| D07 | Only after rereading all affected keys as erased/tombstoned may the head become purged and the UI report completion. Recovery resumes from the remote head, not only one device's journal. |
| D08 | Provider purge does not cascade to plugin-business. A plugin purge previews all known cloud dependents and blocks until the selected dependent Providers are deleted or rewritten to remove that dependency. Incoming concurrent references remain pending; they cannot recreate the purged plugin implicitly. |
| D09 | Synced devices remove that Provider from desired/active state; independent local-only copies remain. Local exclusions never suppress reading tombstones needed to stop shared credential refresh. |

The persistent marker includes object/operation ID, epoch, state and publication sequence where applicable, but no body, credentials, labels copied from account secrets, or old payload hashes. This is an intentional space cost to protect against arbitrarily old offline writers. Bound individual head size; refuse further reservations before the backend limit rather than drop history/tombstones. Operators see a storage-capacity error. Pagination/sharding of very large single-entity histories is not part of protocol 1.

Purge completion concerns records accessible through the backend API. It does not claim erasure of Apple's internal disaster-recovery copies. Losing network or identity during purge leaves a pending operation, not success.

## 7. Local persistence, commit and activation

| ID | Requirement |
| --- | --- |
| L01 | Use local SQLite tables for binding/range/overrides, object identity mapping, commit journal, outbox and OAuth result journal. Keep raw config as the authored file; do not export resolved Config snapshots. |
| L02 | Record the intent before a config/account mutation. After file verification and successful account finalization, atomically mark the local logical commit confirmed and enqueue projected changes in SQLite. |
| L03 | A file transaction, pending OAuth account operation or account-removal compensation can roll back. Capture cannot run from buildSnapshot or provisional verify callbacks. On unknown commit outcome, reconcile under the existing config lock and server mutation queue before exporting. |
| L04 | Recovery compares the saved raw candidate digest and pending account operation status. Finalize a matching committed state, discard a rolled-back state, or leave an ambiguous state pending. Never guess by file mtime. |
| L05 | Manual file edits enter through successful reload and the same capture fence. Plugin-secret writes, API settings edits, Provider account login/import/removal and automatic credential writes each have explicit origin/finalization hooks. |
| L06 | Imported cloud state carries origin "remote" and its operation IDs. Persist desired state, apply preserved local overlays, validate dependencies/options/env and commit locally without a new outgoing edit. |
| L07 | Missing plugin/version, missing env, invalid config/credentials, unresolved identity collision and unverified multi-device OAuth create specific pending-activation reasons. Keep an existing safe runtime where possible; deletion, credential revocation or a purged dependency must disable affected usage. |
| L08 | State recovery happens before constructing a runtime that could refresh a shared credential. OAuth result journal commits use SQLite synchronous=FULL before cloud publication; restore/default performance policy cannot weaken an outstanding shared credential journal. |

Local tables: sync_binding, sync_entity, sync_commit, sync_outbox and sync_oauth_journal. Each row is scoped by binding ID; sync_entity stores Provider exclusion and JSON-pointer overlays with the desired/baseline snapshot. The outbox and journals have unique operation IDs and explicit phase. Secrets retain existing 0700 directory/0600 database protection and are removed from completed transient journals after recovery no longer needs them.

The commit journal is a logical write-ahead protocol, not a filesystem/SQLite distributed transaction. Fault injection must cover each durable boundary. ServerState currently has a synchronous close API: keep close() as immediate abort and add closeAsync() for awaited sync drain/disposal before database close. Existing synchronous callers retain safe immediate cancellation; the background service uses the awaited path.

## 8. OAuth coordination

### 8.1 Eligibility and portability

| ID | Requirement |
| --- | --- |
| O01 | Add credential format metadata per adapter. Copy eligible credential state to the cloud even when multi-device execution has not been verified. Receiving devices keep it pending until the exact adapter/version has evidence. |
| O02 | Credentials, account options/secrets, generation and refresh phase occupy one CAS account object. Generation starts at 0, increases on credential replacement and is scoped to object epoch. |
| O03 | Before sharing a local account, serialize with all local runtime/control-plane refresh and login operations, finish or stop active local refresh, seed the remote account, and atomically record shared ownership before releasing the gate. |
| O04 | Every shared refresh path, including runtime, catalog, quota and manual refresh, goes through the same host coordinator. Another account row with the same semantic upstream token is not automatically an independent authorization. |
| O05 | A never-shared local account retains current local lease/single-flight behavior. A previously shared account cannot fall back to it when sync is disabled or unavailable. |
| O06 | Adapter evidence must cover copied access-token use, rotation/reuse policy, refresh concurrency, login effects, device-bound fields and independent detachment. SDK metadata declarations from trusted third-party plugins are their compatibility assertion, not host certification. |

Proposed SDK addition on OAuthAdapter:

~~~ts
credentialSync?: {
  formatVersion: number;
  multiDevice?: { evidenceId: string };
  canDetach?: (input: {
    shared: Credential; candidate: Credential; signal: AbortSignal;
  }) => Promise<boolean>;
};
~~~

An absent multiDevice declaration means unverified, not forbidden cloud storage. An absent credentialSync declaration means the adapter must be updated before account export; preserve Provider configuration and show pending-plugin-update. Initial built-in metadata declares formatVersion 1, with no unearned evidence. Exact plugin release and credential format must match the verification record. No implicit token-format migration.

### 8.2 Refresh state machine

Account phases: ready, refreshing, uncertain, login-required and deleted. Refreshing/uncertain include operationId, ownerDeviceId and baseGeneration. A live account retains lastCompletedOperationId for reconciling lost publication replies. The original current credential remains available only while valid and not known revoked. A device with an existing local login may keep using it through shared coordination; the verification gate controls activation of received copies, not retroactive revocation of that original login.

1. Read the server account object and compare local epoch/generation.
2. If newer, validate/import it and return superseded without calling upstream.
3. If ready, CAS to refreshing with a new persisted operation ID and baseGeneration; await confirmed success.
4. Persist local started state before invoking the upstream exchange exactly once.
5. On upstream success, durably journal the returned credential and metadata immediately, before cloud publication or any failure-prone validation/logging. Validate it; invalid output stays quarantined and cannot trigger old-token replay.
6. CAS the exact operation/epoch/generation to ready with generation + 1 and the new credential.
7. On acknowledged success, update the local account and complete the journal. On conflict or unknown outcome, reread remote and reconcile the same operation/result.
8. If upstream result is uncertain, retain remote refreshing/uncertain. Only the matching recoverable result or a confirmed newer usable account can resolve it. Otherwise pause that account and request login.

| ID | Requirement |
| --- | --- |
| O07 | Remote coordination failure defers refresh. Existing unexpired credentials may still serve requests when the adapter says they remain usable. No local-only refresh fallback. |
| O08 | Lease expiry or elapsed time alone never authorizes another upstream exchange. CAS fences cloud publication, not a request already sent to the OAuth endpoint. |
| O09 | A successful result received late must still enter the journal while the process/DB is alive. Avoid Promise.race patterns that discard successful rotation results after timeout. |
| O10 | Restart recovers a journaled result by matching operation ID/epoch/generation. A stale result cannot overwrite a new login, deletion or newer generation. |
| O11 | If a token rotates and the process dies before any durable result, login may be required. No transaction covers OAuth and CloudKit; this limitation must be described in UX and adapter evidence. |
| O12 | Configuration rollback selects old config bodies and current account state. Cloud login/replacement explicitly serializes with the coordinator; it is not ordinary last-writer-wins config synchronization. |
| O13 | Full local detachment obtains an independently usable authorization and verifies it using canDetach. Different token strings or a successful login alone do not establish independence. Failure keeps detachment pending/cancellable. |

The coordinator uses no expiring distributed lease in protocol 1. An abandoned refreshing claim is recoverable from its owner's journal, or requires login. Polling/timers are liveness and UX aids, never permission to replay. This conservative choice avoids promising semantics CloudKit cannot supply.

Built-in evidence matrix at planning time:

| Adapter | Observed current refresh behavior | Required validation |
| --- | --- | --- |
| Claude, Cursor, Google Antigravity, Kimi, OpenAI ChatGPT, xAI | Accept rotated refresh tokens | Two-device rotation, uncertain outcome, login/revocation effects. |
| Kimi | Credential includes deviceId | Device portability must be proved separately. |
| GitHub Copilot | Derives short-lived Copilot token from GitHub token | Concurrent use, expiry, GitHub authorization scope and revocation. |
| OpenRouter, Muse | No refreshCredential capability | Copied credential use, revocation and safe detachment still need evidence. |

Some existing fallback fingerprints depend on token material. They remain local dedup hints; do not derive sync account IDs from them. Test fixtures with synthetic plugin-level secrets must not imply the current nine built-ins use such secrets.

## 9. CloudKit implementation and distribution

| ID | Requirement |
| --- | --- |
| C01 | JavaScript CloudKit plugin connects to an official Swift component over bounded, request-ID-correlated newline JSON on stdin/stdout. Logs go to stderr through redaction; raw payloads never do. |
| C02 | The native component uses CKContainer privateCloudDatabase and one private custom CKRecordZone. Map keys to deterministic CKRecord IDs, payload bytes to CKAsset, version to encoded record system fields/change tag. |
| C03 | Direct server operations implement read/CAS/remove. Use CKModifyRecordsOperation savePolicy .ifServerRecordUnchanged. Implement conditional remove as a CAS clearing the asset and marking the backing record removed; CloudKit recordIDsToDelete does not supply an expected-version condition. Expected absence uses create-only behavior, including a conditional replacement of a logically removed backing record, verified against concurrent creation. |
| C04 | CKSyncEngine/APNs may improve wakeups, but queued CKSyncEngine writes are not CAS acknowledgements. Polling works without notifications or a push delivery guarantee. |
| C05 | Capture the iCloud identity at connect and detect CKAccountChanged. Stop the old session on identity change, including in-flight callbacks. Bind the new identity only through a new local preview. |
| C06 | The native executable ships in a properly signed/notarized app bundle with matching entitlements/provisioning, is versioned with the plugin, and is verified before execution. Keep the previous working installation through update staging and swap. |
| C07 | Confirm installed-path and launchd/background-service CloudKit access on macOS 14 and a current macOS. Developer execution in Xcode alone is insufficient. |
| C08 | No release claim before real two-device CAS, offline/reconnect, identity switch, native exit/restart, quota and signed-artifact tests. Never reuse the CLI's ad hoc re-sign step for this bundle. |

Registered App ID: dev.aioproxy, description AIO Proxy. User domain: aioproxy.dev. iCloud/CloudKit and Push Notifications were enabled, broadcast disabled. Proposed container: iCloud.dev.aioproxy. Container creation/association, team identity, provisioning profile and signing/notarization access are execution inputs, not established facts.

Use a native app bundle whose bundle identifier matches the registered App ID for the first entitlement probe. An LSUIElement helper can run without a Dock UI. Invoke the inner executable by its verified absolute path with stdio and prove that launch mode under the production service; do not assume a .app wrapper automatically grants entitlement access. If the installed command-line launch fails the gate, fix and revalidate packaging before product activation, without changing the storage protocol.

Ship a separately installable package @aio-proxy/plugin-cloudkit containing JS and a signed AIOProxyCloudKit.app archive plus digest/version manifest. The host's existing plugin install flow provides local approval. Native extraction is a plugin concern; no network download or execution from setup. Unsupported systems can load capability metadata but connect reports unsupported. The native artifact build runs on macOS and precedes package packing; runtime package updates reuse staging and preserve the old version until validation succeeds.

Developer ID distribution must be verified with an appropriate provisioning profile for the actual identifier/container/entitlements. Signing team, Developer ID certificate, profile and notarization credentials are supplied privately at execution time. Codesign output/entitlements are recorded with secret fields redacted.

## 10. Product control plane

Dashboard settings exposes backend connection/status, first-connection preview, pending activations, history and cloud cleanup. Provider UI exposes local-only/synced state and rejoin/detachment actions. Exiting sync and purging are distinct actions with different copy. A rejoin preview lists automatically included plugin data; it does not add another shared-secret switch.

The API returns only redacted data and opaque preview tokens. Preview binds the local commit ID, local range version, binding identity/session generation and exact remote versions; acceptance fails with preview-stale if any change. Secret differences show presence/changed status, never values or reusable hashes. Backend secret input may be submitted to the local authorized endpoint, never reflected by status.

CLI shares the same coordinator through the running background service and existing Dashboard authentication/loopback protections. A configured Dashboard password is entered through a hidden prompt or stdin to obtain an in-memory bearer token. It supports status, connect/preview/apply, per-Provider range, detach, history/restore, purge, retry and disconnect. It must not create a second engine or independently edit shared account state.

Operational states: disconnected, connecting, preview-required, syncing, idle, offline, quota, identity-changed, upgrade-required and error. Per-entity pending reasons are distinct from connection state. OAuth states include refresh-deferred, result-uncertain, login-required and detach-pending.

Deleting a shared service password/API key can invalidate a Dashboard session/client; existing authentication validation/confirmation rules apply. Local host/port and proxy changes remain local. Pending invalid service-access data keeps last known good authentication active.

## 11. Acceptance and execution gates

- A two-device fake backend passes all protocol behavior tests, including paused writers after revision reservation, before upload, during purge and after history cleanup.
- Raw env references and excluded Provider credentials/proxy secrets never appear in uploaded bytes. Required plugin business secrets do appear, with a synthetic fixture.
- Config rollback, account compensation and failed reload produce no outgoing snapshot. Remote import persists without echo.
- Offline older edits may win only by a later valid successful submission; tombstones and unknown versions prevent publication.
- Rejoin previews, same-ID conflicts and local structured model overlays survive reboot.
- Every refresh caller uses remote coordination for shared accounts, while never-shared local accounts retain current behavior.
- Two simultaneous refresh callers send at most one upstream exchange. Unknown result, lost CAS reply and restart with journal do not replay the old token.
- Native entitlement/distribution and each claimed verified OAuth adapter have recorded execution evidence.
- Documentation-only delivery does not mark any of those gates as passed.

## 12. Code anchors and references

Verified starting points (paths relative to repository root):

| Area | Existing source |
| --- | --- |
| SDK and registry | packages/plugin-sdk/src/plugin/plugin.ts; packages/plugin-sdk/src/oauth.ts; packages/core/src/plugins/registry.ts |
| Install validation and plugin load | packages/core/src/plugins/installed-package.ts; packages/core/src/plugins/loader/index.ts |
| Account ownership/schema | packages/server/src/plugin-account.ts; packages/core/src/db/schema/plugin-oauth.ts; packages/core/src/plugins/repository/types.ts |
| Local refresh | packages/core/src/plugins/credential-port.ts; packages/core/src/plugins/repository/accounts.ts; packages/core/src/plugins/repository/plugin-state.ts |
| Raw config transaction | packages/core/src/plugins/config-file/index.ts; packages/server/src/config-store.ts |
| Account staging/recovery | packages/core/src/plugins/account-login/login/stage.ts; packages/core/src/plugins/account-login/recovery.ts |
| Runtime/lifecycle | packages/server/src/server-state/index.ts; packages/server/src/server-state/lifecycle.ts; packages/server/src/server-state/snapshot.ts |
| Control plane/UI | packages/server/src/dashboard-routes/config.ts; packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx; packages/cli/src/main.ts |
| Migration/release | packages/core/drizzle.config.ts; packages/core/scripts/build-migrations.ts; scripts/release.ts; .github/workflows/release.yml |
| Existing ad hoc signing | packages/cli/scripts/resign-standalone-binary.ts |

Apple references:
[Record change tag](https://developer.apple.com/documentation/cloudkit/ckrecord/recordchangetag),
[conditional save policy](https://developer.apple.com/documentation/cloudkit/ckmodifyrecordsoperation/recordsavepolicy/ifserverrecordunchanged),
[atomic operation limits](https://developer.apple.com/documentation/cloudkit/ckmodifyrecordsoperation/isatomic),
[custom zones](https://developer.apple.com/documentation/cloudkit/ckrecordzone),
[CKSyncEngine](https://developer.apple.com/documentation/cloudkit/cksyncengine-5sie5).

Implementation plans:
[Host and SDK](../plans/2026-09-08-config-sync-core.md),
[CloudKit](../plans/2026-09-08-config-sync-cloudkit.md),
[OAuth](../plans/2026-09-08-config-sync-oauth.md),
[Product integration and release](../plans/2026-09-08-config-sync-integration.md).
