# Task 6 report: product integration and release gates

## Delivered

- Added a real two-server acceptance fixture using two `createServerState`
  instances, separate temporary configuration homes, and one shared in-memory
  backend. The scenario drives the public ConfigStore, PluginControlPlane, and
  SyncControlPlane paths through restart, discovery, exclusion, purge, and
  independent local-copy assertions.
- Added immediate lifecycle reconciliation for retry and public control-plane
  apply flows. Remote-origin commits continue to avoid an entity publication
  echo; the backend server-time fence may still advance during reconciliation.
- Added a macOS release workflow gate that detects a lockstep CloudKit version
  newer than npm, imports signing material into a temporary keychain, builds and
  signs the native bundle, exports the exact signed archive for the publish
  script, and removes the keychain and temporary credential files in an
  always-running cleanup step.
- Extended `scripts/release.ts` to restore the signed archive after the JS build
  cleans package `dist` directories and to reject missing or stale CloudKit
  manifests, version mismatches, unsafe archive paths, team mismatches, and
  digest mismatches before packing. The existing Changesets publish/tag flow is
  unchanged.
- Consolidated the two pending sync changesets into one lockstep feature note
  covering `aio-proxy`, `@aio-proxy/plugin-sdk`, `@aio-proxy/core`,
  `@aio-proxy/server`, `@aio-proxy/types`, and `@aio-proxy/plugin-cloudkit`.
- Updated the configuration sync, CloudKit, and OAuth testing guides with the
  deterministic commands and the blocked native/live release conditions.

## Verification

From `packages/server`:

```text
rtk bun test --preload=./__tests__/setup.ts src/sync-control-plane/acceptance.test.ts
1 pass, 0 fail, 6 expect() calls
```

CloudKit deterministic checks:

```text
rtk bun test packages/plugins/cloudkit/build/artifact.test.ts
1 pass, 0 fail

rtk bun run --filter @aio-proxy/plugin-cloudkit test
16 pass, 0 fail

rtk swift test --package-path packages/plugins/cloudkit/native
exit 0; native test bundle built successfully
```

The first full CloudKit package run encountered an intermittent EPIPE in the
partial-frame test; the focused native-session run and an immediate full rerun
both passed. Swift emitted the existing Swift 6 concurrency warnings for the
`NSLock` calls in `StdioServer.swift`.

Other checks:

```text
rtk bun run --filter @aio-proxy/dashboard build
exit 0

rtk bun run i18n:compile
exit 0

rtk bun run check
exit 0; existing oxlint warnings only, formatting clean
```

The focused native build command also completed successfully:

```text
rtk bun packages/plugins/cloudkit/scripts/build-native.ts
exit 0
```

## Blocked gates

- `rtk bun packages/plugins/cloudkit/scripts/sign-native.ts` exited 1 with
  `Missing native signing input: CLOUDKIT_TEAM_ID`. No private signing
  material, profile, or notarization credentials were available in this
  workspace.
- The unsigned installed probe was run with an isolated temporary data root
  and `CLOUDKIT_CONTAINER_ID=iCloud.dev.aioproxy`. It exited 0 while recording
  `signatureStatus: unsigned`, direct launch `unsupported` with exit code 133,
  an unverified launchd result, and `productionGate: blocked`. The existing
  redacted evidence file remains
  `docs/testing/evidence/cloudkit-sync.json`, with all live cases blocked.
- The live OAuth runner could not proceed without the required isolated test
  home, dedicated account, Provider, remote object, configured backend, and
  provider-specific upstream. The existing redacted evidence at
  `docs/testing/evidence/oauth-sync.json` remains blocked with
  `setup-test-home-required`; no credentials or account identifiers were
  created.
- `rtk bun run preflight` remains blocked by baseline type-aware diagnostics in
  the dashboard OAuth editor (`TS2322`, `TS2589`), CloudKit `artifact.ts`
  (`TS18048`), and CloudKit `sign-native.ts` (`TS2322`). The touched release
  script itself passes `rtk bunx oxlint scripts/release.ts` and the touched
  files pass `rtk bunx oxfmt --check`.

Signed CloudKit, installed-path, launchd, two-Mac, and live OAuth readiness are
therefore not claimed.
