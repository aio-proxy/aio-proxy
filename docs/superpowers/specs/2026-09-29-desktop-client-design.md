# macOS menu-bar desktop client

Date: 2026-09-29
Status: draft

## Goal

Ship a lightweight macOS menu-bar companion for aio-proxy. A user installs one `.app`, gets a running proxy without installing Bun or the CLI, and sees a summary panel anchored to a menu-bar icon: proxy status, last-24h usage, Provider health and quota, a 7-day trend, an activity heatmap, and quick actions.

The desktop app is a companion, not a second dashboard. Everything that edits configuration stays in the existing Web Dashboard, which the panel opens in the browser.

Windows and Linux are committed follow-ups. Phase 1 is macOS on Apple Silicon only, but the UI stack is chosen so the panel code carries over.

## Non-goals

- Re-implementing any Web Dashboard feature natively: Provider create/edit, OAuth flows, routing rules, API keys, trace payloads, JSON config editing, large log tables.
- Owning the proxy process. launchd owns it; the desktop app never runs aio-proxy as its own child.
- Replacing a user's existing CLI-installed service with the desktop's bundled version.
- Intel Macs. macOS 26 is the last Intel release; Intel users keep the CLI.
- Windows and Linux in phase 1. On Linux the anchored popover is not achievable under Wayland (no client-side global positioning, no tray icon rect) and GNOME hides tray icons without an extension; that degraded design is a phase-2 decision.
- A per-refresh CLI protocol. CLI commands are used only for discovery and lifecycle; data goes over HTTP.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Panel UI | GPUI Kit (`gpui-kit` 0.7, Longbridge; formerly `gpui-component`) on GPUI `gpui-pre =0.3.7` | Cross-platform GPU UI with built-in area/bar/line charts and a plot layer; used in Longbridge Pro |
| Menu-bar icon | `tray-icon` crate | Neither GPUI nor GPUI Kit exposes a status item. `tray-icon` reports the icon rect on click (needed for anchoring) and covers Windows/Linux later |
| Panel window | GPUI `WindowKind::PopUp` | Borderless, above other windows; hide on deactivation via GPUI window-activation observation |
| No Dock / Cmd+Tab | `LSUIElement` in `Info.plist` | Native, zero code |
| App launch at login | `SMAppService.mainApp` via objc2 | Native API, macOS 13+ |
| Updates | Sparkle 2 via objc2 (`SPUStandardUpdaterController`) | Standard for non-App-Store apps; EdDSA-verified |
| HTTP | The reqwest client already in the GPUI dependency tree | No extra HTTP dependency |
| Proxy | The existing Bun standalone binary from `packages/cli/scripts/build-binary.ts` (`darwin-arm64`) | Already built and resigned in CI |
| Toolchain | Root `mise.toml` for local dev, reading `.bun-version` and `desktop/rust-toolchain.toml` | Each tool keeps one version source; CI is unchanged (`setup-bun` and rustup read the same files) |

GPUI Kit pins an exact `gpui-pre` snapshot because snapshots break API. The desktop crate pins `gpui-kit` exactly and bumps it deliberately.

## Process model and discovery

The desktop app does not spawn the proxy. The proxy runs as the existing launchd user agent (`com.aio-proxy.agent`), and the desktop app talks to it through the bundled CLI (rare lifecycle calls) and HTTP (all data).

### Bundled binary and stable symlink

- The `.app` ships `Contents/MacOS/aio-proxy` next to `Contents/MacOS/aio-proxy-desktop`.
- On every launch the app ensures `~/Library/Application Support/aio-proxy-desktop/bin/aio-proxy` is a symlink to its own bundled binary, re-pointing it if the app moved.
- The launchd plist for a desktop-owned service points at that symlink, not into the bundle. After a Sparkle update the symlink already resolves to the new binary; the running process keeps its old inode until restart.
- The app refuses to proceed from a translocated location (launched from Downloads) and asks the user to move it to `/Applications`. A translocated path is random and changes on reboot, and Sparkle requires a writable location anyway.

### Startup flow

