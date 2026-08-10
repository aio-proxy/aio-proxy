# PR #102 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the confirmed PR #102 review findings, restore green CI, and remove dead transform-evaluator state without expanding V1 scope.

**Architecture:** Keep request transforms Provider ID-scoped and fetch-layer-owned. Make OAuth runtime cache identity include request transforms, select JSON editing when a valid transform cannot be represented visually, preserve the controlled JSON acknowledgement contract, and reduce schema/evaluator code without adding new engines or response transforms.

**Tech Stack:** Bun, TypeScript, Zod, React 19, Rstest/Testing Library, Mingo, GitHub Actions.

## Global Constraints

- Preserve CPA-aligned sequential request-header/request-body semantics.
- Do not add response transforms, scripts, FFI, WASM, native engines, or a Dashboard Mingo bundle.
- Keep tests behavior-oriented and colocated; do not add static line-count unit tests.
- Keep handwritten non-test implementation files at or below 300 lines.
- Run every repository shell command through `rtk`.
- Do not reply to or resolve GitHub review threads without explicit user authorization.

---

### Task 1: Rebuild cached OAuth runtimes when transforms change

**Files:**
- Modify: `packages/server/src/plugin-runtime/identity.test.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`

**Interfaces:**
- Consumes: `OAuthProvider.transforms`, `digest(value)`, and `runtimeIdentity(value)`.
- Produces: an identity that changes with `config.transforms?.request` while routing-only changes still reuse the runtime.

- [x] **Step 1: Write the failing test**

Add a test that materializes with a request transform, reuses the same transform, then changes the transform. Assert `createCalls()` is `2`, the unchanged provider is reused, and the changed provider is rebuilt.

- [x] **Step 2: Verify RED**

Run `rtk bun test packages/server/src/plugin-runtime/identity.test.ts`. Expected: the changed transform still reuses the first runtime.

- [x] **Step 3: Implement the identity input**

Add this field to the existing runtime identity object:

```ts
requestTransformsDigest: digest(config.transforms?.request ?? []),
```

- [x] **Step 4: Verify GREEN**

Run the same focused test. Expected: all identity tests pass.

---

### Task 2: Fall back to JSON for valid transforms unsupported by the visual codec

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.tsx`

**Interfaces:**
- Consumes: `parseRequestTransformStages` and `parseRequestTransformCondition` as visual capability checks.
- Produces: default JSON mode and a disabled Visual tab for valid but visually unsupported rules.

- [x] **Step 1: Write the failing fallback test**

Render this valid value without manually selecting JSON:

```ts
[{ update: [{ $set: { 'request.body.options': { retries: 2 } } }] }]
```

Assert that the JSON textbox renders, Visual is disabled, the object is preserved, and no change is emitted.

- [x] **Step 2: Verify RED**

Run the focused editor test. Expected: render throws `Non-canonical request transform value`.

- [x] **Step 3: Implement a narrow compatibility guard**

Attempt condition and stage parsing for every rule inside a `try/catch`. Initialize to JSON when incompatible, switch an active visual editor to JSON if controlled input becomes incompatible, and block selecting Visual until compatible.

- [x] **Step 4: Verify GREEN**

Run `provider-request-transforms-editor.test.tsx`. Expected: the fallback and existing JSON tests pass.

---

### Task 3: Report controlled JSON acknowledgement as pending

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx`
- Modify: `packages/dashboard/src/components/json-editor/json-editor.tsx`

**Interfaces:**
- Consumes: `JsonEditorValueAcknowledgement` and `externalValuePending`.
- Produces: `onValidationChange` receives the same complete validation used by the rendered editor.

- [x] **Step 1: Write the failing controlled-value test**

Reuse the existing Monaco boundary in `provider-request-transforms-editor.test.tsx` and render the real `JsonEditor` without a schema. Emit a new JSON value, call the acknowledgement callback, rerender with the old controlled value, and assert `{ valid: false, pending: true }` is reported before rollback completes.

- [x] **Step 2: Verify RED**

Run the focused provider transform editor test. Expected: the callback only receives `draftValidation`, so pending is absent.

- [x] **Step 3: Publish complete validation**

Memoize `validation` from `draftValidation` and `externalValuePending`, then make the validation effect publish `validation` and depend on it.

- [x] **Step 4: Verify GREEN**

Run the focused provider transform editor test.

---

### Task 4: Reduce provider schema and evaluator dead state

**Files:**
- Modify: `packages/types/src/provider-alias.ts`
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/server/src/provider-request-transform/compile.ts`
- Modify: `packages/server/src/provider-request-transform/compile.test.ts`
- Modify: `packages/server/src/provider-request-transform/evaluate.ts`
- Modify: `packages/server/src/provider-request-transform/evaluate.test.ts`

**Interfaces:**
- Produces: alias normalization owned by `provider-alias.ts`; `provider.ts` below 300 lines.
- Produces: per-rule/per-stage lazy body metadata without unused aggregate/result fields.

- [x] **Step 1: Verify structural RED**

Run `rtk wc -l packages/types/src/provider.ts`. Expected: `303`.

- [x] **Step 2: Move alias normalization to its domain module**

Add generic `normalizeProviderAliasKeys` and `normalizeProviderAlias` functions to `provider-alias.ts`; import them from `provider.ts` and remove the local implementations.

- [x] **Step 3: Verify provider behavior and line count**

Run provider alias/config tests and `wc -l`. Expected: tests pass and `provider.ts` is below 300 lines.

- [x] **Step 4: Remove dead evaluator surface**

Delete `CompiledProviderRequestTransforms.readsBody` and `ProviderRequestTransformResult.bodyLoaded`. Make `ensureBody` return `Promise<void>` and set the private local flag after loading.

- [x] **Step 5: Preserve behavior assertions**

Remove assertions that inspect the deleted fields. Keep assertions proving lazy loading through `loadBody` calls and transformed request/body results. Run focused compile/evaluate tests.

---

### Task 5: Stabilize CI and publish

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-visual-editor.test.tsx`
- Modify: `docs/superpowers/plans/2026-07-31-pr102-review-fixes.md`

**Interfaces:**
- Produces: a 10-second timeout on the long sequential Visual/JSON integration test only.

- [x] **Step 1: Set the focused timeout**

Pass `10_000` as the timeout for `edits ordered Set and Remove actions losslessly across Visual and JSON modes`.

- [x] **Step 2: Run focused tests**

Run server identity/transform tests, provider type tests, and both transform editor suites.

- [x] **Step 3: Run full verification**

Run `rtk bun run preflight`. Expected: no new lint warnings, formatting passes, and all test/artifact tasks succeed.

- [x] **Step 4: Commit and push**

Commit as `fix: address provider transform review findings` with `Co-authored-by: Codex <noreply@openai.com>`, then push the current branch. Do not reply to or resolve review threads.
