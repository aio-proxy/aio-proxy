# Codex session contract fixtures

These fixtures contain synthetic identifiers and no user paths, credentials, or conversation data. They capture only the fields that the Task 1 experiment could verify for offline inspection:

- `legacy-session.jsonl` uses the observed legacy `session_meta.payload.id` and `session_meta.payload.model_provider` fields, followed by opaque rollout records that must remain byte-for-byte unchanged by a metadata rewrite.
- `paginated-state.json` records the observed state-index fields needed to identify a paginated thread: `id`, `model_provider`, `history_mode`, `rollout_path`, `archived`, and `parent_thread_id`.
- `codex-0.146.0-schema-summary.json` preserves the sanitized generated schema contract used by the probe.
- `rejection-cases.json` makes the required refusal conditions concrete without containing real session data.

The current Codex app-server schema exposes `modelProvider` on `thread/start` and `thread/resume`, and `modelProviders` on `thread/list`. It does not expose a provider update method. The fixtures therefore document accepted inspection shapes only; they are not evidence that a provider migration is supported through app-server.
