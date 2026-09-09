# Task 1 report: Codex authentication, listing, and migration contract

Status: DONE_WITH_CONCERNS

## Changed files

- `packages/cli/scripts/verify-codex-contract.ts` — isolated executable/version/schema/auth/persistence probe. It requires one explicit executable argument, strips inherited credential environment variables, uses temporary `HOME`/`CODEX_HOME`, and reports PASS/FAIL/BLOCKED.
- `packages/cli/src/agent/codex/sessions/fixtures/legacy-session.jsonl` — synthetic legacy JSONL with session metadata, two turns, and a tool record.
- `packages/cli/src/agent/codex/sessions/fixtures/paginated-state.json` — synthetic paginated state metadata covering active, archived, and child sessions.
- `packages/cli/src/agent/codex/sessions/fixtures/README.md` — fixture scope and refusal rules.
- `docs/superpowers/specs/2026-09-09-codex-contract-verification.md` — verified contract and migration decision.

## Exact commands and outputs

Environment discovery:

```text
rtk proxy codex --version
codex-cli 0.146.0

rtk proxy codex app-server --help
[experimental] Run the app server or related tooling
Commands: daemon, proxy, generate-ts, generate-json-schema, help

rtk proxy bun --version
1.4.0
```

Schema help showed:

```text
rtk proxy codex app-server generate-json-schema --help
Usage: codex app-server generate-json-schema [OPTIONS] --out <DIR>
--experimental  Include experimental methods and fields in the generated output
```

Schema export and inspection:

```text
rtk proxy codex app-server generate-json-schema --experimental --out <temporary-dir>/schema
exit 0
verified v2 schema methods: ThreadStartParams, ThreadResumeParams, ThreadListParams, ThreadMetadataUpdateParams
```

The generated v2 schema title was `CodexAppServerProtocolV2`. Its relevant fields and the unavailable upstream revision are recorded in the companion spec.

Authentication and persistence experiment:

```text
rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex
executable: codex-cli 0.146.0
version command exit: 0
app-server help exit: 0
schema command exit: 0
verified v2 schema methods: ThreadStartParams, ThreadResumeParams, ThreadListParams, ThreadMetadataUpdateParams
PASS: logged-out / test-proxy-key: model request used the configured proxy bearer
PASS: logged-out / aio-proxy-local: model request used the configured proxy bearer
PASS: logged-in / test-proxy-key: model request used the configured proxy bearer
PASS: logged-in / aio-proxy-local: model request used the configured proxy bearer
BLOCKED: native provider migration persistence: resume override=source-proxy, after restart=source-proxy, list source/target=1/0, restart source/target=1/0; metadata/update has no provider field, so no native migration write was attempted
migration: BLOCKED — this probe does not claim persistence without a restart/list/resume proof
```

Missing executable argument was also checked:

```text
rtk bun run packages/cli/scripts/verify-codex-contract.ts
exit 2
FAIL: Pass the Codex executable explicitly
```

Static checks:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-contract.ts
Finished in 35ms on 1 files using 12 threads.

rtk bunx oxlint packages/cli/scripts/verify-codex-contract.ts
exit 0
```

The package unit suite was also run:

```text
rtk bun run --filter @aio-proxy/cli test:unit
Ran 500 tests across 69 files.
487 pass
13 fail
Exited with code 1
```

The 13 failures are pre-existing upgrade-path expectations for Homebrew, pnpm, and native cli-* restart resolution. They fail because the macOS runtime resolves temporary paths through `/private/var`; the changed Task 1 files are not involved. The task-scoped formatter, linter, and live contract probe pass.

## Contract conclusions

- The executable contract is pinned to `codex-cli 0.146.0`; its exposed upstream revision is unavailable.
- `requires_openai_auth = true` still sent the configured proxy bearer in all four synthetic login/token combinations. A synthetic login token was never forwarded.
- `thread/list` supports provider filtering and `useStateDbOnly`; `thread/resume` declares a `modelProvider` override; `thread/metadata/update` updates pin/Git metadata only.
- The live resume override did not persist or change provider ownership. Native migration is rejected for this version.
- The database path and full SQLite schema were not inferred from a temporary run. The implementation must not select a `state_*.sqlite` by modification time.
- Legacy and paginated fixtures are synthetic inspection inputs. They contain no real IDs, paths, credentials, or conversation data.

## Concerns

- The probe does not validate the full TUI login flow, OS keychain behavior, or a successful inference response; its deliberate 503 only verifies credential selection.
- The native migration branch is blocked, so Task 5 must independently discover and version-gate the active SQLite/rollout location before any write.
- No changes to user data were made, and no upstream revision could be established from the installed binary.
