# Dashboard Rstest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace dashboard Bun tests with Rstest and colocate every test with its primary source module.

**Architecture:** Configure Rstest only inside `packages/dashboard`, using the existing React plugin plus happy-dom and Testing Library. Migrate pure tests mechanically to `@rstest/core` and Node filesystem APIs, while replacing the sidebar preference source-inspection test with a rendered interaction test.

**Tech Stack:** Rstest, Rsbuild React plugin, React 19, Testing Library, jest-dom, happy-dom, Bun workspace.

## Global Constraints

- Dashboard tests use Rstest; other workspace packages retain their current runners.
- Tests use `*.test.ts` or `*.test.tsx` beside the primary source file.
- `packages/dashboard/_test` is removed.
- Dashboard tests do not import `bun:test` or use `Bun.file`/`Bun.Glob`.
- No Rsbuild adapter or extra test abstraction is introduced.

---

### Task 1: Configure Rstest and migrate existing dashboard tests

**Files:**
- Create: `packages/dashboard/rstest.config.ts`
- Create: `packages/dashboard/rstest.setup.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `bun.lock`
- Move: `packages/dashboard/_test/alias-editor.test.ts` → `packages/dashboard/src/modules/providers/alias-editor.test.ts`
- Move: `packages/dashboard/_test/data-table-pagination.test.ts` → `packages/dashboard/src/components/data-table-pagination/pagination-items.test.ts`
- Move: `packages/dashboard/_test/delete-provider-dialog-component.test.ts` → `packages/dashboard/src/modules/providers/components/delete-provider-dialog.test.tsx`
- Move: `packages/dashboard/_test/json-editor.test.ts` → `packages/dashboard/src/components/json-editor/json-editor-state.test.ts`
- Move: `packages/dashboard/_test/provider-alias-component.test.ts` → `packages/dashboard/src/modules/providers/components/provider-alias/provider-alias-drawer.test.tsx`
- Move: `packages/dashboard/_test/provider-options-editor.test.ts` → `packages/dashboard/src/modules/providers/components/provider-options-editor.test.ts`
- Move: `packages/dashboard/_test/usage-overview.test.ts` → `packages/dashboard/src/modules/usage/templates/usage-overview.test.ts`

**Interfaces:**
- Consumes: Rstest `defineConfig`, `describe`, `expect`, `test`, `afterEach`; existing React plugin.
- Produces: `bun run --cwd packages/dashboard test:unit` executing colocated Rstest files.

- [ ] **Step 1: Install the package-scoped test dependencies**

Run:

```bash
rtk bun add --cwd packages/dashboard -d @rstest/core @testing-library/react @testing-library/jest-dom happy-dom
```

Expected: dashboard `devDependencies` and `bun.lock` contain the four packages.

- [ ] **Step 2: Add the minimal Rstest configuration**

Create `rstest.config.ts`:

```ts
import { pluginReact } from "@rsbuild/plugin-react";
import { defineConfig } from "@rstest/core";

export default defineConfig({
  plugins: [pluginReact()],
  setupFiles: ["./rstest.setup.ts"],
  testEnvironment: "happy-dom",
});
```

Create `rstest.setup.ts`:

```ts
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "@rstest/core";

expect.extend(jestDomMatchers);
afterEach(cleanup);
```

Change `test:unit` in `packages/dashboard/package.json` to `rstest run`.

- [ ] **Step 3: Run Rstest and verify the unmigrated suite fails**

Run: `rtk bun run --cwd packages/dashboard test:unit`

Expected: FAIL because existing tests still import `bun:test` and use Bun-only filesystem APIs.

- [ ] **Step 4: Move tests beside their primary modules and migrate runtime APIs**

For every moved test:

```ts
import { describe, expect, test } from "@rstest/core";
```

Update relative source imports for the new colocated path. Replace source reads with:

```ts
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./target.tsx", import.meta.url), "utf8");
```

Replace `Bun.Glob` with `readdir` from `node:fs/promises` and filter filenames ending in `.tsx`. Preserve all existing assertions while changing only runner and filesystem integration.

- [ ] **Step 5: Run the migrated suite and verify GREEN**

Run: `rtk bun run --cwd packages/dashboard test:unit`

Expected: all migrated tests except the sidebar preference test pass under Rstest.

---

### Task 2: Replace sidebar source inspection with a colocated component test

**Files:**
- Delete: `packages/dashboard/_test/sidebar-preferences.test.ts`
- Create: `packages/dashboard/src/components/side-menu/sidebar-preferences.test.tsx`
- Modify: `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx` only if accessibility or dependency injection is required by the rendered test.

**Interfaces:**
- Consumes: `SidebarPreferences`, Testing Library `render`, `screen`, `fireEvent`, Rstest `rs.mock` and `expect`.
- Produces: behavioral coverage for appearance and language selection.

- [ ] **Step 1: Write the rendered interaction test**

Mock `next-themes` and `@aio-proxy/i18n`, render `SidebarPreferences`, then assert:

```tsx
expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Language" })).toBeInTheDocument();
```

Open the appearance menu and select Dark, expecting `setTheme("dark")`. Open the language menu and select Simplified Chinese, expecting `setLocale("zh-Hans")` and a page reload request. Use real Base UI menu interactions rather than source strings.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk bun run --cwd packages/dashboard test:unit -- sidebar-preferences.test.tsx`

Expected: FAIL until mocks, browser reload handling, or component accessibility are correctly wired.

- [ ] **Step 3: Make the minimum component adjustment required by the test**

Keep production behavior unchanged. If `window.location.reload` cannot be spied on in happy-dom, extract only this boundary:

```ts
export const reloadDashboard = () => window.location.reload();
```

Mock that exported boundary in the test; do not add a settings context or new state layer.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
rtk bun run --cwd packages/dashboard test:unit -- sidebar-preferences.test.tsx
rtk bun run --cwd packages/dashboard test:unit
```

Expected: focused test and full dashboard suite pass.

- [ ] **Step 5: Verify migration invariants and build**

Run:

```bash
rtk rg -n 'bun:test|Bun\\.(file|Glob)' packages/dashboard
rtk rg --files packages/dashboard | rtk rg '^packages/dashboard/_test/'
rtk bunx biome check packages/dashboard package.json bun.lock
rtk bun run --cwd packages/dashboard build
```

Expected: both ripgrep checks return no matches, Biome passes, and dashboard build exits 0.

- [ ] **Step 6: Commit and update the existing PR**

```bash
git add packages/dashboard bun.lock docs/superpowers
git commit -m "test(dashboard): migrate unit tests to Rstest" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
git push
```
