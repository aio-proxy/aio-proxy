# CLI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the `aio-proxy` CLI around single-daemon conventions — rename `serve`→`run`, add `status`/`reload`/`service`/`config`/`doctor`/`completion`, remove `provider install`, and back it with a loopback-only admin endpoint plus a real `/health` version and exit-code contract.

**Architecture:** The CLI (commander, `packages/cli`) gains flat lifecycle verbs (`run`/`reload`/`status`) and `noun verb` subtrees (`service`/`config`/`plugin`/`provider`). Control actions that the config watcher does not cover call a new unauthenticated, loopback-only `POST /admin/reload` on the server (mounted before the dashboard CSRF/auth middlewares), reusing the existing `state.reload()`. All user-facing strings are paraglide messages in `@aio-proxy/i18n`.

**Tech Stack:** Bun, TypeScript, commander 15, Hono (server), paraglide-js (i18n), `bun test`.

## Global Constraints

- Runtime is Bun; prefer Bun APIs when Bun provides the capability. Reference: https://bun.com/llms.txt
- Prefer `es-toolkit` (narrow imports like `es-toolkit/array`) over hand-written generic utilities; keep trivial native JS. Reference: https://es-toolkit.dev/llms.txt
- Colocate new unit tests next to source in a same-name directory: `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`. Do NOT add files to legacy `__tests__/` dirs.
- Handwritten non-test implementation files: 300-line hard limit; evaluate splitting at 240.
- Every user-facing string is a paraglide message key in `packages/i18n/messages/{en,zh-Hans}.json`; after editing JSON run `bun run --filter @aio-proxy/i18n build` to regenerate `m.*`. Both locales must define every key.
- Domain language: "Provider ID" (config `providers` key), "Provider weight". Never "provider name/key/order/rank".
- Before done: `bun run preflight` (oxlint + oxfmt check + all unit tests), or at minimum `bun run check` plus affected package tests.
- Commit message footer: `Co-authored-by: Codex <noreply@openai.com>`.
- Branch already isolated in worktree `.worktrees/cli-redesign-spec` on `codex/cli-redesign-spec`.

**Spec:** `docs/superpowers/specs/2026-07-30-cli-redesign-design.md`

---

## File Structure

- `packages/cli/src/main.ts` — command registration; grows a `run`/`reload`/`status` block, a `service` subtree, a `config` subtree, `doctor`/`completion`; loses `serve`, `provider install`, and the `model`/`trace`/`dashboard` stubs' bad exit code. Watch the 300-line limit — extract action handlers into sibling files.
- `packages/cli/src/exit.ts` (new) — exit-code taxonomy + a `CliExit` error and `toExitCode()`.
- `packages/cli/src/status/` (new) — `index.ts`, `status.ts`, `status.test.ts`: hit `/health` and (deep) the providers endpoint.
- `packages/cli/src/reload/` (new) — `index.ts`, `reload.ts`, `reload.test.ts`: POST `/admin/reload`.
- `packages/cli/src/service/` (new) — `index.ts`, `service.ts`, unit templates, `service.test.ts`: generate launchd/systemd units and wrap launchctl/systemctl.
- `packages/cli/src/config-cmd/` (new) — `index.ts`, `config-cmd.ts`, `config-cmd.test.ts`: `show`/`edit`/`validate`/`path`.
- `packages/server/src/server/server.ts` — mount `POST /admin/reload` before dashboard middlewares; make `/health` emit the real version.
- `packages/server/src/server/health/` (new, optional split) — version injection helper if `server.ts` nears its limit.
- `packages/core/src/paths/paths.ts` + `paths/index.ts` + `core/src/index.ts` — remove `pidPath`/`logPath`.
- `packages/i18n/messages/{en,zh-Hans}.json` — new/renamed keys.

---

## Task 1: Rename `serve` → `run`

**Files:**
- Modify: `packages/cli/src/main.ts` (command block, `serve()`→`run()`, `ServeOptions`→`RunOptions`)
- Modify: `packages/i18n/messages/en.json`, `packages/i18n/messages/zh-Hans.json` (`cli_serve_*`→`cli_run_*`; `cli_dashboard_not_yet_implemented` example text)
- Modify: `packages/cli/package.json` (`serve:dev` and `start` script bodies use `run`)
- Modify: `packages/cli/__tests__/cli-test-helpers.ts` (`cliServeArgs`→`cliRunArgs`, `'serve'`→`'run'`)
- Modify: `packages/cli/src/main.test.ts`, `packages/cli/src/main.dev.test.ts`, `packages/i18n/__tests__/resolve-locale.test.ts`, `packages/i18n/__tests__/compile-output.smoke.ts`
- Modify: `npm/aio-proxy/README.md`

