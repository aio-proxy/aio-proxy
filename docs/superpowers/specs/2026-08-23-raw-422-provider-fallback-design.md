# Raw 422 Provider Fallback

## Goal

When a same-protocol raw candidate returns HTTP 422 and another candidate remains, try the next candidate instead of returning the 422 to the client.

## Background

`shouldFallbackStatus()` currently allows only `429` and `>= 500`. A sticky `api` provider that speaks `openai-response` therefore terminates the loop on relay `422`, even when an OAuth candidate for the same model is live.

Local traces showed this on `grok-4.6`: affinity selected `carpool`, one raw attempt, `422` SSE with zero frames, and no attempt on `grok-f3495225242e`.

`.reference` peers split 400 and 422. new-api retries `409-499` and skips `400`/`408`. claude-code-hub stops only on body-matched client-input rules; an unmatched 422 is a provider error and continues. OmniRoute fail-closes typed config 422s, but generic 422 falls through to account fallback. 9router and CLIProxyAPI keep a 429/5xx transport whitelist.

This change follows the 400-vs-422 split. It does not add a body-rule engine.

## Behavior

Raw candidate HTTP status:

| Status | Fallback when `hasNext` |
|---|---|
| `422`, `429`, `>= 500` | yes |
| other `4xx`, including `400`, `401`, `403`, `404`, `408`, `409`, `413` | no |

Unchanged:

- Exception-path fallback still uses `hasNext` after a mapped provider error. It is not narrowed to this table.
- `422` does not write cooldown. Only `429` with a parseable `Retry-After` cools.
- Affinity write rules stay as they are. A later successful candidate still rebinds through the existing success path.
- Inbound abort, stream-already-committed, and last-candidate terminal responses stay as they are.

## Scope

- Change `shouldFallbackStatus()` and the existing raw fallback contract test.
- Update the shared-pipeline design sentence that said ordinary raw `4xx` never fallback.
- Add a user-facing changeset on `aio-proxy` and `@aio-proxy/server`.

## Non-goals

- Body-text classification of unprocessable requests.
- Retrying `400`, `409`, `413`, or all remaining `4xx`.
- Same-account replay, extra cooldown, or a dedicated affinity-clear on `422`.
- Configurable retry policy, circuit breaker, or health scoring.

## Verification

- Raw `422` with a live backup candidate must call the backup and return its success.
- Raw `400` must keep the existing no-fallback contract.
- Existing raw `429`/`503` fallback tests must still pass.
