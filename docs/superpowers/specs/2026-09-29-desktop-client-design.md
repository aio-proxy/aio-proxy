# macOS menu-bar desktop client

Date: 2026-09-29
Status: draft (rev 4, after two review rounds and the Phase 0 spike; results in `2026-09-29-desktop-spike-findings.md`)

## Goal

Ship a lightweight macOS menu-bar companion for aio-proxy. A user installs one `.app`, gets a running proxy without installing Bun or the CLI, and sees a summary panel anchored to a menu-bar icon: proxy status, last-24h usage, Provider health and quota, a 7-day trend, an activity heatmap, and quick actions.

The desktop app is a companion, not a second dashboard. Everything that edits configuration stays in the existing Web Dashboard, which the panel opens in the browser.

Windows and Linux are committed follow-ups. Phase 1 is macOS on Apple Silicon only, but the UI stack is chosen so the panel code carries over.

## Non-goals

- Re-implementing any Web Dashboard feature natively: Provider create/edit, OAuth flows, routing rules, API keys, trace payloads, JSON config editing, large log tables.
- Owning the proxy process. launchd owns it; the desktop app never runs aio-proxy as its own child.
- Changing an external (CLI-installed) service without an explicit user click.
- Intel Macs. macOS 26 is the last Intel release; Intel users keep the CLI.
- Windows and Linux in phase 1. On Linux the anchored popover is not achievable under Wayland (no client-side global positioning, no tray icon rect) and GNOME hides tray icons without an extension; that degraded design is a phase-2 decision.
- Live push (SSE) in phase 1. The panel polls while visible; see Refresh policy.
- A per-refresh CLI protocol. CLI commands are used only for discovery and lifecycle; data goes over HTTP.

## Platform baseline

- Architecture: `arm64` only.
- Minimum macOS: **13.0**, set by `SMAppService.mainApp` (launch at login).
- The value is propagated to `MACOSX_DEPLOYMENT_TARGET` (Rust build), `LSMinimumSystemVersion` (`Info.plist`), and `sparkle:minimumSystemVersion` (appcast), and the bundle step checks every Mach-O's `minos` (`vtool -show-build`) is ≤ 13.0, including the prebuilt Bun sidecar and Sparkle.
- Install location: the app only performs persistent operations (symlink, service, login item) when it runs from `/Applications` or `~/Applications` on a writable volume. Anywhere else (a mounted DMG, Downloads, a translocated path) it shows "Move to Applications" and runs read-only. This is a location policy, not translocation detection, which Apple provides no supported API for.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Panel UI | GPUI Kit (`gpui-kit` 0.7, Longbridge; formerly `gpui-component`) on GPUI `gpui-pre =0.3.7` | Cross-platform GPU UI with built-in area/bar/line charts and a plot layer; used in Longbridge Pro |
| Menu-bar icon | `tray-icon` crate | Neither GPUI nor GPUI Kit exposes a status item. `tray-icon` reports the icon rect on click (needed for anchoring) and covers Windows/Linux later |
| Panel window | GPUI `WindowKind::PopUp` | In gpui-pre 0.3.7 this is a non-activating `NSPanel` subclass at `NSPopUpWindowLevel` that joins all Spaces (titled with a full-size content view, not borderless); hide on deactivation via GPUI window-activation observation (hide-on-click-away still awaits a human check) |
| No Dock / Cmd+Tab | `LSUIElement` in `Info.plist` | Native, zero code. GPUI forces the `Regular` activation policy at launch, so the host also sets `Accessory` in its `run` callback |
| App launch at login | `SMAppService.mainApp` via objc2 | Native API, macOS 13+ |
| Updates | Sparkle 2.10.0, archive SHA-256 `c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`, via objc2 (`SPUStandardUpdaterController`) | Standard for non-App-Store apps; EdDSA-verified. Updates always go through Sparkle's "Install and Relaunch", never a silent install (see Release job and feed) |
| Local HTTP | A minimal HTTP/1.1 client over std `TcpStream` on a thread, cancelled by `shutdown` from a drop guard owned by the GPUI task | Spike check 2: the only measured stack meeting every transport rule. GPUI's `ReqwestClient` always starts its own tokio runtime, which costs one permanent thread, about 3 MiB RSS and 1.9 MB footprint, plus about 6 MiB of binary; `reqwest::blocking` cannot be cancelled |
| Proxy | The existing Bun standalone binary from `packages/cli/scripts/build-binary.ts` (`darwin-arm64`) | Already built and resigned in CI |
| Toolchain | Root `mise.toml` for local dev, reading `.bun-version` and `desktop/rust-toolchain.toml` | Each tool keeps one version source; CI reads the same files |

GPUI Kit pins an exact `gpui-pre` snapshot because snapshots break API. The desktop crate pins `gpui-kit` exactly and bumps it deliberately.

## Service model

The desktop app does not spawn the proxy. The proxy runs as the existing launchd user agent (`com.aio-proxy.agent`); the desktop app observes it through the bundled CLI and HTTP, and changes it only under the rules below.

### Bundled binary and stable symlink

- The `.app` ships `Contents/MacOS/aio-proxy` next to `Contents/MacOS/aio-proxy-desktop`.
- A desktop-owned plist points at `~/Library/Application Support/aio-proxy-desktop/bin/aio-proxy`, a symlink to a bundled binary, never into a bundle directly. After a Sparkle update the symlink already resolves to the new binary; the running process keeps its old inode until restart.
- **Single instance:** the app takes an exclusive `flock` on `~/Library/Application Support/aio-proxy-desktop/instance.lock` at launch. A second copy exits.
- **No downgrade:** before re-pointing, the app runs `<current target> --version`. It re-points only when the target is missing or not newer than its own bundled version. If an installed copy is newer, this copy runs read-only with a notice naming that copy's path.
- Re-pointing is create-temp-symlink + `rename`, and only happens after the install-location check passes.

### Discovery: `__desktop-connect`

A hidden CLI command, run through the symlink (or the bundled binary before the symlink exists), prints one JSON object on stdout and nothing else; human-readable messages go to stderr. It separates facts that rev 2 conflated:

```json
{
  "protocolVersion": 1,
  "bundledVersion": "0.37.0",
  "unit": {
    "present": true,
    "wrapperValid": true,
    "target": "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
    "home": "/Users/me/.aio-proxy",
    "owner": "desktop"
  },
  "job": { "loaded": true, "disabled": false, "pid": 4310 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "ppid": 4310,
    "matchesJob": true
  },
  "token": "<local token or null>"
}
```