**Interfaces:**
- Produces: top-level command `run` with `--host`/`--port`/`--open`; message keys `cli_run_description`, `cli_run_option_host_description`, `cli_run_option_port_description`, `cli_run_option_open_description`, `cli_run_started`.

- [ ] **Step 1: Rename the i18n keys in both locales**

In `packages/i18n/messages/en.json` and `zh-Hans.json`, rename `cli_serve_description`, `cli_serve_option_host_description`, `cli_serve_option_port_description`, `cli_serve_option_open_description`, `cli_serve_started` to the `cli_run_*` equivalents (keep values). In both, change the `cli_dashboard_not_yet_implemented` value's example from `aio-proxy serve --open` to `aio-proxy run --open`.

- [ ] **Step 2: Regenerate paraglide messages**

Run: `bun run --filter @aio-proxy/i18n build`
Expected: PASS; `packages/i18n/src/paraglide/messages/cli_run_*` now exist, no `cli_serve_*`.

- [ ] **Step 3: Update the failing test expectation first**

In `packages/cli/__tests__/cli-test-helpers.ts` rename `cliServeArgs`→`cliRunArgs` and its `'serve'` literal to `'run'`. In `packages/cli/src/main.test.ts` there are **three** `serve` literals plus the helper spawn — update the import (`cliServeArgs`→`cliRunArgs`), `runCli(['serve', '--port', ...])` at line 53, `runCli(['serve', '--help'])` at line 105, the `cliRunArgs(port)` spawn at line 70 (renamed via the helper), and the two test titles at lines 43/103 mentioning `serve`. In `main.dev.test.ts` change the spawn arg `'serve'`→`'run'`. In `resolve-locale.test.ts` change `['serve', ...]`→`['run', ...]`. In `compile-output.smoke.ts` change `m.cli_serve_description`→`m.cli_run_description`. Grep-gate before done: `rg -n "'serve'|cliServeArgs" packages/cli` must return nothing.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test packages/cli/src/main.test.ts`
Expected: FAIL — `main.ts` still registers `serve`, `m.cli_run_*` unused.

- [ ] **Step 5: Rename in main.ts**

In `packages/cli/src/main.ts`: `type ServeOptions`→`type RunOptions`; `const serve = (deps) => async (options: ServeOptions)`→`const run = (deps) => async (options: RunOptions)`; `m.cli_serve_started`→`m.cli_run_started`; the `.command('serve')` block → `.command('run')` with `m.cli_run_*` descriptions and `.action(run(deps))`. Leave `Bun.serve(...)` untouched (runtime API, unrelated).

- [ ] **Step 6: Update package.json script bodies**

In `packages/cli/package.json`, change the `serve:dev` command body `... src/main.dev.ts serve ...`→`... src/main.dev.ts run ...` and `start` `bun src/main.ts serve`→`bun src/main.ts run`. Keep the turbo task key `serve:dev` as-is (build task name, not a CLI verb). Update `npm/aio-proxy/README.md` occurrences of `aio-proxy serve`→`aio-proxy run`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test packages/cli/src/main.test.ts packages/cli/src/main.dev.test.ts packages/i18n/__tests__/resolve-locale.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli packages/i18n npm/aio-proxy/README.md
git commit -m "refactor(cli): rename serve command to run" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 2: Server — loopback admin `POST /admin/reload` + real `/health` version

**Files:**
- Modify: `packages/server/src/server/server.ts` (add route before dashboard middlewares; inject version into `/health`)
- Test: `packages/server/src/server/admin-reload.test.ts` (colocated)

**Interfaces:**
- Consumes: `state.reload()` → `{ ok: true, diff } | { ok: false, error, stage }` (already used by `/dashboard/api/reload`).
- Produces: `POST /admin/reload` (loopback-only, no CSRF, no password) returning `200 {ok:true,diff}` or `409 {ok:false,error,stage}`; `GET /health` returning `{ status, uptime, version }` where `version` is the real package version passed into `createServer`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/server/admin-reload.test.ts`. Use the existing loopback test helper pattern (see `server-config.test.ts` for how it builds an app + `loopbackServer`). Assert:

```ts
// /admin/reload is reachable WITHOUT an Origin header or auth cookie.
// The point is "no CSRF/auth gate", not reload success — so assert it is
// neither 404 (unmounted) nor 403 (CSRF) nor 401 (auth). Use an empty
// { providers: {} } config in the fixture so reload also yields ok:true.
const res = await app.request('/admin/reload', { method: 'POST' }, loopbackServer);
expect([200, 409]).toContain(res.status);
expect(res.status).not.toBe(403);
expect(res.status).not.toBe(401);
expect(res.status).not.toBe(404);
// /health reports the injected version, not '0.0.0'
const health = await (await app.request('/health', undefined, loopbackServer)).json();
expect(health.version).toBe('9.9.9-test');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/server/admin-reload.test.ts`
Expected: FAIL — `/admin/reload` is 404; `/health` version is `'0.0.0'`.

- [ ] **Step 3: Thread a version into createServer and /health**

In `packages/server/src/server/server.ts`: add `readonly version?: string` to `CreateServerOptions`; pass it through to `createRoutes`; change the `/health` handler's `version: '0.0.0'` to `version: version ?? '0.0.0'`. In `createRoutes` add a `version` parameter with default `'0.0.0'`.

- [ ] **Step 4: Mount /admin/reload before the dashboard middlewares**

In `createRoutes`, immediately after the `/health` and `/v1/models` routes and BEFORE the `app.use('/dashboard', requireDashboardLoopback)` lines, add:

```ts
app.use('/admin/*', requireDashboardLoopback);
app.post('/admin/reload', async (context) => {
  const result = await state.reload();
  return result.ok
    ? context.json({ ok: true, diff: result.diff })
    : context.json({ ok: false, error: result.error, stage: result.stage }, 409);
});
```

This reuses `requireDashboardLoopback` (loopback guard) but is not under `/dashboard/api/*`, so it has no CSRF/origin or password gate.

- [ ] **Step 5: Pass the real version from the CLI boot path**

In `packages/cli/src/boot-proxy-server/boot-proxy-server.ts`, thread a `version` through `CreateServerOptions` (add to the options it forwards to `createServer`). In `packages/cli/src/main.ts` `run()`, pass `version: VERSION` into `bootProxyServer({...})`. Add `version` to `bootProxyServer`'s option type.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/server/src/server/admin-reload.test.ts`
Expected: PASS.

- [ ] **Step 7: Guard against regressions in existing server tests**

Run: `bun test packages/server/src/server`
Expected: PASS (existing `/health` and dashboard tests unaffected; `version` default keeps them green).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/server packages/cli/src/boot-proxy-server packages/cli/src/main.ts
git commit -m "feat(server): add loopback POST /admin/reload and real /health version" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 3: CLI `reload` command

**Files:**
- Create: `packages/cli/src/reload/index.ts`, `packages/cli/src/reload/reload.ts`, `packages/cli/src/reload/reload.test.ts`
- Modify: `packages/cli/src/main.ts` (register `reload`)
- Modify: `packages/i18n/messages/{en,zh-Hans}.json` (`cli_reload_description`, `cli_reload_failed`)

**Interfaces:**
- Consumes: `POST /admin/reload` from Task 2.
- Produces: `export async function reloadCommand(options: { host?: string; port?: string }): Promise<void>`; top-level command `reload` with `--host`/`--port`.

- [ ] **Step 1: Add i18n keys and regenerate**

Add `cli_reload_description` ("Reload configuration in the running server.") and `cli_reload_failed` ("Reload failed: {error}") to both locales, then run `bun run --filter @aio-proxy/i18n build`.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/reload/reload.test.ts`. Start a local `Bun.serve` that records the hit path and returns `{ok:true,diff:{}}`, point `reloadCommand` at its port, assert it POSTs `/admin/reload` and resolves; then a second case returning `409 {ok:false,error:'boom',stage:'validate'}` asserts it throws/prints the failure.

```ts
import { expect, test } from 'bun:test';
import { reloadCommand } from './reload';

