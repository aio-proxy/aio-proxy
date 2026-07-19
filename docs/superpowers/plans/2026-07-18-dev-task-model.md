# Development Task Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun run dev` start a deterministic full-stack development environment without overlapping a package's one-shot build and watcher.

**Architecture:** Build the artifact-first core dependency chain once, then launch long-running Rslib, Paraglide, Rsbuild, and Bun tasks without build dependencies. The CLI development entry uses the existing dependency seam to point developers at the Rsbuild Dashboard while production entries retain same-origin static assets.

**Tech Stack:** Bun 1.3+, Turborepo 2.10, Rslib 0.23, Rsbuild 2.1, Rspack 2.1, TypeScript 6, Bun test.

## Global Constraints

- Follow `AGENTS.md` and `packages/dashboard/AGENTS.md`.
- Add no dependencies.
- Keep `build` one-shot, `dev` compiler/generator/HMR-only, and `serve:dev` runtime-only.
- Use port `22078` for the API and strict port `3000` for the Dashboard development server.
- Keep production binary and embedded Dashboard behavior unchanged.
- Keep tests next to their source; when modifying a module with legacy `_test` coverage, move that coverage next to the source.
- Keep every handwritten code and test file under 300 lines.
- Run commands from the repository root.
- Design reference: `docs/superpowers/specs/2026-07-18-dev-task-model-design.md`.

## File map

- `packages/types/package.json`: expose the complete types package from `dist`.
- `packages/types/src/package-export.test.ts`: lock the root export to the built entry.
- `packages/cli/src/dashboard-assets.ts`: define static and Dashboard-URL dependencies for CLI adapters.
- `packages/cli/src/main.ts`: consume the injected Dashboard URL.
- `packages/cli/src/main.dev.ts`: development adapter with no static assets and the Rsbuild URL.
- `packages/cli/src/main.dev.test.ts`: exercise the real development entry.
- `packages/cli/src/main.test.ts`: colocated move of legacy CLI coverage.
- `packages/cli/src/dashboard-assets.test.ts`: colocated move of asset-adapter coverage.
- `packages/cli/package.json`: run the development entry with Bun watch.
- `packages/plugin-sdk/package.json`: add its Rslib watcher.
- `packages/plugins/github-copilot/package.json`: add its Rslib watcher.
- `packages/plugins/openai-chatgpt/package.json`: add its Rslib watcher.
- `packages/dashboard/rsbuild.config.ts`: make the Dashboard development URL stable.
- `package.json`: add the preparation phase and explicit persistent-task launch.
- `turbo.json`: remove build dependencies and the virtual CLI sidecar task from persistent tasks.

---

### Task 1: Make `@aio-proxy/types` artifact-first

**Files:**

- Modify: `packages/types/package.json:6-9`
- Create: `packages/types/src/package-export.test.ts`

**Interfaces:**

- Consumes: Rslib outputs `packages/types/dist/index.js`, `index.d.ts`, and `config.schema.json`.
- Produces: `@aio-proxy/types` root export resolving to `dist/index.js`; JSON Schema export remains `dist/config.schema.json`.

- [ ] **Step 1: Write the failing package-export test**

Create `packages/types/src/package-export.test.ts`:

```ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("package root resolves to the built entry", () => {
  const resolved = fileURLToPath(import.meta.resolve("@aio-proxy/types"));
  expect(resolved).toEndWith(join("packages", "types", "dist", "index.js"));
});
```

- [ ] **Step 2: Run the test and verify the current source export fails**

Run:

```bash
bun test packages/types/src/package-export.test.ts
```

Expected: FAIL because the resolved path ends in `packages/types/src/index.ts`.

- [ ] **Step 3: Point the root export at Rslib outputs**

Replace the root export in `packages/types/package.json`:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  },
  "./config.schema.json": "./dist/config.schema.json"
}
```

- [ ] **Step 4: Build and verify all package artifacts**

Run:

```bash
bun run --filter @aio-proxy/types build
bun test packages/types/src/package-export.test.ts
bun -e 'await import("@aio-proxy/types"); const schema = await Bun.file(import.meta.resolve("@aio-proxy/types/config.schema.json")).json(); if (schema.type !== "object") process.exit(1)'
```

Expected: build succeeds, the test passes, and the JSON Schema check exits 0.

- [ ] **Step 5: Commit the artifact interface**

```bash
git add packages/types/package.json packages/types/src/package-export.test.ts
git commit -m "build(types): export generated artifacts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Add an explicit CLI development Dashboard adapter

