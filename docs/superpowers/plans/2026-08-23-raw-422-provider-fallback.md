# Raw 422 Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a raw HTTP 422 fall through to the next live candidate instead of returning that 422 to the client.

**Architecture:** Keep the single raw-status gate in `shouldFallbackStatus()`. Add `422` beside the existing `429` and `>= 500` checks. Do not add a body-rule engine, cooldown, or affinity rewrite. The existing candidate loop, `hasNext`, body cancel, logging, and success-path affinity rebind stay in place.

**Tech Stack:** TypeScript, Bun test runner, existing pipeline harness in `packages/server`.

**Spec:** [docs/superpowers/specs/2026-08-23-raw-422-provider-fallback-design.md](../specs/2026-08-23-raw-422-provider-fallback-design.md)

## Global Constraints

- User-visible retry policy change: raw `422` fallbacks when another candidate is live.
- `400`, `401`, `403`, `404`, `408`, `409`, and `413` stay terminal. Keep the existing raw `400` test as the lock.
- Do not add a body-text classifier, same-account replay, extra cooldown, or a dedicated affinity-clear on `422`.
- Do not change `handleAttemptError()` exception fallback.
- `422` must not call `cooldown.cool()`. Only `429` with a parseable `Retry-After` cools.
- No new dependencies. No new files except the spec, this plan, and one changeset.
- Changeset must list product package `aio-proxy` and internal package `@aio-proxy/server` at the same `patch` level.
- Workspace is already an isolated git worktree. Do not create another worktree.

---

## File map

- `packages/server/src/routes/pipeline/failure.ts` — `shouldFallbackStatus()` is the only policy function raw uses.
- `packages/server/src/routes/pipeline/attempt/raw.ts` — already calls `hasNext && shouldFallbackStatus(response.status)`. Do not edit unless a compile error forces an import change.
- `packages/server/src/routes/pipeline/raw-fallback.test.ts` — existing contract tests for raw fallback vs terminal `400`.
- `docs/superpowers/specs/2026-07-12-shared-protocol-routing-pipeline-design.md` — still says ordinary raw `4xx` never fallbacks. Update the two sentences that state that contract.
- `.changeset/raw-422-provider-fallback.md` — release note.

---

### Task 1: Raw 422 fallback

**Files:**
- Modify: `packages/server/src/routes/pipeline/raw-fallback.test.ts:7`
- Modify: `packages/server/src/routes/pipeline/failure.ts:6-8`
- Modify: `docs/superpowers/specs/2026-07-12-shared-protocol-routing-pipeline-design.md:259` and `:294-295`
- Create: `.changeset/raw-422-provider-fallback.md`

**Interfaces:**
- Consumes: `shouldFallbackStatus(status: number): boolean` from `packages/server/src/routes/pipeline/failure.ts`.
- Consumes: `pipeline()`, `attemptsOf()`, `rawProvider()`, `jsonRequest()`, `REQUESTED_MODEL`, `settleRecording()` already used by `raw-fallback.test.ts`.
- Produces: `shouldFallbackStatus(422) === true`. `shouldFallbackStatus(400) === false`. Raw `422` with a live backup returns the backup success and records `fallback: true`.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/routes/pipeline/raw-fallback.test.ts`, change only the parameterized statuses:

```ts
test.each([422, 429, 503])('falls back after raw status %d', async (status) => {
```

Leave the test body, the `400` case, and the 503 body-cancel / observation tests unchanged.

- [ ] **Step 2: Run the new case and confirm it fails**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-fallback.test.ts --test-name-pattern "falls back after raw status 422"
```

Expected: FAIL. The client response is the primary `422` body, `backup.calls.raw` is `0`, and the log has `fallback: false`.

- [ ] **Step 3: Implement the status gate**

Replace `shouldFallbackStatus` in `packages/server/src/routes/pipeline/failure.ts` with:

```ts
export function shouldFallbackStatus(status: number): boolean {
  return status === 422 || status === 429 || status >= 500;
}
```

Do not edit `packages/server/src/routes/pipeline/attempt/raw.ts`. It already uses this function.

- [ ] **Step 4: Re-run the raw fallback file**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-fallback.test.ts
```

Expected: all tests PASS, including `does not fall back after an ordinary raw 400 response`.

- [ ] **Step 5: Update the shared-pipeline contract sentences**

In `docs/superpowers/specs/2026-07-12-shared-protocol-routing-pipeline-design.md`, change the raw-error bullet from:

```text
2. **raw upstream response**：除 `429`/`5xx` fallback 外保持原始响应；最终候选的响应原样返回。
```

to:

```text
2. **raw upstream response**：除 `422`/`429`/`5xx` fallback 外保持原始响应；最终候选的响应原样返回。
```

Change the contract-test bullets from:

```text
- raw `429`/`5xx`、网络异常和 model 首 event 失败按顺序 fallback。
- raw 普通 `4xx`、inbound abort 和流已提交后不 fallback。
```

to:

```text
- raw `422`/`429`/`5xx`、网络异常和 model 首 event 失败按顺序 fallback。
- raw 普通 `4xx`（`422` 除外）、inbound abort 和流已提交后不 fallback。
```

Do not rewrite the rest of that historical design.

- [ ] **Step 6: Add the changeset**

Create `.changeset/raw-422-provider-fallback.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Raw provider `422` responses now fall through to the next live candidate. Other `4xx` statuses still return immediately.
```

- [ ] **Step 7: Check and commit**

Run:

```bash
bun test packages/server/src/routes/pipeline/raw-fallback.test.ts && bun run check
```

Expected: exit 0.

Commit only the files this task owns:

```bash
git add \
  packages/server/src/routes/pipeline/failure.ts \
  packages/server/src/routes/pipeline/raw-fallback.test.ts \
  docs/superpowers/specs/2026-07-12-shared-protocol-routing-pipeline-design.md \
  docs/superpowers/specs/2026-08-23-raw-422-provider-fallback-design.md \
  docs/superpowers/plans/2026-08-23-raw-422-provider-fallback.md \
  .changeset/raw-422-provider-fallback.md

git commit -m "$(cat <<'EOF'
fix(server): fall back after raw provider 422

Co-authored-by: Codex <noreply@openai.com>
EOF
)"
```

---

## Self-review

1. Spec coverage: the 422 fallback table, the 400 lock, unchanged exception/cooldown/affinity rules, and the changeset are all in Task 1. Non-goals are constraints, not extra tasks.
2. Placeholder scan: no TBD/TODO, no "add tests later", no "similar to Task N".
3. Type consistency: the only function name is `shouldFallbackStatus(status: number): boolean`.
