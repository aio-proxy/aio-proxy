# Notify-and-confirm aio-proxy updates

Date: 2026-09-07
Status: accepted

This spec supersedes `docs/superpowers/specs/2026-09-06-auto-update-design.md`.
`aio-proxy upgrade` remains the only installer. The process checks for a
newer npm `latest` in the background and tells the operator. It does
not install until they confirm.

Installer, managed-process detection, Cellar-only Homebrew, pnpm
virtual-store ExecStart, and Darwin in-job restart stay as implemented
on that earlier spec's Architecture section. This document replaces the
product model: no `server.autoUpdate` toggle, no tick-time install.

## Problem

A long-running proxy is easy to leave on an old build. Silent
background install is uncommon for a local developer tool and surprises
people. Operators who never open Settings still need a prompt they will
see. Operators who do open the Dashboard need a front-of-house confirm
control, not a buried Switch that installs on its own.

## Goals

- Check npm `latest` whenever the process is running: once at start,
  then every 24 hours, and again when the Dashboard mounts.
- Persist the last successful check so CLI, OS notification, and the
  Dashboard share one fact.
- Prompt on three surfaces: Dashboard sidebar banner, CLI banner, OS
  notification.
- Install only after confirm: sidebar / Settings **Update now**, or
  `aio-proxy upgrade`.
- Remove `server.autoUpdate` and the Settings Automatic updates row.

## Non-goals

- A tray icon (`Deno.Tray` has no Bun equivalent; no third-party tray
  daemon this cycle).
- OS timer units, interval UI, or a major/minor channel split.
- Windows, musl, or platforms outside the current published matrix.
- In-process binary replacement inside `@aio-proxy/server`.
- Changing brew / npm / bun / pnpm / curl install behavior.
- Auto-updating plugins, Agent hosts, or anything other than aio-proxy.
- Notification click-to-install (OS actions are unreliable).
- A dismiss-forever control on the sidebar banner.

## Product decisions

| Topic | Decision |
| --- | --- |
| Toggle | None. Checking does not need consent; installing does. |
| Schedule | Start, then every 24 hours, plus Dashboard mount |
| Versions | All newer npm `latest`, same as `aio-proxy upgrade` |
| Check gate | Any running CLI-hosted process (managed or `aio-proxy run`) |
| Install | Only Update now or `aio-proxy upgrade` |
| Shared state | `{aioHome()}/update-check.json` |
| OS notify | Once per newly seen `latest` (`notifiedVersion`) |
| Interval UI | None. Constant `24 * 60 * 60 * 1000` ms |

A leftover `server.autoUpdate` key in an existing config file is
ignored. Parse must not fail. Settings must not rewrite the file solely
to delete the key.

## Architecture

`@aio-proxy/server` never imports `@aio-proxy/cli`.

CLI `run` injects:

```ts
autoUpdate?: {
  readonly isManagedService: () => boolean;
  readonly applyUpdate: (version: string) => Promise<'installed' | 'unchanged'>;
  readonly notifyAvailable?: (latest: string) => void;
};
```

`applyUpdate` and managed-process / ExecStart / Darwin restart rules
are unchanged from the 2026-09-06 Architecture section.

`notifyAvailable` is optional. The controller calls it only when a
successful check finds `latest` newer than `current` and
`notifiedVersion !== latest`. The CLI implementation:

- Darwin: `osascript` `display notification` with the version in the
  title/body.
- Linux: `notify-send` when that binary exists.
- Missing binary, non-zero exit, or no graphical session: swallow.
  Checking must not fail because notify failed.

`isManagedService` still answers "was this process launched by the
unit?" It is **not** a check gate. It remains on `GET /release` for
any UI that still needs it, and `applyUpdate` still uses it for
post-install `serviceRestart()`.

### Check state file

Path: `join(aioHome(), 'update-check.json')`. Add `updateCheckPath()`
next to `aioHome` / `configPath` in `@aio-proxy/core`.

```ts
type UpdateCheckState = {
  readonly latest: string;
  readonly checkedAt: number;
  readonly notifiedVersion?: string;
};
```

`current` is always the running process version, never stored. CLI
banner and `outdated` compare `latest` to that process version.

