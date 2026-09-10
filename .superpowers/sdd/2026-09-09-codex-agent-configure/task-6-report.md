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

## Review fix round 1

The follow-up review fixes move the TTY gate ahead of executable detection and pending-journal prompts, return a localized non-interactive result without writes, catch prompt aborts as cancelled, report the detected semver with compatibility explicitly marked unverified, pass the selected target Provider into session preview, and allow built-in `openai` history to be previewed before the first managed marker. The migration confirmation now explains the current-Provider default and target-Provider exclusion.

The fix-round affected test command completed with 63 pass, 0 fail, 965 expectations across 6 files. `rtk proxy bun run check` completed with exit 0; only the same pre-existing dashboard/logger warnings remained. `rtk git diff --check` completed with no output.

## Review fix round 2

The integration now keeps the approved ChatGPT-preservation versus command-auth choice, starts the command-auth timeout only when setup commits or recovery begins, catches cancellation during pending auth recovery, and keeps restore output focused on history ownership. The obsolete API-key creation option and its Codex-specific retained-key error/localizations were removed. Wizard, helper command, output, update-banner, and locale tests cover the resulting behavior.

Verification commands and results:

- `bun run i18n:compile` — exit 0; Paraglide compilation and package build completed.
- `bun test packages/cli/src/agent/codex packages/cli/src/agent/agent.test.ts packages/cli/src/agent/output.test.ts packages/cli/src/update-notify/update-notify.test.ts` — 123 pass, 0 fail, 1,127 expectations across 14 files.
- `bun run --filter @aio-proxy/i18n test:unit` — 11 pass, 0 fail, 36 expectations across 5 files.
- `bun run --filter @aio-proxy/cli test:unit` — completed with all CLI unit tests passing, including `main.test.ts` and the new Codex auth command assertions.
- `bun run check` — exit 0; oxlint reported only existing dashboard/logger warnings and oxfmt passed all files.
- `git diff --check` — no output.

## Review fix round 4

Command cleanup now handles identity-only, credential-only, both-file, and neither-file states idempotently, fences credential removal to the journal installation ID, and deletes credentials before identity metadata so a cleanup crash remains recoverable. Recovery also blocks safely when an orphan credential has no installation ID to validate. Added a regression test for identity deletion leaving an orphan credential.

Verification commands and results:

- `bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/setup` — 5 pass, 0 fail, 16 expectations.
- `bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/lifecycle` — 3 pass, 0 fail, 8 expectations.
- `bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/command-auth` — 7 pass, 0 fail, 23 expectations.
- `bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/wizard src/agent/output.test.ts` — 15 pass, 0 fail, 793 expectations.
- `bun run check` — exit 0; oxlint reported only existing dashboard/logger warnings and oxfmt passed all files.
- `git diff --check` — no output.

The direct mixed `main.test.ts` run intermittently reported the existing port-conflict assertion as exit code 2 instead of 1; the package unit run passed that test, and no server code was changed for it.

## Review fix round 3

This round restores static keep-chatgpt connectivity checks for `agent list --check`, makes command-to-keep-chatgpt recovery roll back safely when no static token is available, rebinds an existing command installation when its managed Provider ID changes, and reports command authorization cancellation as incomplete/recoverable rather than write-free. Pending command identities are visible in list and authorization data. Focused tests cover each regression plus helper UUID and startup-budget rejection.

Verification commands and results:

- `bun run i18n:compile` — exit 0; Paraglide compilation and package build completed.
- `bun run --filter @aio-proxy/i18n test:unit` — 11 pass, 0 fail, 36 expectations across 5 files.
- `bun run --filter @aio-proxy/cli test:unit` — all CLI unit tests passed, including main, update-notify, Codex setup/lifecycle/wizard, and helper assertions.
- `bun test packages/cli/src/agent/codex/setup packages/cli/src/agent/codex/lifecycle packages/cli/src/agent/codex/wizard packages/cli/src/agent/codex/codex.test.ts packages/cli/src/agent/output.test.ts` — 26 pass, 0 fail, 817 expectations across 5 files.
- `bun run check` — exit 0; oxlint reported only existing dashboard/logger warnings and oxfmt passed all files.
- `git diff --check` — no output.