**Files:**

- Modify: `packages/cli/src/dashboard-assets.ts:6-27`
- Modify: `packages/cli/src/main.ts:118-143`
- Create: `packages/cli/src/main.dev.ts`
- Create: `packages/cli/src/main.dev.test.ts`
- Move: `packages/cli/_test/cli.test.ts` to `packages/cli/src/main.test.ts`
- Move: `packages/cli/_test/dashboard-assets.test.ts` to `packages/cli/src/dashboard-assets.test.ts`

**Interfaces:**

- Consumes: `main(deps: CliDeps)`, `DashboardAssets`, and compiled-entry asset maps.
- Produces: optional `CliDeps.dashboardUrl` and `developmentCliDeps` for `http://127.0.0.1:3000/dashboard/`.

- [ ] **Step 1: Move legacy tests next to the modules they cover**

Use `apply_patch` moves, then change only these imports:

`packages/cli/src/main.test.ts`:

```ts
import packageJson from "../package.json" with { type: "json" };
import { cliServeArgs, freePort, output, repoCwd, runCli, waitForOk } from "../_test/cli-test-helpers";
import { formatCliError } from "./main";
import { LoopbackPortUnavailableError } from "./plugin-commands/loopback";
import { ProviderCapabilityNotFoundError } from "./plugin-commands/provider-login";
```

`packages/cli/src/dashboard-assets.test.ts`:

```ts
import { devDashboardStaticDir, embeddedDashboardAssets } from "./dashboard-assets";
```

- [ ] **Step 2: Add the failing development-entry test**

