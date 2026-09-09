# Task 5 report: CLI configuration sync integration

## Delivered behavior

The CLI now registers one `sync` command tree in `packages/cli/src/main.ts` and
delegates every operation to the running Dashboard service:

- `status`, `connect`, `join`, `leave`, `apply`, `history`, `restore`,
  `overrides`, `purge`, `detach`, `detach-cancel`, `retry`, and `disconnect`.
- Connect, join, restore, overrides, and purge read local JSON input, request a
  redacted server preview, and print the opaque preview token. Only `apply` reads
  decisions and performs the reviewed mutation.
- `--json` emits one JSON value and keeps the preview/apply boundary explicit.
- `overrides` sends path-segment arrays to the service and never edits local
  SQLite or configuration files.
- `detach` starts the existing Dashboard OAuth login-session flow and forwards only
  its local session ID with the Provider ID to sync control.

## Authentication and secret handling

`createDefaultSyncCliDeps` resolves the endpoint through
`resolveControlAddress`/`controlBaseUrl`, sends same-host `Origin`, and keeps the
Dashboard bearer token in process memory only. It checks the existing Dashboard
session endpoint first. Password-protected services use the hidden Inquirer
password prompt or `--password-stdin`; the password is never cached, logged, or
printed. Authentication-disabled services continue through the existing loopback
and Origin policy. Model API keys are never treated as Dashboard credentials.

The client validates service DTOs with the shared sync schemas and converts HTTP
and control-plane error codes to localized CLI messages. Native errors and backend
secrets do not reach output. Preview rendering applies an additional key-based
redaction pass before JSON output.

## Documentation and localization

Added `docs/config-sync.md` covering local-only defaults, cloud discovery,
environment/local fields, explicit business-option overrides, plugin dependency
activation, rejoin choices, 30-day history, leave versus purge, backend switching,
OAuth adapter limits, and third-party backend conformance guidance. Added the CLI
sync messages to all five supported locales and compiled the i18n artifact.

## Verification

- TDD red phase: the new command test initially failed because `./commands` did
  not exist.
- Targeted CLI tests: **30 passed, 0 failed** across `main.test.ts` and
  `sync/commands.test.ts`.
- i18n tests: **11 passed, 0 failed**.
- `bun run i18n:compile`: passed.
- `bun run check`: passed; repository lint emitted only the existing warnings and
  format check passed for all 2,919 files.
- `bun run --filter @aio-proxy/cli test`: **488 passed, 13 failed**. The failures
  are pre-existing upgrade-path tests whose expected temporary paths omit macOS's
  `/private` canonical prefix; no sync test failed.
- `bun run lint:types`: blocked by existing errors in Dashboard OAuth route typing
  and CloudKit artifact scripts; no reported error was in the new sync files.

The affected CLI tests and repository check are green. The two broader repository
checks retain the unrelated failures described above.

## Review round 1

- Wired the CLI and Dashboard routes to the server-owned sync control plane while
  retaining one lifecycle/engine owner and awaited shutdown ordering.
- `sync detach` now waits for the local OAuth session to reach a successful
  terminal state before handing its ID to sync control; failed or cancelled
  sessions never reach the mutation endpoint.
- Wildcard service hosts are canonicalized for both requests and same-origin
  checks, password stdin removes only one final line ending, and top-level
  `dashboard_unavailable` responses map to the actionable service-unavailable
  error.
- Human previews now show redacted local/cloud values and dependencies. A real
  configured-service fixture verifies CLI range mutation, Dashboard password
  authentication, bearer forwarding, and same-origin headers.

Review-round verification:

- Focused CLI/server sync suite: **82 passed, 0 failed**.
- `bun run i18n:compile`: passed.
- `bun run check`: passed with the existing lint warnings.
- `bun run lint:types`: still reports only the existing Dashboard OAuth editor
  and CloudKit script diagnostics; the touched sync files are clean.

## Review round 2

- Sync endpoint resolution now canonicalizes wildcard binds for local access but
  preserves configured remote hosts when Dashboard password authentication is
  enabled. The existing loopback and same-origin policy remains the server's
  authorization boundary; no unauthenticated remote path was added.
- Backend connection is now a reviewed service operation. Applying a connect
  preview validates options, creates the local backend data directory, opens the
  candidate session, persists a new binding, carries local entities forward,
  swaps the lifecycle, and activates the single server-owned engine. Backend
  options stay in the service/backend path and never enter preview output.
- Extracted state option construction into a private server collaborator;
  `server.ts` is now below the 500-line implementation limit.

Review-round 2 verification:

- Focused CLI/server sync suite: **102 passed, 0 failed**.
- `bun run i18n:compile`: passed.
- `bun run check`: passed with the existing lint warnings.
- `bun run lint:types`: touched files remain clean; only the existing Dashboard
  OAuth editor and CloudKit diagnostics remain.

## Review round 3

- Connect previews and backend replacement now retain the validated
  `safeParse().data` options, including schema defaults, for backend connection
  and persisted binding state.
- Backend switching starts and validates a candidate lifecycle while the old
  binding and engine remain active. It persists and activates the candidate
  first, then closes the old lifecycle; startup, activation, and persistence
  failures dispose the candidate and restore the previous binding and runtime
  references.
- Lifecycle callbacks are isolated per candidate so a failed or retired
  lifecycle cannot clear the active OAuth coordinator or sharing service. The
  configured-service test now verifies defaulted options, binding/entity
  transfer, status continuity, connection/disposal counts, one active engine,
  and failed replacement rollback.

Review-round 3 verification:

- Focused configured-service regression: passed.
- CLI/server sync, control-plane, dashboard sync, server-state, and
  server-config tests: **102 passed, 0 failed**.
- `bun run check`: passed with the existing lint warnings.
- `bun run i18n:compile`: passed.
- `bun run lint:types`: only the existing Dashboard OAuth editor and CloudKit
  diagnostics remain.
- `git diff --check`: passed.
