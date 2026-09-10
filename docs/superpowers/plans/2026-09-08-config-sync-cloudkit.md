# Configuration Sync — CloudKit Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a signed macOS CloudKit storage plugin that satisfies the public CAS contract.

**Architecture:** An installable JavaScript plugin owns a Swift app bundle and stdio session. Native CloudKit calls return confirmed server results; the host remains responsible for scope, merge, OAuth and recovery.

**Tech Stack:** macOS 14+, Swift 5.9+, CloudKit/Foundation, Bun 1.4.2+, TypeScript, Zod 4, codesign, notarytool and Bun test.

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

## Dependencies and gate order

Requires the SDK contract from core Task 1. Task 1 below is an early feasibility gate; run it before investing in the production adapter. Tasks 2–4 can use local fake storage without credentials. Task 5 must pass against signed installed artifacts before enabling CloudKit in a release.

Read Apple's recordChangeTag/.ifServerRecordUnchanged/custom-zone docs linked in the spec. Bun process APIs were checked against [the official subprocess page](https://bun.com/docs/runtime/child-process.md); use piped stdin/stdout/stderr, bounded streaming reads and awaited process exit.

## File structure

| Path | Responsibility |
| --- | --- |
| packages/plugins/cloudkit/package.json, rslib.config.ts, tsconfig.json | Separately installable @aio-proxy/plugin-cloudkit package. |
| packages/plugins/cloudkit/src/index.ts | Plugin descriptor with registration only. |
| packages/plugins/cloudkit/src/native-session/ | IPC protocol, bounded parsing, connection and cancellation. |
| packages/plugins/cloudkit/src/native-artifact/ | Manifest/digest/signature validation and staged installation. |
| packages/plugins/cloudkit/native/Package.swift | Native targets with macOS 14 deployment floor. |
| packages/plugins/cloudkit/native/Sources/CloudKitBridge/ | CloudKit store, wire frames and executable entry. |
| packages/plugins/cloudkit/native/Tests/CloudKitBridgeTests/ | Storage/IPC behavior using an injected database driver. |
| packages/plugins/cloudkit/native/Resources/Info.plist | dev.aioproxy bundle identity and hidden helper metadata. |
| packages/plugins/cloudkit/scripts/ | Build, sign, notarize, installed-artifact smoke and evidence output. |
| docs/testing/cloudkit-sync.md | Reproducible native gates and redacted evidence schema. |

Each tested TypeScript directory has index.ts, a named implementation and colocated tests. Native files separate storage/IPC/identity/assets. Do not place Apple entitlements or credentials on the main CLI binary.

### Task 1: Prove iCloud access from the signed installed native bundle

**Files:**

- Create: packages/plugins/cloudkit/native/Package.swift.
- Create: packages/plugins/cloudkit/native/Sources/CloudKitBridge/main.swift, AccountProbe.swift.
- Create: packages/plugins/cloudkit/native/Resources/Info.plist.
- Create: packages/plugins/cloudkit/scripts/build-native.ts, sign-native.ts, probe-installed.ts.
- Create: docs/testing/cloudkit-sync.md.

**Interfaces:**

- Native invocation: AIOProxyCloudKit --probe; reads one JSON line { containerId: string, expectedBundleId: "dev.aioproxy" } from stdin.
- Output: { ok: true, account: "available", identityId: string, bundleId: string } or { ok: false, error: { code: SyncFailureCode } }.
- build-native.ts produces a universal arm64/x86_64 AIOProxyCloudKit.app under dist/native.
- sign-native.ts consumes APPLE_TEAM_ID, APPLE_SIGN_IDENTITY, APPLE_PROFILE_PATH, APPLE_CLOUDKIT_CONTAINER_ID and APPLE_NOTARY_PROFILE from the executing environment. Signing identity/profile/container must agree; these are actual supplied inputs, not example credentials.

- [ ] **Step 1: Create the probe and expected-failure procedure.**

~~~swift
import CloudKit
import Foundation

struct AccountProbe {
    static func run(containerId: String) async throws -> String {
        let container = CKContainer(identifier: containerId)
        guard try await container.accountStatus() == .available else {
            throw ProbeError.accountUnavailable
        }
        return try await container.userRecordID().recordName
    }
}
enum ProbeError: Error { case accountUnavailable }
~~~

main.swift decodes the input, checks Bundle.main.bundleIdentifier, invokes AccountProbe and emits only the structured result; it must never print user email or payload values. Hash the container-scoped userRecordID before returning identityId; it is an opaque local binding identifier, not a login credential.