- **`unit`** comes from parsing the plist. The aio-proxy path is not `ProgramArguments[0]` (that is `/bin/sh`); `wrapperValid` requires `ProgramArguments` to be exactly `["/bin/sh", "-c", <known wrapper>, <target>]`, and `target` is the fourth element. `home` is the plist's `AIO_PROXY_HOME`. `owner` is `desktop` when `target` equals the symlink path, `external` for any other valid target, `unknown` when the wrapper is not recognized, `null` when no plist exists.
- **`job`** comes from `launchctl print gui/<uid>/com.aio-proxy.agent` (loaded, pid) and `launchctl print-disabled gui/<uid>` (disabled). The disk plist and the loaded job can differ; both are reported. `job.pid` is the `/bin/sh` wrapper launchd started, not the sidecar: the sidecar is the wrapper's child in the same process group.
- **`instance`** resolves the address with `AIO_PROXY_HOME` set to `unit.home` (the service's own config, not the calling process's environment), else the default home. A wildcard bind maps to its loopback (`0.0.0.0` → `127.0.0.1`, `::` → `::1`); a non-loopback bind yields `controlUrl: null` and no token is ever sent. `version`, `pid` and `ppid` come from `GET /dashboard/api/desktop-summary` (authenticated; `server.version`, `server.pid`, `server.ppid`), not `/health`, so an instance is identified by a credential only a same-user process can read. `matchesJob` is `instance.pid == job.pid || instance.ppid == job.pid`, and `null` when `instance.pid` or `job.pid` is unknown (an older instance without `desktop-summary` reports `version` from `/health` and `pid: null`, `ppid: null`); `null` counts as not matching for automation. A sidecar reparented to launchd (ppid 1, wrapper gone) does not match, so it gets no automation.
- **`token`** is read from `<home>/desktop-token`; `null` if absent or failing the file checks below.
- Failure: a step that fails degrades its own fields. If discovery throws anyway, the command still prints one object: `unit.present: true`, `owner: "unknown"`, `job` not loaded, `instance` unreachable, `token: null`. It never reports `owner: null`, which means "no plist" and would trigger a fresh install.
- Timeouts: 10s for the whole command, enforced by the CLI. Each HTTP probe gets 2s, and the helper processes (`plutil`, `launchctl`) share the remaining 6s; a helper still running when that budget ends is killed and its fields degrade.

**Environment contract.** The app runs `__desktop-connect`, and every `service` command it issues, with `AIO_PROXY_DESKTOP_EXEC=<symlink path>` in the child's environment. It is the only input for `owner: desktop` (the CLI never guesses the app's symlink), and it is what makes `service install`/`restart` write a desktop-owned plist (CLI changes). A run without it reports a desktop plist as `external`, the safe direction.

### What the app does automatically

Automatic mutation requires **`owner: desktop` and either `matchesJob: true` or no reachable instance**, plus a valid install location. Everything else is read-only until the user clicks.