test('reload posts /admin/reload', async () => {
  let hit = '';
  const server = Bun.serve({ port: 0, fetch: (r) => { hit = new URL(r.url).pathname; return Response.json({ ok: true, diff: {} }); } });
  await reloadCommand({ port: String(server.port) });
  expect(hit).toBe('/admin/reload');
  server.stop(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/src/reload/reload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement reload.ts and index.ts**

`reload.ts`: build `http://${host??'127.0.0.1'}:${port??9317}/admin/reload`, `fetch` POST with a 5s `AbortSignal.timeout`, parse JSON; on `ok:false` or non-2xx throw an error carrying `m.cli_reload_failed({error})`. `index.ts`: `export { reloadCommand } from './reload';`.

- [ ] **Step 5: Register in main.ts**

Add `program.command('reload').description(m.cli_reload_description()).option('--host <host>').option('--port <port>').action(reloadCommand);` and import from `./reload`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/cli/src/reload/reload.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/reload packages/cli/src/main.ts packages/i18n
git commit -m "feat(cli): add reload command hitting /admin/reload" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 4: CLI `status` command (shallow + `--deep`)

**Files:**
- Create: `packages/cli/src/status/index.ts`, `packages/cli/src/status/status.ts`, `packages/cli/src/status/status.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/i18n/messages/{en,zh-Hans}.json` (`cli_status_description`, `cli_status_option_deep_description`, `cli_status_not_running`)

**Interfaces:**
- Consumes: `GET /health` (from Task 2) → `{ status, uptime, version }`; for `--deep`, `GET /dashboard/api/providers?probe=true`.
- **Design decision (not deferred):** `--deep` reads provider health from the password-gated `/dashboard/api/providers?probe=true`. When a dashboard password is set this returns 401, so `--deep` ships as **best-effort/password-limited by design** for this milestone: on 401 it prints a clear one-line note and still returns the shallow result. A loopback-exempt `/admin/providers` endpoint (parallel to `/admin/reload`) is the follow-up that removes this limit; it is intentionally out of scope here. This is a conscious, stated exception to the "never route the CLI through `/dashboard/api/*`" rule, made because the data is read-only and the shallow path already covers liveness.
- Produces: `export async function statusCommand(options: { host?: string; port?: string; deep?: boolean; json?: boolean }): Promise<void>`; top-level `status` with `--deep`/`--json`.

- [ ] **Step 1: Add i18n keys and regenerate**

Add `cli_status_description`, `cli_status_option_deep_description`, `cli_status_not_running` to both locales; run the i18n build.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/status/status.test.ts`. Case A: a local server returns `/health` `{status:'ok',uptime:1,version:'1.2.3'}`; capture stdout via a `print` dependency and assert it reports running + version. Case B: point at a closed port and assert it reports not-running (exit code mapped in Task 6; here assert it throws a typed "not running" error).

```ts
import { expect, test } from 'bun:test';
import { statusCommand } from './status';

test('status reports running + version from /health', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: 'ok', uptime: 1, version: '1.2.3' }) });
  const lines: string[] = [];
  await statusCommand({ port: String(server.port) }, (l) => lines.push(l));
  expect(lines.join('\n')).toContain('1.2.3');
  server.stop(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/src/status/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement status.ts and index.ts**

`statusCommand(options, print = console.log)`: GET `/health` with a short timeout; on connect failure print `m.cli_status_not_running()` and signal not-running. On success print status/port/version. If `options.deep`, additionally GET `/dashboard/api/providers?probe=true`; if it returns 401, print a note that a dashboard password blocks deep probing on this build (documented limitation from the spec's Control Plane). With `--json`, print a single JSON object instead. `index.ts` re-exports.

- [ ] **Step 5: Register in main.ts**

`program.command('status').description(m.cli_status_description()).option('--deep', m.cli_status_option_deep_description()).option('--json').option('--host <host>').option('--port <port>').action((o) => statusCommand(o));`

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/cli/src/status/status.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/status packages/cli/src/main.ts packages/i18n
git commit -m "feat(cli): add status command (shallow + --deep)" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 5: `config` subtree (`show` / `edit` / `validate` / `path`)

**Files:**
- Create: `packages/cli/src/config-cmd/index.ts`, `config-cmd.ts`, `config-cmd.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/server/src/index.ts` (export `redactSecrets` from the package barrel — see Interfaces)
- Modify: `packages/i18n/messages/{en,zh-Hans}.json` (`cli_config_description`, `cli_config_show_description`, `cli_config_edit_description`, `cli_config_validate_description`, `cli_config_path_description`, `cli_config_invalid`)

**Interfaces:**
- Consumes: `configPath()`, `parseRuntimeConfig` (from `@aio-proxy/core`); `redactSecrets` (from `@aio-proxy/server`); `$EDITOR` env.
- **Verified gap:** `redactSecrets` is **not** on the `@aio-proxy/server` package barrel today (`packages/server/src/index.ts` exports only `createServer`/`serverDefaults`/types). It lives at `dashboard-routes/config.ts` (re-exported from `provider-secrets`). So `import { redactSecrets } from '@aio-proxy/server'` will NOT resolve until Step 2 below adds the export. Do not import via a deep cross-package path.
- Produces: `configShow(opts)`, `configEdit()`, `configValidate(path?)`, `configPathCmd()`; `config` command with the four subcommands. NO `set`/`get` (spec Open Question: `JSON.stringify` write path strips JSONC comments).

- [ ] **Step 1: Add i18n keys and regenerate**

Add the six `cli_config_*` keys to both locales; run the i18n build.

- [ ] **Step 2: Export `redactSecrets` from the server barrel**

In `packages/server/src/index.ts` add `export { redactSecrets } from './dashboard-routes/config';` (that module already re-exports it from `provider-secrets`). This makes `import { redactSecrets } from '@aio-proxy/server'` resolvable for the CLI. Quick check: `rg -n "redactSecrets" packages/server/src/index.ts` returns the new line.

- [ ] **Step 3: Write the failing test**

Create `packages/cli/src/config-cmd/config-cmd.test.ts`. Use a temp `AIO_PROXY_HOME` with a `config.jsonc` containing a comment and a secret-like field. Assert: `configValidate` resolves for valid config and throws `m.cli_config_invalid`-carrying error for malformed; `configShow` output redacts the secret; `configPathCmd` prints the resolved path.

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configValidate, configShow } from './config-cmd';

test('validate accepts valid config, show redacts secrets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-cfg-'));
  writeFileSync(join(home, 'config.jsonc'), '{ /* c */ server: { port: 9317, password: "s3cr3t" }, providers: {} }\n');
  const env = { ...process.env, AIO_PROXY_HOME: home };
  const lines: string[] = [];
  await configShow({}, (l) => lines.push(l), env);
  expect(lines.join('\n')).not.toContain('s3cr3t');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/cli/src/config-cmd/config-cmd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement config-cmd.ts**

