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
