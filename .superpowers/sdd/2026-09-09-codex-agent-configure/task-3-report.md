# Task 3 report

Status: IMPLEMENTED

## Changed files

- `packages/cli/src/agent/codex/contracts.ts` — location, ownership-marker, inspection, commit, and removal contracts.
- `packages/cli/src/agent/codex/location/index.ts` — global Codex home resolution with `CODEX_HOME`, `HOME`, `~`, and fixed managed paths.
- `packages/cli/src/agent/codex/location/location.test.ts` — location resolution coverage.
- `packages/cli/src/agent/codex/managed-config/index.ts` — public managed-configuration API.
- `packages/cli/src/agent/codex/managed-config/managed-config.ts` — inspection, drift-aware configure/remove, version probe, and in-process coordination.
- `packages/cli/src/agent/codex/managed-config/managed-config.test.ts` — round-trip, drift, collision, auth-field, symlink, and permission coverage.
- `packages/cli/src/agent/codex/managed-config/marker.ts` — strict private marker validation and durable persistence.
- `packages/cli/src/agent/codex/managed-config/journal.ts` — journal-first operation records and recovery checks.
- `packages/cli/src/agent/codex/managed-config/storage.ts` — regular-file checks, durable writes, fsync, and atomic TOML replacement.

## Exact commands and output

```text
rtk bun test ./packages/cli/src/agent/codex/location ./packages/cli/src/agent/codex/managed-config
8 pass
0 fail
23 expect() calls

rtk bun test ./packages/cli/src/agent/codex/config-document/config-document.test.ts
14 pass
0 fail
50 expect() calls

rtk bunx oxlint packages/cli/src/agent/codex/location packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/contracts.ts
Finished in 38ms on 9 files using 12 threads.

rtk bunx oxfmt --check packages/cli/src/agent/codex/location packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/contracts.ts
All matched files use the correct format.
```

## Implementation notes

- Configure and remove record operation type, fingerprints, file existence, old/target marker, and stage in a private `config-operation.json` journal before replacing TOML.
- TOML writes use a same-directory `open('wx', 0600)` temporary, sync, identity/content recheck, rename, and parent-directory sync. Managed directories and markers are forced to 0700/0600.
- Marker fields are restored only while their current value still equals the recorded applied value. Later user edits, provider renames, adjacent-key reordering, and user authentication fields are preserved or rejected as conflicts.
- Public inspection/commit/removal values contain no marker contents or credentials.

## Concerns

- The configure entry point intentionally requires an installed `codex --version` command and accepts the verified `codex-cli X.Y.Z` output shape; callers that need to inspect or remove an existing configuration do not perform that probe.
- Recovery leaves an indeterminate journal in place and refuses further mutation when neither the before nor after fingerprint matches. This is deliberate protection against overwriting an unknown concurrent writer and requires manual review.
- The repository-wide TypeScript check has pre-existing unrelated diagnostics in existing CLI tests and project references; focused lint, formatting, and unit checks above pass.

## Fix round 1

Addressed the review findings by adding a journal owner PID/token/lease and refusing live or ownerless recovery, serializing inline-field restoration and deleting only provider nodes recorded in `createdTables`, syncing the containing directory after journal/marker create, replace, and delete operations, requiring the complete six-field ownership set plus one consistent created-provider table, and using recursive no-follow parent checks, no-follow reads, destination snapshots, and checked chmod operations.

Added regression coverage for inline provider cleanup, incomplete markers, live journals, and symlinked parents.

Exact commands and output:

```text
rtk bunx oxfmt packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/location packages/cli/src/agent/codex/contracts.ts
Finished in 39ms on 9 files using 12 threads.

rtk bunx oxlint packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/location packages/cli/src/agent/codex/contracts.ts
(no diagnostics)

rtk bun test ./packages/cli/src/agent/codex/location ./packages/cli/src/agent/codex/managed-config ./packages/cli/src/agent/codex/config-document/config-document.test.ts
26 pass
0 fail
79 expect() calls
```

Concerns remain limited to the existing repository-wide TypeScript baseline diagnostics; the changed implementation has no focused lint diagnostics and all 26 focused tests pass.

## Fix round 1 verification

The review fix round was committed after a fresh verification run:

```text
rtk bunx tsc --noEmit -p packages/cli/tsconfig.json 2>&1 | rtk rg 'packages/cli/src/agent/codex/(location|managed-config|contracts)' | head -100
(no diagnostics for changed Codex implementation files)

rtk bun test ./packages/cli/src/agent/codex/location ./packages/cli/src/agent/codex/managed-config ./packages/cli/src/agent/codex/config-document/config-document.test.ts
26 pass
0 fail
79 expect() calls

rtk bunx oxlint packages/cli/src/agent/codex/location packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/contracts.ts
(no diagnostics)

rtk bunx oxfmt --check packages/cli/src/agent/codex/location packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/contracts.ts
All matched files use the correct format.
```
