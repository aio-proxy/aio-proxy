# Anthropic Disabled Thinking and Effort Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Claude Code Anthropic Messages requests that explicitly disable thinking while still carrying `output_config.effort`, without enabling reasoning or forwarding the ineffective effort.

**Architecture:** Change the existing shared thinking parser so explicit `disabled` wins during cross-protocol conversion. Extend the existing raw Anthropic request rewriter to remove only the conflicting effort field while preserving all sibling fields and current effort normalization for non-conflicting requests.

**Tech Stack:** TypeScript 7, Bun 1.3.14, `bun:test`, Zod, Changesets

## Global Constraints

- Explicit `thinking.type: "disabled"` wins over `output_config.effort`.
- Cross-protocol model dispatch must keep `{ mode: "disabled" }` and must not carry reasoning effort.
- Same-protocol raw dispatch must remove only `output_config.effort`; preserve sibling keys and remove `output_config` only when empty.
- Keep current invalid-request behavior for missing thinking plus effort, fixed thinking plus effort, and adaptive thinking without effort.
- Do not add dependencies, feature flags, retries, logging, provider-specific branches, or new abstractions.
- Adaptive effort normalization and byte-preserving no-op forwarding must remain unchanged.
- Use Bun commands and follow the repository's colocated test layout.
- Add a patch changeset targeting both `@aio-proxy/core` and `aio-proxy`.

---

### Task 1: Make explicit disabled thinking authoritative

**Files:**
- Modify: `packages/core/src/protocol/anthropic-thinking.ts:19-22`
- Test: `packages/core/src/protocol/anthropic-thinking.test.ts:5-57`

**Interfaces:**
- Consumes: `anthropicThinkingOption(request: Pick<AnthropicMessagesRequest, 'thinking' | 'output_config' | 'max_tokens'>): AnthropicThinkingOption | undefined`
- Produces: explicit disabled thinking maps to `{ readonly mode: 'disabled' }` even when `output_config.effort` is present; all other validation branches retain their current behavior.

- [ ] **Step 1: Replace the old rejection expectation with a cross-protocol regression test**

Remove this row from the `rejects invalid fixed/adaptive settings` table:

```typescript
[{ type: 'disabled' }, 8192, 'high'],
```

Add this behavior test after `returns no option when thinking and effort are absent`:

```typescript
test('keeps thinking disabled when Claude Code also sends effort', () => {
  const request = parseAnthropicMessages({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    output_config: { effort: 'high' },
  });

  expect(anthropicMessagesToModelMessages(request).settings.providerOptions).toEqual({
    aioProxy: { thinking: { mode: 'disabled' } },
  });
});
```

- [ ] **Step 2: Run the focused test and verify the regression is red**

Run:

```bash
rtk bun test packages/core/src/protocol/anthropic-thinking.test.ts
```

Expected: FAIL in `keeps thinking disabled when Claude Code also sends effort` with `AnthropicMessagesTransformError: Invalid Anthropic Messages request at output_config.effort`.

- [ ] **Step 3: Implement the minimal parser change**

Replace the disabled branch in `anthropicThinkingOption()` with:

```typescript
case 'disabled':
  return { mode: 'disabled' };
```

Do not change the missing-thinking, enabled, or adaptive branches.

- [ ] **Step 4: Run the focused test and verify it is green**

Run:

```bash
rtk bun test packages/core/src/protocol/anthropic-thinking.test.ts
```

Expected: PASS with zero failed tests. The remaining table row `[undefined, 8192, 'high']` proves missing thinking plus effort is still rejected.

- [ ] **Step 5: Commit the parser behavior**

```bash
rtk git add packages/core/src/protocol/anthropic-thinking.ts packages/core/src/protocol/anthropic-thinking.test.ts
rtk git commit -m 'fix(core): accept effort with disabled thinking' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

### Task 2: Sanitize disabled-thinking raw requests

**Files:**
- Modify: `packages/core/src/protocol/anthropic-messages/effort.ts:17-47`
- Test: `packages/core/src/protocol/anthropic-messages/effort.test.ts:12-54`

**Interfaces:**
- Consumes: `rewriteAnthropicRawEffort(raw: Request, resolvedModel: string, supportedEfforts: ReadonlySet<string>): Promise<Request>`
- Produces: a forwarded raw request where explicit disabled thinking is preserved and `output_config.effort` is absent; non-conflicting requests keep current normalization and byte-preservation behavior.

- [ ] **Step 1: Add table-driven raw rewrite regressions**

Append this test to `effort.test.ts`:

```typescript
test.each([
  [{ effort: 'high' }, undefined],
  [{ effort: 'high', verbosity: 'high' }, { verbosity: 'high' }],
])('strips effort when thinking is disabled %#', async (outputConfig, expectedOutputConfig) => {
  const raw = anthropicRequest({
    model: 'same',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
    output_config: outputConfig,
  });

  const forwarded = await rewriteAnthropicRawEffort(raw, 'same', new Set(['low', 'medium', 'high']));
  const body = (await forwarded.json()) as Record<string, unknown>;

  expect(body['thinking']).toEqual({ type: 'disabled' });
  expect(body['output_config']).toEqual(expectedOutputConfig);
});
```

- [ ] **Step 2: Run the raw rewrite test and verify the regression is red**

Run:

```bash
rtk bun test packages/core/src/protocol/anthropic-messages/effort.test.ts
```

Expected: both new cases FAIL because the current no-op path forwards `output_config.effort` unchanged.

- [ ] **Step 3: Detect explicit disabled thinking and sanitize the copied output config**

After parsing `body`, inspect the existing `thinking` field:

```typescript
const thinking = body['thinking'];
const thinkingDisabled =
  typeof thinking === 'object' &&
  thinking !== null &&
  (thinking as { readonly type?: unknown }).type === 'disabled';