A missing, unreadable, or schema-invalid file is treated as "no
check yet": no banner, no OS notify, `GET /release` omits `latest`
and reports `outdated: false`.

Writes are atomic (temp file + rename). `notifiedVersion` is updated
only after `notifyAvailable` returns (including a swallowed failure)
so a crash mid-notify can retry once, but a successful no-op notify
does not repeat every 24 hours.

### AutoUpdateController

Tick **never** calls `applyUpdate`. `start()` always schedules when
`fetchLatest` exists (it always does). Missing `applyUpdate` still
checks and persists; `POST /apply` stays `unavailable`.

```ts
type AutoUpdateSnapshot = {
  readonly status: 'idle' | 'in_progress' | 'failed' | 'restart_required';
  readonly latest?: string;
  readonly outdated: boolean;
};

type AutoUpdateController = {
  readonly isManagedService: () => boolean;
  readonly snapshot: () => AutoUpdateSnapshot;
  readonly check: () => Promise<
    { readonly current: string; readonly latest: string; readonly outdated: boolean } | { readonly status: 'check_failed' }
  >;
  readonly apply: () => Promise<AutoUpdateApplyResult>;
  readonly start: () => void;
  readonly stop: () => void;
};
```

`notifyCheck` is removed. Settings no longer triggers a check by
writing a toggle.

**Check** (start, interval, `GET /latest`):

1. If the apply lock is held, return the current snapshot without a
   second registry fetch (in-progress install already knows).
2. Fetch npm `latest` for `aio-proxy`. On failure: do not rewrite a
   successful previous state; do not notify; do not claim up to date.
   Apply-path `GET /latest` still returns `check_failed`. Tick-path
   failures stay quiet and retry next interval.
3. Persist `{ latest, checkedAt, notifiedVersion }`. Keep the previous
   `notifiedVersion` unless this check notifies.
4. If outdated and `notifiedVersion !== latest`, call
   `notifyAvailable(latest)` and persist `notifiedVersion: latest`.
5. Return `{ current, latest, outdated }`.

A check does **not** set snapshot `status` to `in_progress`. That
status is only for install. Concurrent checks may share one in-flight
fetch; they must not take the apply lock.

**Apply** (Update now / confirmed install):

Same lock, `started` / `up_to_date` / `in_progress` / `unavailable` /
`check_failed` mapping as today. No toggle recheck. No
`isManagedService` gate. `stop()` during lookup still skips install.

### Release HTTP

`GET /dashboard/api/release` (no registry):

```ts
{
  current: string;
  latest?: string;
  outdated: boolean;
  managedService: boolean;
  update: { status: 'idle' | 'in_progress' | 'failed' | 'restart_required' };
}
```

`latest` is absent when no successful check has been persisted.
`outdated` is true only when `latest` is present and
`Bun.semver.order(latest, current) > 0`.

`GET /dashboard/api/release/latest` calls `controller.check()` (or the
same fetch + persist when the controller is missing, without notify).
Dashboard mount and Settings "Check for updates" both use this
endpoint.

`POST /dashboard/api/release/apply` is unchanged.

### Config and Settings

Remove `autoUpdate` from `ServerConfigSchema`,
`DashboardSettingsViewSchema`, and `DashboardSettingsMutationSchema`.
Settings GET/PUT stop reading and writing it. `notifyCheck` on PUT
goes away.

### Dashboard

Lift release query/service out of the settings module to
`packages/dashboard/src/lib/release/` so the shell and Settings can
both import it. Modules must not import each other.

**Root layout** (authenticated shell only):

1. Subscribe to `GET /release` (cheap).
2. On mount, fire `GET /latest` in the background and invalidate
   `GET /release` when it settles.
3. A failed latest check leaves the last good `GET /release` data in
   place.

**Sidebar footer** (Claude Desktop-style card, above Logout):

- No update: render nothing.
- Outdated: a rounded card, visually separate from nav items. Title
  "Update available", supporting `{latest}`, solid **Update now**.
  The button is the confirm control and posts `/apply` (same mutation
  as Settings).
- Collapsed sidebar: the card does not fit — one upgrade icon with a
  dot; expand to see the card.
- `in_progress`: Updating…, disabled.
- `restart_required`: restart copy, no Update now, no
  `reloadDashboard()`.