Run the unsigned executable through probe-installed.ts first.
Expected: compilation succeeds, and the production-access gate is not marked passed. Record whether the unsigned probe fails with entitlement/account errors rather than requiring one particular Apple error string.

- [ ] **Step 2: Build the real app bundle.**

~~~swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CloudKitBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AIOProxyCloudKit", targets: ["CloudKitBridge"])],
    targets: [
        .executableTarget(name: "CloudKitBridge"),
        .testTarget(name: "CloudKitBridgeTests", dependencies: ["CloudKitBridge"]),
    ]
)
~~~

build-native.ts runs swift build for arm64-apple-macosx14.0 and x86_64-apple-macosx14.0, uses lipo to create a universal executable and writes Contents/MacOS/AIOProxyCloudKit plus Info.plist. Info.plist contains CFBundleIdentifier dev.aioproxy, CFBundleExecutable AIOProxyCloudKit, CFBundlePackageType APPL, LSUIElement true and LSMinimumSystemVersion 14.0. Derive CFBundleVersion from the plugin release manifest rather than an unrelated version.

Validate required environment inputs without printing their values:

~~~ts
const required = [
  'APPLE_TEAM_ID', 'APPLE_SIGN_IDENTITY', 'APPLE_PROFILE_PATH',
  'APPLE_CLOUDKIT_CONTAINER_ID', 'APPLE_NOTARY_PROFILE',
] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error('Missing native signing input: ' + key);
}
~~~

The GitHub-hosted release runner supplies the corresponding `APPLE_*` secrets,
imports the Developer ID certificate and profile into a temporary keychain, and
creates `APPLE_NOTARY_PROFILE` from the App Store Connect API key before signing.

Decode the supplied profile using security cms, verify its team/application identifier, allowed iCloud container and distribution environment. Generate only profile-permitted entitlements, including iCloud-services CloudKit, container IDs, team/application identifier and the matching iCloud environment. Embed the profile. Sign nested code first and the bundle last with Developer ID, hardened runtime and timestamp. Do not ad hoc re-sign after this step. Push entitlement is included only when actually implementing/validating push; polling needs no push delivery.

- [ ] **Step 3: Notarize, staple and validate installed-path launch.**

Run after real inputs have been supplied:

~~~sh
rtk proxy bun packages/plugins/cloudkit/scripts/build-native.ts
rtk proxy bun packages/plugins/cloudkit/scripts/sign-native.ts
rtk proxy bun packages/plugins/cloudkit/scripts/probe-installed.ts
~~~

sign-native.ts submits the zipped app using xcrun notarytool with the named private keychain profile, waits for Accepted, staples the app and verifies codesign/spctl. probe-installed.ts extracts into the same versioned plugin cache layout used in production, verifies that path, launches its inner executable with piped stdio and checks the bundle identity/iCloud account response.

The gate must also run from the real launchd aio-proxy background service context, on macOS 14 and a current macOS. Being signed or working in Xcode is not sufficient. Confirm iCloud.dev.aioproxy creation/association and development/production environment access with the user's Apple account; no container is assumed to exist. Record missing inputs or entitlement rejection as an unmet gate.

- [ ] **Step 4: Record evidence and commit the probe tooling.**

Evidence fields: host OS/architecture, bundle/plugin version, team ID, bundle ID, container ID, environment, signature/notarization status, direct launch result, service launch result and timestamp. Exclude credentials, private keys, profile bytes and raw account IDs.

~~~sh
rtk git add packages/plugins/cloudkit/native packages/plugins/cloudkit/scripts docs/testing/cloudkit-sync.md
rtk git commit -m "feat(cloudkit): add signed native entitlement probe" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

Do not mark production readiness if service-path access is unproven. The remaining deterministic tasks are still useful, but CloudKit stays unavailable for release until the gate is resolved.

### Task 2: Implement server-confirmed CloudKit storage primitives

**Files:**

- Create: native/Sources/CloudKitBridge/CloudKitStore.swift, RecordVersion.swift, AssetStore.swift, AccountIdentity.swift, CloudKitDriver.swift under packages/plugins/cloudkit/.
- Create: native/Tests/CloudKitBridgeTests/CloudKitStoreTests.swift, FakeCloudKitDriver.swift.
- Modify: native/Sources/CloudKitBridge/main.swift.

**Interfaces:**

