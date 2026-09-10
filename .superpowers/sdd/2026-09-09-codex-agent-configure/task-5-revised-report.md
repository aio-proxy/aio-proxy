# Revised Task 5 report

## Implemented

- Kept proxy API key inspection read-only. Keyless configurations resolve to the non-secret `aio-proxy-local` placeholder, existing authored entries retain their complete authored shape, and selection IDs remain stale when authored or expanded runtime values change.
- Removed the obsolete credential creation expectations and dependencies from the credential tests. No credential transaction, random key generation, reload, or rollback path remains in the credential module.
- Completed setup and lifecycle type wiring around `CodexSetupSelection`, `CodexSetupCommit`, `CodexListResult`, and `CodexRemoveResult`.
- Enforced exact installation endpoint binding during pending command recovery. A context endpoint change blocks recovery before device authorization or token requests, preserving the pending journal for a later retry against the verified endpoint.
- Unknown or malformed authentication journal state now returns `blocked` from recovery. Valid journal state remains recoverable only when the installation, config path, phase, and endpoint agree.
- Kept static list/check read-only and idempotent. Command list/check derives authorization state from `inspectCodexCommandCredential`; it never refreshes or starts device authorization. Command removal marks retiring before revoke, returns `blocked` on revoke failure, and preserves the journal and installation for retry.
- Normalized filesystem `stat.mode` with `Number(...)` before bitwise permission checks so Bun's `number | bigint` type is accepted without weakening the private-file checks.

## Tests

- Added setup recovery coverage for endpoint drift, unknown journal state, and secret-free journal diagnostics.
- Added lifecycle coverage for static list/remove idempotence and blocked command removal with retained retry state.
- Updated credential coverage for keyless no-write behavior, existing-key resolution, stale selections, invalid configuration, and secret-free errors.

Focused command:

```text
rtk bun test packages/cli/src/agent/codex/credentials packages/cli/src/agent/codex/setup packages/cli/src/agent/codex/lifecycle packages/cli/src/agent/codex/managed-config packages/cli/src/agent/agent.test.ts
```

Result: 49 passed, 0 failed.

`rtk git diff --check` and focused `oxfmt --check` pass. The repository-wide `bun run check` reaches lint successfully but currently fails its formatting check on unrelated in-progress files owned by the surrounding Task 6 work (`codex.ts`, `agent.ts`, `main.ts`, output/update-notify files, and locale files); those files were left untouched by this task.

Follow-up regression: keyless placeholder resolution now re-reads the proxy config and returns `CREDENTIAL_SELECTION_STALE` if an API key appears after inspection. The credential suite is now 7 passed, 0 failed.