- `failed`: card remains, error line, Update now still enabled.
- Check failure: no "update available" card.
- Not dismissible.

**Settings About**:

- Remove `settings-auto-update-row` and unmanaged-hint copy.
- Keep Check for updates and Update now. Mount-time `GET /latest`
  already refreshes About; Check remains a manual retry.

### CLI banner

After locale resolution, before the subcommand runs, read
`update-check.json`. If the running package version is older than
`latest`, print one line to stderr and continue.

Skip when:

- the invoked command is `upgrade` or `update`
- the user asked for `--version` / `-v`
- the file is missing or not outdated

Do not fetch the registry from the CLI banner path.

English shape: `aio-proxy {latest} is available. Run aio-proxy upgrade or open the Dashboard.`

### OS notification

Fired only from `controller.check()` via `notifyAvailable`. Copy
includes the version and points at the Dashboard or
`aio-proxy upgrade`. No install action.

## Data flow

```text
start / 24h timer / GET /release/latest
  -> fetch npm latest
  -> write update-check.json
  -> notifyAvailable once per new latest
  -> snapshot { latest, outdated }   // never applyUpdate

Dashboard shell mount
  -> GET /release (last persisted)
  -> GET /latest (async refresh)
  -> sidebar card if outdated

CLI (most commands)
  -> read update-check.json
  -> stderr banner if outdated

Update now / aio-proxy upgrade
  -> applyUpdate(pinned version)
  -> existing install + restart path
```

## Error handling

- Registry failure on tick: keep last good file, no notify, retry next
  interval. Do not render "up to date" or "update available".
- Registry failure on `GET /latest`: HTTP 502 `check_failed`. Sidebar
  stays on last good `GET /release`.
- `notifyAvailable` throw or non-zero: log, persist `notifiedVersion`
  anyway so the operator is not spammed, keep the daemon up.
- `applyUpdate` throw: `failed`, release lock, banner shows retry.
- Concurrent apply: 409 `in_progress`.
- Missing `applyUpdate`: 501 `unavailable`; checks still run.
- `close()` always `stop()`s the timer. An in-flight check may finish
  and persist. An in-flight apply is not cancelled.

## Testing

Behavior tests only.

- `update-check.json` round-trip; invalid file is "no check".
- Controller tick fetches and persists, never calls `applyUpdate`.
- Second check of the same `latest` does not call `notifyAvailable`.
- Newer `latest` calls `notifyAvailable` once.
- Failed fetch leaves the previous file intact.
- `GET /release` exposes persisted `latest` / `outdated` without
  fetching.
- `GET /latest` persists and returns outdated.
- Settings schemas and About UI have no `autoUpdate`.
- Config with leftover `autoUpdate: true` still parses.
- Sidebar card appears when outdated, hidden when current, collapsed
  icon when the sidebar is collapsed, Update now posts apply.
- CLI banner prints on a normal command when the file is outdated;
  silent for `upgrade` / `--version` / missing file.
- Existing apply / restart / Cellar / pnpm ExecStart tests stay.

## Acceptance

- A running process never installs solely because a check found a
  newer `latest`.
- Opening the Dashboard refreshes the check without blocking first
  paint.
- An outdated build shows the sidebar card, and (once) an OS
  notification, and a CLI banner on the next non-upgrade command.
- Update now and `aio-proxy upgrade` still install through the
  existing path.
- Config files that still contain `autoUpdate` boot.

## i18n keys

Add under `dashboard` (shell / settings) and `cli` in all five
locales:

| Key | en |
| --- | --- |
| `dashboard.update.available` | Update available |
| `cli.update.available` | aio-proxy {version} is available. Run aio-proxy upgrade or open the Dashboard. |
| `cli.update.notify_title` | aio-proxy {version} is available |
| `cli.update.notify_body` | Open the Dashboard or run aio-proxy upgrade. |

The sidebar button reuses `dashboard.settings.version_update`. The
supporting line is the raw `{latest}` version string (no extra sentence).

Remove `dashboard.settings.auto_update`,
`auto_update_description`, and `auto_update_unmanaged_hint`.

Existing `version_check`, `version_outdated`, `version_up_to_date`,
`version_check_failed`, `version_updating`, `version_update_failed`,
`version_update_unavailable`, and `version_restart_required` stay.
