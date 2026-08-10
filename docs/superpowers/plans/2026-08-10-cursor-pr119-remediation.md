# Cursor PR #119 Remediation Plan

> Execute with `superpowers:subagent-driven-development`. Every behavior change follows RED → GREEN → focused regression.

**Goal:** Make PR #119 mergeable on current `main` by repairing Cursor tool continuation, transport cleanup, runtime boundary handling, OAuth popup flow, and release/legal packaging.

**Architecture:** Keep the existing Cursor plugin boundaries. `runtime/stream` correlates interaction updates; `runtime/history` and `run-request` rebuild resumable protobuf state; `driver` owns one turn; `wire` owns Connect/HTTP2 lifecycle. Do not add a stateful live bridge, connection pool, or new dependency.

## Global Constraints

- Work only in `/Volumes/ExternalSSD/workspace/aio-proxy-pr119-fix` on `codex/cursor-oauth-spec`; preserve the original PR branch.
- Prefer the smallest root-cause fix in an existing module. No speculative abstraction or dependency.
- Preserve current SDK v2 names from `main`: `displayName`, `accountLabel`, and required `RuntimeContext.fetch`.
- Preserve the generic `presentAuthorizeUrl` OAuth seam: Cursor PKCE polling is neither device-code nor loopback OAuth.
- Never send a fake MCP result. A caller/MCP tool call suspends the current model turn and resumes from the next caller request.
- The outward AI SDK tool-call ID is Cursor's outer `callId`; persist `outer callId -> nested McpArgs.toolCallId` and use it when encoding the resumed Cursor history.
- Same-session failures must not delete the last known-good checkpoint. Successful turns replace state atomically.
- `shellStreamArgs` ends only the logical shell stream with an exit event; it must not close the whole Cursor Run prematurely.
- Every HTTP/2 Run has a dedicated session. All success/error/abort/cancel paths settle frames/trailers and release it exactly once.
- Unsupported file inputs fail explicitly; do not silently drop non-image files or non-inline images.
- Do not reply to or resolve GitHub review threads. The user only authorized code/PR-branch updates.
- Every commit must end with `Co-authored-by: Codex <noreply@openai.com>`.
- Before completion run `bun run preflight`, `bun run test:e2e:api`, affected artifact/binary smoke tests, and a whole-branch review.

### Task 1: Sync current main and migrate the OAuth/SDK integration

**Files:** merge-conflicted integration files plus Cursor plugin/tests; do not edit generated protobuf.

- Merge `origin/main` into the PR branch without discarding either side's unrelated work.
- Take current `main` as the base for package versions, Dashboard/UI structure, config schemas, lint config, and SDK v2.
- Restore `AuthorizationPort.presentAuthorizeUrl` with an HTTP(S)-validated end-to-end CLI/server/types/Dashboard implementation and existing error-boundary behavior.
- Migrate Cursor to `OAuthAdapter.displayName`, plugin metadata display/icon, `OAuthLoginResult.accountLabel`, refresh `metadata.accountLabel`, and `RuntimeContext.fetch` (control traffic marked through existing runtime fetch options).
- Keep Cursor statically registered in core and listed by compiled binary behavior.
- Resolve `bun.lock` by running Bun after package manifests are correct, not by keeping stale conflict blocks.
- RED evidence: after the merge, run the smallest compile/tests that demonstrate broken SDK/OAuth integration before fixing.
- GREEN: run Cursor OAuth/plugin/catalog/runtime tests plus affected plugin-sdk/core/server/types/CLI/Dashboard tests and `bun run check`.
- Commit the merge/integration migration.

### Task 2: Implement MCP suspend/resume and checkpoint-safe history

**Files:**

- `packages/plugins/cursor/src/runtime/stream/interaction.ts`
- `packages/plugins/cursor/src/runtime/stream/interaction.test.ts`
- `packages/plugins/cursor/src/runtime/driver.ts`
- `packages/plugins/cursor/src/runtime/driver.test.ts`
- `packages/plugins/cursor/src/runtime/history/history.ts`
- `packages/plugins/cursor/src/runtime/history/history.test.ts`
- `packages/plugins/cursor/src/runtime/run-request.ts`
- `packages/plugins/cursor/src/runtime/run-request.test.ts`
- `packages/plugins/cursor/src/runtime/cursor-model.ts`
- `packages/plugins/cursor/src/runtime/cursor-model.test.ts`
- existing session/blob modules only if required

- RED first:
  - Interleave two MCP calls with distinct outer/nested IDs; assert two complete, uncrossed tool calls.
  - Keep the fake upstream open after a completed MCP call; assert the AI SDK stream promptly finishes with `tool-calls`, the write side ends, and no fake `mcpResult` is written.
  - Run a second request containing tool results only; assert same Cursor conversation, `ResumeAction`, preserved prior checkpoint turns, and structured `McpToolCall.result` using the stored nested ID.
  - Make the new request fail after a prior successful checkpoint; assert the old state remains.
