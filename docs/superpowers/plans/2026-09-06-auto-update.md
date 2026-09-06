# Automatic aio-proxy updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off `server.autoUpdate` Settings toggle and an Update now action so a managed aio-proxy service can install newer npm `latest` versions on startup and every 24 hours by calling the existing `aio-proxy upgrade` path.

**Architecture:** Persist `server.autoUpdate` through the existing Dashboard settings contract. CLI `run` injects `isManagedService` (marker or pre-marker) + `applyUpdate(version)` (`runUpgradeCommand` pinned) into `createServer`. Server owns an `AutoUpdateController` (single-flight lock, start/24h/notify ticks, apply) and the release HTTP surface. Server never imports CLI.

**Tech Stack:** TypeScript, Zod 4 in `@aio-proxy/types`, Hono typed RPC, Bun test (`packages/types`, `packages/server`, `packages/cli`), rstest + Testing Library (`packages/dashboard`), TanStack Form/Query, Paraglide i18n, Changesets.

**Spec:** `docs/superpowers/specs/2026-09-06-auto-update-design.md`

## Global Constraints

- Domain terms: Provider ID, provider priority, provider weight. Do not write "provider name", "order", or "rank".
- `@aio-proxy/server` must not import `@aio-proxy/cli`. Upgrade execution is an injected `applyUpdate` callback only.
- `server.autoUpdate` defaults to `false`. Omitted config means off. A Settings write persists the boolean explicitly.
- Auto-install (scheduler ticks) requires **all** of: toggle on, `isManagedService() === true` (**this process** is the managed daemon — marker or pre-marker fallback; not `isManagedServiceInstalled()` alone), npm `latest` newer than the process version. Manual `POST /release/apply` skips the toggle and managed-process gates.
- `applyUpdate(version)` installs **that** version and returns `'installed' | 'unchanged'`. It must not look up npm `latest` again. Resolve the target from the launched absolute path (Cellar → `{ command, bin }`; never `Bun.which`, never spawn bare `brew` on `PATH`). After brew, if `bin` version did not move, return `'unchanged'` and do not restart. Darwin in-job helper unloads after detach and does not wait for this PID. Agent post-upgrade uses `bin`. Interactive `aio-proxy upgrade` PATH lookup stays unchanged.
- Take the single-flight lock **before** `fetchLatest`. A second apply during a pending lookup returns `in_progress` and must not start a second `applyUpdate()`.
- When `applyUpdate(version)` fulfills `'installed'` and this process is still alive, set `restart_required`. When it fulfills `'unchanged'`, set `idle` (do not tell the operator to restart). When it throws, set `failed`.
- Follow npm `latest` for every newer version. No major/minor channel split. Interval is the constant `24 * 60 * 60 * 1000` ms. No interval/channel UI.
- Toggling `autoUpdate` never sets `restartRequired`. The controller reads live `state.currentConfig().server.autoUpdate`.
- Writing `autoUpdate: true` calls `notifyCheck()` once. `close()` must `stop()` the timer.
- User-facing copy goes through i18n in **all five** files `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`, then `bun run i18n:compile`. Keys are nested (`dashboard.settings.x`). `packages/i18n/__tests__/locale-parity.test.ts` fails on missing/extra keys or placeholder drift.
- Dashboard rules in `packages/dashboard/AGENTS.md` are authoritative: one `React.FC` per `.tsx`, `<Name>Props` interfaces, kebab-case filenames, TanStack Form for the Switch, no `fetch` outside `src/modules/<domain>/services/`.
- Colocated tests in same-name directories. Do not add files under `_test/`.
- Handwritten non-test implementation files stay under 500 lines; evaluate splitting at 400.
- Prefer `es-toolkit` narrow imports. Use `isPlainObject` from `es-toolkit/predicate` only for authored/parsed data.
- Every changeset targets `aio-proxy` **plus** every internal package actually touched, at the same bump level (`minor`). Never author a changeset that targets only internal packages.
- `bun run check` plus the affected package tests after each task. `bun run preflight` at the end of Task 6.

---

## File Structure

- `packages/types/src/config/config.ts` — `server.autoUpdate` boolean, default `false`.
- `packages/types/src/config/config-acceptance.test-support.ts` — `defaultServer.autoUpdate: false`.
- `packages/types/src/dashboard/control-plane/control-plane.ts` — settings + release Zod contracts.
- `packages/server/src/dashboard-routes/settings/settings.ts` — persist `autoUpdate`, `notifyCheck` on `true`.
- `packages/server/src/auto-update/` — controller (`index.ts` exports only, `auto-update.ts`, colocated test).
- `packages/server/src/dashboard-routes/release/release.ts` — GET fields + POST apply.
- `packages/server/src/dashboard-routes/config.ts` — pass controller into settings + release.
- `packages/server/src/server/server.ts` — create/start/stop controller; `CreateServerOptions.autoUpdate`.
- `packages/cli/src/run/run.ts` — inject managed-process probe + pinned-version `applyUpdate`; migrate pre-marker units on boot.
- `packages/cli/src/run/auto-update-hooks.ts` — `createCliAutoUpdateHooks()`, `isManagedAutoUpdateProcess()`, pre-marker unit rewrite.
- `packages/cli/src/service/unit-templates.ts` — `AIO_PROXY_MANAGED=1` on launchd/systemd units; optional `AIO_PROXY_UPGRADE_METHOD` when known (`brew` / `npm` / `bun` / `pnpm` only).
- `packages/cli/src/upgrade/detect.ts` — `resolveUpgradeTargetFrom(binPath)` and `resolveStableManagedExec`; Cellar → brew + stable launcher, never binary.
- `packages/cli/src/upgrade/constants.ts` — package-manager `UpgradeTarget` includes `command` and `bin`.
- `packages/cli/src/upgrade/methods.ts` — exec `target.command`, not the bare `brew` / `npm` / `bun` / `pnpm` name.
- `packages/cli/src/upgrade/agent-post-upgrade-process.ts` — `resolveNewAgentBinary` uses `target.bin`, not `Bun.which`.
- `packages/cli/src/upgrade/upgrade.ts` — accept pinned `version`, return `'installed' | 'unchanged'`; after brew, verify `target.bin` version moved.
- `packages/cli/src/service/service.ts` — Darwin in-job restart via detached unload+load.
- `packages/dashboard/src/modules/settings/components/settings-about-group/` — Switch + Update now.
- `packages/dashboard/src/modules/settings/services/release-service/` — apply mutation + typed GET.
- `packages/i18n/messages/*.json` — eight new `dashboard.settings` keys (including `version_restart_required`).
- `.changeset/auto-update-settings.md` — user-facing note targeting `aio-proxy` and touched packages.

