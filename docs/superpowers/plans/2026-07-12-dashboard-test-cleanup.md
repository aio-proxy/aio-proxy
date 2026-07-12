# Dashboard Test Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete dashboard tests that inspect source text or AST structure, leaving only executable behavior tests.

**Architecture:** Remove two source-only test files and trim mixed suites to their pure-function or rendered-interaction assertions. Delete all filesystem and TypeScript-parser helpers that exist only for implementation inspection.

**Tech Stack:** Rstest, React Testing Library, TypeScript.

## Global Constraints

- No production code changes.
- No replacement tests added merely to preserve test count.
- Remaining tests call behavior directly or interact with rendered UI.
- Dashboard tests must not read product `.ts`/`.tsx` files or parse their AST.

---

### Task 1: Delete source-structure assertions

**Files:**
- Delete: `packages/dashboard/src/modules/providers/components/delete-provider-dialog.test.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-alias/provider-alias-drawer.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-options-editor.test.ts`
- Modify: `packages/dashboard/src/components/json-editor/json-editor-state.test.ts`
- Modify: `packages/dashboard/src/modules/usage/templates/usage-overview.test.ts`

**Interfaces:**
- Preserves: all pure function, state transition, service, formatting, atom, and rendered component assertions.
- Removes: `readFile`, `readFileSync`, `existsSync`, path traversal, TypeScript AST helpers, and their tests.

- [ ] **Step 1: Remove source-only test files**

Delete the delete-dialog wiring test and provider-alias drawer implementation test. Neither executes a component or exported behavior.

- [ ] **Step 2: Trim mixed provider and JSON suites**

In `provider-options-editor.test.ts`, delete:

- `wires schema workflow, package commit events, and the JSON editor`
- `ai-sdk pages start with Save blocked until options validity reports`
- the two source-string expectations at the start of `initial package synchronization checks without authorizing trusted auto-install`, while retaining its state-transition assertions

Remove the now-unused `readFile` import.

In `json-editor-state.test.ts`, retain the direct `setCodeEditorAriaInvalid` assertions in the final test, delete all subsequent source reads/assertions, make the test synchronous, and remove `readFile`.

- [ ] **Step 3: Reduce usage overview to behavior tests**

Keep only:

- `keys cache and polling by all selected controls`
- `stores all overview filters in one Jotai atom`
- `preserves meaningful USD precision without compacting cost`
- `formats token and request metrics as compact integers`

Delete every other test and remove Node filesystem/path imports, TypeScript import, `dashboardRoot`, and all AST helper functions.

- [ ] **Step 4: Verify no source-inspection machinery remains**

Run:

```bash
rtk rg -n 'readFile|readFileSync|createSourceFile|toContain\(' packages/dashboard/src --glob '*.test.ts' --glob '*.test.tsx'
```

Expected: no matches. (`toContain` is intentionally absent from current legitimate dashboard behavior tests.)

- [ ] **Step 5: Run full validation**

Run:

```bash
rtk bun run --cwd packages/dashboard test:unit
rtk bun run test:unit --filter=@aio-proxy/dashboard
rtk bunx biome check packages/dashboard
rtk bun run --cwd packages/dashboard build
rtk git diff --check
```

Expected: all remaining tests, Turbo tasks, Biome, and build pass.

- [ ] **Step 6: Commit and update the PR**

```bash
git add packages/dashboard docs/superpowers
git commit -m "test(dashboard): remove source-inspection tests" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
git push
```