| State | Automatic action |
| --- | --- |
| No plist | `service install` + `service start` (fresh install; the app now owns the service) |
| Desktop, loaded, enabled, no process | `service start` (which kickstarts, see CLI changes) — the recovery path after a dangling-symlink exit or an external SIGTERM. One attempt per app launch; on failure show the error, no retry loop (a broken config's exit 1 is remapped to 0 and looks identical, so retrying would loop) |
| Desktop, not loaded, enabled | `service start` |
| Desktop, disabled | Nothing. The user stopped it; show Stopped with a Start button |
| Desktop, running, `instance.version < bundledVersion` | `service restart`, then wait up to 30s for the pre-restart `instance.pid` to be gone and `/health` reporting `bundledVersion`. One attempt per app launch; on failure show the error, no retry loop |
| Desktop, running, `instance.version >= bundledVersion` | Nothing (never downgrade) |
| External or unknown owner, or `matchesJob: false` | Nothing, ever. Buttons act only on click |

The version-triggered restart interrupts in-flight requests: `shutdownProxyServer` is not a drain (`app.close()` then `server.stop(true)`), and `aio-proxy run` force-exits 3 s after SIGTERM (CLI changes). This is an accepted product decision for phase 1. The restart runs when the app relaunches after Sparkle's "Install and Relaunch", which the user has already consented to.

Every mutating command re-runs `__desktop-connect` first and aborts if ownership, `matchesJob` or `job.disabled` changed since the panel rendered. An automatic `service start` therefore never undoes a user stop that landed between discovery and the start (`service start` runs `launchctl enable`).

### User actions

| Action | Desktop owner | External owner | Unknown owner / no plist |
| --- | --- | --- | --- |
| Start | `service start` | `service start` (does not rewrite an installed plist) | Not offered |
| Restart | `service restart` (rewrites the plist to the symlink) | `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent` (never rewrites the plist) | Not offered |
| Stop | `service stop` | `service stop` | Not offered |
| Reload config | `POST /admin/reload` (loopback, no auth) | same | same |

Completion conditions differ per action: Restart waits for the pre-restart `instance.pid` to be gone and `/health` with the expected version (this is the guard against the inferred case where an old sidecar outlives SIGTERM, the new instance fails to bind and exits, and the old binary keeps serving); Stop waits for `job.pid == null` and the instance unreachable; Reload reports the response (`409` carries `error` and `stage`). Then the panel refetches.

`service restart` is never used on an external service: `writeManagedUnit` rewrites the plist with the invoking binary.

"Proxy starts at login" is the launchd job itself (`RunAtLoad`). "App starts at login" is a separate toggle backed by `SMAppService`, whose UI reflects the real status including "requires approval" (with a link to System Settings).

### Dangling symlink

The launchd plist uses a conditional `KeepAlive` (`SuccessfulExit = false`); the `/bin/sh` wrapper already maps exit 1 to 0 so launchd does not relaunch on unrecoverable config errors. The wrapper gains `[ -x "$0" ] || exit 0` before `"$0" run`, so a missing executable is a clean exit launchd does not relaunch. The job stays loaded; recovery is the "loaded, enabled, no process" row above, which requires `service start` to kickstart a loaded job (CLI changes). The spike measured one extra run and two launchd log lines in 10 minutes with the app deleted; restoring the executable alone does not revive the job.

### Stop and restart signals

- `launchctl kickstart -k`, `bootout` and `unload` signal the job's main pid (the wrapper, which dies at once), then SIGTERM the rest of its process group. The sidecar therefore gets a graceful SIGTERM on every stop and restart path. The wrapper stays as it is; a trap-forwarding variant would only change the recorded exit code.
- launchd never escalates to SIGKILL for the orphaned group (observed with a stand-in that ignores SIGTERM). `shutdownProxyServer` stops the listener synchronously once the handler runs, but outbound connections or timers can keep the process alive afterwards. `aio-proxy run` therefore bounds how long an orphan outlives SIGTERM (CLI changes). The stale-binary guard is the Restart completion condition above, not this deadline.
- A graceful SIGTERM exits 0, which `SuccessfulExit = false` does not relaunch. A SIGTERM launchd did not send (the user, `pkill`) therefore leaves the service down until the automatic table, or the user, starts it.

### Health check

- `GET /health`, 2s timeout; two consecutive failures mark the proxy down.
- Updates the tray icon and triggers rediscovery. Never mutates anything by itself; the automatic-action table is the only mutation path, and crash recovery is launchd's `KeepAlive`.
- Every 60s, plus immediately on panel open and on wake (`NSWorkspaceDidWakeNotification`).

## Server and CLI changes

### Local token

| Property | Rule |
| --- | --- |
| Value | 32 bytes from the OS CSPRNG, base64url |
| Location | `$AIO_PROXY_HOME/desktop-token` |
| Created by | The server at boot, if absent. The CLI only reads. |
| Creation | Temp file opened `O_CREAT \| O_EXCL` with mode `0600`, written, then `link()` to the final name (fails if another process won; the loser reads the winner's file), then unlink temp |
| Read checks | Open with `O_NOFOLLOW` (a symlink fails) and `O_NONBLOCK` (a FIFO cannot block), then `fstat` the descriptor: regular file, owned by the current uid, no group/other permission bits; read from the same descriptor. A failing check or an unreadable file means "no token" plus a logged reason from a closed set (`not_regular_file`, `foreign_owner`, `insecure_mode`, `unreadable`, `malformed`, or `unwritable` when the server cannot create it); permissions are never widened or repaired silently |
| Lifetime | Loaded by the server once at boot. Persistent across restarts, reinstalls, and app updates. Rotation = replace the file and restart the proxy |
| Transport to the app | The stdout pipe of `__desktop-connect`. Never an environment variable or URL |
| Transport to the server | `Authorization: Bearer` |
| Logging | The Rust token type has a redacting `Debug`; the app never logs `__desktop-connect` stdout or `Authorization` |

This is a same-user local credential, not proof that the caller is the official app.

**Accepted exposure: whoever answers the port.** Discovery sends the token to whatever answers `GET /health` with `status: "ok"` on the configured loopback address. While the proxy is down, another local process can bind that port, including one run by a different user on a shared Mac, answer `/health`, and receive the token. The impact is capped by the scope below: the token reads one summary and grants nothing else, and it keeps working only until the file is replaced and the proxy restarted. Pinning the listener (for example by checking its pid against `job.pid`) is not done in phase 1.

**Scope.** The token authorizes exactly one route: `GET /dashboard/api/desktop-summary`. That route has its own guard and always requires the desktop token, with or without a dashboard password. It is exempted from the dashboard session middleware; `DashboardAuthentication.verify()` is not changed, so the token is never a dashboard session. No other route accepts it. Being a `GET`, it never touches the CSRF guard.

**Loopback.** The route accepts the token only when `isDashboardLoopbackRequest` passes, which uses the socket peer from Bun's `requestIP` (`127.0.0.0/8`, `::1`, `::ffff:127.*`), not `Host`, `Origin`, or `X-Forwarded-For`. `requireLoopbackHost` also runs in front of `/dashboard/api/*`, but only when no dashboard password is set; the design does not rely on it.

**401 handling (client).** Re-run discovery once to pick up a replaced token. Still 401: show "authentication failed", never restart the proxy.

### CLI

- `__desktop-connect` as specified above.
- `serviceStart` on macOS: `launchctl enable gui/<uid>/com.aio-proxy.agent` (clearing the override `service stop` leaves, as `load -w` did). Then `launchctl kickstart gui/<uid>/com.aio-proxy.agent` when the job is already loaded (`load -w` does not start a loaded job), or `launchctl bootstrap gui/<uid> <plist>` when it is not. Success is then verified with `launchctl print gui/<uid>/com.aio-proxy.agent`, never taken from an exit status: legacy `launchctl load` exits 0 on "Load failed: 5". `serviceRestart` outside the job does `launchctl bootout`, waits up to 10s for `launchctl print` to stop finding the job (bootout can return while teardown is still in progress), then runs the same sequence, so the rewritten plist is re-read. A job still present after the wait is an error. Benefits CLI users too.
- `aio-proxy run` force-exits with code 0 3 s after SIGTERM or SIGINT if the event loop has not drained, because launchd never escalates. This bounds orphan lifetime and background work after a stop. Exit 0 keeps a forced stop identical to a clean one for `KeepAlive`.
- `resolveAgentExecutable` checks `AIO_PROXY_DESKTOP_EXEC` first, before PATH and realpath resolution, and returns it verbatim (not passed through `resolveStableManagedExec`, so the symlink is never resolved into the bundle).
- When `AIO_PROXY_DESKTOP_EXEC` is set, `writeManagedUnit` writes the plist environment with `AIO_PROXY_DESKTOP_EXEC=<symlink>` and `AIO_PROXY_UPGRADE_METHOD=desktop`, skipping upgrade-method detection. Because the running daemon then inherits `AIO_PROXY_DESKTOP_EXEC`, every later rewrite from inside it (including `migratePreMarkerManagedUnit` at `run` startup) keeps the symlink and the marker. `UnitOptions.upgradeMethod` gains `'desktop'`.
- **No self-upgrade of desktop binaries.** `runUpgradeCommand` is the shared write path for `aio-proxy upgrade`, Dashboard "apply update" (`/dashboard/api/release/apply` → auto-update hooks), and background auto-update. It refuses when `AIO_PROXY_UPGRADE_METHOD=desktop` or the executable resolves inside a `.app` bundle, returning a result that tells the user to update through the desktop app. A desktop-managed sidecar also wires no `applyUpdate` and no update notification, so the Dashboard reports the update action as unavailable instead of offering one that fails.
- **CLI upgrades leave a desktop-owned service alone.** A desktop-owned plist is one whose wrapper target equals its own `AIO_PROXY_DESKTOP_EXEC` marker. When one is installed, a CLI `aio-proxy upgrade` (for example Homebrew's) installs its own copy but skips the managed-service restart and prints a hint. That restart would rewrite the app's plist to the CLI binary and flip the owner to `external`.
- The launchd wrapper guard described above.

### Quota cache additions

The cache keeps successes in `entries`, first failures in `failures`, permanently unsupported Providers in `unsupported`, and running reads in `inFlight`. A peek of `entries` alone cannot tell "loading" from "first read failed". Two additions:

- `status(providerId)`, synchronous: `unsupported` | `failed` (in `failures`, no entry) | `ready` (entry; its `stale` flag means "last refresh failed, showing the previous snapshot", not "old") | `loading` (in flight, no entry) | `none`.
- `refresh(providerId)`: starts a background read bypassing cooldown, through the same `start()` so in-flight dedupe and generation isolation still apply. Never awaited by callers.

Read timeouts are already enforced by the host, not just signalled: `withOAuthAccountContext` wraps the plugin call in `withAbort(request.signal, …)` so a plugin that ignores its signal cannot hold the read past the cache's 15s `AbortSignal.timeout` (`oauth-account-context.ts`). A test still pins that `inFlight` clears after the timeout.

### `GET /dashboard/api/desktop-summary`

> The panel refinement in `2026-10-01-desktop-panel-design.md` replaces `usage24h`/`trend7d` with a `?range=`-driven `usage` block and adds `accountLabel`, `quota.plan` and `diagnostic.suggestedCommand`; that document is authoritative for the DTO below.

One versioned endpoint rather than several dashboard-internal ones: when the app attaches to an instance of a different version, this DTO is the contract. It is an explicit mapping, never a spread of internal objects.

```ts
type DesktopSummaryV1 = {
  protocolVersion: 1;
  generatedAt: string;                 // RFC 3339, UTC
  server: { version: string; pid: number; ppid: number }; // ppid: process.ppid, the launchd wrapper for a managed service
  usage24h: {
    requests: string;                  // decimal integer strings, like the existing overview API
    failedRequests: string;
    inputTokens: string;
    outputTokens: string;
    estimatedCostNanoUsd: string;
    pricingCoverage: number | null;    // 0..1; null when nothing was priceable
  };
  trend7d: Array<{ start: string /* bucket start, RFC 3339 */; requests: string; totalTokens: string; estimatedCostNanoUsd: string }>;
  activity: Array<{ date: string /* YYYY-MM-DD */; totalTokens: string }>; // up to 365 days
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
    diagnostic: { code: string; summary: string } | null;
    quota:
      | { status: 'none' | 'unsupported' | 'loading' | 'failed' }
      | { status: 'ready'; sampledAt: string; refreshFailed: boolean;
          windows: Array<{ id: string; label: string | Record<string, string>; remainingRatio: number | null;
                           resetsAt: string | null; windowMinutes: number | null }> };
  }>;
  alerts: Array<{ providerId: string; kind: 'diagnostic' | 'quota_exhausted'; message: string }>;
};
```

Sources:

| Field | Source |
| --- | --- |
| `usage24h` | `traceStore.overview({ range: '24h', metric: 'requests', groupBy: 'provider' }).summary` (`requestCount`, `failureCount`, tokens, cost, `pricingCoverage`) |
| `trend7d` | `traceStore.overviewDashboard({ range: '7d' }).modelTrendByMetric.{requests,tokens,cost}.buckets`, summing each bucket's per-model values |
| `activity` | `traceStore.overviewDashboardActivity().items` (the existing heatmap source counts tokens, not requests) |
| `providers` | `state.providerSummaries({ probe: false })` (`state.status` + `diagnostic`, `enabled`) + `quotaCache.status()`; quota items map 1:1 to windows. Probe-only fields (`last_status`, `last_latency`) are omitted because they are `unknown` without a probe |
| `alerts` | A provider diagnostic, or any quota window with `remainingRatio === 0` |

Compatibility: Rust parses `protocolVersion` first and only then the body; unknown fields are ignored; unknown enum values map to an `Unknown` variant. "Today" is the existing rolling 24h window. One Provider's quota failure is reported on that Provider and never fails the response.

`?refresh=true` calls `quotaCache.refresh()` for quota-capable Providers and returns immediately with current state.

#### Why quota never blocks

Measured on a live 0.35.1 instance (6 Providers, 25 MB DB, median of 30):

| Call | Latency |
| --- | --- |
| `overview?range=24h` | 3.33 ms |
| `overview?range=7d` | 0.20 ms |
| `overview/activity` | 0.68 ms |
| `providers` | 0.11 ms |
| All four sequential / parallel | 3.48 ms / 3.28 ms |
| Quota, cache hit | 6–13 ms per Provider |
| Quota, cache miss (upstream) | 690–1320 ms per Provider |

Local aggregation costs the same in one endpoint or four: SQLite reads are synchronous on a single-threaded server. The summary then only reads `status()` and calls the existing `warm()`; it holds no quota promise.

The spike re-measured the three trace queries on synthetic 1 GB trace DBs (warm page cache):

- 31 ms median (33 ms p95) at 36k requests per 24 h.
- 4.8 ms at 4k requests per 24 h.

Only the 24h overview reads spans, at about 0.8 µs per request in the window, so cost is linear in 24h traffic and nearly independent of DB size. The 50 ms budget holds up to roughly 55-60k requests per 24 h. At the refresh policy below (at most every 15s, only while the panel is open) that event-loop hold is accepted without a cache or rollup. An hourly rollup is the upgrade if a user exceeds the ceiling.

### Refresh policy (client)

| Trigger | Response |
| --- | --- |
| Panel opens | New panel session; fetch immediately |
| Every 15s while open | Fetch |
| User action completes | Fetch (after the action's own completion condition) |
| Any Provider `loading` after a fetch | One shared refetch after 2s; still `loading` afterwards → keep rendering it until the next 15s tick |
| Manual refresh | Fetch with `?refresh=true` |
| Panel closes | Cancel the in-flight request and all timers |

- At most one request in flight, 5s deadline. A trigger during a request marks dirty; one more fetch runs when it finishes, subject to the 15s floor except for panel-open, user actions, and manual refresh.
- Every response is tagged with (panel session, instance identity, request counter); a response from a closed session, a different instance, or an older counter is discarded.

### Local HTTP transport rules

- A dedicated client for the local instance: no proxy (ignores system and environment proxy settings), no redirects, connect timeout 1s, request timeout 5s.
- It is the std `TcpStream` HTTP/1.1 client from the Stack table; it speaks only to `127.0.0.1`/`::1` over plain HTTP. The 5s limit is a total deadline raced against the whole request, not a per-read socket timeout. It decodes `Transfer-Encoding: chunked` and caps the response size.
- The token is attached only when the URL host is a literal loopback IP (`127.0.0.1` or `::1`); never to a hostname, never to a non-loopback address.
- The token is never set as a default header on any client.

## Desktop app structure

One Cargo binary crate at `desktop/`, outside the Bun workspace.

| Module | Responsibility |
| --- | --- |
| `main.rs` | GPUI application, single-instance lock, tray creation, wake notification, `--version` |
| `tray.rs` | `tray-icon` setup; left click toggles the panel with the icon rect; right click opens a native menu carrying every service action (contents: `2026-10-01-desktop-panel-design.md`, Right-click menu); three icon states |
| `panel/` | PopUp placement (below the menu bar, centered on the icon, clamped to the icon's screen) and views: header, then one scrolling body of Usage (window switch, metric cards, trend, Top models, By Provider), Quota and Last 12 months groups, and a footer (layout: `2026-10-01-desktop-panel-design.md`) |
| `install.rs` | Install-location policy, symlink maintenance and no-downgrade rule |
| `connect.rs` | `__desktop-connect` invocation and parsing, automatic-action table, user actions with completion conditions |
| `client.rs` | Local HTTP transport and the refresh policy |
| `summary.rs` | `DesktopSummaryV1` types; version-first parsing |
| `login_item.rs` | `SMAppService.mainApp` register/unregister/status |
| `updater.rs` | Sparkle controller on the main thread. Implements `SPUStandardUserDriverDelegate` gentle-reminder support: Sparkle warns that a background (`LSUIElement`) app gets no gentle reminders, and every update goes through the UI dialog |

Panel details:

- No arrow, matching arrowless system menu-bar popovers such as Control Center.
- The heatmap is a plain grid of cells; GPUI Kit has no heatmap component and a fixed 365-cell grid does not need one.
- Window lifecycle on close: **hybrid** (PROVISIONAL until the human flash and on-screen latency checks, and the unlocked 100-cycle run of hybrid with animation None, which the spike did not measure).
  - Destroy the window and its Metal surface. Keep the summary model and last response in an app-level entity, so a reopen renders the last numbers at once.
  - Set `NSWindowAnimationBehaviorNone` on the GPUI panel right after creation, reached through `HasWindowHandle`. AppKit's default utility-window animation otherwise runs on its own thread for every open and close.
  - If the checks argue against hybrid, fall back to plain destroy (the same code without the cached model). Hide/show fails the closed-panel budget.
- Anchor the panel only from a click (or on a later runloop turn): the status item's frame is zero right after `tray-icon` builds it.
- "Open logs" (right-click menu) reveals `$AIO_PROXY_HOME/logs` in Finder. The app's own log goes to `~/Library/Logs/aio-proxy-desktop/`.
- An instance whose `desktop-summary` is missing (404, older version) or has an unsupported `protocolVersion` gets a degraded panel: status, endpoint, Open Dashboard, Reload.

## Build, sign, release

### Bundle command

`bun run desktop:bundle` (`desktop/scripts/bundle.ts`) is the only entry point for CI and release:

1. Verify tools (`cargo`, `codesign`, `xcrun notarytool`, `xcrun stapler`, `vtool`, pinned Sparkle tools) and fail fast.
2. `bun run build` (includes the dashboard `dist` the compiled entry embeds).
3. `build-binary.ts darwin-arm64 <out>`; require `THIRD_PARTY_NOTICES` next to it.
4. `cargo build --release --target aarch64-apple-darwin` with `MACOSX_DEPLOYMENT_TARGET=13.0`. `build.rs` links `Sparkle.framework` and adds the rpath `@loader_path/../Frameworks`.
5. Assemble the `.app`:
   - `Contents/MacOS/aio-proxy-desktop`, `Contents/MacOS/aio-proxy`
   - `Contents/Frameworks/Sparkle.framework`, from the pinned `Sparkle-2.10.0.tar.xz` (SHA-256 checked on the archive), extracted with `tar -xJf` and copied with `ditto` so symlinks stay intact
   - `Contents/Resources/THIRD_PARTY_NOTICES` (aio-proxy's plus Sparkle's license)
   - `Info.plist`: `CFBundleIdentifier`, `CFBundleExecutable`, `CFBundleName`, `CFBundleDisplayName`, `CFBundlePackageType` (`APPL`), `CFBundleInfoDictionaryVersion` (`6.0`), `CFBundleShortVersionString`, `CFBundleVersion`, `LSUIElement`, `LSMinimumSystemVersion`, `SUFeedURL`, `SUPublicEDKey`, `SUAllowsAutomaticUpdates` (`false`). `SUAutomaticallyUpdate` is never set: Sparkle's silent install-on-quit does not relaunch the app, which would defer the proxy restart to the next launch
6. Checks: `lipo -archs` is exactly `arm64` for the host and the sidecar, and includes `arm64` for Sparkle's Mach-Os (2.10.0 ships them universal and they are kept as shipped); `vtool -show-build` `minos` ≤ 13.0 for every Mach-O (measured: sidecar 13.0, Sparkle 12.0); `aio-proxy-desktop --version` runs (proves dyld resolves Sparkle through the rpath).
7. Runtime smoke (below).
8. `--unsigned` stops here with an ad-hoc signature; `--release` continues to Developer ID signing and notarization. Both re-run the runtime smoke on the signed bundle and require the `JS JIT Generated Code` region in `vmmap` (falling back to `sudo -n vmmap`). The `.dmg` holds the app and a link to `/Applications`.

Version: `CFBundleShortVersionString` and `CFBundleVersion` are both the `version` of `npm/aio-proxy/package.json` (the product package; lockstep through the Changesets `fixed` group). A stable `X.Y.Z` is monotonic and Sparkle compares it correctly. Canary builds skip the desktop, so prerelease strings never reach `CFBundleVersion`; if desktop prereleases ship later, add a numeric build number then.

### Runtime smoke

Against the assembled bundle, with a temporary `AIO_PROXY_HOME` holding a minimal config on a free port, and `PATH=/usr/bin:/bin` (no Bun, Node, or user tools): start `aio-proxy run` from the bundle, then check `/health` reports the bundle version, `/dashboard` returns HTML and one asset it references returns 200, and `desktop-summary` answers 200 with the token from the temp home; then SIGTERM it. It never installs a launchd job.

### Signing and notarization

The sidecar's entitlements are a committed, fixed file (`desktop/entitlements/aio-proxy.plist`) with a comment justifying each key. It holds **only `com.apple.security.cs.allow-jit`**.

- The spike started from Bun's documented standalone set and re-ran the full workload for each variant: proxied requests, an installed AI SDK package, SQLite, and JIT presence.
- Only a JIT-capable key matters. Without one, JavaScriptCore silently falls back to the interpreter: every functional step still passes, but the `JS JIT Generated Code` region disappears from `vmmap` and requests are about 30% slower.
- `allow-jit` is the narrowest such key. `allow-unsigned-executable-memory` and `disable-executable-page-protection` also work but grant more.
- `allow-dyld-environment-variables` and `disable-library-validation` were never exercised. **Plugins with native addons (`.node`, `dlopen`, `bun:ffi`) are unsupported under the desktop sidecar.** Revisit only if a real plugin needs one.
- Proven with ad-hoc hardened-runtime signatures; the Developer ID re-run and the OAuth Provider step are still pending.

JIT is verified by that `vmmap` region, never by the sidecar starting.

The host executable gets **no entitlements** under Developer ID: it and `Sparkle.framework` share a Team ID, so library validation passes (pending Developer ID confirmation). An ad-hoc hardened-runtime signature has no Team ID, so library validation rejects Sparkle. An ad-hoc hardened build (CI smoke only, never a release) therefore gives the host `disable-library-validation`. Signing the `.app` re-signs its main executable, so a host entitlement must be passed on the `.app` step. The release script never adds entitlements. Sparkle's components never receive the sidecar's file.

`build-binary.ts` ad-hoc resigns Bun output (its comment says the arm64 signer was fixed in Bun 1.4.1 and the x64 target still fails); the Developer ID signature replaces it either way.

Order:

1. Sign inside-out with Developer ID, hardened runtime, and `--timestamp` (`codesign -f -s "$ID" -o runtime --timestamp`), following Sparkle 2.10.0's documented procedure. `--deep` is never used for signing. The order:
   1. `Sparkle.framework/Versions/B/XPCServices/Installer.xpc`
   2. `Sparkle.framework/Versions/B/XPCServices/Downloader.xpc`, with `--preserve-metadata=entitlements`
   3. `Sparkle.framework/Versions/B/Autoupdate`
   4. `Sparkle.framework/Versions/B/Updater.app`
   5. `Sparkle.framework`
   6. `Contents/MacOS/aio-proxy`, with `--entitlements desktop/entitlements/aio-proxy.plist`
   7. `Contents/MacOS/aio-proxy-desktop`
   8. the `.app`

   Re-signing `Autoupdate` without `--preserve-metadata` drops its upstream `application-identifier` entitlement, as Sparkle's docs do.
2. `codesign --verify --deep --strict --verbose=2` on the `.app` (structure only; Gatekeeper assessment of an un-notarized app is expected to fail and is not a gate here).
3. Zip with `ditto -c -k --keepParent`, `notarytool submit --wait`, `stapler staple` the `.app`.
4. Gatekeeper assessment of the `.app`: `syspolicy_check distribution` and `spctl --assess --type execute`.
5. Build the `.dmg` from the stapled `.app`, sign it, `notarytool submit --wait`, `stapler staple`.
6. `spctl --assess --type open --context context:primary-signature` on the `.dmg`; `stapler validate` on both.
7. EdDSA-sign the final `.dmg` bytes (via `generate_appcast --ed-key-file`) and verify against `SUPublicEDKey`. This is done by `desktop:publish` (`generate_appcast` on stdin, then its own verification), not by the bundle script.

### Release job and feed

- The macOS build is `.github/workflows/desktop-release.yml`: dispatch-only with a `tag` input, on the pinned arm64 label `macos-15` (the runner is per job, so it cannot be a step in the existing Linux job). It sets up Bun from `.bun-version` and Rust from `desktop/rust-toolchain.toml` with `rustup target add aarch64-apple-darwin`, and holds the job-level `desktop-feed` concurrency group because every run replaces the same `appcast.xml`. `bun run desktop:publish --version X.Y.Z` is its build step; `desktop/RELEASING.md` is the maintainer runbook.
- `release.yml`'s `desktop` job (`needs: release`, gated on `published`) only dispatches it: `gh workflow run desktop-release.yml --ref main -f tag=v<version>`. The desktop publish therefore runs as its own workflow run and never holds the release concurrency group for the ~90-minute build, and its failure does not fail the release run. Dispatching the workflow again with the tag resumes a failed publish for the same immutable version without re-running the npm publish.
- Idempotence: if `aio-proxy-<version>-arm64.dmg` already exists on the tag's Release, the job downloads it and re-verifies it instead of rebuilding; it never uploads different bytes under the same name.
- **Feed.** `SUFeedURL` is `https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml`: a dedicated prerelease tag `desktop-feed` that never becomes "latest" and holds only `appcast.xml`. The Changesets Release becoming latest therefore never affects the feed.
- Publish sequence, with the feed upload as the single commit point:
  1. Upload the `.dmg` to the version's Release (or reuse it, above).
  2. Verify the versioned URL `https://github.com/aio-proxy/aio-proxy/releases/download/v<version>/aio-proxy-<version>-arm64.dmg` answers 200.
  3. Download the current `appcast.xml` from `desktop-feed`.
  4. Run the pinned `generate_appcast` with that file beside the new `.dmg`, `--download-url-prefix` set to the versioned Release URL, `--maximum-versions 3` stated explicitly, and `--versions <version>` so only this version is added. It reads prior items from the existing XML; old `.dmg` files are not needed locally (measured). Before the upload, `desktop:publish` checks the regenerated feed: exactly one new item with the versioned URL, the DMG's length, `sparkle:minimumSystemVersion` 13.0, and a `sparkle:edSignature` that verifies (Ed25519) against the app's `SUPublicEDKey`; the prior items are the newest ones, unchanged. `generate_appcast` exits 0 and writes an unsigned enclosure when the key does not match, so this check is the only guard. A version the feed already lists is re-verified, not regenerated; one older than the feed's newest is not added. A `desktop-feed` Release that exists without a readable `appcast.xml` item stops the job; only a missing Release starts a fresh feed (there is no appcast backup: deleting the Release is the deliberate way to start over). Before building and before uploading, `desktop:publish` checks the key pair (the public key derived from `SPARKLE_ED_PRIVATE_KEY` equals `SPARKLE_PUBLIC_ED_KEY` equals the DMG's `SUPublicEDKey`), and it reads the feed before the irreversible `.dmg` upload: it refuses to upload when the feed already lists the version but the DMG is not on the Release.
  5. `gh release upload desktop-feed appcast.xml --clobber`. The replace has a brief window where the feed 404s; Sparkle treats that as a failed check and retries on its schedule.
- Canary releases skip the desktop job.
- New secrets: Developer ID certificate (p12 + password), App Store Connect API key for `notarytool`, Sparkle EdDSA private key.
- **The EdDSA private key is the update root of trust.** Sparkle 2 logs a code-signature mismatch between the running and the new app but still installs when the EdDSA signature verifies (observed with ad-hoc builds). So whoever holds this key can ship an update. It exists only as a CI secret, reaches `generate_appcast` only on stdin (`--ed-key-file -`), is kept out of child-process environments (the build's included; env stripping is hygiene, not an isolation boundary, since same-user processes can read ancestor environments), and is never used through `--account` (the Keychain path blocks on an interactive ACL prompt). A Developer ID update must show no signature-mismatch line in Sparkle's log.
- Updates are user-driven: the app never sets `SUAutomaticallyUpdate`, and `SUAllowsAutomaticUpdates=false` removes the opt-in. An update installs through Sparkle's "Install and Relaunch", and the relaunched app restarts its desktop-owned proxy through the automatic table (version-triggered restart). Until then the old sidecar keeps serving from the old binary's inode.

### CI

| Job | Paths | Runs |
| --- | --- | --- |
| Rust | `desktop/**` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` |
| Bundle smoke | `desktop/**`, `packages/cli/scripts/**`, `.github/workflows/**`, `bun.lock`, `.bun-version` | `bun run desktop:bundle --unsigned` (includes the runtime smoke) |

Server and dashboard changes can break the compiled sidecar without changing the bundle layout. They are not in the PR smoke paths to spare macOS minutes, but the release `desktop` job always runs the full runtime smoke before signing, so a broken sidecar blocks only the desktop publish, which is resumable by tag.

### Changesets

`desktop/` is not a workspace package. Desktop release notes target `aio-proxy`, per the repo rule that user-facing changesets must target a product package. Server/CLI changes list `@aio-proxy/server` / `@aio-proxy/cli` alongside `aio-proxy`. A desktop-only changeset targeting `aio-proxy` still bumps the desktop version, because the bundle reads the product package version.

## Phasing

Release and lifecycle risks block the plan, so they are proven before any product contract merges. Phase 1 may be implemented and reviewed on its feature branch before that, but it does not merge to `main` until spike check 1's human items pass: Developer ID signing, notarization, the clean-Mac browser install, and the Developer ID Sparkle update.

0. **Spike** (throwaway code; the output is the go/no-go below). Check 1 first.
1. **Server + CLI.** Token, `__desktop-connect`, `serviceStart`/`serviceRestart` bootstrap-or-kickstart with `launchctl print` verification, bounded `run` shutdown, `AIO_PROXY_DESKTOP_EXEC` + marker, upgrade refusal, wrapper guard, quota `status`/`refresh`, `desktop-summary`.
2. **Desktop app** in `desktop/`.
3. **Release pipeline.**

### Spike checks

| # | Check | Pass | If it fails |
| --- | --- | --- | --- |
| 1 | The real release sidecar (not hello-world) and a minimal GPUI host with Sparkle, signed and notarized per the order above, as `.app` and `.dmg`; installed on a clean Mac by browser download (quarantine set); launched by launchd through the symlink; one Sparkle update from build N to N+1 with the proxy restarted onto N+1; then: delete the app, kill the running daemon so the wrapper's missing-executable branch actually runs, watch `launchctl print` and the unified log for 10 minutes, restore the app, launch it, and confirm the loaded job is kickstarted back | Every verification command passes; the sidecar serves the entitlement workload; the update installs; no relaunch or log spam while missing; recovery succeeds | Blocks the plan as specified |
| 2 | GPUI Kit PopUp + `tray-icon`: anchoring, hide on deactivation, absent from Dock and Cmd+Tab, multiple displays with different scale factors, full-screen Spaces, sleep/wake. Also fixes the local HTTP stack (meets the transport rules, cancellation, no second runtime) and Sparkle's integration with GPUI's main loop | Correct in every case | No fallback exists: the spike showed gpui-pre 0.3.7 cannot host its content in an external `NSView`/`NSPanel` (it always creates its own window, and the Mac platform types are crate-private). Its PopUp is already an `NSPanel` and can only be tuned after creation. A failure here reopens the UI stack decision |
| 3 | Window lifecycle and resources; plus the 24h summary query on a synthetic 1 GB trace DB | Matrix below; panel-closed physical footprint ≤ 40 MB with ≤ 1 idle wakeup/s; summary ≤ 50 ms | Destroy vs hide per matrix; a slow summary moves aggregation behind a cache |

Check 3 decision matrix:

| Strategy | Choose when |
| --- | --- |
| Destroy/recreate | Reopen ≤ 100 ms, no visible flash, physical footprint drops after close (Metal surface released), 100 cycles grow memory ≤ 10 MB |
| Hide/show | Destroy/recreate misses the reopen or flash criteria, and a hidden window still meets the closed-panel budget |
| Hybrid | Keep the model and last summary, destroy the window and its Metal surface; choose when it meets the destroy criteria with less reopen work |

Memory is judged by physical footprint (Activity Monitor's "Memory"), not `ps` RSS. RSS counts shared framework and dyld-cache pages: a bare AppKit status-item app is already 44 MB RSS, and the spike host is 92 MB RSS at 32.4 MB footprint with the panel closed. The freed GPU and IOSurface memory never showed in RSS.

**Spike result: CONDITIONAL GO** (`2026-09-29-desktop-spike-findings.md`). No check has fully passed yet:

- Check 1 is **PENDING**. Its sandboxed mechanics pass (ad-hoc signatures, a launchd sandbox job, recovery, an ad-hoc Sparkle N→N+1), but Developer ID signing, notarization, the clean-Mac install and the Developer ID Sparkle update have not run, and a failure there still blocks the plan.
- Check 2 is **PENDING** until its interactive rows (click-away, click-again, second display, full-screen Space, sleep/wake) are run.
- Check 3 is a **conditional GO**: summary 31 ms at 36k requests/24 h, closed footprint 32.4 MB, 0.37 wakeups/s, hybrid chosen (PROVISIONAL, [locked] measurements).

Human confirmations remain for every check.

## Testing

Each automated test guards one concrete failure.

- **Server**
  - `desktop-summary` accepts the desktop token from a loopback peer, with and without a dashboard password.
  - With a dashboard password set, the desktop token gets 401 on another `/dashboard/api/*` route (it adds no dashboard privilege). Without a password, a request with the token gets exactly what an anonymous loopback request gets.
  - The token is rejected from a non-loopback peer even when `Host`, `Origin`, or `X-Forwarded-For` claim loopback: IPv4, IPv6, and IPv4-mapped peers via injected connection metadata, plus one real-socket integration test.
  - Token file checks: a symlink, a group-readable file, a file owned by another uid, an unreadable (`0000`) file and a FIFO each yield "no token" without throwing or blocking; two concurrent creators end with one token both read. A rejected file is logged with its closed-set reason only.
  - A server with no resolvable home, or whose token file fails the checks, still boots and answers 401 on `desktop-summary`.
  - `desktop-summary` returns promptly with `loading` quota when the quota reader never resolves (guards the measured 1.3s stall); a first-read failure shows `failed`, not `loading`; one Provider's failure leaves the response 200, including a plugin that returns invalid window values (a `NaN` `resetsAt`, a ratio outside 0..1), which marks only that Provider `failed`.
  - A never-settling quota read is aborted by the host: already covered by `plugin-quota/read.test.ts` ("aborts a plugin read that ignores its signal…"); the cache's `finally` then clears `inFlight`.
  - The DTO: golden fixture shared with the Rust tests; internal fields added to Provider summaries do not appear in the response.
- **CLI**
  - `__desktop-connect`: `owner` for desktop, external, unrecognized-wrapper, and absent plists; `home` taken from the plist, not the environment; wildcard bind mapped to loopback; non-loopback bind yields `controlUrl: null`; stdout is exactly one JSON object when the command fails partway, and one with `owner: "unknown"` and no token when discovery throws; a helper process that outlives the time budget is killed.
  - `serviceStart` enables the job and then kickstarts an already-loaded one or bootstraps an unloaded one. It fails when `launchctl print` does not show the job afterwards, even though every launchctl call exited 0. `serviceRestart` boots out before bootstrapping, waits while `launchctl print` still finds the job after bootout, and fails without starting anything when the job never goes away (manager calls injected).
  - `aio-proxy run` exits 0 at its shutdown deadline after SIGTERM when shutdown leaves the event loop busy, and exits at once, without waiting for the deadline, when shutdown drains it.
  - `__desktop-connect`: `matchesJob` is true when the summary's `ppid` equals `job.pid` (the wrapper) and false for a reparented sidecar.
  - With `AIO_PROXY_DESKTOP_EXEC` set, the written plist targets that exact path (not its realpath) and carries both env markers; a rewrite from a process that inherited the markers keeps them.
  - `runUpgradeCommand` refuses for a desktop-marked process and for an executable inside a `.app`, without invoking any installer. A CLI upgrade with a desktop-owned plist installed never restarts the service. A desktop-managed sidecar's auto-update hooks carry no `applyUpdate` or notification.
  - The launchd wrapper exits 0 when its executable is missing, asserted by executing the wrapper.
- **Rust**
  - Panel placement clamps to the screen for icons near an edge.
  - Summary parsing: unknown fields ignored, unknown enum values map to `Unknown`, unsupported `protocolVersion` selects the degraded panel; the golden fixture parses.
  - The automatic-action table: every row, including never acting on external/unknown/mismatched instances and never downgrading.
  - Refresh scheduler: responses from a closed session, another instance, or an older counter are discarded; the 15s floor holds under a trigger storm; closing cancels everything.
  - Transport: the token is not attached to a hostname, a non-loopback IP, or a redirect target; proxy environment variables are ignored. A server that drips bytes slower than the read timeout is still cut off at the 5s total deadline. Chunked responses decode, and an oversized response is refused. Dropping the request shuts its socket.
  - Install policy and symlink: outside `/Applications` nothing persistent happens; a newer installed copy is never re-pointed to an older one; a second instance exits.
  - The token type's `Debug` output is redacted.
- **Release.** The bundle script fails the job for: arm64 and `minos` for every Mach-O; the JIT check, which is unconditional in both `--unsigned` and `--release` (the signed sidecar must show a `JS JIT Generated Code` region in `vmmap` while serving, with `sudo -n vmmap` as the fallback; a missing `allow-jit` does not fail any functional check); `codesign --verify --strict`; post-notarization `syspolicy_check`/`spctl` for the `.app` and `.dmg`; `stapler validate` for both. `desktop:publish` fails the job for: a private key, `SPARKLE_PUBLIC_ED_KEY` and DMG `SUPublicEDKey` that do not match (before the build and before the upload); the feed listing the version while the DMG is not on the Release; the versioned `.dmg` URL not answering 200 with the DMG's length before the feed is replaced; the regenerated feed's new item lacking an Ed25519 signature that verifies against `SUPublicEDKey`, or lacking `sparkle:minimumSystemVersion` 13.0; prior items changed; an empty or unreadable `desktop-feed`. Whether `vmmap` can read a Developer ID hardened sidecar on CI is a human check (rehearsal R1/R6), not a condition in the code.
- **Manual acceptance (UI and lifecycle):** toggle via icon; click outside hides; not in Dock or Cmd+Tab; second display with a different scale factor; full-screen app in another Space; sleep/wake with panel open and closed; each user action per ownership with its completion condition; an external service is never changed without a click and never has its plist rewritten; a user-stopped desktop service stays stopped across app relaunch; quit leaves the proxy running; a Sparkle update restarts a desktop-owned proxy onto the new version; opening an older app copy does not downgrade; app deleted leaves launchd quiet and restoring it recovers.