~~~swift
struct StoredValue {
    let bytes: Data
    let version: String
    let modifiedAt: Int64
}
enum StoreRead { case absent, present(StoredValue) }
enum StoreCAS { case conflict, written(version: String, modifiedAt: Int64) }
struct StorePage { let keys: [String]; let nextCursor: String? }

protocol SyncStore {
    func read(key: String) async throws -> StoreRead
    func compareAndSwap(key: String, expected: String?, value: Data) async throws -> StoreCAS
    func list(prefix: String, cursor: String?) async throws -> StorePage
    func remove(key: String, expected: String) async throws -> Bool
}
~~~

CloudKitStore implements SyncStore over an injected CloudKitDriver. Driver methods fetch(id:), saveConditionally(record:), query(prefix:cursor:) and accountIdentity() mirror those operations using CKRecord/CKQueryOperation.Cursor. FakeCloudKitDriver keeps records/change tags in an actor, supports create conflicts and injected post-save transport loss. Native tests never contact CloudKit by default.

- [ ] **Step 1: Add atomic create and stale-removal tests.**

~~~swift
func testOnlyOneConcurrentCreateWins() async throws {
    let driver = FakeCloudKitDriver()
    let a = CloudKitStore(driver: driver)
    let b = CloudKitStore(driver: driver)
    async let left = a.compareAndSwap(key: "k", expected: nil, value: Data("a".utf8))
    async let right = b.compareAndSwap(key: "k", expected: nil, value: Data("b".utf8))
    let results = try await [left, right]
    XCTAssertEqual(results.filter { if case .written = $0 { return true }; return false }.count, 1)
}
~~~

Place the method in CloudKitStoreTests: XCTestCase and import XCTest/@testable import CloudKitBridge. Add a stale version remove case and a compareAndSwap expected nil after a logical remove. Verify one winner and no deletion of a newer value.

- [ ] **Step 2: Run failing tests.**

Run: rtk proxy swift test --package-path packages/plugins/cloudkit/native
Expected: FAIL missing driver/store methods.

- [ ] **Step 3: Implement mapping and conditional saves.**

Use record type AioSyncValue in zone AioProxySyncV1. Fields: logicalKey String, removed Int64, payload CKAsset. Record IDs derive from SHA-256 of the full protocol key, scoped to that zone. Store key in the record to verify against collisions/corrupted version input. Encode/decode system fields with secure NSKeyedArchiver/Unarchiver to reconstruct the exact record ID/change tag.

~~~swift
final class SavedRecordBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: CKRecord?
    func store(_ record: CKRecord) { lock.lock(); defer { lock.unlock() }; value = record }
    func load() -> CKRecord? { lock.lock(); defer { lock.unlock() }; return value }
}
func saveConditionally(_ record: CKRecord, database: CKDatabase) async throws -> CKRecord {
    try await withCheckedThrowingContinuation { continuation in
        let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
        operation.savePolicy = .ifServerRecordUnchanged
        operation.isAtomic = true
        let saved = SavedRecordBox()
        operation.perRecordSaveBlock = { _, result in
            if case let .success(record) = result { saved.store(record) }
        }
        operation.modifyRecordsResultBlock = { result in
            switch result {
            case .success:
                if let record = saved.load() { continuation.resume(returning: record) }
                else { continuation.resume(throwing: StoreError.invalidData) }
            case let .failure(error): continuation.resume(throwing: error)
            }
        }
        database.add(operation)
    }
}
enum StoreError: Error { case invalidData, identityChanged, outcomeUnknown }
~~~

The result cell protects cross-callback access. Validate callback completion ordering with the injected driver and Swift concurrency checks before consuming the saved record.

CloudKit does not provide version-conditional record deletion through recordIDsToDelete. Implement SDK remove as a conditional update setting removed=1 and clearing payload. read maps that storage tombstone to absent; list hides it. A subsequent expected-null create fetches that backing record and conditionally replaces it, so concurrent creates still have one winner. Protocol erased markers are live payload records and are never passed to remove.

For non-null expected, verify its record ID/zone/key and reuse system fields. A serverRecordChanged or create collision returns conflict. Offline/unknown writes remain distinct. Use temporary asset files with mode 0600, delete only after CloudKit operation completion, and remove abandoned temp files at native startup. Use 8 MiB payload and 16 MiB frame bounds.