`configShow(opts, print=console.log, env=process.env)`: resolve path via `configPath()` (respecting `AIO_PROXY_HOME`), read+parse, print `redactSecrets(config)` (JSON, 2-space). `configValidate(path?)`: read the file, `parseRuntimeConfig`; on failure throw an error carrying `m.cli_config_invalid`. `configEdit()`: spawn `$EDITOR` (fallback `vi`) on the config path via `Bun.spawn`, inheriting stdio; do NOT rewrite the file ourselves (comment-safe). `configPathCmd(print=console.log)`: print `configPath()`. `index.ts` re-exports all four.

- [ ] **Step 6: Register in main.ts**

```ts
const config = program.command('config').description(m.cli_config_description());
config.command('show').description(m.cli_config_show_description()).option('--json').action((o) => configShow(o));
config.command('edit').description(m.cli_config_edit_description()).action(() => configEdit());
config.command('validate [path]').description(m.cli_config_validate_description()).action((path) => configValidate(path));
config.command('path').description(m.cli_config_path_description()).action(() => configPathCmd());
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test packages/cli/src/config-cmd/config-cmd.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/config-cmd packages/cli/src/main.ts packages/server/src/index.ts packages/i18n
git commit -m "feat(cli): add config show/edit/validate/path (no set/get)" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 6: Exit-code contract

**Files:**
- Create: `packages/cli/src/exit/index.ts`, `exit.ts`, `exit.test.ts`
- Modify: `packages/cli/src/main.ts` (`main()` catch; remove stub `exitCode = 2`)

**Interfaces:**
- Produces: `export const EXIT = { ok: 0, unrecoverable: 1, transient: 2 } as const;` and `export class CliExit extends Error { constructor(readonly code: number, message: string) }`; `main()` maps `ServeListenError`/config errors → `1`, `CliExit` → its code, unknown → `2`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/exit/exit.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { EXIT, toExitCode, CliExit } from './exit';
import { ServeListenError } from '../errors';

test('port conflict is unrecoverable (1)', () => {
  expect(toExitCode(new ServeListenError('127.0.0.1', 9317))).toBe(EXIT.unrecoverable);
});
test('unknown error is transient (2)', () => {
  expect(toExitCode(new Error('boom'))).toBe(EXIT.transient);
});
test('CliExit carries its own code', () => {
  expect(toExitCode(new CliExit(EXIT.unrecoverable, 'bad config'))).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/exit/exit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement exit.ts**

Define `EXIT`, `CliExit`, and `toExitCode(err): number` — `CliExit`→`err.code`; `ServeListenError`/`ConfigWriteError`/`PortOutOfRangeError`→`EXIT.unrecoverable`; everything else→`EXIT.transient`. `index.ts` re-exports. Import origins (verified): `ServeListenError` from `../errors`; `ConfigWriteError` and `PortOutOfRangeError` from `@aio-proxy/i18n` (they are re-exported there, as in `main.ts`), NOT from `../errors`.

- [ ] **Step 4: Wire into main() and remove stub exit code**

In `main()` catch, replace `process.exitCode = 1` with `process.exitCode = toExitCode(err)`. Keep messages formatted via `formatCliError`. For the `dashboard` stub's `process.exitCode = 2`: **decide now** — convert it to `throw new CliExit(EXIT.unrecoverable, m.cli_dashboard_not_yet_implemented())` (exit 1). Then update the asserting test in lockstep: `packages/cli/src/main.rendering.test.ts` (the `runCli(['dashboard'])` case, ~lines 60-68) must change `expect(...exitCode).toBe(2)` to `toBe(1)` and still assert the "not yet implemented" message. `model`/`trace` stubs are handled in Task 9; this task only touches `dashboard` so the exit-code contract lands with a passing suite.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/cli/src/exit/exit.test.ts packages/cli/src/main.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/exit packages/cli/src/main.ts
git commit -m "feat(cli): exit-code contract (0 ok / 1 unrecoverable / 2 transient)" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 7: Remove `provider install` (fold into `plugin add`)

**Files:**
- Modify: `packages/cli/src/main.ts` (drop the `provider install` registration)
- Modify: `packages/cli/src/provider-commands.ts` (remove `providerInstall`, `ProviderInstallOptions`, `confirmInstall`; keep `providerList`/`providerTest`/`providerLogin`)
- Modify: `packages/core/src/error.ts` (`ProviderNotInstalledError` hint: `provider install` → `plugin add`)
- Modify: `packages/i18n/messages/{en,zh-Hans}.json` (remove `cli_provider_install_*` keys; fix `error_provider_not_installed` hint text)
- Modify (tests): `packages/cli/__tests__/provider-commands.test.ts`, `packages/cli/src/main.rendering.test.ts`, and the server missing-provider tests that assert the hint string
- Test: colocated where practical; legacy `__tests__` files are edited in place (do not add new files there)

**Interfaces:**
- Consumes: `plugin add` (already the full install flow).
- Produces: `provider` subtree without `install`; `ProviderNotInstalledError.hint` now reads `run aio-proxy plugin add <pkg>`.

**Note on the hint string (verified):** `packages/core/src/error.ts:52` hardcodes `run aio-proxy provider install ${packageName}` inside `ProviderNotInstalledError`, surfaced to API clients. `error_provider_not_installed` in both locales repeats it. Several server tests assert this hint (via the test harness's command-name substitution), e.g. `packages/server/__tests__/openai-responses-missing-provider.test.ts`, `gemini-missing-provider.test.ts`, `anthropic-messages-failures.validation.test.ts`, `openai-completions-boundaries.provider-missing.test.ts`, and `packages/core/src/provider/ai-sdk/ai-sdk-fetch-errors.test.ts`. Changing the verb requires updating all of them in this task.

- [ ] **Step 1: Find every reference (symbols AND CLI-string literals)**

Run both greps:
```bash
rg -n "providerInstall|provider_install|cli_provider_install" packages
rg -n "provider install|provider', 'install|provider\\b.*install" packages --glob '*.test.ts'
rg -n "provider install" packages/core/src/error.ts packages/i18n/messages
```
Expected: `main.ts`, `provider-commands.ts`, i18n JSON, `error.ts:52`, the two install tests in `provider-commands.test.ts` (lines ~64-100), the `provider install --help` case in `main.rendering.test.ts` (~line 14), and the server hint-asserting tests listed above.

- [ ] **Step 2: Update the hint and its asserting tests (write the failing expectation first)**

Change `packages/core/src/error.ts` `const hint = \`run aio-proxy provider install ${packageName}\`` to `const hint = \`run aio-proxy plugin add ${packageName}\``. Update `error_provider_not_installed` in both locales to say `plugin add`. Update each server test that asserts the hint substring to expect `plugin add` instead of `provider install` (the harness substitutes the command name, so match its existing pattern rather than a literal).

