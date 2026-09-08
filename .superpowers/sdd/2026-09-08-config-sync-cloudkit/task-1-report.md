# Task 1 review follow-up

Date: 2026-09-09

The signed artifact path now binds the final post-staple artifact to the
release manifest. The build manifest records unsigned executable/app digests;
the signing procedure verifies the Developer ID identity and distribution
profile, signs nested code before the bundle, verifies effective entitlements,
submits a pre-staple archive, staples and validates the ticket, then creates a
final archive and records its executable/app/archive digests. The installed
probe checks those digests, universal architectures, bundle identifier,
deployment floor, signing team, effective CloudKit entitlements, embedded
profile properties, stapled ticket and Gatekeeper assessment before launch.

Installation validation is staged in a temporary versioned directory. The
previous version remains in place until validation succeeds; a failed swap
restores the previous directory. The deterministic Bun tests cover profile and
entitlement mismatches, universal manifest/digest requirements, signing order,
privacy-shaped probe responses and rollback on injected swap failure.

Verification performed:

- `rtk proxy bun test packages/plugins/cloudkit/scripts/artifact.test.ts packages/plugins/cloudkit/scripts/build-native.test.ts packages/plugins/cloudkit/scripts/probe-installed.test.ts` — 9 passed.
- `rtk proxy bunx oxlint` on all CloudKit scripts — passed.
- `rtk proxy bunx oxfmt` on all CloudKit scripts — passed.
- `rtk proxy bun packages/plugins/cloudkit/scripts/build-native.ts` — passed; universal arm64/x86_64 output and manifest digests confirmed.
- `rtk proxy swift test --package-path packages/plugins/cloudkit/native` — build/test target passed.
- Unsigned installed probe — recorded `productionGate: blocked`, `serviceLaunch: unverified`, direct `unsupported` with exit 133.

The live signing, notarization, CloudKit account, installed launchd service,
macOS 14/current two-host and production-container gates remain unverified.
No signing credentials, profile bytes, raw account IDs or fabricated success
were used.

## Round 2 follow-up

The manifest now requires the app digest and validates release-safe relative
paths, executable containment, final signed archive binding and signing status.
Signing and installed probing resolve the executable from the manifest and
reject source, archive, cache, version and staging symlink escapes. Installed
validation binds executable/app/archive digests, deployment floor, universal
architectures, effective entitlements, embedded profile, stapled ticket and
Gatekeeper assessment before the atomic swap. Evidence records the actual
`sw_vers -productVersion` value.

Additional deterministic coverage checks unsafe manifest paths, final archive
requirements, symlinked roots and rollback behavior. Verification performed:

- 11 CloudKit Bun tests passed.
- CloudKit oxlint and oxfmt checks passed.
- Native universal build and Swift package tests passed.
- Unsigned installed probe recorded `osVersion: 26.6`, direct `unsupported`,
  `productionGate: blocked`, and `serviceLaunch: unverified`.