1. Run `<symlink> __desktop-connect`. It prints one JSON line:

   ```json
   {
     "protocolVersion": 1,
     "running": true,
     "url": "http://127.0.0.1:9317",
     "dashboardUrl": "http://127.0.0.1:9317/dashboard",
     "version": "0.36.0",
     "token": "<local token>",
     "service": { "installed": true, "owner": "desktop" }
   }
   ```

   `running`/`url`/`version` reuse `resolveControlAddress` + `probeHealth` from `status`. `owner` is `"desktop"` when the installed plist's executable equals the symlink path, `"external"` when a plist exists with any other executable, and `null` when no plist exists.
2. `running: true`: connect. A version different from the bundled one is shown as a notice, never acted on.
3. `running: false`, no service installed: run `service install` then `service start` with `AIO_PROXY_DESKTOP_EXEC=<symlink>`. The service is now desktop-owned.
4. `running: false`, service installed: run `service start`. The plist is not rewritten.

Every CLI invocation goes through the symlink with `AIO_PROXY_DESKTOP_EXEC=<symlink>` set, so any plist the desktop app writes always points at the symlink. The implementation plan must confirm that `service start` and `service stop` never rewrite an existing plist; only `install` and `restart` do today.

### Actions by ownership

| Action | `owner: desktop` | `owner: external` | No service (manual `aio-proxy run`) |
| --- | --- | --- | --- |
| Restart | `service restart` via the symlink (rewrites the plist to the current symlink, which is how app updates reach the proxy) | `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent` (never rewrites the plist) | Not offered |
| Reload config | `POST /admin/reload` | same | same |
| Stop | `service stop` | same | Not offered |
| After app update | `service restart` | nothing | nothing |
| Quit app | Proxy keeps running | same | same |

`service restart` must never run against an external service: `writeManagedUnit` rewrites the plist with the invoking binary, which would silently switch a user's npm/brew service to the desktop binary.

"Proxy starts at login" is the launchd service itself (`RunAtLoad`). "App starts at login" is a separate toggle backed by `SMAppService`.

### Liveness

- Panel closed: one `GET /health` every 60s to drive the icon state (running / has alerts / stopped).
- Panel open: the SSE subscription (below) doubles as liveness; a dropped stream triggers rediscovery.
- Health failure or dropped stream re-runs `__desktop-connect`.

## Server and CLI changes

### Local token

- `$AIO_PROXY_HOME/desktop-token`: 32 random bytes, base64url, mode `0600`, persistent across restarts. Get-or-create with write-to-temp + rename so two concurrent creators cannot corrupt it; the loser re-reads.
- One shared get-or-create function used by both the server (at boot) and `__desktop-connect`.
- `DashboardAuthentication.verify(token)` additionally accepts the desktop token with a constant-time comparison. Bearer auth, the SSE events stream, and session checks all route through `verify`, so no route changes. `refresh()` must not mint a session renewal for the desktop token.
- The same-origin CSRF guard on `/dashboard/api/*` (active when no dashboard password is set) is skipped for requests carrying a valid desktop token. That guard stops browser cross-site requests, and a browser cannot attach a custom `Authorization` header cross-site without a CORS preflight the server does not grant.
- The existing loopback restriction on `/dashboard/api/*` is unchanged: the token only works from loopback. Its privilege equals a logged-in dashboard session.
- The token file sits in the same trust boundary as `config.jsonc`, which already holds provider secrets.

### CLI

- Hidden command `__desktop-connect` as specified above.
- `resolveAgentExecutable` honors `AIO_PROXY_DESKTOP_EXEC` when set: the plist's executable becomes that path and the unit carries `AIO_PROXY_UPGRADE_METHOD=desktop`.
- The auto-update hooks treat `AIO_PROXY_UPGRADE_METHOD=desktop` as "never self-upgrade". Sparkle owns updates for desktop-owned services; a self-upgrade would break the app's code signature.
- The launchd wrapper gains `[ -x "$0" ] || exit 0` before `"$0" run`. With `KeepAlive.SuccessfulExit=false`, a missing executable (app deleted, brew uninstalled) then stops cleanly instead of relaunching forever. systemd needs no change.