- [ ] **Step 3: Rewrite the CLI-string tests that exercise `provider install`**

In `packages/cli/__tests__/provider-commands.test.ts` delete the two tests `'provider install reports a failed explicit install'` and `'provider install requires explicit confirmation before installing'` (~lines 64-100); keep the `provider list --installed` test. In `packages/cli/src/main.rendering.test.ts` remove the `provider install --help` line (~line 14) and its assertions, and add one assertion that `runCli(['provider', 'install', 'x']).stderr` reports an unknown command (commander error), proving removal.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test packages/cli/src/main.rendering.test.ts packages/cli/__tests__/provider-commands.test.ts`
Expected: FAIL — `provider install` still registered / hint still says `provider install`.

- [ ] **Step 5: Remove the command and dead code**

Delete the `.command('install <package>')` block under `provider` in `main.ts` and the `providerInstall` import. In `provider-commands.ts` delete `providerInstall`, `ProviderInstallOptions`, `confirmInstall`, and the now-unused `npmAdd`/`confirm` imports. Remove `cli_provider_install_description`, `cli_provider_install_option_yes_description`, `cli_provider_install_option_registry_description` from both locales; run `bun run --filter @aio-proxy/i18n build`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/cli packages/server/__tests__ packages/core/src/provider/ai-sdk`
Expected: PASS. Also re-run the Step 1 greps and confirm no `provider install` literals remain outside historical docs.

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/core packages/i18n packages/server
git commit -m "refactor(cli): remove provider install; installation is plugin add" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 8: Remove dead `pidPath`/`logPath` helpers

