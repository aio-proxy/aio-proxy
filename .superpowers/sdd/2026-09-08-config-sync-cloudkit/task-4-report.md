# Task 4 report

Implemented the CloudKit package and lazy sync registration.

The package now exports a `definePlugin` descriptor that registers only the `cloudkit` sync backend and exposes only `containerId` as business configuration. Connection derives the local native cache from the SDK `dataDirectory`, loads the packaged manifest, verifies the archive digest, safely extracts into a staging directory, rejects traversal and symlinks, checks the bundle/executable, and atomically activates a versioned installation. Failed activation retains the previous installation. macOS runtime verification invokes `codesign` and checks the bundle identifier, minimum OS, and signing team; there is no unsigned production fallback.

Added `NativeManifest`/`NativeManifestSchema`, artifact installer tests, package export/artifact checks, the native packing script, publish metadata, README, and the CloudKit package in the Changesets fixed list.

## Verification

- `rtk proxy bun run --filter @aio-proxy/plugin-cloudkit test` — 11 passed.
- `rtk proxy bun run --filter @aio-proxy/plugin-cloudkit build` — passed; 10 files generated.
- `rtk proxy bun test packages/plugins/cloudkit/build/artifact.test.ts` — 1 passed.
- `rtk bunx oxlint ...` on changed files — passed.
- `rtk bunx oxfmt ...` on changed files — passed after formatting.

The production signed artifact gate is blocked in this environment: the host is not macOS and no signed/notarized archive or Apple signing tools are available. `scripts/pack-native.ts` therefore refuses to run without `CLOUDKIT_SIGNED_ARCHIVE` and `CLOUDKIT_TEAM_ID`; it never creates an unsigned runtime package.
