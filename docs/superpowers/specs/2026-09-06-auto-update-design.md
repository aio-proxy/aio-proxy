# Automatic aio-proxy updates

Date: 2026-09-06
Status: accepted

This spec supersedes the "no background upgrade" non-goal in
`docs/superpowers/specs/2026-07-31-cli-upgrade-design.md`. Explicit
`aio-proxy upgrade` remains the only installer. Automatic updates are an
opt-in scheduler that calls that same command.

## Problem

The Dashboard About card can check npm `latest` and tell the operator a
newer aio-proxy exists. Installing it still requires leaving the UI and
running `aio-proxy upgrade` (or `update`). There is no persisted setting
that makes a long-running managed service keep itself current.

## Goals

- Add one Settings item that enables automatic updates. Default **off**.
- Keep a manual **Update now** action next to the existing version check.
- When the toggle is on, a **managed** launchd/systemd service checks npm
  `latest` once at process start and again every 24 hours, then installs
  every newer `latest` version (no major/minor split).
- Reuse `runUpgradeCommand`. Do not reimplement channel detection, binary
  replace, Agent post-upgrade, or service restart.
- Persist the toggle in the user's config as `server.autoUpdate`.

## Non-goals

- OS timer units (`launchd` `StartInterval`, `systemd` timers).
- A second setting for interval, channel, or "patch only".
- Windows, musl, or platforms outside the current published matrix.
- Auto-install while the process was started with a foreground
  `aio-proxy run` (even if a unit file exists on the same machine).
- In-process binary replacement inside `@aio-proxy/server`.
- Changing brew / npm / bun / pnpm / curl install behavior.
- Auto-updating plugins, Agent hosts, or anything other than aio-proxy.

## Product decisions

| Topic | Decision |
| --- | --- |
| Surfaces | Toggle **and** Update now |
| Schedule | Immediate check at start, then every 24 hours |
| Default | `false` |
| Versions | All newer npm `latest`, same as `aio-proxy upgrade` |
| Auto-install | Only when **this process** was launched by the managed unit (`AIO_PROXY_MANAGED=1`) |
| Manual install | Always allowed when the apply callback exists |
| Interval UI | None. Constant `24 * 60 * 60 * 1000` ms |

Turning the toggle on while running a foreground `aio-proxy run` is
allowed and persisted. The scheduler will not install until that machine
later runs under `aio-proxy service`. The About card must say so when
`managedService` is false.

Toggling `autoUpdate` does **not** require a process restart. The
scheduler reads `state.currentConfig().server.autoUpdate` on every tick.
Writing `autoUpdate: true` triggers one extra check immediately so the
operator does not wait up to 24 hours.

## Architecture

`@aio-proxy/server` never imports `@aio-proxy/cli`.

CLI `run` injects two callbacks into `createServer`:

```ts
autoUpdate?: {
  readonly isManagedService: () => boolean;
  readonly applyUpdate: () => Promise<void>;
};
```

`isManagedService` means **this process** was launched by the managed
unit, not that a unit file exists on disk. `isManagedServiceInstalled()`
is the wrong gate: a foreground `aio-proxy run` on a machine that also
has a unit would auto-install and `serviceRestart()` would bounce or
start that unit. Service unit templates set `AIO_PROXY_MANAGED=1`
(alongside `AIO_PROXY_HOME`). The injected callback is
`process.env.AIO_PROXY_MANAGED === '1'`. Foreground `run` never sets it.
`service install` and the existing `service restart` unit rewrite pick
the env up.

`applyUpdate` calls `runUpgradeCommand` with an explicit upgrade target
derived from `resolveExec()` / the launched absolute path. It must not
rely on `Bun.which('aio-proxy')`: launchd/systemd units execute that
absolute path and do not put the install dir or package managers on
`PATH`, so the current `resolveUpgradeTarget()` throws
`cannot locate aio-proxy in PATH`. Channel detection still compares that
absolute path to brew/npm/bun/pnpm prefixes when those CLIs are
reachable; if they are not, fall back to the binary method on that path.
Its `isServiceManaged` restart gate is the same this-process marker, so
a foreground Update now does not `serviceRestart()` a unit that happens
to exist. No `--force`, no `--check`, no custom `--registry`. Default
interactive `aio-proxy upgrade` PATH and unit-file restart behavior stay
unchanged.

Server owns:

- `server.autoUpdate` on the settings read/write contract.
- An `AutoUpdateController` that schedules checks, holds the single-flight
  lock, and records
  `{ status: 'idle' | 'in_progress' | 'failed' | 'restart_required' }`.
- Release routes: `GET /release`, `GET /release/latest`, `POST /release/apply`.

If `autoUpdate` callbacks are omitted (unit tests, non-CLI hosts), the
controller does not start a timer, `managedService` is `false`, and
`POST /release/apply` returns `unavailable`.

## Config

Add to `ServerConfigSchema` (and therefore the authoring schema and
generated `config.schema.json`):

```ts
autoUpdate: z
  .boolean()
  .default(false)
  .describe('When true, a managed service installs newer npm latest versions on start and every 24 hours.');
```