modifiedAt is the returned saved record.modificationDate. If missing, do not return success; report outcome-unknown and recover by read. List uses a queryable logicalKey prefix and serialized cursor, with desiredKeys limited to logicalKey/removed. Verify query/index support in both CloudKit environments; deploy the AioSyncValue schema/indexes to Production before its live test. No lease TTL, arbitrary server predicate or multi-zone transaction is inferred from these APIs.

- [ ] **Step 4: Verify native deterministic cases.**

Run: rtk proxy swift test --package-path packages/plugins/cloudkit/native
Expected: PASS for keys/assets/CAS, backing tombstones, pagination, missing account, account identity change and post-save unknown outcome. Re-run gate 1 after native bundle contents change.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugins/cloudkit/native
rtk git commit -m "feat(cloudkit): implement conditional native storage" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 3: Add bounded stdio IPC, cancellation and session disposal

**Files:**

- Create: packages/plugins/cloudkit/src/native-session/index.ts, native-session.ts, protocol.ts, frame-reader.ts, native-session.test.ts.
- Create: packages/plugins/cloudkit/native/Sources/CloudKitBridge/WireProtocol.swift, StdioServer.swift.
- Create: packages/plugins/cloudkit/src/native-session/fake-native.ts (test executable).
- Create: packages/plugins/cloudkit/package.json, tsconfig.json, rslib.config.ts.

**Interfaces:**

~~~ts
export type NativeRequest = {
  id: string;
  op: 'connect' | 'read' | 'cas' | 'list' | 'remove' | 'cancel' | 'dispose';
  input: Record<string, unknown>;
};
export type NativeReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: SyncFailureCode } }
  | { event: 'identity-changed' | 'change-hint' };
export function connectNative(input: {
  executable: string; containerId: string; signal: AbortSignal;
}): Promise<SyncSession>;
~~~

read returns spec SyncRead with value represented as base64 on the wire; cas input is { key, expected, valueBase64 }. list input/output follows SyncSession. remove input is { key, expected }. connect returns identityId, spaceId "default", maxValueBytes, protocol 1 and native version. cancel input is { targetId }; dispose stops new work, cancels operations and exits. Only a correlated confirmed reply resolves a pending mutation as success.

- [ ] **Step 1: Test exit, truncation and identity changes.**

~~~ts
import { expect, test } from 'bun:test';
import { connectNative } from './native-session';
import { withFakeNative } from './test-support';

test('native exit during CAS does not look like an uncommitted failure', async () => {
  await withFakeNative('exit-after-write', async (executable) => {
    const signal = new AbortController().signal;
    const session = await connectNative({ executable, containerId: 'test', signal });
    await expect(session.compareAndSwap('k', null, new Uint8Array([1]), signal))
      .rejects.toMatchObject({ code: 'outcome-unknown' });
    await session.dispose();
  });
});
~~~

Create native-session/test-support.ts with withFakeNative(mode: 'exit-after-write' | 'partial-frame' | 'identity-change' | 'oversized' | 'ok', run: (executable: string) => Promise<void>): Promise<void>. It builds a temporary executable launcher for fake-native.ts, which speaks the real frames and stores only test bytes. On Windows tests may call Bun with explicit argv through an injected spawn factory; production connectNative always uses the verified native executable path. Test that disposal kills that child and resolves without leaking handles.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/plugins/cloudkit/src/native-session/native-session.test.ts
Expected: FAIL missing native session.

- [ ] **Step 3: Implement framing and transport.**

~~~ts
const child = Bun.spawn([input.executable], {
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});
function send(request: NativeRequest): void {
  const line = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(line) > 16 * 1024 * 1024)
    throw new SyncBackendError('quota', 'native frame limit exceeded');
  child.stdin.write(line);
  child.stdin.flush();
}
~~~

Use a streaming byte parser that rejects a frame once buffered bytes exceed 16 MiB; do not await stdout.text() on an indefinite service. Decode JSON/Zod only after a full newline, reject duplicate/unexpected IDs and fail all pending work on EOF. Keep read/control failures and possible submitted mutations separate: EOF/abort after sending a mutation is outcome-unknown. Cancellation does not prove non-commit.

Native StdioServer keeps an operation task by request ID and observes input EOF/SIGTERM. Wire output is serialized so responses cannot interleave. AccountIdentity emits identity-changed on CKAccountChanged, cancels in-flight work and terminates the old session. JS ignores later replies from its old session generation. Use no process.unref(); the component is owned by the host service.