- Replace the single tool accumulator slot with call-ID-keyed state. Buffer interleaved deltas by outer `callId`, emit completed calls atomically, and expose each outer/nested mapping.
- Suspend after completed caller tools (once currently-open parallel calls are complete): finalize text/reasoning/tool parts, emit one finish, close the caller stream/write side, resolve a non-usable mid-tool checkpoint plus pending map, and do not wait for `turnEnded`.
- On resume, reuse the stored mid-tool conversation state only for matching pending tool results. Preserve checkpoint `turns` when the incremental prompt contributes no historical turns; patch/synthesize the matching structured MCP history entry rather than flattening the result to anonymous text.
- Consume only returned mappings and retain still-pending calls. Normal clean turns clear pending state.
- Preserve prior session state on failed/aborted attempts; only a successful result replaces it.
- GREEN: all affected Cursor runtime/store tests and `bun run check`.
- Commit the MCP/history fix.

### Task 3: Close HTTP/2 Runs and reject truncated Connect frames

**Files:**

- `packages/plugins/cursor/src/wire/frame.ts`
- `packages/plugins/cursor/src/wire/frame.test.ts`
- `packages/plugins/cursor/src/wire/transport.ts`
- `packages/plugins/cursor/src/wire/transport.test.ts`
- `packages/plugins/cursor/src/runtime/driver.ts`
- `packages/plugins/cursor/src/runtime/driver.test.ts`

- RED first for normal EOF, request error, session error, in-flight abort, already-aborted input, reader cancellation, and partial header/payload EOF.
- Give `ConnectFrameDecoder` an EOF check that throws `Truncated Cursor Connect frame` when bytes remain.
- In `openRun`, use one idempotent terminal path: settle frames and trailers, remove the abort listener, end/close the request as appropriate, and close/destroy the dedicated session exactly once.
- Reject before `connect()` when the signal is already aborted and preserve its reason.
- Propagate downstream `ReadableStream.cancel()` into the active Run; stop heartbeat and reject the turn result without persisting new state.
- Apply the same already-aborted/session-release correctness to unary requests where the same defect exists.
- Do not close the whole Run in response to a logical shell-stream exit.
- GREEN: frame/transport/driver/model focused tests and `bun run check`.
- Commit the transport fix.

### Task 4: Enforce remaining runtime call options and input boundaries

**Files:** existing Cursor runtime/history/exec files and colocated tests.

- RED first:
  - `toolChoice:none` advertises zero MCP tools.
  - named tool choice advertises only the named tool.
  - unsupported `required` is surfaced as an AI SDK V4 warning rather than silently claimed as enforced.
  - inline PDF/text and URL/reference images fail before transport; inline image data still succeeds.
  - `shellStreamArgs` encodes exactly one terminal exit event with code `1`.
- Implement tool filtering in the existing model-to-MCP-definition seam. Capture `stream-start` warnings in `doGenerate` results.
- Validate the prompt once at run-request construction: only text and inline image data are accepted until Cursor document support exists.
- Keep the already-correct shell-stream production mapping; add production code only if the RED protocol assertion proves it wrong.
- GREEN: focused Cursor tests and `bun run check`.
- Commit the runtime-boundary fix.

### Task 5: Reuse the pre-opened Dashboard OAuth popup

**Files:** current-main provider create/edit OAuth owners and their colocated tests; authorization panel only if its fallback link needs adjustment.

- RED first in both create and edit flows: a pre-opened popup receives `session.url` when status becomes `authorize_url`, is cleared from the ref, and no second `window.open` is required.
- Extend the existing loopback navigation effect to `authorize_url`; retain the visible safe `<a target="_blank" rel="noreferrer">` as a blocked/closed-popup fallback.
- Preserve cancellation/success cleanup and main's current Dashboard state ownership/UI imports.
- GREEN: focused Dashboard tests and build.
- Commit the popup fix.

### Task 6: Complete release metadata and third-party notice

**Files:** `.changeset/config.json`, one new `.changeset/*.md`, Cursor/core/package manifests, binary artifact test, `packages/plugins/cursor/src/gen/README.md`, and `packages/plugins/cursor/src/gen/LICENSE`.

- Add `@aio-proxy/plugin-cursor` to the Changesets fixed group and set its manifest version to the current lockstep version.
- Ensure core has the static Cursor workspace dependency and the compiled-binary artifact test proves `aio-proxy plugin list` exposes Cursor from an external temporary cwd.
- Add a user-facing minor changeset targeting `aio-proxy`, `@aio-proxy/plugin-sdk`, `@aio-proxy/core`, and `@aio-proxy/plugin-cursor` at equal levels.
- Add the complete upstream MIT text with both notices: Mario Zechner and Can Bölük. Point the provenance README to the vendored notice.
- Do not edit `agent.proto` or generated `agent_pb.ts` for licensing.
- RED first for fixed-group/version/binary packaging behavior where an existing behavior-level test can carry the contract; do not add a test that only restates static text.
- GREEN: Changesets status, Cursor build/tests, core/CLI artifact tests, binary smoke, and `bun run check`.
- Commit the release/legal fix.

## Final Verification and Review

- Run `bun run preflight`.
- Run `bun run test:e2e:api`.
- Run Cursor package build/unit tests and the compiled binary artifact smoke explicitly.
- If real Cursor credentials are available locally without exposing them, run the documented text/tool/discovery smoke; otherwise record this as the only external validation gap and do not fabricate success.
- Run a whole-branch correctness review against `origin/main`; fix Critical/Important findings in one bounded fix wave and re-review once.
- Confirm `git status`, PR mergeability, and GitHub checks; push `codex/cursor-oauth-spec` to update PR #119.