Omitted in a config file means off. A Settings write always persists the
boolean explicitly (`true` or `false`).

`DashboardSettingsViewSchema` and `DashboardSettingsMutationSchema` gain
`autoUpdate`. Changing it never sets `restartRequired`.

## Components

### AutoUpdateController (`packages/server/src/auto-update/`)

Export-only `index.ts`, implementation `auto-update.ts`, colocated test.

```ts
type AutoUpdateSnapshot = {
  readonly status: 'idle' | 'in_progress' | 'failed' | 'restart_required';
};

type AutoUpdateApplyResult =
  | { readonly status: 'started' }
  | { readonly status: 'up_to_date' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'check_failed' };

type AutoUpdateController = {
  readonly isManagedService: () => boolean;
  readonly snapshot: () => AutoUpdateSnapshot;
  readonly apply: () => Promise<AutoUpdateApplyResult>;
  readonly notifyCheck: () => void;
  readonly start: () => void;
  readonly stop: () => void;
};
```

`start()` no-ops when `applyUpdate` is missing. Otherwise it runs one
check immediately and then on `intervalMs` (default 24h). `stop()`
clears the timer. `createServer` must call `stop()` from `close()`.

Clock and `fetchLatest` are injectable so tests never touch the network
or wait 24 hours.

### Tick versus Apply

**Tick** (startup, interval, `notifyCheck`) and **Apply** share one lock.
Acquire it **before** the first awaited operation (`fetchLatest`). A
second caller that sees the lock returns immediately (`in_progress` for
Apply; no-op for Tick). Do not fetch twice and then both call
`applyUpdate()`.

**Tick** (startup, interval, `notifyCheck`):

1. Return if the lock is held.
2. Return if `getEnabled()` is false.
3. Return if `isManagedService()` is false (this process is not the
   managed daemon).
4. Acquire the lock and set `in_progress`.
5. Fetch npm `latest` for `aio-proxy`. On failure set `failed`, release,
   stop.
6. If `Bun.semver.order(latest, currentVersion) <= 0`, set `idle`,
   release, return.
7. Start `applyUpdate()` without awaiting it in the tick.

**Apply** (Update now):

1. Return `unavailable` if `applyUpdate` is missing.
2. Return `in_progress` if the lock is held.
3. Acquire the lock and set `in_progress`.
4. Fetch latest. On failure set `failed`, release, return `check_failed`.
5. If not newer, set `idle`, release, return `up_to_date`.
6. Start `applyUpdate()` **without blocking the HTTP response**, return
   `started`.

Manual apply does **not** require the toggle or a managed process.

When the background `applyUpdate()` **fulfills**, this process is still
alive, so the install did not restart it. Set `restart_required` and
release the lock. That is the foreground `aio-proxy run` / Update now
outcome: `GET /release` `current` stays the boot version.

When `applyUpdate()` **throws**, set `failed`, release the lock, do not
crash the daemon.

When a managed upgrade calls `serviceRestart()`, the process is replaced
and never observes fulfill. A new process boots at `idle` on the new
version.

`currentVersion` is the process version at boot (`CreateServerOptions.version`
/ CLI `package.json`). After a successful managed upgrade the process is
replaced, so a stale in-memory version cannot linger.

### Release HTTP

`GET /dashboard/api/release` becomes:

```ts
{
  current: string;
  managedService: boolean;
  update: { status: 'idle' | 'in_progress' | 'failed' | 'restart_required' };
}
```

Additive for the Dashboard. Existing `{ current }` consumers must read
the new fields. Put the Zod contracts in `@aio-proxy/types` next to the
settings schemas (`DashboardReleaseViewSchema`,
`DashboardReleaseApplyResponseSchema`).

`GET /dashboard/api/release/latest` is unchanged.

`POST /dashboard/api/release/apply` (empty body):

| Result | HTTP |
| --- | --- |
| `started` | 202 `{ ok: true, status: 'started' }` |
| `up_to_date` | 200 `{ ok: true, status: 'up_to_date' }` |
| `in_progress` | 409 `{ ok: false, error: { code: 'in_progress' } }` |
| `unavailable` | 501 `{ ok: false, error: { code: 'unavailable' } }` |
| registry failure | 502 `{ ok: false, error: { code: 'check_failed' } }` |

A managed upgrade restarts the service and may drop the connection after
202. That is expected.

### Settings route

`settingsView` includes `autoUpdate: config.server.autoUpdate`.
`applySettingsMutation` writes `server.autoUpdate` when present.
`restartRequired` stays false for this field.

After a successful write with `autoUpdate === true`, call
`controller.notifyCheck()`.

Unknown `server.*` keys already on disk stay untouched (same preserve
behavior as `futureServer` in the settings tests).

### Dashboard About card

Stay on the Settings page About card. Do not add an Updates page or put
the toggle in Service / Logs.

Split files (one component per `.tsx`):

- `settings-about-group.tsx` — assembly only.
- `settings-auto-update-row.tsx` — Switch via TanStack Form, saves
  `{ autoUpdate }` through `useSettingsMutation`.