On dispose, send dispose, await exit up to 5 seconds, then SIGTERM, wait up to 2 seconds, then SIGKILL. Always settle pending promises and close frame readers. Treat timing as shutdown policy, not a remote commit decision. Redact stderr by emitting only enumerated diagnostic codes; unknown native stderr is not passed through to the user verbatim.

- [ ] **Step 4: Verify.**

Run: rtk proxy bun test packages/plugins/cloudkit/src/native-session/native-session.test.ts
Run: rtk proxy swift test --package-path packages/plugins/cloudkit/native
Expected: PASS including fragmented UTF-8 frames, excessive payload, abort, lost reply, identity switch and repeated disposal.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugins/cloudkit
rtk git commit -m "feat(cloudkit): bridge storage sessions over bounded stdio" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 4: Package the signed artifact and register a lazy plugin

**Files:**

- Create: packages/plugins/cloudkit/src/index.ts.
- Create: packages/plugins/cloudkit/src/native-artifact/index.ts, native-artifact.ts, native-artifact.test.ts.
- Create: packages/plugins/cloudkit/scripts/pack-native.ts, packages/plugins/cloudkit/build/artifact.test.ts.
- Modify: packages/plugins/cloudkit/package.json, packages/plugins/cloudkit/rslib.config.ts, .changeset/config.json.
- Create: packages/plugins/cloudkit/README.md.

**Interfaces:**

~~~ts
export interface NativeManifest {
  format: 1; pluginVersion: string; nativeVersion: string;
  bundleId: 'dev.aioproxy'; teamId: string;
  minimumMacOS: '14.0'; archive: string; sha256: string;
}
export function ensureNativeArtifact(input: {
  packageRoot: string; cacheRoot: string; manifest: NativeManifest; signal: AbortSignal;
}): Promise<{ executable: string }>;
export interface CloudKitOptions { containerId: string }
~~~

cacheRoot is join(context.dataDirectory, 'native'), using the SDK's required local connection dataDirectory. ensureNativeArtifact creates a versioned installation below it. CloudKitOptions contains only containerId; never put local cache paths into business config or share installations implicitly across configuration directories.

- [ ] **Step 1: Add lazy setup and artifact integrity tests.**

~~~ts
import { expect, test } from 'bun:test';
import { ensureNativeArtifact } from './native-artifact';
import { withArtifactFixture } from './test-support';