---

### Task 1: Persist `server.autoUpdate` on config and settings

**Files:**

- Modify: `packages/types/src/config/config.ts`
- Modify: `packages/types/src/config/config.test.ts`
- Modify: `packages/types/src/config/config-acceptance.test-support.ts`
- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts`
- Modify: `packages/types/src/dashboard/control-plane/control-plane.test.ts`
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts`
- Modify: `packages/server/src/dashboard-routes/settings/settings.test.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts` (only if needed to thread an optional `notifyCheck`)
- Modify every `DashboardSettingsView` fixture so TypeScript still typechecks:
  - `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx`
  - `packages/dashboard/src/modules/settings/hooks/use-settings-mutation/use-settings-mutation.test.tsx`

**Interfaces:**

- Produces `ServerConfig.autoUpdate: boolean` (default `false`).
- Produces `DashboardSettingsView.autoUpdate: boolean` and optional `DashboardSettingsMutation.autoUpdate?: boolean`.
- Produces settings GET/PUT that persist the field with `restartRequired: false`.
- Consumes existing `createDashboardSettingsRoute(state)` plus an optional `notifyCheck?: () => void` argument. If you add the argument, default it so current callers compile.

- [ ] **Step 1: Write the failing config test**

Add to `packages/types/src/config/config.test.ts`:

```ts
test('defaults server.autoUpdate to false', () => {
  expect(ConfigSchema.parse({ server: {}, providers: {} }).server.autoUpdate).toBe(false);
});
test('accepts an explicit autoUpdate boolean', () => {
  expect(ConfigSchema.parse({ server: { autoUpdate: true }, providers: {} }).server.autoUpdate).toBe(true);
  expect(ConfigSchema.parse({ server: { autoUpdate: false }, providers: {} }).server.autoUpdate).toBe(false);
});
```

Add `autoUpdate: false` to `defaultServer` in `config-acceptance.test-support.ts`. Without it, `ConfigSchema.parse(...).toEqual({ server: defaultServer, ... })` fails after the field exists.

- [ ] **Step 2: Run the config tests and confirm they fail**

Run: `bun test packages/types/src/config/config.test.ts`
Expected: FAIL — `server.autoUpdate` is undefined.

- [ ] **Step 3: Add the config field**

In `ServerConfigSchema`:

```ts
autoUpdate: z
  .boolean()
  .default(false)
  .describe(
    'When true, a managed service installs newer npm latest versions on start and every 24 hours.',
  ),
```

Do not omit it from `ServerConfigAuthoringSchema`. The authoring omit list stays `{ host, logging, apiKeys }`.

- [ ] **Step 4: Re-run config tests**

Run: `bun test packages/types/src/config/config.test.ts packages/types/src/config/config-acceptance.test.ts packages/types/src/config/config-acceptance.mixed.test.ts packages/types/src/config/config-acceptance.oauth-aisdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing dashboard contract tests**

Extend the `settings` fixture in `control-plane.test.ts` with `autoUpdate: false`.

Add:

```ts
test('exposes autoUpdate on the settings view and accepts a boolean mutation', () => {
  const view = schema('DashboardSettingsViewSchema');
  const mutation = schema('DashboardSettingsMutationSchema');

  expect(view.parse(settings).autoUpdate).toBe(false);
  expect(view.safeParse({ ...settings, autoUpdate: 'yes' }).success).toBe(false);
  expect(mutation.parse({}).autoUpdate).toBeUndefined();
  expect(mutation.parse({ autoUpdate: true })).toEqual({ autoUpdate: true });
  expect(mutation.parse({ autoUpdate: false })).toEqual({ autoUpdate: false });
});
```

- [ ] **Step 6: Run the contract test and confirm it fails**

Run: `bun test packages/types/src/dashboard/control-plane/control-plane.test.ts`
Expected: FAIL — fixture missing `autoUpdate` and mutation rejects the field.

- [ ] **Step 7: Add the dashboard fields**

In `DashboardSettingsViewSchema`:

```ts
autoUpdate: required(ServerConfigSchema.shape.autoUpdate),
```

In `DashboardSettingsMutationSchema` inner object:

```ts
autoUpdate: required(ServerConfigSchema.shape.autoUpdate).optional(),
```

- [ ] **Step 8: Re-run the contract test**

Run: `bun test packages/types/src/dashboard/control-plane/control-plane.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing settings route tests**

`GET /settings returns only the redacted typed settings view` currently `toEqual`s a body without `autoUpdate`. After Step 10 that assertion must include `autoUpdate: false`. Add these new tests first so the write path is forced:

```ts
test('PUT /settings persists autoUpdate without requiring a restart', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const response = await put(routes, { autoUpdate: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      restartRequired: false,
      settings: { autoUpdate: true },
    });
    expect(onDisk(configPath).server).toMatchObject({ autoUpdate: true });
  });
});

test('PUT /settings autoUpdate true notifies a pending check', async () => {
  // Import `mock` from `bun:test` next to `expect` / `test`.
  const notifyCheck = mock(() => {});
  await withSettingsFixture(async ({ routes }) => {
    await put(routes, { autoUpdate: true });
    expect(notifyCheck).toHaveBeenCalledTimes(1);
    await put(routes, { autoUpdate: false });
    expect(notifyCheck).toHaveBeenCalledTimes(1);
  }, { notifyCheck });
});
```

Thread `notifyCheck` through `withSettingsFixture` into `createDashboardSettingsRoute(state, notifyCheck)`. Keep the existing `put` helper.

- [ ] **Step 10: Implement settings view + mutation**

`settingsView`:

```ts
autoUpdate: config.server.autoUpdate,
```

In `applySettingsMutation`, include `mutation.autoUpdate` in the server-section condition (alongside host/port/logging/retry). When `mutation.autoUpdate !== undefined` and the authored value differs, set `nextServer = { ...nextServer, autoUpdate: mutation.autoUpdate }`. Do **not** set `restartRequired`.

After a successful `mutateConfig` in the PUT handler, if `mutation.autoUpdate === true` call `notifyCheck?.()`.

Update the GET `toEqual` body to include `autoUpdate: false`.

Update the two Dashboard fixtures with `autoUpdate: false`.

- [ ] **Step 11: Run settings + types tests**

Run:

```bash
bun test packages/types/src/config/config.test.ts \
  packages/types/src/dashboard/control-plane/control-plane.test.ts \
  packages/server/src/dashboard-routes/settings/settings.test.ts
```

