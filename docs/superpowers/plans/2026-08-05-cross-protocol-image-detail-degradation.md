# Cross-Protocol Image Detail Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let OpenAI Responses image requests fall back to non-Responses providers by dropping only the OpenAI-specific `imageDetail` metadata during target materialization.

**Architecture:** Keep the canonical model invocation and raw Responses passthrough unchanged. In the OpenAI Responses adapter, clone only messages and file parts whose valid `providerOptions.openai.imageDetail` must be removed for a non-Responses target, preserving ordinary images, tool-result images, unrelated provider options, and object identity for untouched branches. Emit the existing sanitized degradation warning for each removed field before image preflight runs.

**Tech Stack:** TypeScript, Bun test runner, AI SDK model-message types, Changesets.

## Global Constraints

- Raw OpenAI Responses passthrough remains byte-preserving, including `detail`.
- `ProviderProtocol.OpenAIResponse` target materialization preserves `providerOptions.openai.imageDetail`.
- Non-Responses targets remove only a valid OpenAI `imageDetail` from ordinary and tool-result image file parts.
- Existing compatibility failures for provider references and unsupported assistant/tool image shapes remain unchanged.
- Warnings use `warnOpenAIResponsesDegradation('image_detail', path, 'dropped')` and never include image URL or base64 content.
- The user-visible patch Changeset targets both `@aio-proxy/core` and `aio-proxy`.

---

### Task 1: Protect target-specific image-detail behavior

**Files:**
- Modify: `packages/core/src/protocol/openai-responses-basic.test.ts`
- Modify: `packages/core/src/protocol/openai-responses.ts`
- Modify: `packages/server/src/routes/pipeline/target-materialization.test.ts`
- Modify: `packages/server/src/routes/token-count/token-count-target-materialization.test.ts`

**Interfaces:**
- Consumes: `openAIResponsesAdapter.modelInvocation()` and `modelInvocationForTarget(invocation, targetProtocol, supportedEfforts)`.
- Produces: private `portableImageDetailMessages(messages: readonly ModelMessage[]): readonly ModelMessage[]`, `portableImageDetailPart(part: ModelMessagePart, path: string): ModelMessagePart`, `isCurrentFilePart<T>(part: T): part is Extract<T, { type: 'file' }>`, and `withoutOpenAIImageDetail<T extends FilePart>(part: T, path: string): T` collaborators inside `openai-responses.ts`.

- [ ] **Step 1: Write the failing ordinary-image target-materialization test**

Add a behavior test that parses an actual Responses request containing a base64 `input_image` with `detail: 'high'`, materializes it for Anthropic, and expects this literal file part:

```typescript
{
  type: 'file',
  mediaType: 'image/png',
  data: { type: 'data', data: 'AA==' },
  providerOptions: { openai: { retained: 'sentinel' }, custom: { retained: true } },
}
```

Before materialization, extend the generated part's provider options with the two literal sentinel values. Assert that the original invocation still has `imageDetail: 'high'`, while the Anthropic result does not. Spy on `console.warn` and assert the sanitized literal arguments:

```typescript
expect(warn).toHaveBeenCalledWith(
  '[aio-proxy] OpenAI Responses model conversion degraded',
  'image_detail',
  'messages.0.content.0.providerOptions.openai.imageDetail',
  'dropped',
);
```

- [ ] **Step 2: Write the failing tool-result and same-protocol tests**

Parse a Responses request with a `function_call` followed by a `function_call_output` whose output contains a detailed base64 image. Assert that Anthropic materialization preserves the `aioProxy.toolImage` marker and image bytes but removes `openai.imageDetail`. Separately assert that `ProviderProtocol.OpenAIResponse` materialization preserves `imageDetail: 'high'` for the ordinary image.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-basic.test.ts
```

Expected: the new Anthropic assertions fail because the current adapter returns file parts with `providerOptions.openai.imageDetail` intact.

- [ ] **Step 4: Implement the minimal target-specific degradation**

Import `FilePart` and `openAIImageDetail`, then materialize non-Responses messages before returning:

```typescript
const messages = portableImageDetailMessages(clamped.messages);
if (targetProtocol !== ProviderProtocol.OpenAIResponse) {
  return messages === clamped.messages ? clamped : { ...clamped, messages };
}
```

`portableImageDetailMessages` walks non-string message content. It calls `withoutOpenAIImageDetail` for image file parts and for file parts inside `tool-result` outputs of type `content`, using the canonical paths asserted by the tests. It returns untouched objects when no valid detail is present.

`withoutOpenAIImageDetail` must:

```typescript
if (openAIImageDetail(part) === undefined) return part;
warnOpenAIResponsesDegradation('image_detail', `${path}.providerOptions.openai.imageDetail`, 'dropped');
const openaiOptions = part.providerOptions?.['openai'] as Record<string, unknown>;
const { imageDetail: _imageDetail, ...remainingOpenAIOptions } = openaiOptions;
return {
  ...part,
  providerOptions: {
    ...part.providerOptions,
    openai: remainingOpenAIOptions,
  },
};
```

The OpenAI Responses branch continues to pass the original clamped messages into `openAIResponsesMessages`, so same-protocol metadata is preserved.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
rtk bun test packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/image-input/image-input.test.ts packages/core/src/transform/openai-responses/images.test.ts packages/server/src/routes/pipeline/target-materialization.test.ts packages/server/src/routes/token-count/token-count-target-materialization.test.ts
```

Expected: all focused tests pass. The two server target-materialization tests assert that the Anthropic candidate receives the image without detail and is invoked before a later Responses candidate.

- [ ] **Step 6: Review the mutation coverage**

Confirm the tests fail for each realistic regression: returning `clamped` unchanged for Anthropic, stripping all OpenAI options, mutating the original invocation, failing to traverse tool-result output, or stripping detail from the OpenAI Responses target.

- [ ] **Step 7: Commit the implementation task**

```bash
rtk git add packages/core/src/protocol/openai-responses-basic.test.ts packages/core/src/protocol/openai-responses.ts packages/server/src/routes/pipeline/target-materialization.test.ts packages/server/src/routes/token-count/token-count-target-materialization.test.ts
rtk git commit -m "fix(core): degrade image detail across protocols" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Publish and verify the fix

**Files:**
- Create: `.changeset/quiet-images-travel.md`

**Interfaces:**
- Consumes: the target-specific degradation implemented in Task 1.
- Produces: patch release notes for `@aio-proxy/core` and `aio-proxy`.

- [ ] **Step 1: Add the patch Changeset**

Create `.changeset/quiet-images-travel.md` with this exact package scope and user-facing note:

```markdown
---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Allow OpenAI Responses requests with image detail hints to fall back across provider protocols.
```

- [ ] **Step 2: Run full repository verification**

Run:

```bash
rtk bun run preflight
```

Expected: oxlint, oxfmt check, and all unit tests exit successfully.

- [ ] **Step 3: Inspect the final diff and whitespace**

Run:

```bash
rtk git diff --check HEAD
rtk git status --short
```

Expected: no whitespace errors; only the Changeset remains uncommitted after Task 1's commit, apart from the pre-existing untracked `.reference` symlink and the design/plan documents if they were intentionally left outside the implementation commit.

- [ ] **Step 4: Commit release metadata and planning documents**

```bash
rtk git add .changeset/quiet-images-travel.md docs/superpowers/specs/2026-08-05-cross-protocol-image-detail-degradation-design.md docs/superpowers/plans/2026-08-05-cross-protocol-image-detail-degradation.md
rtk git commit -m "docs: release image detail fallback fix" -m "Co-authored-by: Codex <noreply@openai.com>"
```
