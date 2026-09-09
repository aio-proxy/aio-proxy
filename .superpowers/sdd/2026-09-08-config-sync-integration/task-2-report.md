# Task 2 report

## Result

Implemented typed sync DTOs/Zod contracts and an in-memory sync control plane with redacted previews, one-use expiring preview tokens, local/remote preview fences, status and backend metadata views, history reads, range exclusion, detach hooks, retry/disconnect hooks, and preview application hooks.

## Files changed

- `packages/types/src/sync/index.ts`
- `packages/types/src/sync/sync.ts`
- `packages/types/src/sync/sync.test.ts`
- `packages/types/src/index.ts`
- `packages/server/src/sync-control-plane/control-plane.ts`
- `packages/server/src/sync-control-plane/operations.ts`
- `packages/server/src/sync-control-plane/preview.ts`
- `packages/server/src/sync-control-plane/preview.test.ts`
- `packages/server/src/sync-control-plane/status.ts`
- `packages/server/src/sync-control-plane/index.ts`
- `packages/server/src/server-state/types.ts`

## TDD evidence

The first schema test was run before `sync.ts` existed:

```text
rtk proxy bun test packages/types/src/sync/sync.test.ts
Cannot find module './sync'
0 pass, 1 fail, 1 error
```

The first server preview test was run before the control-plane implementation existed:

```text
rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane/preview.test.ts
Cannot find module './control-plane'
0 pass, 1 fail, 1 error
```

After the minimal implementation, both tests passed. The preview test covers secret redaction, remote version fencing, one-use tokens, and stale rejection. The final focused runs passed:

```text
rtk proxy bun test packages/types/src/sync
1 pass, 0 fail

rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane
10 pass, 0 fail
```

The full types suite also passed:

```text
rtk proxy bun test packages/types/src
330 pass, 0 fail
```

Modified-file checks passed:

```text
rtk proxy bunx oxlint packages/types/src/sync packages/types/src/index.ts packages/server/src/sync-control-plane/control-plane.ts packages/server/src/sync-control-plane/preview.ts packages/server/src/sync-control-plane/operations.ts packages/server/src/sync-control-plane/status.ts packages/server/src/server-state/types.ts
0 errors

rtk proxy bunx oxfmt --check packages/types/src/sync packages/types/src/index.ts packages/server/src/sync-control-plane/control-plane.ts packages/server/src/sync-control-plane/preview.ts packages/server/src/sync-control-plane/operations.ts packages/server/src/sync-control-plane/status.ts packages/server/src/server-state/types.ts
All matched files use the correct format.
```

`rtk proxy bun run check` remains blocked by an existing unrelated lint error in `scripts/verify-oauth-sync.ts` (`OAuthAdapter` is imported but unused), plus pre-existing warnings. I left that file untouched.

## Self-review

- Preview output traverses and redacts known secret subtrees and configured secret keys; private records retain the unredacted entity candidates for apply.
- Preview tokens are generated from random bytes, stored only in process memory, expire after ten minutes, and are removed before application, making them one-use and invalid after restart.
- Apply rechecks binding identity, session generation, confirmed local commit, range revision, and remote head versions. A changed fence returns `preview-stale` and never falls back to an unconditional write.
- Remote tombstones expose only `restore`; same logical identities with different object IDs are marked conflicts and require `newProviderId`.
- Backend forms expose descriptors and secret `configured` flags only; backend option values never enter the DTO.
- The control plane is intentionally hook-based for lifecycle/config/account mutation integration. Server-state construction and authenticated routes remain the follow-up integration boundary for Tasks 3 and the parent task.

## Fix round 1

The review fixes derive redaction keys from OAuth account form metadata, validate remote object and revision identities, preserve restore operation IDs, enforce preview fences and expected remote versions, implement nested override projection with forbidden and array traversal checks, preserve local-only purge rows, validate backend options, persist included state after apply, and make the default session-backed mutation hooks lazy and core-backed. The status view also reports the actual disconnected state and durable pending-operation sources.

Additional regression coverage now checks nested and array overrides, explicit deletion of a missing local field, unsafe paths, non-obvious secret fields, and restore operation ID forwarding.

Verification after the fix round:

```text
rtk proxy bun test packages/types/src/sync
1 pass, 0 fail

rtk proxy bun test packages/types/src
330 pass, 0 fail

rtk proxy bun test --preload=./__tests__/setup.ts src/sync-control-plane
13 pass, 0 fail

rtk proxy bunx oxlint packages/types/src/sync packages/types/src/index.ts packages/server/src/sync-control-plane packages/server/src/server-state/types.ts
0 errors

rtk proxy bunx oxfmt --check packages/types/src/sync packages/types/src/index.ts packages/server/src/sync-control-plane packages/server/src/server-state/types.ts
All matched files use the correct format.

rtk proxy bunx tsc --noEmit -p tsconfig.json 2>&1 | rg 'src/sync-control-plane|server-state/types'
No matching errors.
```

Self-review after the fixes:

- Preview redaction no longer depends on a caller-provided secret-key set and covers account, credential, secret, and plugin-business secret records plus adapter-declared secret fields.
- A preview records one remote snapshot and fences that snapshot; every default cloud mutation checks the expected head version before invoking the core CAS-backed operation and rereads purge results.
- Restore previews require the requested history revision and apply forwards its operation ID. Remote history rejects mismatched object or logical identities and purging heads.
- Overrides copy selected nested values, copy whole arrays only at the selected path, delete cloud values whose local source is absent, reject forbidden paths, and reject array traversal.
- Purge computes dependent targets, rejects unresolved dependencies, skips local-only rows, and verifies tombstones. Same logical identities on different object IDs require a replacement provider ID.
- The remaining integration boundary is server-state construction and authenticated route registration in the parent task; the root `bun run check` still includes the unrelated pre-existing unused import in `scripts/verify-oauth-sync.ts`.