```

Replace the current `nextEffort` and `nextOutputConfig` declarations with:

```typescript
let nextOutputConfig = outputConfig;
if (thinkingDisabled && currentEffort !== undefined) {
  const sanitized = { ...(outputConfig as Record<string, unknown>) };
  delete sanitized['effort'];
  nextOutputConfig = Object.keys(sanitized).length === 0 ? undefined : sanitized;
} else if (currentEffort !== undefined) {
  const nextEffort = normalizeEffort(currentEffort, supportedEfforts);
  if (nextEffort !== currentEffort) {
    nextOutputConfig = { ...(outputConfig as object), effort: nextEffort };
  }
}
```

Keep `modelUnchanged` and `effortUnchanged` unchanged. Replace the changed-body serialization with an explicit `output_config` override so `JSON.stringify` omits it when its value is `undefined`:

```typescript
const forwardedBody =
  modelUnchanged && effortUnchanged
    ? bodyText
    : JSON.stringify({
        ...body,
        model: resolvedModel,
        output_config: nextOutputConfig,
      });
```

- [ ] **Step 4: Run both affected test files**

Run:

```bash
rtk bun test packages/core/src/protocol/anthropic-thinking.test.ts packages/core/src/protocol/anthropic-messages/effort.test.ts
```

Expected: PASS with zero failed tests, including the existing verbatim-body and adaptive effort-clamping cases.

- [ ] **Step 5: Commit the raw sanitization**

```bash
rtk git add packages/core/src/protocol/anthropic-messages/effort.ts packages/core/src/protocol/anthropic-messages/effort.test.ts
rtk git commit -m 'fix(core): strip effort from disabled Anthropic requests' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

### Task 3: Add release metadata and run full verification

**Files:**
- Create: one generated `.changeset/*.md` file
- Verify: all files changed by Tasks 1-2

**Interfaces:**
- Consumes: the completed parser and raw rewrite behavior from Tasks 1-2.
- Produces: patch release notes for `@aio-proxy/core` and `aio-proxy`, plus fresh repository-wide verification evidence.

- [ ] **Step 1: Author the required changeset with the repository CLI**

Run:

```bash
rtk bun changeset
```

Select `@aio-proxy/core` and `aio-proxy`, choose `patch` for both, and enter this summary:

```text
Accept Claude Code Anthropic requests that combine disabled thinking with output_config.effort by preserving disabled thinking and dropping the ineffective effort.
```

Expected generated file content:

```markdown
---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Accept Claude Code Anthropic requests that combine disabled thinking with output_config.effort by preserving disabled thinking and dropping the ineffective effort.
```

- [ ] **Step 2: Verify the changeset scope before staging**

Run:

```bash
rtk git status --short .changeset
```

Expected: exactly one new `.changeset/*.md` file. Do not stage `.reference` or unrelated working-tree changes.

- [ ] **Step 3: Run focused verification again**

Run:

```bash
rtk bun test packages/core/src/protocol/anthropic-thinking.test.ts packages/core/src/protocol/anthropic-messages/effort.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 4: Run the repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: type-aware lint, format check, unit tests, and artifact tests all exit successfully with zero failures.

- [ ] **Step 5: Commit the release metadata**

After confirming Step 2 showed exactly one generated changeset:

```bash
rtk git add .changeset
rtk git commit -m 'chore: add disabled Anthropic effort changeset' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

- [ ] **Step 6: Inspect the final implementation diff**

Run:

```bash
rtk git status --short
rtk git log --oneline -4
```

Expected: only the pre-existing untracked `.reference` entry remains; the log contains the plan commit followed by the three implementation commits.
