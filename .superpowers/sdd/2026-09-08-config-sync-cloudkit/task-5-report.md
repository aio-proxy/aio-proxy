# Task 5 report: real backend conformance and distribution gates

## Implementation

Added `packages/plugins/cloudkit/scripts/conformance-live.ts` and
`live-support.ts`. The wrapper requires `--live`, records redacted case
evidence for every required gate, and exits unsuccessfully when any gate is
blocked or fails. The
support module validates the package/native manifest version, container ID,
signed artifact metadata, cached bundle/executable digests, codesign,
notarization, entitlements, and versioned installed cache path before starting
two separate native processes. Cleanup disposes both sessions and removes the
UUID-scoped fixtures. The shared conformance harness supplies a fresh UUID key
prefix and exercises concurrent create, stale CAS, direct reads, pagination,
and conditional removal.

Updated `docs/testing/cloudkit-sync.md` with the invocation, namespace and
installed-artifact requirements. The generated evidence is at
`docs/testing/evidence/cloudkit-sync.json`; it contains no credentials or
account identifiers. Stdout is restricted to aggregate counts and error codes.

## Deterministic checks

| Check                                                        | Result                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `bun run --filter @aio-proxy/plugin-cloudkit test`           | PASS (16 tests; one transient rerun failure recovered) |
| `swift test --package-path packages/plugins/cloudkit/native` | PASS (build and native test target; no failures)       |
| `oxfmt --check` on new scripts                               | PASS                                                   |
| `oxlint` on new scripts                                      | PASS                                                   |

## Live gate outcome

The live wrapper was invoked with `--live`. The installed signed artifact and
container inputs were unavailable, so the case is recorded as `blocked` with
`productionGate: blocked`. Evidence records the actual host as macOS 26.6,
arm64, and reports the artifact digest as unavailable because no native
manifest was present. No Apple/CloudKit success is claimed. Cross-device
execution on two Macs, launchd service execution, identity/network/quota
failure exercises, and Production schema/index verification remain blocked
until the signed installed artifact and controlled test account are supplied.

CloudKit remains a release NO-GO under the task brief.

## Review fix round 1

The review identified that a passing local pair could leave the release gate
looking ready and that setup errors were classified as failures. The wrapper
now initializes every required distribution/live gate to `blocked`, marks only
the local pair after execution, and keeps setup errors blocked. It also checks
the installed app through the existing bundle verifier, including digest,
signature, notarization, entitlement, archive, and container metadata checks.
The evidence field is now named `installedAppSha256` and is validated against
the manifest's app digest; it comes from the installed cached app. The
remaining gates are intentionally blocked because this host has no signed
artifact, controlled CloudKit account/schema, second Mac, or launchd test
environment.

Focused wrapper tests were not added because importing the executable wrapper
intentionally requires `--live` and performs filesystem/process setup at module
scope. Existing installed-probe tests cover the shared bundle verifier and
redacted output contract; the live wrapper was exercised directly and emitted
nine blocked cases with aggregate-only stdout.

## Review fix round 2

Native launch and account connection errors are setup blockers and are wrapped
as `LiveSetupError`; only failures after both sessions connect can be a
conformance failure. Fixture keys are registered before every mutation,
cleanup retries reads/removes, and cleanup errors are surfaced while retaining
the original failure. The executable is derived with the manifest path helper
after bundle verification. Evidence writing and host probing degrade to a
blocked result instead of masking it.

The rerun used the prescribed commands:

```sh
rtk proxy bun run --filter @aio-proxy/plugin-cloudkit test
rtk proxy swift test --package-path packages/plugins/cloudkit/native
rtk proxy bun packages/plugins/cloudkit/scripts/conformance-live.ts --live
rtk proxy bun run check
```

All deterministic checks passed, the direct live run exited 1 with nine
blocked cases, and the release gate remains NO-GO. Swift emitted existing
Swift-concurrency locking warnings; repository lint emitted existing
dashboard/logger warnings.

## Review fix round 3

Cleanup now treats a remove conflict as unresolved, rereads the current
version, and retries until the record is actually removed or cleanup fails.
Native session disposal is likewise retried and surfaced through an idempotent
cleanup promise; primary conformance errors remain preserved alongside any
cleanup error. The nine unavailable live/distribution gates remain blocked and
CloudKit remains a release NO-GO.
