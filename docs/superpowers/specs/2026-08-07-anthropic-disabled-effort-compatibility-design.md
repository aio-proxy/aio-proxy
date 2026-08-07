# Anthropic Disabled Thinking and Effort Compatibility Design

## Context

Claude Code 2.1.166 and later can send auxiliary Anthropic Messages requests that contain both:

```json
{
  "thinking": { "type": "disabled" },
  "output_config": { "effort": "high" }
}
```

aio-proxy currently rejects this request during protocol parsing. `anthropicThinkingOption()` treats any effort paired with disabled thinking as an `AnthropicMessagesTransformError`, so the request returns a local HTTP 400 before provider selection.

The explicit `thinking.type` is the stronger expression of client intent. Reference implementations that normalize the conflict preserve disabled thinking and remove the ineffective effort field. This also avoids silently enabling reasoning, which could increase latency and cost.

## Decision

When `thinking.type` is explicitly `disabled`, aio-proxy will accept `output_config.effort` but treat the effort as ineffective:

- Cross-protocol model dispatch keeps `{ mode: "disabled" }` and does not add a reasoning effort.
- Same-protocol raw dispatch removes only `output_config.effort` before forwarding.
- Other `output_config` fields are preserved.
- If removing `effort` leaves `output_config` empty, the empty object is removed.

No warning, feature flag, retry, or new abstraction is added. Existing debug request logging already exposes inbound and forwarded request shapes when diagnostics are needed.

## Behavior Matrix

| Thinking input | Effort input | Result |
| --- | --- | --- |
| absent | absent | No thinking option |
| absent | present | Keep current invalid-request behavior |
| `disabled` | absent | Disabled thinking |
| `disabled` | present | Disabled thinking; discard effort |
| `enabled` | absent, valid budget | Fixed thinking |
| `enabled` | present | Keep current invalid-request behavior |
| `adaptive` | present | Adaptive thinking with effort |
| `adaptive` | absent | Keep current invalid-request behavior |

## Data Flow

### Parse and cross-protocol model dispatch

`anthropicThinkingOption()` stops rejecting effort only in the explicit `disabled` branch and returns `{ mode: "disabled" }`. The existing Anthropic-to-model-message transformation then stores only that disabled option in `settings.providerOptions.aioProxy.thinking`; no effort reaches the AI SDK invocation.

The missing-thinking and fixed-thinking validation branches remain unchanged so this fix does not broaden unrelated request semantics.

### Same-protocol raw dispatch

`rewriteAnthropicRawEffort()` already parses the decoded request body when it must inspect the model and effort. It will additionally inspect `thinking.type`. For explicit `disabled`, it removes `effort` from `output_config` before the existing model/effort rewrite decision:

- Preserve sibling keys in `output_config`.
- Omit `output_config` when no keys remain.
- Preserve `thinking: { type: "disabled" }`.
- Re-serialize because the forwarded body changed.
- Continue removing stale `content-encoding` and `content-length` headers through the existing path.

Adaptive effort normalization and no-op byte preservation remain unchanged for non-conflicting requests.

## Tests

Add the smallest behavior-level regressions in the existing colocated test files:

1. `anthropic-thinking.test.ts`: parse and transform a request with disabled thinking plus effort; assert the resulting provider option is exactly `{ mode: "disabled" }`. Keep the missing-thinking-plus-effort case in the rejection table.
2. `anthropic-messages/effort.test.ts`: raw-rewrite a disabled-thinking request whose `output_config` contains `effort` and a sibling field; assert effort is absent, the sibling survives, and thinking stays disabled.

Run the two focused test files, then `bun run preflight`.

## Release

Create a patch changeset targeting both `@aio-proxy/core` and `aio-proxy`. The user-facing note should state that Claude Code requests combining disabled thinking with an effort setting no longer fail locally with HTTP 400.

## Non-goals

- Do not change requests where `thinking` is absent.
- Do not reinterpret fixed thinking plus effort.
- Do not convert disabled thinking to adaptive thinking.
- Do not add provider-specific retries or configuration switches.
- Do not change general effort capability normalization.