**Files:**
- Modify: `packages/core/src/paths/paths.ts` (delete `pidPath`, `logPath`)
- Modify: `packages/core/src/paths/index.ts` and `packages/core/src/index.ts` (drop from re-exports)
- Modify: `packages/core/src/paths/paths.test.ts` (drop their assertions if present)

**Interfaces:**
- Produces: `paths` module without `pidPath`/`logPath`.

- [ ] **Step 1: Confirm no runtime users**

Run: `rg -n "pidPath|logPath" packages --glob '!**/paths/**'`
Expected: only the two re-export lines in `paths/index.ts` and `core/src/index.ts` (no real callers). If any real caller appears, STOP and report — do not delete.

- [ ] **Step 2: Delete the functions and exports**

Remove `pidPath` and `logPath` function bodies from `paths.ts`; remove them from the `export { ... } from './paths'` line in `paths/index.ts` and the `export { ... } from './paths/index'` line in `core/src/index.ts`. Also delete their assertions in `packages/core/src/paths/paths.test.ts` (both `pidPath` and `logPath` blocks are present today — delete them, not conditional).

- [ ] **Step 3: Run tests + typecheck to verify nothing breaks**

Run: `bun test packages/core/src/paths/paths.test.ts && bun run --filter @aio-proxy/core check`
Expected: PASS; no unresolved `pidPath`/`logPath` references.

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "chore(core): remove unused pidPath/logPath helpers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 9: `service` subtree + `doctor` + `completion`

**Files:**
- Create: `packages/cli/src/service/index.ts`, `service.ts`, `unit-templates.ts`, `service.test.ts`
- Modify: `packages/cli/src/main.ts` (register `service`, `doctor`, `completion`; drop `model`/`trace` stubs or keep as documented placeholders per maintainer call)
- Modify: `packages/i18n/messages/{en,zh-Hans}.json` (service/doctor/completion keys)

**Interfaces:**
- Consumes: `configPath()`, the resolved `aio-proxy` binary path (`process.execPath` + entry, or the installed bin), `EXIT`/`CliExit` from Task 6.
- Produces: `service install|uninstall|start|stop|restart|status`; `doctor`; `completion <shell>`. Unit generation: `renderLaunchdPlist(opts)` and `renderSystemdUnit(opts)` returning strings with `ExecStart`/`ProgramArguments` pointing at `aio-proxy run`, `Restart=on-failure`, and `RestartPreventExitStatus=1` (systemd) so exit 1 (Task 6) is honored.