Create `packages/cli/src/main.dev.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, repoCwd, waitForOk } from "../_test/cli-test-helpers";

test("development entry advertises the Rsbuild Dashboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-cli-dev-"));
  const port = freePort();
  const child = Bun.spawn(
    [process.execPath, "run", "packages/cli/src/main.dev.ts", "serve", "--port", String(port)],
    {
      cwd: repoCwd,
      env: { ...process.env, AIO_PROXY_HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    await waitForOk(`http://127.0.0.1:${port}/health`, {
      probeTimeoutMs: 1_000,
      readinessTimeoutMs: 5_000,
    });
    child.kill();
    await child.exited;
    expect(`${await stdout}${await stderr}`).toContain("http://127.0.0.1:3000/dashboard/");
  } finally {
    child.kill();
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
bun run build:dashboard
bun test --preload=packages/cli/_test/setup.ts \
  packages/cli/src/dashboard-assets.test.ts \
  packages/cli/src/main.dev.test.ts \
  packages/cli/src/main.test.ts
```

Expected: FAIL because `main.dev.ts` does not exist.

- [ ] **Step 4: Extend the CLI dependency seam**

Update `packages/cli/src/dashboard-assets.ts`:

```ts
export type CliDeps = {
  readonly dashboardAssets: () => DashboardAssets;
  readonly dashboardUrl?: (apiUrl: string) => string;
};
```

Keep `devDashboardStaticDir`, `embeddedDashboardAssets`, and `defaultCliDeps`
otherwise unchanged. Leaving `dashboardUrl` absent exercises the same-origin
fallback used by both the source default and generated compiled entry.

- [ ] **Step 5: Make `serve` use the injected URL consistently**

In `packages/cli/src/main.ts`, replace the hard-coded URL assignments with:

```ts
const apiUrl = `http://${host}:${port}`;
const dashboardUrl = deps.dashboardUrl?.(apiUrl) ?? `${apiUrl}/dashboard`;
```

and pass the same resolved value to the startup message:

```ts
m.cli_serve_started({
  apiUrl: `http://${server.hostname}:${server.port}`,
  dashboardUrl,
});
```

Keep config bootstrap and `openBrowser(dashboardUrl)` using that same variable.

- [ ] **Step 6: Add the source-only development adapter**

Create `packages/cli/src/main.dev.ts`:

```ts
import type { CliDeps } from "./dashboard-assets";
import { main } from "./main";

export const developmentCliDeps: CliDeps = {
  dashboardAssets: () => () => null,
  dashboardUrl: () => "http://127.0.0.1:3000/dashboard/",
};

if (import.meta.main) {
  await main(developmentCliDeps);
}
```

- [ ] **Step 7: Run focused CLI tests**

Run:

```bash
bun test --preload=packages/cli/_test/setup.ts \
  packages/cli/src/dashboard-assets.test.ts \
  packages/cli/src/main.dev.test.ts \
  packages/cli/src/main.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Verify the unchanged compiled-entry path**

Run:

```bash
bun run build:dashboard
bun test --preload=packages/cli/_test/setup.ts packages/cli/_test/generate-compiled-entry.test.ts
```

Expected: Dashboard assets exist and the unchanged compiled-entry generator tests pass.

- [ ] **Step 9: Commit the CLI adapters and test moves**

```bash
git add packages/cli/src packages/cli/_test
git commit -m "feat(cli): add dashboard development adapter" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Separate preparation from persistent development tasks

**Files:**

- Modify: `package.json:42-55`
- Modify: `turbo.json:43-56`
- Modify: `packages/cli/package.json:12-19`
- Modify: `packages/plugin-sdk/package.json:14-20`
- Modify: `packages/plugins/github-copilot/package.json:15-20`
- Modify: `packages/plugins/openai-chatgpt/package.json:15-20`
- Modify: `packages/dashboard/rsbuild.config.ts:31-43`

**Interfaces:**

- Consumes: package-local `build`, `dev`, and `serve:dev` scripts.
- Produces: root `dev:prepare`, root `dev`, stable Dashboard port 3000, and a persistent task graph containing no builds.

- [ ] **Step 1: Capture the current failing persistent task graph**

Run:

```bash
bunx turbo run dev serve:dev --filter='!@aio-proxy/infra' --dry=json \
  | jq -e '[.tasks[].taskId | select(endswith("#build"))] | length == 0'
```

Expected: jq exits 1 because the current `dev -> ^build` configuration includes build tasks.

- [ ] **Step 2: Add Rslib watchers to every artifact-first plugin package**

Add this script beside `build` in each of these package manifests:

- `packages/plugin-sdk/package.json`
- `packages/plugins/github-copilot/package.json`
- `packages/plugins/openai-chatgpt/package.json`

```json
"dev": "rslib --watch --no-clean"
```

- [ ] **Step 3: Make the CLI development runtime restart on imports changing**

Change `packages/cli/package.json`:

```json
"serve:dev": "AIO_PROXY_HOME=../../.aio-proxy-dev bun --watch src/main.dev.ts serve"
```

- [ ] **Step 4: Give the Dashboard a stable development URL**

Update the existing `server` object in `packages/dashboard/rsbuild.config.ts`:

```ts
server: {
  port: 3000,
  strictPort: true,
  proxy: {
    "/dashboard/api": {
      target: "http://127.0.0.1:22078",
      on: {
        proxyReq: (proxyReq) => {
          proxyReq.setHeader("Origin", "http://127.0.0.1:22078");
        },
      },
    },
  },
},
```

- [ ] **Step 5: Separate the root preparation and persistent phases**

Replace the root `dev` script and add `dev:prepare`:

```json
"dev:prepare": "turbo run build --filter=@aio-proxy/core",
"dev": "bun run dev:prepare && turbo run dev serve:dev --filter=!@aio-proxy/infra"
```

- [ ] **Step 6: Flatten the Turbo persistent task configuration**

Replace the three current dev-related task entries in `turbo.json` with:

```json
"dev": {
  "persistent": true,
  "cache": false,
  "outputs": []
},
"serve:dev": {
  "persistent": true,
  "cache": false,
  "outputs": []
}
```

Remove `@aio-proxy/cli#dev`, its `with` sidecar, and all persistent-task `dependsOn` fields.

- [ ] **Step 7: Verify the preparation build contains the required artifact packages**

Run:

```bash
bunx turbo run build --filter=@aio-proxy/core --dry=json | jq -e '
  [.tasks[].taskId] as $tasks
  | [
      "@aio-proxy/types#build",
      "@aio-proxy/plugin-sdk#build",
      "@aio-proxy/plugin-github-copilot#build",
      "@aio-proxy/plugin-openai-chatgpt#build",
      "@aio-proxy/core#build"
    ]
  | all(. as $task | $tasks | index($task) != null)
'
```

Expected: jq exits 0.

- [ ] **Step 8: Verify the persistent graph has no build tasks and has every watcher**

Run:

```bash
bunx turbo run dev serve:dev --filter='!@aio-proxy/infra' --dry=json | jq -e '
  [.tasks[] | select(.command != "<NONEXISTENT>") | .taskId] as $tasks
  | ([ $tasks[] | select(endswith("#build")) ] | length == 0)
    and ([
      "@aio-proxy/types#dev",
      "@aio-proxy/plugin-sdk#dev",
      "@aio-proxy/plugin-github-copilot#dev",
      "@aio-proxy/plugin-openai-chatgpt#dev",
      "@aio-proxy/core#dev",
      "@aio-proxy/i18n#dev",
      "@aio-proxy/dashboard#dev",
      "@aio-proxy/cli#serve:dev"
    ] | all(. as $task | $tasks | index($task) != null))
'
```

Expected: jq exits 0.

- [ ] **Step 9: Run static checks for all edited configuration**

Run:

```bash
bun run check
```

Expected: Biome exits 0.

- [ ] **Step 10: Commit the task graph**

```bash
git add package.json turbo.json packages/cli/package.json packages/plugin-sdk/package.json \
  packages/plugins/github-copilot/package.json packages/plugins/openai-chatgpt/package.json \
  packages/dashboard/rsbuild.config.ts
git commit -m "build(dev): separate prepare and watch tasks" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Verify full-stack startup and watch propagation

**Files:**

- No committed file changes.

**Interfaces:**

- Consumes: root `dev:prepare`, persistent Turbo graph, Bun watch, Rslib watch, Paraglide watch, and Rsbuild HMR.
- Produces: evidence that the original cache race is gone and development changes propagate.

- [ ] **Step 1: Build the deterministic development baseline**

Run:

```bash
bun run dev:prepare
```

Expected: the core dependency build completes without a Rspack lock panic.

- [ ] **Step 2: Start the full development environment**

Run in a persistent terminal:

```bash
bun run dev
```

Expected: API startup reports port 22078 and Dashboard startup reports
`http://127.0.0.1:3000/dashboard/`; no `#build` task starts after the preparation phase.

- [ ] **Step 3: Verify both HTTP endpoints**

Run from another terminal:

```bash
curl --fail http://127.0.0.1:22078/health
curl --fail http://127.0.0.1:3000/dashboard/
```

Expected: both commands exit 0.

- [ ] **Step 4: Verify artifact-first watchers and Bun restart**

For each file below, use `apply_patch` to temporarily append the exact export
shown, wait for its Rslib rebuild and the Bun process restart, then remove the
probe before continuing:

```text
packages/types/src/index.ts
export const __devWatchProbe = "types";

packages/plugin-sdk/src/index.ts
export const __devWatchProbe = "plugin-sdk";

packages/plugins/github-copilot/src/index.ts
export const __devWatchProbe = "github-copilot";

packages/plugins/openai-chatgpt/src/index.ts
export const __devWatchProbe = "openai-chatgpt";

packages/core/src/index.ts
export const __devWatchProbe = "core";
```

Expected for each file: its package watcher reports a successful rebuild and
the CLI startup message appears again. `git diff --check` must remain clean
after removing each probe.

- [ ] **Step 5: Verify source-oriented backend restart**

Use `apply_patch` to temporarily append this export to
`packages/server/src/index.ts`, wait for the Bun process to restart, then
remove it:

```ts
export const __devWatchProbe = "server";
```

Expected: Bun restarts without an Rslib build for `@aio-proxy/server`.

- [ ] **Step 6: Verify Paraglide and Dashboard live updates**

Use `apply_patch` to temporarily change this entry in
`packages/i18n/messages/en.json`:

```diff
-  "cli_root_description": "AIO Proxy command line interface.",
+  "cli_root_description": "AIO Proxy command line interface (dev watch probe).",
```

Verify Paraglide regenerates `packages/i18n/src/paraglide`, then revert the
message. Next, temporarily add this immediately before `DashboardRoute` in
`packages/dashboard/src/routes/index.tsx`:

```ts
const __devWatchProbe = "dashboard";
void __devWatchProbe;
```

Verify Rsbuild reports HMR without restarting the API, then remove both lines.

- [ ] **Step 7: Repeat full startup to target the original race**

Stop the development command cleanly. Start `bun run dev`, wait until both the
API and Dashboard are ready, inspect the log for `State lock mismatch` or a
Rust panic, then stop it with Ctrl-C. Repeat this complete start/readiness/stop
cycle three times.

Expected: all three full development starts reach readiness with no Rspack
state-lock mismatch and no Rust panic.

- [ ] **Step 8: Run repository verification**

Run:

```bash
bun run preflight
git status --short
```

Expected: preflight exits 0 and the worktree contains only the intended committed changes plus this plan document if it has not yet been committed.