### `GET /dashboard/api/desktop-summary`

One versioned endpoint rather than several dashboard-internal ones. When the desktop app attaches to an external instance of a different version, this is the stable contract. The Rust client never tracks four internal response shapes.

Every field comes from existing code:

| Field | Source |
| --- | --- |
| `usage` (last 24h: requests, input/output tokens, estimated cost, failure rate) | `traceStore.overviewDashboard({ range: '24h' }).summary` |
| `trend` (7 days) | `traceStore.overviewDashboard({ range: '7d' })` series |
| `activity` (heatmap) | `traceStore.overviewDashboardActivity()` |
| `providers` (id, name, state, last status/latency, quota) | `state.providerSummaries({ probe: false })` + quota cache (below) |
| `alerts` | Derived from providers: credential failure, cooldown, exhausted quota window |

The response carries `protocolVersion: 1` and `generatedAt`. Clients ignore unknown fields. "Today" means the existing rolling 24h window; no calendar-day range is added.

#### Quota never blocks the summary

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

Local aggregation costs the same in one endpoint or four: the server is single-threaded and SQLite reads are synchronous, so parallel requests do not overlap. The ~3 ms event-loop hold happens only while the panel is open, at most every 15–30s, which is what the Web Dashboard already does.

Quota is the real risk. `createOAuthQuotaCache` keeps entries behind a 5-minute cooldown and, once it lapses, `read()` awaits upstream with no stale-while-revalidate. A summary that awaited quota would stall ~1.3s every 5 minutes.

So:

- Add `peek(providerId): OAuthQuotaCacheEntry | undefined` to the quota cache: a synchronous read of the current entry, no fetch.
- The summary calls `peek` then the existing `warm` (which already respects cooldown and dedupes in flight) for each quota-capable Provider.
- Each Provider's quota is `{ status: 'ready', snapshot, sampledAt, stale }` or `{ status: 'pending' }`.
- `?refresh=true` forces a background refresh (bypassing cooldown) and still does not await it.

### Refresh policy (client)

- Panel opens: fetch the summary immediately, then subscribe to the existing `GET /dashboard/api/events` SSE stream.
- Any event: debounce 2s, refetch the summary.
- A 30s timer refetches as a fallback in case SSE goes silent without closing.
- Any Provider still `pending`: refetch once after 2s.
- Panel closes: drop the SSE connection and timers; only the 60s health check remains.

## Desktop app structure

One Cargo binary crate at `desktop/`, outside the Bun workspace.

