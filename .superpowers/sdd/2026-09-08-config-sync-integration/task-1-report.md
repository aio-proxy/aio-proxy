# Task 1 report: committed capture, lifecycle recovery, and awaited shutdown

## Delivered

- Added the server sync lifecycle and local port. An existing durable binding is recovered before backend connection, uses one engine/session for the server lifetime, creates a 0700 backend data directory under the configuration directory, and is stopped before asynchronous resource teardown.
- Added dependency-aware activation checks for exact package versions, missing environment references, credential validity, and remote OAuth evidence. Desired data remains available to retry while activation is pending.
- Moved `config-store.ts` into the `config-store/` module layout and added finalized local commit preparation/confirmation hooks. Rejected candidates never reach the sync outbox.
- Added `ServerState.closeAsync()` and wired server/CLI shutdown and route-assembly failure cleanup to await sync disposal before database ownership release. Existing synchronous `close()` remains available for legacy callers.
- Added lifecycle, activation, and config-store commit regression fixtures/tests.

## Validation

- `rtk proxy bun test --preload=./__tests__/setup.ts __tests__/config-store.test.ts __tests__/config-store.oauth.test.ts src/server/server-lifecycle.test.ts src/sync-control-plane` — 15 passed.
- `rtk proxy bun test --preload=./__tests__/setup.ts src/config-store/sync-commit.test.ts` — 2 passed.
- `rtk proxy bun test packages/core/src/sync` — 115 passed.
- CLI lifecycle/run tests — 7 passed.
- `rtk proxy bun run check` — passed with existing dashboard/logger warnings.
- Scoped `oxfmt --check` — passed.
- `rtk proxy bun run build` — 19 workspace builds passed.

## Review round 1 fixes

- Local sync digests now use the exact `encodeCandidate` representation used by config commits, and remote application is serialized through the server FIFO fence.
- Remote deletion removes included runtime Providers and their stored accounts while preserving excluded local-only copies. Remote desired bodies are checked for dependency/version and credential prerequisites before activation; rejected bodies remain durable pending state.
- OAuth login/import completion and successful external reloads can prepare and confirm durable local sync commits, while remote-origin commits continue to avoid outbox echoes.
- Backend startup rechecks binding identity and session generation after connection, disposes stale sessions, and rejects stale commit callbacks. Startup cleanup and `closeAsync()` use `finally` so database ownership is released even when sync disposal fails; startup fixtures await disposal before removing their database.

## Review scope and remaining risk

Please run a targeted review of commit `3600adf39`, focusing on the close/closeAsync state machine, FIFO fence composition, and startup recovery ordering. The later control-plane task still owns public sync settings/preview operations and richer activation identity/OAuth coordination; plugin-secret/account-specific capture hooks remain integration follow-up work beyond this commit.