test('rejects a changed archive before launching anything', async () => {
  await withArtifactFixture(async (f) => {
    await Bun.write(f.archivePath, 'tampered');
    await expect(ensureNativeArtifact({
      packageRoot: f.packageRoot, cacheRoot: f.cacheRoot,
      manifest: f.manifest, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'invalid-data' });
    expect(f.launched()).toBe(false);
  });
});
~~~

Define native-artifact/test-support.ts with withArtifactFixture(run): Promise<void>; it creates a temporary archive/manifest/cache and injected signature verifier/launcher counters. Also run the real codesign verifier in the live artifact gate. Test refusal of path traversal/symlink escape, wrong team/bundle, old native version, unsupported OS, interrupted extraction and preservation of the previous installation.

- [ ] **Step 2: Run.**

Run: rtk proxy bun test packages/plugins/cloudkit/src/native-artifact/native-artifact.test.ts
Expected: FAIL missing artifact installer.

- [ ] **Step 3: Register only, stage and verify on connect.**

~~~ts
export default definePlugin((api) => {
  api.sync.register({
    id: 'cloudkit', displayName: 'iCloud',
    options: {
      schema: z.object({ containerId: z.string().default('iCloud.dev.aioproxy') }),
      form: [],
    },
    async connect(options, context) {
      const packageRoot = fileURLToPath(new URL('../', import.meta.url));
      const cacheRoot = join(context.dataDirectory, 'native');
      const manifest = NativeManifestSchema.parse(
        await Bun.file(join(packageRoot, 'dist/native/manifest.json')).json(),
      );
      const artifact = await ensureNativeArtifact({
        packageRoot, cacheRoot, manifest, signal: context.signal,
      });
      return connectNative({
        executable: artifact.executable, containerId: options.containerId, signal: context.signal,
      });
    },
  });
});
~~~

Import fileURLToPath from node:url and join from node:path; NativeManifestSchema is the Zod schema for NativeManifest exported by native-artifact. The packaged entry is dist/index.js, so its parent is packageRoot. Do not read cloud state, download, extract or launch from setup.

Ship native archives as package files; no arbitrary executable URL. Extraction must reject absolute paths, parent traversal and symlinks escaping its staging root. Verify SHA-256, codesign designated requirement/team/bundle identifier, notarization status and native protocol version. Rename the verified staging directory into a versioned cache path; never mutate a running bundle. On upgrade dispose the old session before activating the new executable. On failure retain the old bundle/binding and report a retryable update error.

Package name is @aio-proxy/plugin-cloudkit; make it publishable, with SDK peer/dev dependency workspace:* and the ordinary infra/rslib catalog dependencies. Add its exact name to the Changesets fixed list. A build without a supplied signed archive may create a development package for unit tests, but artifact verification/production packing must fail clearly; no unsigned runtime fallback.

- [ ] **Step 4: Verify packaged exports and install behavior.**

Run: rtk proxy bun run --filter @aio-proxy/plugin-cloudkit test
Run: rtk proxy bun run --filter @aio-proxy/plugin-cloudkit build
Run: rtk proxy bun test packages/plugins/cloudkit/build/artifact.test.ts
Expected: deterministic tests pass. Production artifact test passes only with the signed/notarized archive and verifies contents of the packed package, not the source tree.

- [ ] **Step 5: Commit.**

~~~sh
rtk git add packages/plugins/cloudkit .changeset/config.json
rtk git commit -m "feat(cloudkit): package signed native sync backend" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

### Task 5: Run real backend conformance and distribution gates

**Files:**

- Create: packages/plugins/cloudkit/scripts/conformance-live.ts.
- Modify: docs/testing/cloudkit-sync.md.
- Create at execution time: docs/testing/evidence/cloudkit-sync.json (redacted results, no secrets).

**Interfaces:**

- conformance-live.ts imports exerciseSyncBackend from @aio-proxy/plugin-sdk/testing and creates two connections using the installed artifact.
- Live mode requires explicit --live and a test-space prefix with fresh UUID; it prints only counts/error codes. It must not delete the default user configuration space.
- Evidence records each case as pass/fail/blocked, with actual OS/version and artifact digest. A blocked result is not a pass.

- [ ] **Step 1: Add live execution wiring.**

~~~ts
import { exerciseSyncBackend } from '@aio-proxy/plugin-sdk/testing';
import { connectInstalledPair } from './live-support';

if (!process.argv.includes('--live')) throw new Error('Use --live for the dedicated test namespace');
await exerciseSyncBackend(connectInstalledPair);
~~~

Define live-support.ts: connectInstalledPair(): Promise<{ a: SyncSession; b: SyncSession; cleanup(): Promise<void> }>. It validates the actual package manifest/container, prefixes test keys with a fresh run UUID, connects two distinct native processes, and disposes both. The conformance wrapper never aliases a/b to one JS session.

- [ ] **Step 2: Run deterministic package and native tests.**

~~~sh
rtk proxy bun run --filter @aio-proxy/plugin-cloudkit test
rtk proxy swift test --package-path packages/plugins/cloudkit/native
~~~

Expected: PASS before live work.

- [ ] **Step 3: Run signed installed conformance.**

Run: rtk proxy bun packages/plugins/cloudkit/scripts/conformance-live.ts --live
Expected: one winning create/update, stale writes rejected, direct reads confirmed, list convergence and conditional remove correctness. Then repeat the same scenarios using two Macs signed into the same system iCloud account. A same-machine pair alone does not prove cross-device behavior.

- [ ] **Step 4: Exercise distribution and operational failures.**

Run the actual background service on macOS 14/current macOS with Dashboard closed. Disconnect/reconnect network, switch iCloud identity, restart service/native process, interrupt plugin upgrade, simulate quota through the driver and exercise one real storage rejection if a controlled test account permits it. Verify pending CAS results recover on restart. Confirm Production schema/index availability and direct installed-path entitlement access.

Notification delivery is optional: demonstrate polling after lost hints. If APNs/watch is implemented, record subscription/permission behavior separately. Do not mark push delivery as necessary for correctness.

- [ ] **Step 5: Record outcome and commit evidence tooling.**

~~~sh
rtk git add packages/plugins/cloudkit/scripts docs/testing/cloudkit-sync.md docs/testing/evidence/cloudkit-sync.json
rtk git commit -m "test(cloudkit): verify installed backend conformance" -m "Co-authored-by: Codex <noreply@openai.com>"
~~~

Release requires the real native gates to pass. If signing or installed-path access is blocked, retain the tested generic engine and keep the CloudKit capability unavailable until those inputs/issues are resolved.
