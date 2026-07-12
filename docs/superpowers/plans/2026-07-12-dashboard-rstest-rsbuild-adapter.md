# Dashboard Rstest Rsbuild Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard Rstest inherit the existing Rsbuild configuration through the official adapter.

**Architecture:** Install `@rstest/adapter-rsbuild` in the dashboard package and replace the duplicated React plugin declaration with `extends: withRsbuildConfig()`. Keep only happy-dom and setup files in Rstest's own config.

**Tech Stack:** Rstest 0.11, Rsbuild 2, @rstest/adapter-rsbuild, Bun workspace.

## Global Constraints

- `rsbuild.config.ts` is the source of build plugins and aliases.
- `rstest.config.ts` contains only adapter extension and test-specific options.
- Existing tests and production configuration behavior remain unchanged.

---

### Task 1: Adopt the official Rsbuild adapter

**Files:**
- Create: `packages/dashboard/rstest.config.test.ts`
- Modify: `packages/dashboard/rstest.config.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `withRsbuildConfig(): RstestConfig` from `@rstest/adapter-rsbuild`.
- Produces: Rstest configuration extending dashboard's existing `rsbuild.config.ts`.

- [ ] **Step 1: Write the failing configuration test**

```ts
import { readFile } from "node:fs/promises";
import { expect, test } from "@rstest/core";

test("reuses the dashboard Rsbuild configuration", async () => {
  const source = await readFile(new URL("./rstest.config.ts", import.meta.url), "utf8");
  expect(source).toContain('from "@rstest/adapter-rsbuild"');
  expect(source).toContain("extends: withRsbuildConfig()");
  expect(source).not.toContain("pluginReact(");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk bun x rstest rstest.config.test.ts` from `packages/dashboard`.

Expected: FAIL because the current config imports and calls `pluginReact()`.

- [ ] **Step 3: Install and configure the adapter**

Run:

```bash
rtk bun add --cwd packages/dashboard -d @rstest/adapter-rsbuild
```

Replace `rstest.config.ts` with:

```ts
import { withRsbuildConfig } from "@rstest/adapter-rsbuild";
import { defineConfig } from "@rstest/core";

export default defineConfig({
  extends: withRsbuildConfig(),
  setupFiles: ["./rstest.setup.ts"],
  testEnvironment: "happy-dom",
});
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
rtk bun x rstest rstest.config.test.ts
rtk bun run --cwd packages/dashboard test:unit
rtk bun run test:unit --filter=@aio-proxy/dashboard
```

Expected: config test passes; full dashboard suite passes with 78 tests; Turbo dispatch passes.

- [ ] **Step 5: Run formatting and build verification**

Run:

```bash
rtk bunx biome check packages/dashboard package.json bun.lock
rtk bun run --cwd packages/dashboard build
rtk git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit and update the PR**

```bash
git add packages/dashboard bun.lock docs/superpowers
git commit -m "test(dashboard): reuse Rsbuild config in Rstest" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
git push
```
