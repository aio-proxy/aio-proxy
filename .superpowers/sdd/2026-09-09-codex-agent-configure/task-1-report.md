# Task 1 report: Codex authentication, listing, and migration contract

Status: DONE_WITH_CONCERNS

## Changed files

- `packages/cli/scripts/verify-codex-contract.ts` — isolated executable/version/schema/auth/persistence probe. It requires one explicit executable argument, strips inherited credential environment variables, uses temporary `HOME`/`CODEX_HOME`, and reports PASS/FAIL/BLOCKED.
- `packages/cli/scripts/codex-storage.ts` — real-path-contained SQLite/JSONL storage inspection with symlink and escape refusal.
- `packages/cli/src/agent/codex/sessions/fixtures/legacy-session.jsonl` — one-turn synthetic legacy inspection JSONL with a tool record.
- `packages/cli/src/agent/codex/sessions/fixtures/synthetic-history.json` — separate inspection-only synthetic history containing two turns, a tool record, a child session, and an archived session; it is not described as a live generated rollout.
- `packages/cli/src/agent/codex/sessions/fixtures/paginated-state.json` — synthetic paginated state metadata covering active, archived, and child sessions.
- `packages/cli/src/agent/codex/sessions/fixtures/README.md` — fixture scope and refusal rules.
- `packages/cli/src/agent/codex/sessions/fixtures/codex-0.146.0-schema-summary.json` and `rejection-cases.json` — sanitized schema and concrete refusal fixtures.
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
verified v2 schema fields: ThreadStartParams, ThreadResumeParams, ThreadListParams, ThreadMetadataUpdateParams
```

The generated v2 schema title was `CodexAppServerProtocolV2`. Its relevant fields and the unavailable upstream revision are recorded in the companion spec.

Authentication and persistence experiment:

```text
rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex
executable: codex-cli 0.146.0
version command exit: 0
app-server help exit: 0
schema command exit: 0
verified v2 schema fields: ThreadStartParams, ThreadResumeParams, ThreadListParams, ThreadMetadataUpdateParams
PASS: logged-out / test-proxy-key: model request used the configured proxy bearer
PASS: logged-out / aio-proxy-local: model request used the configured proxy bearer
PASS: logged-in / test-proxy-key: model request used the configured proxy bearer
PASS: logged-in / aio-proxy-local: model request used the configured proxy bearer
BLOCKED: native provider migration persistence: resume override=source-proxy, after restart=source-proxy, list source/target=1/0, restart source/target=1/0; actual configured sqlite_home/state_5.sqlite was inspected; metadata/update has no provider field, so no native migration write was attempted
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
- The isolated run used authored `sqlite_home`, inspected the actual `state_5.sqlite` and rollout files, and recorded the real `threads` columns, `history_mode`, archive state, and `thread_spawn_edges` schema. Storage selection was based on the configured root and table contents, never modification time. The production writer must still refuse symlinks, escapes, unknown formats, and active writers.
- The legacy and paginated files are synthetic inspection inputs. `synthetic-history.json` separately contains two turns, a tool record, a child, and an archived session for offline parser tests; it is not a live generated rollout. All fixtures contain synthetic IDs and no credentials or user data.

## Concerns

- The probe does not validate the full TUI login flow, OS keychain behavior, or a successful inference response; its deliberate 503 only verifies credential selection.
- The native migration branch is blocked, so Task 5 must independently discover and version-gate the active SQLite/rollout location before any write.
- No changes to user data were made, and no upstream revision could be established from the installed binary.

## Fix round 1 review response

Status: DONE_WITH_CONCERNS. The required migration verification remains blocked by the live executable, and the probe now exits nonzero (`1`) whenever a required result is `BLOCKED`; the report is retained for that blocked run.

The probe now rejects extra positional arguments as well as a missing argument:

```text
rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex extra
extra-arg-exit=2
FAIL: Pass exactly one Codex executable argument
```

The rerun recorded the isolated first-login boundary and validated schema fields:

```text
executable: codex-cli 0.146.0
version command exit: 0
app-server help exit: 0
isolated login help exit: 0
isolated login help first line: Manage login
schema command exit: 0
verified v2 schema fields: ThreadStartParams[modelProvider|historyMode], ThreadResumeParams[threadId|modelProvider], ThreadListParams[modelProviders|useStateDbOnly], ThreadMetadataUpdateParams[threadId|isPinned|gitInfo]
PASS: logged-out / test-proxy-key: model request used the configured proxy bearer
PASS: logged-out / aio-proxy-local: model request used the configured proxy bearer
PASS: logged-in / test-proxy-key: model request used the configured proxy bearer
PASS: logged-in / aio-proxy-local: model request used the configured proxy bearer
BLOCKED: native provider migration persistence: resume override=source-proxy, after restart=source-proxy, list source/target=1/0, restart source/target=1/0, repaired source=1; rounds=accepted/accepted, fork=accepted, archive=accepted; storage inspected: configured sqlite_home used; state_5.sqlite threads columns include id, rollout_path, model_provider, archived, history_mode, model, created_at, updated_at, and is_pinned; threadRows=2; providers=source-proxy; historyModes=legacy; archived=1; thread_spawn_edges fields=parent_thread_id, child_thread_id, status; spawnEdges=0; rollouts=two JSONL files with 14/10 lines and session_meta/event_msg/response_item/world_state/turn_context records; sessionMetaProvider=source-proxy; metadata/update has no provider field, so no native migration write was attempted
migration: BLOCKED — this probe does not claim persistence without a restart/list/resume proof
probe-exit=1
```

The storage inspection used the authored `sqlite_home` directory and opened every SQLite candidate in that configured directory by extension and table contents. It did not select a state database by modification time. The observed `state_5.sqlite` contained `threads`, `thread_spawn_edges`, and the real column list recorded above; `logs`, `memories`, and `goals` databases were inspected and rejected as non-thread stores. The rollout scan counted records without printing paths or payloads. `thread/list` with `useStateDbOnly=false` returned the same source row count as the state-only query, so this is the observed repair comparison rather than an index mutation.

The synthetic history attempted two accepted turn starts, a `thread/fork`, and `thread/archive`; the database contained two rows and one archived row, while `thread_spawn_edges` remained empty. The synthetic upstream returned 503 before model output, so no tool call record could be generated through the public API; this is reported as unavailable. Concrete refusal fixtures now cover missing IDs, conflicting providers, unknown `history_mode`, rollout/index mismatch, and active writers. The sanitized generated schema summary is committed alongside the fixtures.

The full TUI login flow remains outside the automated boundary: the isolated no-auth `login --help` surface was observed, but interactive/browser authentication was not started. The app-server bearer experiment does not claim OS keychain or TUI behavior.

Fix-round checks:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
exit 0

rtk bunx oxlint packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
exit 0

rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex
exit 1 (expected: required native migration contract is BLOCKED)
```

## Fix round 2 review response

The changed-files inventory and conclusions above were corrected. `legacy-session.jsonl` is explicitly a one-turn inspection fixture. `synthetic-history.json` is a separate inspection-only synthetic set with two parent turns, a tool call/output, a child session, and an archived child; it is not represented as a live Codex rollout. The live run attempted two turns plus fork/archive and recorded the exact boundary: two state rows, one archived row, zero persisted `thread_spawn_edges`, and no tool record because the synthetic upstream returned 503 before model output.

The authoritative storage conclusion is now that the configured `sqlite_home` was materialized and inspected. The prior wording that the database and full schema were not inferred was removed. `state_5.sqlite` was selected from the configured root and verified by SQLite table contents, never by modification time. The full `threads` field list, `history_mode`, archive count, rollout record counts, and spawn-edge fields are recorded in the fix-round output above.

Schema validation now checks property shape and requiredness: start/list fields are optional, resume requires `threadId` while `modelProvider` is optional, metadata update requires `threadId` while `isPinned`/`gitInfo` are optional, and metadata update explicitly has no `modelProvider` property. The generated sanitized summary remains at `packages/cli/src/agent/codex/sessions/fixtures/codex-0.146.0-schema-summary.json`.

Authorization is captured for every upstream request, including `/v1/models`; all four auth cases passed with every observed request matching the configured bearer. No raw header or token was printed.

Storage hardening resolves real paths for both configured roots, rejects symlink roots and candidate SQLite/JSONL symlinks, and rejects candidate paths escaping their configured root before any SQLite or JSONL read. Unrelated non-candidate links are skipped. This preserves the temporary-home isolation while handling the runtime's unrelated `applypatch` link.

Fix-round 2 exact commands and results:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
Finished in 43ms on 2 files using 12 threads.

rtk bunx oxlint packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
exit 0

rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex
executable: codex-cli 0.146.0
version command exit: 0
app-server help exit: 0
isolated login help exit: 0
isolated login help first line: Manage login
schema command exit: 0
verified v2 schema fields: ThreadStartParams[required=(none);optional=modelProvider|historyMode], ThreadResumeParams[required=threadId;optional=modelProvider], ThreadListParams[required=(none);optional=modelProviders|useStateDbOnly], ThreadMetadataUpdateParams[required=threadId;optional=isPinned|gitInfo]
PASS: logged-out / test-proxy-key: model request used the configured proxy bearer
PASS: logged-out / aio-proxy-local: model request used the configured proxy bearer
PASS: logged-in / test-proxy-key: model request used the configured proxy bearer
PASS: logged-in / aio-proxy-local: model request used the configured proxy bearer
BLOCKED: native provider migration persistence: resume override=source-proxy, after restart=source-proxy, list source/target=1/0, restart source/target=1/0, repaired source=1; rounds=accepted/accepted, fork=accepted, archive=accepted; state_5.sqlite in configured sqlite_home had two source-proxy legacy rows, one archived row, zero spawn edges, and rollout summaries with session_meta/event_msg/response_item/world_state/turn_context records; metadata/update has no provider field, so no native migration write was attempted
migration: BLOCKED — this probe does not claim persistence without a restart/list/resume proof
probe-exit=1
```

The nonzero exit is intentional and machine-visible: a required migration result marked `BLOCKED` cannot be mistaken for a passing contract probe.

## Fix round 3 review response

The schema gate now treats the four validated entries as required: if any definition, property shape, nullable branch, required/optional set, or metadata-provider omission is invalid, it prints `FAIL: required app-server schema contract is missing or invalid` and sets a nonzero exit. It verifies `modelProviders` is nullable array with string items, `useStateDbOnly` is boolean, nullable `historyMode`/`gitInfo` retain their referenced definitions, and `ThreadMetadataUpdateParams` has no `modelProvider` property. The sanitized schema summary remains committed.

Exact fix-round 3 commands/results:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
Finished in 33ms on 2 files using 12 threads.

rtk bunx oxlint packages/cli/scripts/verify-codex-contract.ts packages/cli/scripts/codex-storage.ts
exit 0

rtk bun run packages/cli/scripts/verify-codex-contract.ts /opt/homebrew/bin/codex
executable: codex-cli 0.146.0
version command exit: 0
app-server help exit: 0
isolated login help exit: 0
isolated login help first line: Manage login
schema command exit: 0
verified v2 schema fields: ThreadStartParams[required=(none);optional=modelProvider|historyMode], ThreadResumeParams[required=threadId;optional=modelProvider], ThreadListParams[required=(none);optional=modelProviders|useStateDbOnly], ThreadMetadataUpdateParams[required=threadId;optional=isPinned|gitInfo]
PASS: logged-out / test-proxy-key: model request used the configured proxy bearer
PASS: logged-out / aio-proxy-local: model request used the configured proxy bearer
PASS: logged-in / test-proxy-key: model request used the configured proxy bearer
PASS: logged-in / aio-proxy-local: model request used the configured proxy bearer
BLOCKED: native provider migration persistence: resume override=source-proxy, after restart=source-proxy, list source/target=1/0, restart source/target=1/0, repaired source=1; rounds=accepted/accepted, fork=accepted, archive=accepted; configured sqlite_home/state_5.sqlite inspected with two source-proxy legacy rows, one archived row, zero spawn edges; rollout summaries recorded; metadata/update has no provider field, so no native migration write was attempted
migration: BLOCKED — this probe does not claim persistence without a restart/list/resume proof
probe-exit=1
```

The four auth cases passed because every observed upstream request, including `/v1/models`, matched the configured test bearer; raw headers remain unprinted. The expected probe exit remains nonzero solely because native migration is blocked.