| Module | Responsibility |
| --- | --- |
| `main.rs` | GPUI application, tray creation, app lifecycle |
| `tray.rs` | `tray-icon` setup; left click toggles the panel with the icon rect; right click opens a native menu (Open Dashboard, Quit); three icon states |
| `panel/` | PopUp window placement (below the menu bar, horizontally centered on the icon, clamped to the icon's screen) and views: stat cards, Provider quota list, 7-day trend, heatmap, action row |
| `connect.rs` | Symlink maintenance, `__desktop-connect` invocation and parsing, service commands, `launchctl kickstart` |
| `client.rs` | Summary fetch, SSE subscription, 2s debounce, pending retry |
| `summary.rs` | Serde types for `desktop-summary`, tolerant of unknown fields |
| `login_item.rs` | `SMAppService.mainApp` register/unregister |
| `updater.rs` | Sparkle controller |

Panel details:

- No arrow. macOS 11+ menu-bar popovers (Control Center) are arrowless.
- The heatmap is a plain grid of cells. GPUI Kit has no heatmap component, and one is not needed for a fixed-size 365-cell grid.
- Closing the panel destroys the window so GPU resources (the Metal layer) are released. If the spike measures reopen latency over 100 ms, switch to hide/show.
- "Open logs" reveals `$AIO_PROXY_HOME/logs` in Finder. The app's own log goes to `~/Library/Logs/aio-proxy-desktop/`.
- The actions offered follow the ownership table above.

## Build, sign, release

### Bundle script

`desktop/scripts/bundle.ts` (Bun, like the rest of the repo's scripts):

1. Build the sidecar with `build-binary.ts darwin-arm64 <out>`.
2. `cargo build --release` for `aarch64-apple-darwin`.
3. Assemble `.app`: `Contents/MacOS/{aio-proxy-desktop,aio-proxy}`, `Contents/Frameworks/Sparkle.framework`, `Info.plist` with `LSUIElement`, and `CFBundleShortVersionString` read from `packages/cli/package.json` (lockstep version).
4. Sign inside-out with Developer ID and hardened runtime. The sidecar gets JIT entitlements (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, plus whatever the spike proves necessary).
5. `notarytool submit --wait`, then `stapler staple`.
6. `hdiutil` a `.dmg`; sign it for Sparkle with `sign_update` (EdDSA).

### Release workflow

- The existing `release` job already runs on `macos-latest`. After "Upload platform tarballs and SHA256SUMS", a new step bundles the app and uploads `aio-proxy-<version>-arm64.dmg` and `appcast.xml` to the same GitHub Release.
- `appcast.xml` holds only the latest item. The app's feed URL is `https://github.com/aio-proxy/aio-proxy/releases/latest/download/appcast.xml`. No website change.
- Canary releases skip the desktop step.
- New secrets: Developer ID certificate (p12 + password), App Store Connect API key for `notarytool`, Sparkle EdDSA private key.

### CI

A macOS job in `ci.yml`, path-filtered to `desktop/**`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.

### Changesets

`desktop/` is not a workspace package. Desktop release notes target `aio-proxy`, per the repo rule that user-facing changesets must target a product package. Server/CLI changes list `@aio-proxy/server` / `@aio-proxy/cli` alongside `aio-proxy`.

## Phasing

Each phase merges independently.

1. **Server + CLI.** Local token, `__desktop-connect`, `AIO_PROXY_DESKTOP_EXEC`, `AIO_PROXY_UPGRADE_METHOD=desktop`, launchd wrapper guard, quota `peek`, `desktop-summary`. Useful and testable without any desktop code.
2. **Spike** (throwaway code; the output is the go/no-go below).
3. **Desktop app** in `desktop/`.
4. **Release pipeline.**

### Spike checks

| # | Check | Pass | If it fails |
| --- | --- | --- | --- |
| 1 | Bun sidecar signed with Developer ID + hardened runtime + JIT entitlements, notarized, launched by launchd through the symlink | Runs; `spctl --assess` passes | Blocks the plan as specified; run this first |
| 2 | GPUI Kit PopUp + `tray-icon`: anchoring, hide on deactivation, absent from Dock and Cmd+Tab, multiple displays, full-screen Spaces, sleep/wake | Correct in every case | Create an `NSPanel` via objc2 and host GPUI content in it |
| 3 | Resources | Panel closed: RSS ≤ 40 MB, ≤ 1 idle wakeup/s. Reopen ≤ 100 ms. 100 open/close cycles grow memory ≤ 10 MB | Decides destroy vs. hide on close |

## Testing

Each automated test guards one concrete failure.

- **Server:** the desktop token passes auth and bypasses the same-origin guard; the same token from a non-loopback address is rejected. `desktop-summary` returns promptly with `pending` quota when the quota reader never resolves (guards the measured 1.3s stall).
- **CLI:** `__desktop-connect` reports `owner` correctly for desktop, external, and absent plists. The launchd wrapper exits 0 when its executable is missing, asserted by executing the wrapper, not by string-matching the template.
- **Rust:** panel placement clamps to the screen for icons near an edge; summary deserialization ignores unknown fields; the debounce collapses an event burst into one fetch.
- **Manual acceptance (UI):** toggle via icon; click outside hides; not in Dock or Cmd+Tab; second display with a different scale factor; full-screen app in another Space; sleep/wake with panel open and closed; restart/stop/reload per ownership; quit leaves the proxy running; app deleted leaves launchd quiet.
