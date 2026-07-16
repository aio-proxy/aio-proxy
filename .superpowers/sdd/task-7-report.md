# Task 7 Report: OAuth Plugin Review Hardening

## Status

Implemented and verified against starting HEAD
`183debe1e405c0e025914d63b517fe6da766de54`.

## Delivered

- Added a non-mutating migration-manifest `--check` mode, stable stale-manifest
  error handling, CI enforcement, SQL LF normalization, and removal of the
  redundant OAuth account fingerprint index from both migration SQL and schema.
- Made successful config commits with failed lock release observable through
  `AtomicConfigLockReleaseError`, while preserving the committed-state signal
  inherited from `AtomicConfigCommitUncertainError` so callers do not compensate
  already-committed secrets.
- Aligned config recovery-marker fencing with the conservative npm behavior:
  changed marker contents remain active and cannot cause a competing recovery
  fence to be created.
- Guarded both diagnostic rebuild enqueue and queued execution after server
  shutdown.
- Tightened GitHub Copilot credential parsing to require a valid URL and restored
  `Accept: application/json` for model discovery.
- Removed secret placeholders from the plugin SDK contract and validator; CLI
  secret prompts now always mask input independently of placeholder semantics.
- Rendered provider expiry and catalog timestamps with the browser's current
  locale and added deterministic rendering coverage.

## TDD RED / GREEN Evidence

### Migration check mode

RED: `packages/core/_test/migrations-build.test.ts` showed that the stale
manifest path did not yet support a read-only check failure.

GREEN:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/migrations-build.test.ts
```

The stale-manifest test rejects with
`Migration manifest is stale; run \`bun run build:migrations\`` and confirms the
fixture manifest is unchanged.

### Config and npm lock reliability

RED:

- Config lock cleanup failures were swallowed after a successful commit.
- Changed recovery-marker content could be treated as inactive, permitting a
  competing recovery marker.
- The old CLI regression expected a committed transaction with cleanup failure
  to resolve successfully.

GREEN:

- Config cleanup failure rejects as `AtomicConfigLockReleaseError`, retains the
  committed bytes, leaves recoverable owner identity, and permits a later stale
  owner recovery.
- Config and npm tests pause the third marker read and prove that no competing
  recovery marker appears after marker content changes.
- CLI coverage proves the applied secret remains committed while the release
  error is observable.

### Closed server rebuild guard

RED: the new late credential diagnostic test observed two router builds after
`state.close()` instead of one.

GREEN: enqueue and queued execution both check closed state; the router remains
at one build.

### GitHub Copilot validation and headers

RED: invalid `baseURL` credentials parsed successfully and model discovery did
not send the JSON Accept header.

GREEN: `zod.url()` rejects the invalid URL and model discovery sends
`accept: application/json`.

### Secret placeholder and masking separation

RED: the SDK/validator still accepted secret placeholders and CLI masking was
conditional on their presence.

GREEN: secret placeholders are absent from the SDK type, rejected by the core
validator, and CLI password prompts always receive `{ mask: "*" }`.

### Dashboard locale rendering

RED: provider expiry used ISO formatting and catalog timestamps were passed
through unchanged.

GREEN: the page calls `toLocaleString()` for both values; the deterministic test
spies on `Date.prototype.toLocaleString` and verifies both no-argument calls.

## Focused Verification

```text
bun test packages/core/_test packages/server/_test/plugin-snapshot.test.ts packages/plugins/github-copilot/_test
PASS: 515 tests, 0 failures.

bun test packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx packages/dashboard/src/modules/providers/templates/providers-page.test.tsx
PASS: 20 tests, 0 failures.
```

The first repository-wide unit run exposed one old CLI expectation that lock
release cleanup failure should resolve successfully. The implementation and
test were updated to the approved observable-error semantics while retaining
the applied secret. The complete rerun then passed.

## Repository-wide Verification

All commands were run with the required PATH and `rtk` prefix.

```text
bun run --filter @aio-proxy/core build:migrations --check
PASS: Verified 6 append-only migrations; exit 0.
Manifest SHA-256 before and after:
3901e62f9fabdcb0a362ed0f0bf7f045ee5ecb76a7d564cf1aa0fe7748d9b549

bun run check
PASS: exit 0; 71 existing informational diagnostics and one existing warning.

bun run test:unit -- --concurrency=2
PASS: Turbo 16 successful / 16 total; no test failures.
Notable package totals include Core 464/464 and CLI 146/146.

bun run test:e2e:api
PASS: Turbo 7 successful / 7 total; exit 0 (cache-valid replay).

bun run build
PASS: Turbo 7 successful / 7 total; exit 0 (cache-valid replay).

git diff --check
PASS: exit 0, no output.
```

## Files Changed

- `.gitattributes`
- `.github/workflows/ci.yml`
- `packages/core/scripts/build-migrations.ts`
- `packages/core/src/db/migrations/0004_oauth_plugins.sql`
- `packages/core/src/db/schema/plugin-oauth.ts`
- `packages/core/src/db/migrations.manifest.ts`
- `packages/core/src/plugins/config-file.ts`
- `packages/core/src/plugins/config-spec.ts`
- `packages/plugin-sdk/src/config.ts`
- `packages/cli/src/plugin-commands/form.ts`
- `packages/server/src/server-state.ts`
- `packages/plugins/github-copilot/src/index.ts`
- `packages/plugins/github-copilot/src/github-api.ts`
- `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Corresponding focused tests in Core, CLI, Server, Copilot, and Dashboard.

## Self-review

- Migration check mode compares generated content before any write and returns a
  stable nonzero CLI result on mismatch.
- The release-error subtype deliberately inherits committed-state uncertainty so
  existing compensation guards continue to protect committed credentials.
- Action failures remain primary: cleanup is best-effort on the error path, while
  release failure after a successful transaction is surfaced explicitly.
- Recovery-marker content changes are handled conservatively in both lock
  implementations.
- Server shutdown is checked at both scheduling boundaries, covering diagnostics
  raised before and after queued work begins.
- Secret masking no longer depends on display-hint metadata.
- No unrelated source changes were introduced.

## Concerns

- Full unit output included one handled server diagnostic log showing the new
  observable release failure (`ENOENT` for a recovery marker); the associated
  test passed and no repository-wide gate failed. This is worth watching if the
  same race appears in production telemetry.
- API E2E and build were satisfied by Turbo's content-addressed cache in the
  final run; the commands completed successfully and replayed the matching build
  logs.

## Independent Review Follow-up

### RED: immediate same-process recovery after release failure

Added a regression that injects one main-lock unlink failure, leaves the live
PID/starttime lock completely unchanged, and immediately starts a second
transaction in the same process. The focused run failed after 500 ms with
`exact abandoned config owner was not recovered immediately`, confirming that
the live owner check permanently blocked recovery without manual lock aging or
identity removal.

### GREEN: exact abandoned-owner retry with replacement fencing

Release failure now records a module-local cleanup capability containing the
lock path's exact serialized owner record and file dev/inode identity. A later
acquisition may reclaim it only inside the recovery fence, after exact content
and identity matches followed by a second unchanged-file snapshot. Successful
cleanup removes the registry entry; missing or replacement files invalidate it.

The focused run passed the immediate recovery regression, the new replacement
owner regression, and the existing paused-release fencing regression without
modifying or aging the abandoned lock.

Follow-up verification passed: the complete config-file suite (25 tests), the
Task 7 Core/Server/Copilot affected suite (516 tests), repository check (with
the existing 71 informational diagnostics and one warning), and repository
build (7/7 tasks).
