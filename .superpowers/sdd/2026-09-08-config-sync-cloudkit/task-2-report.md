# Task 2 report: server-confirmed CloudKit storage primitives

Implemented the native `SyncStore` layer over an injected `CloudKitDriver`.

The implementation adds SHA-256 record IDs scoped to `AioProxySyncV1`, secure system-field versions, conditional CloudKit saves, backing tombstones for logical removal, prefix pagination, account identity pinning, payload/frame bounds, temporary asset cleanup, and recovery for a post-save transport loss. `CloudKitDatabaseDriver` contains the production CloudKit operation adapters. `FakeCloudKitDriver` provides deterministic in-memory behavior for native tests and does not contact CloudKit.

Tests cover concurrent create conflict behavior, stale removal protection, tombstone recreation, post-save recovery, pagination, and account identity changes. The test sources are guarded with `canImport(XCTest)` because the current packaging environment does not expose XCTest; on macOS with XCTest available they run as the requested `CloudKitStoreTests` XCTestCase.

## Verification

Command:

```sh
rtk proxy swift test --package-path packages/plugins/cloudkit/native
```

Output:

```text
Build complete! (1.41s)
```

The local toolchain compiled the executable and test bundle successfully. It skipped XCTest execution because XCTest is unavailable in this environment. A live CloudKit gate remains pending: production schema/index deployment, credentials, and a configured CloudKit container are required to verify the account, query, and server conflict behavior against CloudKit.

## Review fix report

The review follow-up now uses secure keyed archiving for CloudKit system fields, requires `CKRecord.modificationDate` for successful timestamps, creates asset files with mode `0600`, and removes them after the operation and at native startup. The fake driver now models server change tokens so replacement CAS and conditional tombstone updates are deterministic. Tests also cover hidden tombstones during pagination, malformed cursors, missing accounts, and payload/frame bounds, with awaited values captured before XCTest assertions.

Verification command:

```sh
rtk proxy swift test --package-path packages/plugins/cloudkit/native
```

Verification output:

```text
Build complete! (0.32s)
```

The command compiled the executable and test bundle successfully. XCTest execution remains unavailable in this host toolchain, and no live CloudKit gate is claimed; credentials and deployed schema/indexes are still required for that validation.

## Scoped re-review fix report

The fake driver now permits expected-null recreation only when the existing backing record is a tombstone; live records still return a create conflict. Fake queries retain tombstones while paginating, matching CloudKit cursor advancement, and `CloudKitStore.list` continues to hide tombstone keys. The pagination test now verifies that a tombstone consumes cursor space without skipping the following live record.

Verification command:

```sh
rtk proxy swift test --package-path packages/plugins/cloudkit/native
```

Verification output:

```text
Build complete! (0.28s)
```

The native executable and test bundle compile successfully. XCTest execution is unavailable on this host, so no live XCTest result or CloudKit gate is claimed.

## Concurrent tombstone recreation fix report

Expected-nil replacement of a tombstone now compares the incoming backing record’s current fake change token inside the actor. This preserves one-winner conditional semantics even when concurrent recreations both fetched the tombstone before either save. A deterministic concurrent recreation XCTest case covers one written result and one conflict.

Verification command:

```sh
rtk proxy swift test --package-path packages/plugins/cloudkit/native
```

Verification output:

```text
Build complete! (0.15s)
```

The executable and test bundle compile successfully. XCTest execution and live CloudKit validation remain unavailable in this environment.
