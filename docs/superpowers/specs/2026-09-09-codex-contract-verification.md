# Codex contract verification (2026-09-09)

This document records the isolated Task 1 experiment. It used the explicit executable `/opt/homebrew/bin/codex`, a temporary `HOME` and `CODEX_HOME`, synthetic credentials, and a loopback synthetic upstream. No host Codex session, keychain, API key, or user history was read.

## Verified executable and schema

The executable reported `codex-cli 0.146.0`. The exported experimental v2 schema has the title `CodexAppServerProtocolV2` and contains these request parameter definitions:

| Request | Verified fields relevant to this task |
| --- | --- |
| `thread/start` | `cwd`, `model`, `modelProvider`, `historyMode` |
| `thread/resume` | required `threadId`; optional `model`, `modelProvider`, `path`, `excludeTurns` |
| `thread/list` | `modelProviders`, `archived`, `parentThreadId`, `limit`, `cursor`, `useStateDbOnly` |
| `thread/metadata/update` | `threadId`, `isPinned`, `gitInfo` |

The schema exposes no provider mutation field on `thread/metadata/update`, and no provider migration method. The live `thread/resume` probe accepted the declared `modelProvider` field but returned the source provider after a restart; this is not a persistent migration mechanism.

The executable does not expose an upstream source revision through `--version` or the generated schema. The supported evidence is therefore pinned to executable version `0.146.0`; the upstream revision is `unavailable` rather than inferred from a different checkout or web source.

The generated schema was also preserved in sanitized form at `packages/cli/src/agent/codex/sessions/fixtures/codex-0.146.0-schema-summary.json`. The probe validates the named properties themselves, including the absence of `modelProvider` on `ThreadMetadataUpdateParams`, rather than only checking definition names.

## Verified global configuration

The isolated config used these authored fields:

```toml
model = "contract-model"
model_provider = "contract-proxy"
cli_auth_credentials_store = "file"

[model_providers.contract-proxy]
name = "contract-proxy"
base_url = "http://127.0.0.1:<synthetic-port>/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "test-proxy-key" # or aio-proxy-local
request_max_retries = 0
```

The process environment was reduced to `PATH`, a temporary `HOME`, a temporary `CODEX_HOME`, and a temporary `TMPDIR`. The logged-in case added only a synthetic `auth.json` containing `OPENAI_API_KEY = synthetic-login-token`. The probe records only whether the observed Authorization value matched the expected test token; it never records raw headers or credentials.

## Authentication results

All four combinations passed. Each model request carried the configured proxy token, including when a synthetic login token was present:

| Synthetic auth file | Configured proxy token | Result |
| --- | --- | --- |
| absent | `test-proxy-key` | PASS |
| absent | `aio-proxy-local` | PASS |
| present with synthetic token | `test-proxy-key` | PASS |
| present with synthetic token | `aio-proxy-local` | PASS |

The upstream returned the deliberate 503 contract-probe response. This verifies bearer selection and does not claim complete TUI login or inference success.

The isolated `codex login --help` invocation exited 0 and printed `Manage login`. Full TUI login was not automated because it requires interactive/browser authentication; no claim is made about that boundary.

## Persistence and migration results

The live experiment created a synthetic source-provider thread, queried `thread/list` with `modelProviders` and `useStateDbOnly`, called `thread/resume` with `modelProvider = aio-proxy`, invoked the declared metadata update (`isPinned` only), closed app-server, reopened it, and repeated list/resume. The observed result was:

```text
resume override=source-proxy, after restart=source-proxy,
list source/target=1/0, restart source/target=1/0
```

The native migration branch is therefore `BLOCKED`: the declared override did not change ownership, and metadata update has no provider field. No SQLite path was guessed and no database or rollout was edited. Task 5 must use an offline, version-gated path after independently validating the active state database and rollout format.

The same isolated run materialized the configured `sqlite_home` directory. The actual SQLite inspection found `state_5.sqlite` with these `threads` columns: `id`, `rollout_path`, `created_at`, `updated_at`, `source`, `model_provider`, `cwd`, `title`, `sandbox_policy`, `approval_mode`, `tokens_used`, `has_user_event`, `archived`, `archived_at`, `git_sha`, `git_branch`, `git_origin_url`, `cli_version`, `first_user_message`, `agent_nickname`, `agent_role`, `memory_mode`, `model`, `reasoning_effort`, `agent_path`, `created_at_ms`, `updated_at_ms`, `thread_source`, `preview`, `recency_at`, `recency_at_ms`, `history_mode`, `name`, and `is_pinned`. It contained two synthetic rows, provider `source-proxy`, `history_mode=legacy`, one archived row. The `thread_spawn_edges` index exists with `parent_thread_id`, `child_thread_id`, and `status`, but the run produced zero persisted edges despite the fork/archive calls; parent/child persistence is therefore not established.

The run materialized two rollout JSONL files. Their sanitized summaries were 14 lines with `session_meta:2`, `event_msg:6`, `response_item:4`, `world_state:1`, `turn_context:1`, and 10 lines with `session_meta:1`, `event_msg:4`, `response_item:3`, `world_state:1`, `turn_context:1`; all observed `session_meta` records carried `source-proxy`. Two turn starts were accepted by app-server, but the synthetic upstream cannot emit a tool call because it returns the deliberate 503 before model output. A tool record is therefore explicitly `unavailable`, not claimed. `thread/list` with `useStateDbOnly=false` returned the same source row count as state-only listing, which is the observed repair comparison; no index-only edit was attempted.

The configured `sqlite_home` was used. If a future executable materializes no SQLite file, the probe reports that exact absence and production migration must reject before writes. Storage selection is based on the configured location and inspected table contents; it never chooses a `state_*.sqlite` by modification time.

The fixtures capture only synthetic, rewrite-safe inspection shapes:

- Legacy JSONL has a unique `session_meta.payload.id` and `session_meta.payload.model_provider`; all following rollout records are opaque bytes to preserve.
- The paginated fixture records the fields required to identify a thread (`id`, `model_provider`, `history_mode`, `rollout_path`, `archived`, and `parent_thread_id`). It is synthetic and does not authorize assuming a database filename or location.

An offline implementation must reject missing or conflicting IDs, a source-provider mismatch, unknown history formats, an unverified database location, and any active writer. It must update a verified metadata field and its index transactionally with recovery information; changing only an index is insufficient because JSONL repair can overwrite it.