Expected: PASS. The new notify test requires the optional callback; if you have not wired it yet, this step fails — finish Step 10.

- [ ] **Step 12: Commit**

```bash
git add packages/types/src/config/config.ts \
  packages/types/src/config/config.test.ts \
  packages/types/src/config/config-acceptance.test-support.ts \
  packages/types/src/dashboard/control-plane/control-plane.ts \
  packages/types/src/dashboard/control-plane/control-plane.test.ts \
  packages/server/src/dashboard-routes/settings/settings.ts \
  packages/server/src/dashboard-routes/settings/settings.test.ts \
  packages/server/src/dashboard-routes/config.ts \
  packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx \
  packages/dashboard/src/modules/settings/hooks/use-settings-mutation/use-settings-mutation.test.tsx
git commit -m "feat: persist server.autoUpdate on dashboard settings"
```

---

### Task 2: AutoUpdateController

**Files:**

- Create: `packages/server/src/auto-update/index.ts`
- Create: `packages/server/src/auto-update/auto-update.ts`
- Create: `packages/server/src/auto-update/auto-update.test.ts`

**Interfaces:**

- Consumes: `getEnabled`, `isManagedService`, optional `applyUpdate: (version: string) => Promise<'installed' | 'unchanged'>`, `currentVersion`, `fetchLatest(pkg)`, optional `intervalMs` / `setInterval` / `clearInterval` / `onError`.
- Produces exactly the spec types:

```ts
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPDATE_PACKAGE = 'aio-proxy';

export type AutoUpdateSnapshot = {
  readonly status: 'idle' | 'in_progress' | 'failed' | 'restart_required';
};

export type AutoUpdateApplyResult =
  | { readonly status: 'started' }
  | { readonly status: 'up_to_date' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'check_failed' };

export type AutoUpdateController = {
  readonly isManagedService: () => boolean;
  readonly snapshot: () => AutoUpdateSnapshot;
  readonly apply: () => Promise<AutoUpdateApplyResult>;
  readonly notifyCheck: () => void;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createAutoUpdateController(options: AutoUpdateControllerOptions): AutoUpdateController;
```

`index.ts` re-exports those names only.

- [ ] **Step 1: Write the failing controller tests**

Use an injectable clock. Do not use real 24h timers.

