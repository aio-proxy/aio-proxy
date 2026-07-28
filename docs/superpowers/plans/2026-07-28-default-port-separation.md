# Default Port Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `9317` the end-user default port while the root local-development command injects `22078` into the CLI and Dashboard proxy.

**Architecture:** Keep the user default as local literals in the existing CLI, schema, and server boundaries; do not add a shared cross-package constant. Inject the development-only port once through `AIO_PROXY_PORT` at the root `dev` command and let Turbo pass it to both persistent tasks.

**Tech Stack:** Bun, TypeScript, Zod, Turborepo, Rsbuild, Bun test.

## Global Constraints

- End-user defaults are exactly `9317`.
- Root local development continues to use exactly `22078`.
- Existing user configuration files are not migrated or rewritten.
- Explicit `--port` values continue to override the default.
- Historical plans/specifications and fixed request-Origin test fixtures remain unchanged.
- Do not add a cross-package port constant or a unit test that merely restates package-script text.
- The baseline `preflight` already fails in unrelated type-aware lint paths; this task must introduce no new failures and must pass the focused tests, normal `check`, CLI unit tests, and Dashboard build.

---

### Task 1: Change end-user defaults to 9317

**Files:**
- Modify: `packages/cli/__tests__/bootstrap-schema.test.ts`
- Modify: `packages/types/src/config/config-acceptance.test-support.ts`
- Modify: `packages/server/src/server/server-config.test.ts`
- Modify: `packages/cli/src/main.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/types/src/config/config.ts`
- Modify: `packages/server/src/server/server.ts`
- Regenerate: `npm/aio-proxy/config.schema.json`

**Interfaces:**
- Consumes: existing `readOrBootstrapConfig`, `ConfigSchema`, `serverDefaults`, and CLI `--port` behavior.
- Produces: generated configurations, omitted-port CLI launches, schema parsing, server defaults, and provider commands defaulting to port `9317`.

- [ ] **Step 1: Write failing behavior assertions**

Update the bootstrap test to assert the generated value:

```ts
const parsed = JSON.parse(raw) as { $schema?: string; server?: { port?: number } };
expect(parsed.server?.port).toBe(9_317);
```

Change the expected schema output fixture and server default assertion:

```ts
export const defaultServer = {
  host: '127.0.0.1',
  port: 9_317,
  logging: { enabled: false, retentionDays: 14, level: 'info' },
} as const;
```

```ts
expect(serverDefaults).toEqual({ host: '127.0.0.1', port: 9_317 });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk bun test packages/cli/__tests__/bootstrap-schema.test.ts packages/types/src/config/config-acceptance.test.ts packages/server/src/server/server-config.test.ts
```

Expected: failures show generated/config/server defaults are still `22078`.

- [ ] **Step 3: Apply the minimal production changes**

Change only the existing defaults:

```ts
server: { port: 9_317 },
```

```ts
port: z.number().int().min(1).max(65_535).default(9_317).describe('HTTP port for the proxy API server.'),
```

```ts
export const serverDefaults = {
  host: '127.0.0.1',
  port: 9_317,
} as const;
```

```ts
const defaultDashboardUrl = 'http://127.0.0.1:9317';
```

Update the stale negative assertion in `packages/cli/src/main.test.ts` from `22078` to `9317`; leave explicit dynamic ports and unrelated fixed Origin fixtures alone.

- [ ] **Step 4: Regenerate the published JSON schema**

Run:

```bash
rtk bun run --filter aio-proxy prepack
```

Expected: `npm/aio-proxy/config.schema.json` contains `"default": 9317` for `server.port`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
rtk bun test packages/cli/__tests__/bootstrap-schema.test.ts packages/cli/src/main.test.ts packages/types/src/config/config-acceptance.test.ts packages/server/src/server/server-config.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the user-default change**

```bash
rtk git add packages/cli/__tests__/bootstrap-schema.test.ts packages/cli/src/main.test.ts packages/cli/src/main.ts packages/cli/src/provider-commands.ts packages/types/src/config/config-acceptance.test-support.ts packages/types/src/config/config.ts packages/server/src/server/server-config.test.ts packages/server/src/server/server.ts npm/aio-proxy/config.schema.json
rtk git commit -m "feat: change default port to 9317" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Inject the local development port

**Files:**
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/dashboard/rsbuild.config.ts`

**Interfaces:**
- Consumes: root `bun run dev`, Turbo `dev`/`serve:dev` tasks, CLI `--port`, and Rsbuild proxy configuration.
- Produces: `AIO_PROXY_PORT=22078` shared by the local CLI server and Dashboard proxy.

- [ ] **Step 1: Verify the Dashboard proxy currently ignores injected ports**

Run:

```bash
AIO_PROXY_PORT=24567 rtk bun -e 'const { default: config } = await import("./packages/dashboard/rsbuild.config.ts"); console.log(config.server?.proxy?.["/dashboard/api"]?.target)'
```

Expected: prints `http://127.0.0.1:22078`, demonstrating the missing injection behavior.

- [ ] **Step 2: Inject and pass the development port**

Change the root command:

```json
"dev": "bun run dev:prepare && AIO_PROXY_PORT=22078 turbo run dev serve:dev --filter=!@aio-proxy/infra"
```

Declare the environment dependency on both Turbo tasks:

```json
"dev": {
  "persistent": true,
  "cache": false,
  "env": ["AIO_PROXY_PORT"],
  "outputs": []
},
"serve:dev": {
  "persistent": true,
  "cache": false,
  "env": ["AIO_PROXY_PORT"],
  "outputs": []
}
```

Pass it through the CLI startup command:

```json
"serve:dev": "AIO_PROXY_HOME=../../.aio-proxy-dev bun --watch src/main.dev.ts serve --port $AIO_PROXY_PORT"
```

Use the same value in Rsbuild, falling back to the user default when the root development command is not running:

```ts
const apiUrl = `http://127.0.0.1:${process.env.AIO_PROXY_PORT ?? '9317'}`;
```

Use `apiUrl` for both the proxy `target` and `Origin` header.

- [ ] **Step 3: Verify the injected Dashboard proxy value**

Run:

```bash
AIO_PROXY_PORT=24567 rtk bun -e 'const { default: config } = await import("./packages/dashboard/rsbuild.config.ts"); const proxy = config.server?.proxy?.["/dashboard/api"]; console.log(proxy?.target, proxy?.on?.proxyReq !== undefined)'
```

Expected: prints `http://127.0.0.1:24567 true`.

- [ ] **Step 4: Run the development-entry and repository checks**

Run:

```bash
rtk bun test packages/cli/src/main.dev.test.ts
rtk bun run check
rtk bun run --filter @aio-proxy/cli test:unit
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all commands pass without warnings or errors.

- [ ] **Step 5: Run full preflight**

Run:

```bash
rtk bun run preflight
```

Expected: type-aware lint, formatting check, and all tests pass.

If the unchanged baseline type-aware lint errors recur, confirm there are no new errors in the changed files and record the baseline limitation instead of expanding scope.

- [ ] **Step 6: Commit the development injection change**

```bash
rtk git add package.json turbo.json packages/cli/package.json packages/dashboard/rsbuild.config.ts
rtk git commit -m "chore: inject local development port" -m "Co-authored-by: Codex <noreply@openai.com>"
```