- `settings-update-now-button.tsx` — `POST /release/apply`, then poll
  `GET /release` until `current` changes,
  `update.status === 'failed' | 'restart_required'`, or ~120s elapse.
  On version change call `reloadDashboard()`. On `restart_required`
  show `version_restart_required` and stop polling (do not wait for a
  version change that will never arrive). Treat a dropped connection
  after `started` as in-progress, not as failure.

When settings have not loaded, hide the Switch; version check still
renders. When `managedService` is false, keep the Switch enabled and
show the unmanaged hint.

**Update now** is enabled whenever the last check reported `outdated`,
or after the user has checked and a newer version is known. It is
disabled while `update.status === 'in_progress'` or the apply mutation
is pending. It does not require the toggle.

All copy goes through `@aio-proxy/i18n` in all five locales.

## Data flow

```text
Settings Switch
  -> PUT /dashboard/api/settings { autoUpdate }
  -> config.json server.autoUpdate
  -> configStore reload (no process restart)
  -> notifyCheck() when true

notifyCheck / start / 24h timer
  -> enabled && this-process-managed && outdated?
  -> applyUpdate() -> runUpgradeCommand(explicit exec path)
  -> install via brew|npm|bun|pnpm|binary
  -> Agent post-upgrade
  -> serviceRestart() when this process is managed

Update now
  -> POST /dashboard/api/release/apply
  -> same applyUpdate() (no enabled/managed gate)
  -> 202 + poll GET /release
  -> reload Dashboard when current changes
  -> stop and show restart hint when status is restart_required
```

Foreground `aio-proxy run` (no `AIO_PROXY_MANAGED=1`): ticks never
install, even if a unit file exists on disk. Update now still installs;
when `applyUpdate` returns, status becomes `restart_required`.

## Error handling

- Registry failures on tick: set `failed`, keep the daemon up, try again
  on the next interval. Do not claim "up to date".
- Registry failures on Apply: HTTP 502 `check_failed`.
- `applyUpdate` throw: set `failed`, release the lock, log a warning
  (`auto_update.failed`). Do not exit the process.
- Concurrent apply, including a second request that arrives while
  `fetchLatest` is still pending: 409 `in_progress`.
- Missing callbacks: 501 `unavailable`; no timer.
- `close()` always `stop()`s the timer, even if a tick is in flight.
  In-flight `applyUpdate` is not cancelled (the child/command owns
  install + restart).
- Failed lookup must never render as "up to date" (same rule as today's
  version check).

## Testing

Behavior tests only. Do not restate schema literals without a user-visible
outcome.

Minimum coverage:

- Config parse: omitted `autoUpdate` is `false`; `true` / `false` round-trip;
  `defaultServer` fixtures include `autoUpdate: false`.
- Settings GET includes `autoUpdate`. PUT persists it, does not set
  `restartRequired`, and preserves unknown `server` keys. PUT `true`
  calls `notifyCheck`.
- Controller: start checks once; a later interval tick runs again;
  disabled / unmanaged / up-to-date never call `applyUpdate`; outdated +
  enabled + managed calls it once; lock is taken before `fetchLatest` and
  a second apply during a deferred lookup returns `in_progress` without
  a second fetch; `applyUpdate` throw sets `failed` and allows a later
  apply; `applyUpdate` fulfill sets `restart_required`; `stop` prevents
  further ticks; missing `applyUpdate` never starts a timer.
- Release GET reports `managedService` and `update.status`. POST maps
  the apply results and `check_failed`.
- About UI: Switch writes `{ autoUpdate: true }`; unmanaged hint visible
  when `managedService` is false; Update now posts apply; in-progress
  disables the button; failed apply does not claim up to date;
  `restart_required` stops polling and shows the restart hint.

## Acceptance

- Default install does not phone npm on a timer and does not upgrade
  itself.
- Enabling the toggle on a managed service installs the current npm
  `latest` when it is newer, then the service comes back on the new
  version.
- Enabling the toggle on a foreground `run` persists the flag and does
  not install, even when a service unit file exists on the same machine.
- Update now installs without the toggle. A foreground process that
  survives the install reports `restart_required` instead of spinning
  until timeout.
- `aio-proxy upgrade` behavior and channel detection are unchanged.
- `bun run preflight` passes.

## i18n keys

Add under `dashboard.settings` in `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`:

| Key | en |
| --- | --- |
| `auto_update` | Automatic updates |
| `auto_update_description` | When aio-proxy is installed as a managed service, download and install new versions on startup and once a day. |
| `auto_update_unmanaged_hint` | Automatic install runs only under a managed service. This process will not install updates until you run aio-proxy service install. |
| `version_update` | Update now |
| `version_updating` | Updating… |
| `version_update_failed` | The update could not be installed. Try again or run aio-proxy upgrade. |
| `version_update_unavailable` | This process cannot install updates. |
| `version_restart_required` | Restart aio-proxy to run the installed version. |

Existing `version_check`, `version_outdated`, `version_up_to_date`, and
`version_check_failed` stay as they are.
