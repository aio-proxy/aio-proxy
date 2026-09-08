# Task 4 report

Implemented the CloudKit package and lazy sync registration.

The package now exports a `definePlugin` descriptor that registers only the `cloudkit` sync backend and exposes only `containerId` as business configuration. Connection derives the local native cache from the SDK `dataDirectory`, loads the packaged manifest, verifies the archive digest, safely extracts into a staging directory, rejects traversal and symlinks, checks the bundle/executable and native bundle version, and atomically activates a versioned installation. Failed activation retains the previous installation. macOS runtime verification invokes `codesign` and `spctl` and checks the bundle identifier, minimum OS, native version, and signing team; there is no unsigned production fallback. The native connect handshake rejects protocol versions other than protocol 1 before a sync session is returned.

Added `NativeManifest`/`NativeManifestSchema`, artifact installer tests, package export/artifact checks, the native packing script, publish metadata, README, and the CloudKit package in the Changesets fixed list.

## Verification

- `rtk proxy bun run --filter @aio-proxy/plugin-cloudkit test` — 16 passed across 3 files, including archive tampering, package path traversal, source symlink escape, verifier identity failure, interrupted extraction/preservation, unsupported OS, previous-version rollback, and native protocol mismatch cases.
- `rtk proxy bun run --filter @aio-proxy/plugin-cloudkit build` — passed; 10 files generated.
- `rtk proxy bun test packages/plugins/cloudkit/build/artifact.test.ts` — 1 passed.
- `rtk bunx oxlint ...` on changed files — passed.
- `rtk bunx oxfmt ...` on changed files — passed after formatting.

The packaged path regression is covered by `packages/plugins/cloudkit/build/artifact.test.ts`: `nativeArchivePath('CloudKit.app.zip')` produces `dist/native/CloudKit.app.zip`, matching the archive location emitted by `pack-native.ts` and the package-root runtime resolver.

The attempted standalone type-aware lint command was not used as a pass criterion because it does not load this package's Bun/Node type configuration; it reported missing `bun:test`, Bun globals, and Node declarations. Package build and runtime tests provide the applicable type/build verification.

The production signed artifact gate is blocked in this environment: the host is not macOS and no signed/notarized archive or Apple signing tools are available. `scripts/pack-native.ts` therefore refuses to run without `CLOUDKIT_SIGNED_ARCHIVE` and `CLOUDKIT_TEAM_ID`; it never creates an unsigned runtime package.