- [ ] **Step 1: Add i18n keys and regenerate**

Add `cli_service_description`, `cli_service_install_description`, `cli_service_install_option_user_description`, `cli_service_install_option_system_description`, `cli_service_uninstall_description`, `cli_service_start_description`, `cli_service_stop_description`, `cli_service_restart_description`, `cli_service_status_description`, `cli_doctor_description`, `cli_completion_description` to both locales; run the i18n build.

- [ ] **Step 2: Write the failing test for unit rendering (pure, platform-independent)**

Create `packages/cli/src/service/service.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { renderSystemdUnit, renderLaunchdPlist } from './service';

test('systemd unit runs `run`, restarts on failure, skips exit 1', () => {
  const unit = renderSystemdUnit({ exec: '/usr/local/bin/aio-proxy', configPath: '/home/u/.aio-proxy/config.jsonc' });
  expect(unit).toContain('ExecStart=/usr/local/bin/aio-proxy run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartPreventExitStatus=1');
});

test('launchd plist runs `run` and keeps alive except on clean exit', () => {
  const plist = renderLaunchdPlist({ exec: '/usr/local/bin/aio-proxy', configPath: '/Users/u/.aio-proxy/config.jsonc' });
  expect(plist).toContain('<string>run</string>');
  expect(plist).toContain('SuccessfulExit');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/src/service/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement unit-templates.ts + service.ts**

`unit-templates.ts`: `renderSystemdUnit({exec,configPath})` → a `[Unit]/[Service]/[Install]` string with `ExecStart=<exec> run`, `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=1`, `WantedBy=default.target`. `renderLaunchdPlist({exec,configPath})` → a plist with `ProgramArguments` = `[<exec>, run]`, `KeepAlive` dict `{ SuccessfulExit: false }`, `RunAtLoad: true`. `service.ts`: `serviceInstall({user,system})` writes the unit to the platform path (`~/Library/LaunchAgents/…plist` on darwin, `~/.config/systemd/user/aio-proxy.service` on linux) and prints the enable/load command; `serviceStart/Stop/Restart/Status/Uninstall` shell out via `Bun.spawn` to `launchctl`/`systemctl --user`. On unsupported platforms throw `CliExit(EXIT.unrecoverable, ...)`. `index.ts` re-exports. Keep each file <300 lines (split templates from control logic — they already are).

- [ ] **Step 5: Register service/doctor/completion in main.ts**

Add the `service` command with its six subcommands wired to the handlers; `doctor` (initial impl: print resolved config path, whether the port is reachable via the same `/health` probe as `status`, and installed plugin count) ; `completion <shell>` using commander's help or a static bash/zsh/fish script. Remove the `program.command('model')` / `program.command('trace')` stubs (or leave with a clear "not yet implemented" message — maintainer's call; default: remove to avoid empty commands).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/cli/src/service/service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/service packages/cli/src/main.ts packages/i18n
git commit -m "feat(cli): add service subtree, doctor, completion" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Final Verification

- [ ] **Step 1: Full preflight**

Run: `bun run preflight`
Expected: oxlint + oxfmt check clean; all unit tests pass.

- [ ] **Step 2: Manual smoke of the new surface**

```bash
bun run packages/cli/src/main.ts --help        # shows run/reload/status/service/config/plugin/provider/doctor/completion
bun run packages/cli/src/main.ts run --help     # run exists; serve does not
bun run packages/cli/src/main.ts config path
```
Expected: help lists the new tree; `serve` and `provider install` are gone.

- [ ] **Step 3: Commit any formatting fixups**

```bash
git add -A && git commit -m "chore: preflight fixups for cli redesign" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Notes / Deferred

- **Deep `status` auth:** `--deep` reads from the password-gated `/dashboard/api/providers?probe=true` and ships as **best-effort/password-limited by design** (stated in Task 4, not deferred). The follow-up that fully removes the limit is a loopback-exempt `/admin/providers` endpoint parallel to `/admin/reload` (spec Control Plane, decision 2) — intentionally out of scope for this plan.
- **`config set`/`get`:** intentionally out of scope until a comment-preserving serializer (`jsonc-parser`) replaces the `JSON.stringify` write path (spec Open Question).
- **`server.logging` file sink removal:** spec delta #8, deliberately NOT in this plan (breaking config-surface change; schedule separately).
