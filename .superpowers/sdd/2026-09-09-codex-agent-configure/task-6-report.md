# Task 6 implementation report

## Status

Implemented the Codex static-config agent integration and committed the changes after verification.

The wizard now enforces the interactive sequence, validates Provider IDs, skips the key prompt when the proxy has no choices, selects migration sources only when needed, resolves credentials immediately before save, saves configuration before migrating history, redacts credentials from returned results, and converts prompt cancellation into a zero-write `cancelled` result. Non-TTY runs are rejected.

The CLI now routes `codex` before `AgentTargetSchema.parse`, keeps plugin behavior intact, injects Codex operations through `AgentCommandDeps`, exposes Codex list/check/remove output, supports `--restore-migration <operation-id>` with UUID validation, and rejects that option for plugin targets. Codex output contains no installation, login, revoke, or token fields. Pending managed-config journals are confirmed and recovered before the wizard continues. Five locale files contain the same `cli.agent.codex.*` keys.

## Verification

Commands were run from the repository worktree with the required `rtk` prefix.

`rtk proxy bun run i18n:compile`

Result: exit 0. Paraglide compilation completed successfully and generated 1,258 files.

`rtk proxy bun test --preload=./packages/cli/__tests__/setup.ts packages/cli/src/agent/codex/codex.test.ts packages/cli/src/agent/codex/wizard/index.test.ts packages/cli/src/agent/output.test.ts packages/cli/src/agent/agent.test.ts packages/cli/src/main.test.ts`

Result: 46 pass, 0 fail, 857 expectations, 5 files.

`rtk proxy bun run check`

Result: exit 0. Oxlint reported only existing warnings in dashboard/logger files; oxfmt reported all files correctly formatted.

`rtk proxy bun run --filter @aio-proxy/cli test:unit`

Result: 544 pass, 13 fail, 557 tests. The 13 failures are pre-existing upgrade-path tests caused by this macOS environment returning `/private/var/...` where fixtures expect `/var/...`, plus related native package-manager path detection failures. No Task 6 test failed. The failures are in `src/upgrade/upgrade.test.ts` and were not modified.

## Concerns

- The full CLI suite remains red because of the existing `/private/var` path fixture mismatch and package-manager path detection failures described above.
- Codex live configure still requires the installed `codex-cli` executable and a loopback proxy endpoint; list/remove and UUID restore do not require the executable.