```ts
import { expect, test } from 'bun:test';

import { AUTO_UPDATE_PACKAGE, createAutoUpdateController } from './auto-update';

const createClock = () => {
  let handler: (() => void) | undefined;
  let cleared = 0;
  return {
    setInterval: (next: () => void) => {
      handler = next;
      return 1;
    },
    clearInterval: () => {
      cleared += 1;
      handler = undefined;
    },
    tick: () => handler?.(),
    cleared: () => cleared,
  };
};

test('start checks immediately and again on each interval tick', async () => {
  const fetchLatest = mock(async () => '1.0.0');
  const clock = createClock();
  const controller = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate: async () => 'installed',
    currentVersion: '1.0.0',
    fetchLatest,
    intervalMs: 50,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  controller.start();
  await Promise.resolve();
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  expect(fetchLatest).toHaveBeenCalledWith(AUTO_UPDATE_PACKAGE);
  clock.tick();
  await Promise.resolve();
  expect(fetchLatest).toHaveBeenCalledTimes(2);
  controller.stop();
  expect(clock.cleared()).toBe(1);
});

test('tick does not apply when disabled, unmanaged, or up to date', async () => {
  const applyUpdate = mock(async () => 'installed' as const);
  const run = async (overrides: { enabled?: boolean; managed?: boolean; latest?: string }) => {
    const controller = createAutoUpdateController({
      getEnabled: () => overrides.enabled ?? true,
      isManagedService: () => overrides.managed ?? true,
      applyUpdate,
      currentVersion: '1.2.0',
      fetchLatest: async () => overrides.latest ?? '1.10.0',
      setInterval: () => 1,
      clearInterval: () => {},
    });
    controller.start();
    await Promise.resolve();
    controller.stop();
  };
  await run({ enabled: false });
  await run({ managed: false });
  await run({ latest: '1.2.0' });
  expect(applyUpdate).not.toHaveBeenCalled();
});

test('tick applies once when enabled, managed, and outdated', async () => {
  const applyUpdate = mock(async () => 'installed' as const);
  const controller = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate,
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.10.0',
    setInterval: () => 1,
    clearInterval: () => {},
  });
  controller.start();
  await Promise.resolve();
  expect(applyUpdate).toHaveBeenCalledTimes(1);
  expect(applyUpdate).toHaveBeenCalledWith('1.10.0');
  controller.stop();
});

test('manual apply ignores the toggle and managed gate and is single-flight', async () => {
  let release!: () => void;
  const applyUpdate = mock(
    () =>
      new Promise<'installed'>((resolve) => {
        release = () => resolve('installed');
      }),
  );
  const controller = createAutoUpdateController({
    getEnabled: () => false,
    isManagedService: () => false,
    applyUpdate,
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.10.0',
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const first = controller.apply();
  await Promise.resolve();
  expect(await controller.apply()).toEqual({ status: 'in_progress' });
  expect(controller.snapshot()).toEqual({ status: 'in_progress' });
  expect(await first).toEqual({ status: 'started' });
  release();
  await Promise.resolve();
  expect(controller.snapshot()).toEqual({ status: 'restart_required' });
});

test('second apply during a pending fetchLatest is in_progress and does not apply twice', async () => {
  let releaseFetch!: (version: string) => void;
  const fetchLatest = mock(
    () =>
      new Promise<string>((resolve) => {
        releaseFetch = resolve;
      }),
  );
  const applyUpdate = mock(async () => 'installed' as const);
  const controller = createAutoUpdateController({
    getEnabled: () => false,
    isManagedService: () => false,
    applyUpdate,
    currentVersion: '1.2.0',
    fetchLatest,
  });
  const first = controller.apply();
  await Promise.resolve();
  expect(await controller.apply()).toEqual({ status: 'in_progress' });
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  releaseFetch('1.10.0');
  expect(await first).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(applyUpdate).toHaveBeenCalledTimes(1);
  expect(applyUpdate).toHaveBeenCalledWith('1.10.0');
});

test('applyUpdate unchanged returns to idle; installed stays restart_required', async () => {
  const unchanged = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate: async (version) => {
      expect(version).toBe('1.10.0');
      return 'unchanged';
    },
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.10.0',
  });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(unchanged.snapshot()).toEqual({ status: 'idle' });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
});

test('apply reports up_to_date, unavailable, and check_failed', async () => {
  const missing = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.10.0',
  });
  expect(await missing.apply()).toEqual({ status: 'unavailable' });

  const current = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate: async () => 'installed',
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.2.0',
  });
  expect(await current.apply()).toEqual({ status: 'up_to_date' });

  const offline = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate: async () => 'installed',
    currentVersion: '1.2.0',
    fetchLatest: async () => {
      throw new Error('offline');
    },
  });
  expect(await offline.apply()).toEqual({ status: 'check_failed' });
  expect(offline.snapshot()).toEqual({ status: 'failed' });
});

test('applyUpdate failure sets failed and releases the lock', async () => {
  const controller = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate: async () => {
      throw new Error('install failed');
    },
    currentVersion: '1.2.0',
    fetchLatest: async () => '1.10.0',
    onError: mock(() => {}),
  });
  expect(await controller.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(controller.snapshot()).toEqual({ status: 'failed' });
  expect(await controller.apply()).toEqual({ status: 'started' });
});

test('stop during a pending fetchLatest does not apply', async () => {
  let releaseFetch!: (version: string) => void;
  const fetchLatest = mock(
    () =>
      new Promise<string>((resolve) => {
        releaseFetch = resolve;
      }),
  );
  const applyUpdate = mock(async () => 'installed' as const);
  const controller = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    applyUpdate,
    currentVersion: '1.2.0',
    fetchLatest,
  });
  controller.start();
  await Promise.resolve();
  controller.stop();
  releaseFetch('1.10.0');
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
});

test('start without applyUpdate does not schedule or fetch', async () => {
  const fetchLatest = mock(async () => '1.10.0');
  const setInterval = mock(() => 1);
  const controller = createAutoUpdateController({
    getEnabled: () => true,
    isManagedService: () => true,
    currentVersion: '1.0.0',
    fetchLatest,
    setInterval,
    clearInterval: () => {},
  });
  controller.start();
  expect(setInterval).not.toHaveBeenCalled();
  expect(fetchLatest).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/server/src/auto-update/auto-update.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Tick path (used by `start` immediate run, interval, and `notifyCheck`): skip when the lock is held, `!getEnabled()`, or `!isManagedService()`; **then acquire the lock** and set `in_progress`; fetch `AUTO_UPDATE_PACKAGE`; on fetch throw set `failed` + `onError` and release; if `Bun.semver.order(latest, currentVersion) <= 0` set `idle` and release; if `stop()` ran during the lookup, release and return; otherwise start the same fire-and-forget `applyUpdate(latest)` as `apply()`.

`apply()`: `unavailable` when `applyUpdate` is missing; `in_progress` when the lock is held; **acquire the lock and set `in_progress` before `fetchLatest`**; return `check_failed` / `up_to_date` (release on those paths); otherwise invoke `applyUpdate(latest)` without awaiting it in the caller, return `started`. The background promise maps `'installed'` → `restart_required`, `'unchanged'` → `idle`, throw → `failed` + `onError`, then releases the lock. Never set `restart_required` after a no-op.

`start()`: if `applyUpdate` is missing, return. Otherwise run one tick and `setInterval(tick, intervalMs ?? AUTO_UPDATE_INTERVAL_MS)`.
`stop()`: set a stopped flag, `clearInterval` once; further ticks are no-ops. A lookup already in flight must see the flag and skip `applyUpdate`. An `applyUpdate` already started is not cancelled.
`notifyCheck()`: void a tick (do not await).

Use `Bun.semver.order` the same way `packages/server/src/dashboard-routes/release/release.ts` does. Do not import CLI.

- [ ] **Step 4: Run the controller tests**

Run: `bun test packages/server/src/auto-update/auto-update.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auto-update
git commit -m "feat: add AutoUpdateController for managed upgrade scheduling"
```

---

### Task 3: Release HTTP + dashboard route wiring

**Files:**

- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts`
- Modify: `packages/types/src/dashboard/control-plane/control-plane.test.ts`
- Modify: `packages/server/src/dashboard-routes/release/release.ts`
- Modify: `packages/server/src/dashboard-routes/release/release.test.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts` (call the controller's `notifyCheck` instead of a bare callback if Task 1 used a standalone function)

**Interfaces:**

- Produces:

```ts
export const DashboardReleaseViewSchema = z.strictObject({
  current: z.string().min(1),
  managedService: z.boolean(),
  update: z.strictObject({ status: z.enum(['idle', 'in_progress', 'failed', 'restart_required']) }),
});

export const DashboardReleaseApplyResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), status: z.enum(['started', 'up_to_date']) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(['in_progress', 'unavailable', 'check_failed']),
    }),
  }),
]);
```

- `createDashboardReleaseRoute(version, fetchLatest?, controller?)`
- `createDashboardRoutes(state, auth, version?, controller?)` passes `controller` into release and settings.
- HTTP map: `started` → 202, `up_to_date` → 200, `in_progress` → 409, `unavailable` → 501, `check_failed` → 502.

- [ ] **Step 1: Write the failing release contract + route tests**

Contract:

```ts
test('release view reports managedService and update status', () => {
  const view = schema('DashboardReleaseViewSchema');
  expect(view.parse({ current: '1.2.0', managedService: false, update: { status: 'idle' } })).toEqual({
    current: '1.2.0',
    managedService: false,
    update: { status: 'idle' },
  });
  expect(view.safeParse({ current: '1.2.0' }).success).toBe(false);
});
```

Update `packages/server/src/dashboard-routes/release/release.test.ts`. The existing GET `/` assertion `{ current: '1.2.0' }` must become `{ current: '1.2.0', managedService: false, update: { status: 'idle' } }` when no controller is passed.

Add POST cases that inject a fake controller:

```ts
test('POST /apply maps controller results to HTTP statuses', async () => {
  const table = [
    [{ status: 'started' as const }, 202, { ok: true, status: 'started' }],
    [{ status: 'up_to_date' as const }, 200, { ok: true, status: 'up_to_date' }],
    [{ status: 'in_progress' as const }, 409, { ok: false, error: { code: 'in_progress' } }],
    [{ status: 'unavailable' as const }, 501, { ok: false, error: { code: 'unavailable' } }],
    [{ status: 'check_failed' as const }, 502, { ok: false, error: { code: 'check_failed' } }],
  ] as const;
  for (const [result, status, body] of table) {
    const routes = createDashboardReleaseRoute('1.2.0', async () => '1.2.0', {
      isManagedService: () => true,
      snapshot: () => ({ status: 'idle' }),
      apply: async () => result,
      notifyCheck: () => {},
      start: () => {},
      stop: () => {},
    });
    const response = await routes.request('/apply', { method: 'POST' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  }
});

test('GET / reports managedService from the controller', async () => {
  const routes = createDashboardReleaseRoute('1.2.0', async () => '1.2.0', {
    isManagedService: () => true,
    snapshot: () => ({ status: 'in_progress' }),
    apply: async () => ({ status: 'in_progress' }),
    notifyCheck: () => {},
    start: () => {},
    stop: () => {},
  });
  const response = await routes.request('/');
  expect(await response.json()).toEqual({
    current: '1.2.0',
    managedService: true,
    update: { status: 'in_progress' },
  });
});
```

Keep the existing `/latest` tests unchanged.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/types/src/dashboard/control-plane/control-plane.test.ts packages/server/src/dashboard-routes/release/release.test.ts`
Expected: FAIL — schema missing, GET body still `{ current }`, POST 404.

- [ ] **Step 3: Implement schemas and routes**

Add the Zod schemas and exported types in `control-plane.ts`.

Change `createDashboardReleaseRoute` to accept an optional `AutoUpdateController`. GET `/` returns the spec view, using `controller?.isManagedService() ?? false` and `controller?.snapshot() ?? { status: 'idle' }`. POST `/apply` calls `controller?.apply() ?? { status: 'unavailable' }` and maps statuses as specified.

Thread `controller` through `createDashboardRoutes` into both `/release` and `/settings` (`notifyCheck: () => controller?.notifyCheck()`).

- [ ] **Step 4: Run the tests**

Run: `bun test packages/types/src/dashboard/control-plane/control-plane.test.ts packages/server/src/dashboard-routes/release/release.test.ts packages/server/src/dashboard-routes/settings/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/dashboard/control-plane \
  packages/server/src/dashboard-routes/release \
  packages/server/src/dashboard-routes/config.ts \
  packages/server/src/dashboard-routes/settings/settings.ts
git commit -m "feat: expose release apply API and managedService on GET /release"
```

---

### Task 4: Start the controller from createServer and inject it in CLI run

**Files:**

- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/server-lifecycle.test.ts`
- Modify: `packages/cli/src/run/run.ts`
- Create: `packages/cli/src/run/auto-update-hooks.ts`
- Create: `packages/cli/src/run/auto-update-hooks.test.ts`
- Modify: `packages/cli/src/service/unit-templates.ts`
- Modify: `packages/cli/src/service/service.ts`
- Modify: `packages/cli/src/service/service.test.ts`
- Modify: `packages/cli/src/upgrade/constants.ts`
- Modify: `packages/cli/src/upgrade/detect.ts`
- Modify: `packages/cli/src/upgrade/methods.ts`
- Modify: `packages/cli/src/upgrade/agent-post-upgrade-process.ts`
- Modify: `packages/cli/src/upgrade/upgrade.ts`
- Modify: `packages/cli/src/upgrade/upgrade.test.ts`

**Interfaces:**

- Extends `CreateServerOptions`:

```ts
readonly autoUpdate?: {
  readonly isManagedService: () => boolean;
  readonly applyUpdate: (version: string) => Promise<'installed' | 'unchanged'>;
};
```

- `createServer` constructs `createAutoUpdateController({ getEnabled: () => state.currentConfig().server.autoUpdate, isManagedService: options.autoUpdate?.isManagedService ?? (() => false), applyUpdate: options.autoUpdate?.applyUpdate, currentVersion: options.version ?? '0.0.0', fetchLatest: fetchLatestNpmVersion, onError })`.
- `close()` calls `controller.stop()` then `state.close()`.
- `createRoutes` / `createDashboardRoutes` receive the controller.
- CLI `run` passes `autoUpdate: createCliAutoUpdateHooks()` and, on boot, migrates a pre-marker unit (rewrite only — do not `serviceRestart`).
- Unit templates add `AIO_PROXY_MANAGED=1` next to `AIO_PROXY_HOME` (systemd `Environment=`, launchd `EnvironmentVariables`). When the install method is known at write time, also persist `AIO_PROXY_UPGRADE_METHOD` (`brew` / `npm` / `bun` / `pnpm` only). Existing `service restart` already rewrites the unit from current templates.
- `createCliAutoUpdateHooks()`:

```ts
export const isManagedAutoUpdateProcess = (
  env: NodeJS.ProcessEnv = process.env,
  io?: {
    readonly platform?: NodeJS.Platform;
    readonly unitExists?: () => boolean;
  },
): boolean => {
  if (env['AIO_PROXY_MANAGED'] === '1') return true;
  const os = io?.platform ?? process.platform;
  const unitExists = io?.unitExists ?? isManagedServiceInstalled;
  if (os === 'linux') return Boolean(env['INVOCATION_ID']) && unitExists();
  if (os === 'darwin') return env['XPC_SERVICE_NAME'] === 'com.aio-proxy.agent';
  return false;
};

export const createCliAutoUpdateHooks = (deps?: {
  readonly isManagedService?: () => boolean;
  readonly upgrade?: typeof runUpgradeCommand;
  readonly resolveExec?: typeof resolveExec;
  readonly resolveTargetFrom?: typeof resolveUpgradeTargetFrom;
}) => ({
  isManagedService: deps?.isManagedService ?? isManagedAutoUpdateProcess,
  applyUpdate: async (version: string) => {
    const exec = (deps?.resolveExec ?? resolveExec)();
    const resolveTarget = async () => (deps?.resolveTargetFrom ?? resolveUpgradeTargetFrom)(exec);
    return (deps?.upgrade ?? runUpgradeCommand)({ version }, (line) => console.log(line), {
      resolveTarget,
      fetchLatest: async () => version,
      isServiceManaged: deps?.isManagedService ?? isManagedAutoUpdateProcess,
    });
  },
});
```

`runUpgradeCommand` gains optional `options.version`. When set, skip the registry lookup and install **that** version. Return `'unchanged'` when `Bun.semver.order(version, current) <= 0` (and `--force` is not set). After a brew install, read the stable launcher's version; if `Bun.semver.order(actual, current) <= 0`, return `'unchanged'` and skip restart (tap/npm skew). Return `'installed'` only after the on-disk version moved. Interactive `aio-proxy upgrade` omits `version`, still fetches `latest`, and ignores the return value.

Export a `createUpgradeDeps` (or accept a partial override) so the implementation can spread `defaultDeps` and override `resolveTarget` + `isServiceManaged` without `as never`. Interactive `aio-proxy upgrade` keeps the default `resolveUpgradeTarget()` (`Bun.which`) and `isManagedServiceInstalled()` restart gate.

Extend `UpgradeTarget` so non-binary methods carry the manager and the installed launcher:

```ts
| { readonly method: Exclude<UpgradeMethod, 'binary'>; readonly command: string; readonly bin: string }
| { readonly method: 'binary'; readonly path: string }
```

`runPackageManagerUpgrade` must `exec([target.command, ...])`. Do not spawn the bare name `brew`. `resolveNewAgentBinary` must use `target.bin` (or `target.path` for `binary`), not `Bun.which('aio-proxy')`. Task 4 **does** modify `constants.ts`, `methods.ts`, and `agent-post-upgrade-process.ts`. Interactive PATH detection may set `command` to `Bun.which('brew') ?? 'brew'` and `bin` to the resolved aio-proxy path.

`resolveUpgradeTargetFrom(binPath)` uses the given absolute path instead of `Bun.which`. Rules:

- If `AIO_PROXY_UPGRADE_METHOD` is `brew` / `npm` / `bun` / `pnpm`, honor it and fill `command` + `bin` from the prefix / unit env if present.
- If `binPath` matches `.../Cellar/aio-proxy/<ver>/bin/aio-proxy`, method is `brew`. Return `{ method: 'brew', command: '{brewPrefix}/bin/brew', bin: '{brewPrefix}/bin/aio-proxy' }`. **Never** return `{ method: 'binary', path: cellarFile }`.
- npm / bun / pnpm when the path sits under those prefixes, with their absolute CLI paths and the matching global `aio-proxy` as `bin`.
- `{ method: 'binary', path }` only for a real curl-style / standalone binary.
- Missing `brew` **binary file** for a Homebrew target is an error, not a Cellar overwrite. A missing `brew` on `PATH` is fine when `command` is the absolute prefix path. Missing `npm` for an npm prefix is the existing CLI fallback for **npm prefixes only**.

`resolveStableManagedExec(execPath)` maps a Cellar `execPath` to `{brewPrefix}/bin/aio-proxy`. `resolveExec()` must use it (so `writeManagedUnit` / `serviceRestart` stay safe when managed PATH is empty and `which('aio-proxy')` is null). Do not bake a Cellar path into `ExecStart`.

Pre-marker boot migration (in `run`, before `createServer`): if `isManagedAutoUpdateProcess()` is true, `AIO_PROXY_MANAGED` is unset, and the unit file exists but lacks the marker, call `writeManagedUnit` with `resolveStableManagedExec()` — not `serviceRestart()`.

Darwin `serviceRestart()`: when this process is the launchd job (`XPC_SERVICE_NAME === com.aio-proxy.agent` or `AIO_PROXY_MANAGED=1` on darwin), rewrite the unit, then spawn a detached helper that initiates `unload -w` + `load -w` after it has detached. The helper must **not** wait for this PID — `serviceRestart` / `runUpgradeCommand` return and the daemon stays up, so a wait-for-PID helper never runs `launchctl`. A short delay after detach is fine; then unload (kills this process) and load. Do **not** call `serviceStop()` / `unload` from inside the job. Interactive `aio-proxy service restart` from a TTY keeps today's in-process unload+load. systemd is unchanged.

Do not pass `--force` or `--check`. Do not use `isManagedServiceInstalled()` alone as the scheduler gate.

- [ ] **Step 1: Write the failing lifecycle test**

```ts
test('close stops the auto-update timer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-auto-update-close-'));
  let stopped = 0;
  const app = await createServer({
    config: { providers: {}, server: { autoUpdate: true } },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: {
      isManagedService: () => false,
      applyUpdate: async () => {
        throw new Error('must not apply when unmanaged');
      },
    },
  });
  app.close();
  app.close();
  expect(stopped).toBeGreaterThanOrEqual(0);
});
```

That test is weak if `stop` is not observable. Prefer injecting nothing and asserting that a mocked `applyUpdate` is never called when unmanaged (the controller is real). Stronger test:

```ts
test('createServer does not apply an update when the service is unmanaged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-auto-update-unmanaged-'));
  const applyUpdate = mock(async () => 'installed' as const);
  const app = await createServer({
    config: { providers: {}, server: { autoUpdate: true } },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: { isManagedService: () => false, applyUpdate },
  });
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
  app.close();
});
```

Extract `createCliAutoUpdateHooks` and test:

```ts
test('isManagedAutoUpdateProcess accepts the marker and pre-marker manager env', () => {
  expect(isManagedAutoUpdateProcess({})).toBe(false);
  expect(isManagedAutoUpdateProcess({ AIO_PROXY_MANAGED: '1' })).toBe(true);
  expect(
    isManagedAutoUpdateProcess({ INVOCATION_ID: 'abc' }, { platform: 'linux', unitExists: () => true }),
  ).toBe(true);
  expect(
    isManagedAutoUpdateProcess({ INVOCATION_ID: 'abc' }, { platform: 'linux', unitExists: () => false }),
  ).toBe(false);
  expect(
    isManagedAutoUpdateProcess({ XPC_SERVICE_NAME: 'com.aio-proxy.agent' }, { platform: 'darwin' }),
  ).toBe(true);
  expect(
    isManagedAutoUpdateProcess({ XPC_SERVICE_NAME: 'com.apple.Terminal' }, { platform: 'darwin', unitExists: () => true }),
  ).toBe(false);
});

test('applyUpdate pins the checked version and upgrades via the launched exec path', async () => {
  const upgrade = mock(async (options: { version?: string }, _print: unknown, deps: { resolveTarget: () => Promise<unknown> }) => {
    expect(options.version).toBe('1.10.0');
    expect(await deps.resolveTarget()).toEqual({ method: 'binary', path: '/opt/aio-proxy' });
    return 'installed' as const;
  });
  const hooks = createCliAutoUpdateHooks({
    upgrade: upgrade as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(upgrade).toHaveBeenCalledTimes(1);
});
```

Add `resolveUpgradeTargetFrom` / `resolveStableManagedExec` tests in `upgrade.test.ts` and `service.test.ts`:

- `{prefix}/bin/aio-proxy` → `{ method: 'brew', command: '{prefix}/bin/brew', bin: '{prefix}/bin/aio-proxy' }`
- `.../Cellar/aio-proxy/<ver>/bin/aio-proxy` → `{ method: 'brew', command: '{brewPrefix}/bin/brew', bin: '{brewPrefix}/bin/aio-proxy' }` (not `{ method: 'binary', path: cellarFile }`), even when `brew` is missing from `PATH`
- standalone `/opt/aio-proxy` → `{ method: 'binary', path }`
- npm prefix path → `{ method: 'npm', command }`
- `resolveStableManagedExec(cellarFile)` → `{brewPrefix}/bin/aio-proxy`
- `runPackageManagerUpgrade` for brew execs the absolute `command`, never the string `'brew'`
- `runUpgradeCommand({ version: '1.2.4' })` installs 1.2.4 and does not call `fetchLatest`; a later stub `latest` of `1.2.5` must not change the installed version
- `runUpgradeCommand({ version: current })` returns `'unchanged'` and does not install
- brew install whose launcher `--version` stays at `current` returns `'unchanged'` and does not call `restartService`
- Darwin in-job `serviceRestart` spawns a detached helper that unloads without waiting for this PID; TTY restart still unloads in-process
- `resolveNewAgentBinary` for a brew target uses `target.bin`, not `Bun.which`

Unit template tests already snapshot `AIO_PROXY_HOME` — assert `AIO_PROXY_MANAGED=1` is also present on systemd and launchd output.

Boot-migration test: pre-marker unit + `INVOCATION_ID` / `XPC_SERVICE_NAME` → `writeManagedUnit` is called with the stable launcher; `serviceRestart` is not.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/server/src/server/server-lifecycle.test.ts`
Expected: FAIL — `autoUpdate` is not on `CreateServerOptions`.

- [ ] **Step 3: Wire createServer and CLI**

Import `createAutoUpdateController` and `fetchLatestNpmVersion`. After `createServerState`, build the controller. Pass it into `createRoutes` (add a parameter; keep it last so `__test.createRoutes` overrides that ignore extra args still work). Call `controller.start()` only after routes assemble successfully. In `close()`, `controller.stop()` then `state.close()`. On `createRoutes` throw, `controller.stop()` then `state.close()` (same `try` that already closes state).

Log apply failures through the existing server logger when present (`auto_update.failed`); tests may omit `onError`.

`run.ts`: pass `autoUpdate: createCliAutoUpdateHooks()`. On boot, if the pre-marker fallback hits and the unit lacks `AIO_PROXY_MANAGED`, rewrite it with `writeManagedUnit` + `resolveStableManagedExec()` (no restart). Add `AIO_PROXY_MANAGED=1` to both unit templates. Implement `resolveUpgradeTargetFrom` and `resolveStableManagedExec` next to `resolveUpgradeTarget`. Extend `UpgradeTarget` with `command` + `bin`; change `runPackageManagerUpgrade` to exec `command` and `resolveNewAgentBinary` to use `bin`. Extend `runUpgradeCommand` with pinned `version`, brew version verification, and `'installed' | 'unchanged'`. Fix Darwin in-job `serviceRestart` so the helper unloads after detach and does not wait for this PID.

- [ ] **Step 4: Run the tests**

Run:

```bash
bun test packages/server/src/server/server-lifecycle.test.ts \
  packages/server/src/auto-update/auto-update.test.ts \
  packages/cli/src/run
```

Expected: PASS. Existing `boot-proxy-server.test.ts` still passes because it stubs `createServer`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/server.ts \
  packages/server/src/server/server-lifecycle.test.ts \
  packages/cli/src/run \
  packages/cli/src/service/unit-templates.ts \
  packages/cli/src/service/service.ts \
  packages/cli/src/service/service.test.ts \
  packages/cli/src/upgrade/constants.ts \
  packages/cli/src/upgrade/detect.ts \
  packages/cli/src/upgrade/methods.ts \
  packages/cli/src/upgrade/agent-post-upgrade-process.ts \
  packages/cli/src/upgrade/upgrade.ts \
  packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat: schedule auto-update from createServer and CLI run"
```

---

### Task 5: Dashboard About card — toggle and Update now

**Files:**

- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/dashboard/src/modules/settings/services/release-service/release-service.ts`
- Modify: `packages/dashboard/src/modules/settings/hooks/use-release-query/use-release-query.ts` (only if the query type is hardcoded)
- Modify: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-about-group.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-about-group.test.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-auto-update-row.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-auto-update-row.test.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-update-now-button.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-about-group/settings-update-now-button.test.tsx`
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx` (release mock shape)

**Interfaces:**

- `releaseQueryOptions` returns `DashboardReleaseView` (`current`, `managedService`, `update`).
- `applyReleaseMutationFn()` POSTs `/dashboard/api/release/apply` via `createDashboardClient`.
- `SettingsAutoUpdateRow` consumes settings `autoUpdate` + `managedService` + `useSettingsMutation`.
- `SettingsUpdateNowButton` consumes outdated flag + apply mutation + polls release.

Copy (add under `dashboard.settings`; keep existing version keys):

| Key | en | zh-Hans | zh-Hant | ja | ko |
| --- | --- | --- | --- | --- | --- |
| `auto_update` | Automatic updates | 自动更新 | 自動更新 | 自動更新 | 자동 업데이트 |
| `auto_update_description` | When aio-proxy is installed as a managed service, download and install new versions on startup and once a day. | 在托管服务下运行时，启动时和每天检查一次并安装新版本。 | 在受管服務下執行時，啟動時和每天檢查一次並安裝新版本。 | マネージドサービスとして実行している場合、起動時と 1 日 1 回、新しいバージョンをダウンロードしてインストールします。 | 관리 서비스로 실행 중이면 시작 시와 하루에 한 번 새 버전을 다운로드하여 설치합니다. |
| `auto_update_unmanaged_hint` | Automatic install runs only under a managed service. This process will not install updates until you run aio-proxy service install. | 自动安装仅在托管服务下生效。在运行 aio-proxy service install 之前，当前进程不会安装更新。 | 自動安裝僅在受管服務下生效。在執行 aio-proxy service install 之前，目前處理程序不會安裝更新。 | 自動インストールはマネージドサービスでのみ実行されます。aio-proxy service install を実行するまで、このプロセスは更新をインストールしません。 | 자동 설치는 관리 서비스에서만 실행됩니다. aio-proxy service install을 실행하기 전까지 이 프로세스는 업데이트를 설치하지 않습니다. |
| `version_update` | Update now | 立即更新 | 立即更新 | 今すぐ更新 | 지금 업데이트 |
| `version_updating` | Updating… | 正在更新… | 正在更新… | 更新中… | 업데이트 중… |
| `version_update_failed` | The update could not be installed. Try again or run aio-proxy upgrade. | 无法安装更新。请重试，或运行 aio-proxy upgrade。 | 無法安裝更新。請重試，或執行 aio-proxy upgrade。 | 更新をインストールできませんでした。再試行するか、aio-proxy upgrade を実行してください。 | 업데이트를 설치할 수 없습니다. 다시 시도하거나 aio-proxy upgrade를 실행하세요. |
| `version_update_unavailable` | This process cannot install updates. | 当前进程无法安装更新。 | 目前處理程序無法安裝更新。 | このプロセスでは更新をインストールできません。 | 이 프로세스에서는 업데이트를 설치할 수 없습니다. |
| `version_restart_required` | Restart aio-proxy to run the installed version. | 重启 aio-proxy 以运行已安装的版本。 | 重新啟動 aio-proxy 以執行已安裝的版本。 | インストールしたバージョンを使うには aio-proxy を再起動してください。 | 설치한 버전을 사용하려면 aio-proxy를 다시 시작하세요. |

- [ ] **Step 1: Add i18n keys and compile**

Edit all five message files, then:

```bash
bun run i18n:compile
bun test packages/i18n/__tests__/locale-parity.test.ts
```

Expected: PASS.

- [ ] **Step 2: Write the failing About tests**

Mock `useSettingsQuery` / `useSettingsMutation` / `useReleaseQuery` / `applyReleaseMutationFn` in the About tests. Cover:

1. Switch save: clicking Automatic updates calls `mutate({ autoUpdate: true })`.
2. Unmanaged hint: `managedService: false` shows `auto_update_unmanaged_hint`; `true` does not.
3. Update now: after a check that returns `outdated: true`, the button is enabled; click calls `applyReleaseMutationFn`.
4. In-progress: `update.status === 'in_progress'` disables Update now and shows `version_updating`.
5. Failed apply: `update.status === 'failed'` shows `version_update_failed` and does not show `version_up_to_date`.
6. Restart required: `update.status === 'restart_required'` shows `version_restart_required`, stops polling, does not call `reloadDashboard()`, and **disables** Update now (do not leave it clickable while `outdated` is still true).

Update `useReleaseQuery` mocks from `{ current: '1.4.2' }` to `{ current: '1.4.2', managedService: false, update: { status: 'idle' } }` in `settings-about-group.test.tsx` and `settings-page.test.tsx`.

- [ ] **Step 3: Run the About tests and confirm they fail**

Run: `bun run --filter @aio-proxy/dashboard test:unit`
Expected: FAIL — Switch / Update now not rendered; GET type may already include extra fields from the Hono client after Task 3.

- [ ] **Step 4: Implement the UI**

`release-service.ts`:

```ts
export const applyReleaseMutationFn = async () => {
  const response = await dashboardClient.dashboard.api.release.apply.$post();
  const result = await response.json();
  if ('error' in result) throw new Error(result.error.code);
  return result;
};
```

Widen `releaseQueryOptions` to return the full GET JSON (`current`, `managedService`, `update`).

`SettingsAutoUpdateRow`: `useForm({ defaultValues: { autoUpdate } })`, shadcn `Switch`, `onCheckedChange` → `onSave({ autoUpdate })`. Show `auto_update_description` always and `auto_update_unmanaged_hint` when `managedService` is false.

`SettingsUpdateNowButton`: ghost `Button` like version check. Pending / `in_progress` → `version_updating` + disabled. `restart_required` → `version_restart_required` + disabled (do not post apply again). After `started` or a dropped connection, poll `releaseQueryOptions` every 2s for at most 120s; if `current` changes, `reloadDashboard()`; if `update.status === 'restart_required'`, show `version_restart_required` and stop. Failed / `unavailable` use the matching i18n string.

`SettingsAboutGroup` assembles version row, auto-update row (only when settings query has data), Update now, repo, docs. Hide the Switch while settings are loading or errored; keep version check.

- [ ] **Step 5: Run dashboard tests**

Run: `bun run --filter @aio-proxy/dashboard test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/messages packages/i18n/src \
  packages/dashboard/src/modules/settings
git commit -m "feat: add automatic updates toggle and Update now on Settings"
```

(`packages/i18n/src` only if `i18n:compile` rewrites generated files. Do not hand-edit generated Paraglide output.)

---

### Task 6: Changeset and preflight

**Files:**

- Create: `.changeset/auto-update-settings.md`
- Modify nothing else unless preflight exposes a missed fixture.

**Interfaces:**

- Changeset targets, all `minor`: `aio-proxy`, `@aio-proxy/types`, `@aio-proxy/server`, `@aio-proxy/cli`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`.
- Do not target only internals. Do not run `changeset version`.

- [ ] **Step 1: Author the changeset**

```md
---
'@aio-proxy/types': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'aio-proxy': minor
---

Settings: add an Automatic updates toggle (off by default) and Update now. When enabled, a managed launchd/systemd service checks npm `latest` on startup and every 24 hours and runs the existing `aio-proxy upgrade` path. Foreground `aio-proxy run` persists the flag but does not auto-install.
```

- [ ] **Step 2: Run preflight**

Run: `bun run preflight`
Expected: oxlint + oxfmt check + all unit tests PASS.

If a `DashboardSettingsView` fixture or GET `/settings` assertion was missed, fix it in this task and keep the changeset.

- [ ] **Step 3: Commit**

```bash
git add .changeset/auto-update-settings.md
git commit -m "chore: add changeset for automatic updates"
```

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| `server.autoUpdate` default false, persisted explicitly | 1 |
| Settings view/mutation, no restartRequired, `notifyCheck` on true | 1 |
| Controller tick gates (enabled + this-process-managed + outdated) | 2 |
| Lock before `fetchLatest`; deferred-lookup single-flight; `stop` during lookup skips apply | 2 |
| `applyUpdate('installed')` → `restart_required`; `'unchanged'` → `idle` | 2, 5 |
| Manual apply skips gates, 202-before-install | 2, 3 |
| GET `/release` `{ current, managedService, update }` | 3 |
| POST apply HTTP map | 3 |
| Marker + pre-marker; Cellar never binary; brew `command`/`bin`; helper unloads without waiting; Agent uses `bin` | 4 |
| `createServer` start/stop + CLI hooks | 4 |
| About Switch + unmanaged hint + Update now + poll/`restart_required` disables button | 5 |
| Five-locale copy + changeset targeting `aio-proxy` | 5, 6 |
| No OS timers, no channel UI, no server→CLI import | all (non-goals) |

**Placeholders:** none.

**Type names:** `AutoUpdateController`, `AutoUpdateApplyResult`, `DashboardReleaseViewSchema`, `DashboardReleaseApplyResponseSchema`, `createCliAutoUpdateHooks`, `isManagedAutoUpdateProcess`, `resolveUpgradeTargetFrom`, `resolveStableManagedExec`, `UpgradeTarget.command`, `UpgradeTarget.bin`, `applyReleaseMutationFn` are used consistently across tasks.
