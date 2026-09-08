# Task 5 report: real backend conformance and distribution gates

## Implementation

Added `packages/plugins/cloudkit/scripts/conformance-live.ts` and
`live-support.ts`. The wrapper requires `--live`, records redacted case
evidence, and exits unsuccessfully when the gate is blocked or fails. The
support module validates the package/native manifest version, container ID,
verified signing status, and versioned installed cache path before starting
two separate native processes. Cleanup disposes both sessions. The shared
conformance harness supplies a fresh UUID key prefix and exercises concurrent
create, stale CAS, direct reads, pagination, and conditional removal.

Updated `docs/testing/cloudkit-sync.md` with the invocation, namespace and
installed-artifact requirements. The generated evidence is at
`docs/testing/evidence/cloudkit-sync.json`; it contains no credentials or
account identifiers.

## Deterministic checks

| Check                                                        | Result                                           |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `bun run --filter @aio-proxy/plugin-cloudkit test`           | PASS (16 tests)                                  |
| `swift test --package-path packages/plugins/cloudkit/native` | PASS (build and native test target; no failures) |
| `oxfmt --check` on new scripts                               | PASS                                             |
| `oxlint` on new scripts                                      | PASS                                             |

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
