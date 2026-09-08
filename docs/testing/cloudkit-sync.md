# CloudKit native access gate

This gate proves that the CloudKit component can be launched from the installed
plugin cache with the entitlements for the real `dev.aioproxy` application. It
does not make CloudKit available just because Swift compiles or because an
unsigned executable can start.

## Required host and inputs

Run the commands on macOS 14 or later with Swift 5.9 or later. A native build
needs a plugin release manifest at `packages/plugins/cloudkit/release-manifest.json`
or the package's `package.json`; its `version` is copied to `CFBundleVersion`.
The package manifest is the source of the native version, so an unrelated root
version must not be substituted.

Signing and notarization require these environment variable names. Their values
must be supplied privately and are never printed or written to evidence:

```text
CLOUDKIT_TEAM_ID
CLOUDKIT_SIGN_IDENTITY
CLOUDKIT_PROFILE_PATH
CLOUDKIT_CONTAINER_ID
CLOUDKIT_NOTARY_PROFILE
```

The profile must contain the matching `dev.aioproxy` application identifier,
the requested iCloud container, CloudKit entitlement and either Development or
Production environment. The signing script embeds the supplied profile,
signs the nested executable before the app bundle, then notarizes and staples
the exact bundle that was verified. It does not use the CLI's ad hoc re-sign
path.

## Deterministic procedure

Build the two architecture slices and the unsigned app bundle:

```sh
rtk proxy bun packages/plugins/cloudkit/scripts/build-native.ts
```

The result is `packages/plugins/cloudkit/dist/native/AIOProxyCloudKit.app` and
`manifest.json`. The manifest records the bundle version, relative app and
executable paths, architectures and unsigned status plus the unsigned
executable and app digests. Manifest paths must stay relative to the package,
the executable must remain inside the app bundle, and validation rejects
symlinked artifact paths. The build checks the host's `sw_vers` result and
stops before invoking Swift on macOS older than 14 or on another platform.

With the real private inputs available, sign and distribute the bundle:

```sh
rtk proxy bun packages/plugins/cloudkit/scripts/sign-native.ts
```

This command fails closed when an input is absent, the profile does not match
the Developer ID team/application/container, the profile is not a macOS
distribution profile, effective entitlements differ from the profile,
codesign verification fails, notarization is not `Accepted`, stapling fails,
or Gatekeeper assessment fails. The manifest is updated only after stapling;
its executable, app and final post-staple archive digests bind the installed
artifact to the recorded release. A successful command updates the local
native manifest with redacted team/container and signature status; it does not
claim installed service access.

Probe the versioned installed cache path with a container identifier:

```sh
rtk proxy env CLOUDKIT_CONTAINER_ID=iCloud.dev.aioproxy \
  bun packages/plugins/cloudkit/scripts/probe-installed.ts
```

The probe stages the bundle without removing the previous version, verifies
the manifest-bound app/executable/archive digests, universal architectures,
`Info.plist` identity and (when signed) its codesign team, effective
entitlements, embedded distribution profile, stapled ticket and Gatekeeper
assessment. Package, cache, version and staging paths are checked for root
escapes and symlink traversal. It launches the staged inner executable with
one bounded JSON request on stdin before changing the active cache entry. Only
after those checks pass does it swap the versioned cache entry; a failed check
restores the previous working entry. The native
response contains only `available`, an opaque SHA-256 identity binding and the
bundle identifier. It never emits an email, account payload or raw CloudKit
record identifier.

Set `CLOUDKIT_EVIDENCE_PATH` to write the same redacted JSON to a file. The
evidence includes the actual `sw_vers -productVersion` host OS version and
architecture, bundle version, team ID, bundle ID, container ID, environment,
signature/notarization status, direct launch result, service launch status and
timestamp. It contains no credentials,
private keys, profile bytes or raw account IDs. The team ID, bundle ID and
container ID are intentional non-secret artifact identifiers; the account
identity is recorded only as the native component's SHA-256 opaque binding.

## Expected failure and release gate

The first probe is intentionally run against the unsigned bundle. It is valid
evidence for build and IPC behavior, but not for production CloudKit access.
Depending on the local account and entitlement state, the native response may
be `unauthorized`, `offline`, `unsupported` or another documented
`SyncFailureCode`; the procedure does not depend on one Apple error string.
An account-unavailable response is recorded as a blocked direct launch rather
than converted into success.

`probe-installed.ts` always records the service launch as `unverified` and the
production gate as `blocked`. To resolve the gate, run the same versioned
absolute executable through the real launchd aio-proxy background service, with
Dashboard closed, on macOS 14 and a current macOS. Repeat with the actual
iCloud account after confirming that `iCloud.dev.aioproxy` is associated with
the App ID and that the intended Development or Production container is
available. Record the service result only from that execution context.

Being signed, notarized, or runnable from Xcode is not enough. Until the
installed path and launchd path both return a confirmed account result, keep
the CloudKit capability unavailable for release.
