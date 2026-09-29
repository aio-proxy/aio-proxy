# macOS menu-bar desktop client

Date: 2026-09-29
Status: draft (rev 2, after review)

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

## Platform baseline

- Architecture: `arm64` only.
- Minimum macOS: **13.0**, set by `SMAppService.mainApp` (launch at login). Sparkle 2 and GPUI both support older systems, so 13.0 is the binding floor.
- The single value is propagated to `MACOSX_DEPLOYMENT_TARGET` (Rust build), `LSMinimumSystemVersion` (`Info.plist`), and `sparkle:minimumSystemVersion` (appcast).

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
| Toolchain | Root `mise.toml` for local dev, reading `.bun-version` and `desktop/rust-toolchain.toml` | Each tool keeps one version source; CI reads the same files |

GPUI Kit pins an exact `gpui-pre` snapshot because snapshots break API. The desktop crate pins `gpui-kit` exactly and bumps it deliberately.

## Process model and discovery

The desktop app does not spawn the proxy. The proxy runs as the existing launchd user agent (`com.aio-proxy.agent`), and the desktop app talks to it through the bundled CLI (rare lifecycle calls) and HTTP (all data).

### Bundled binary and stable symlink

- The `.app` ships `Contents/MacOS/aio-proxy` next to `Contents/MacOS/aio-proxy-desktop`.
- On every launch the app atomically (create temp symlink + rename) ensures `~/Library/Application Support/aio-proxy-desktop/bin/aio-proxy` points at its own bundled binary, re-pointing it if the app moved.
- The launchd plist for a desktop-owned service points at that symlink, not into the bundle. After a Sparkle update the symlink already resolves to the new binary; the running process keeps its old inode until restart.
- The app refuses to proceed from a translocated location (launched from Downloads) and asks the user to move it to `/Applications`. A translocated path is random and changes on reboot, and Sparkle requires a writable location anyway.

### Startup flow

1. Run `<symlink> __desktop-connect`. It prints one JSON line on stdout:

   ```json
   {
     "protocolVersion": 1,
     "bundledVersion": "0.37.0",
     "running": true,
     "runningVersion": "0.36.0",
     "url": "http://127.0.0.1:9317",
     "dashboardUrl": "http://127.0.0.1:9317/dashboard",
     "token": "<local token or null>",
     "service": { "installed": true, "owner": "desktop" }
   }
   ```

   `bundledVersion` is the CLI's own version (it runs from the symlink, so it is the desktop's bundled sidecar). `running`/`url`/`runningVersion` reuse `resolveControlAddress` + `probeHealth` from `status`. `owner` is `"desktop"` when the installed plist's executable equals the symlink path, `"external"` when a plist exists with any other executable, and `null` when no plist exists.
2. `running: true`: connect, then apply the version rules below.
3. `running: false`, no service installed: run `service install` then `service start`. The service is now desktop-owned.
4. `running: false`, service installed: run `service start`. The plist is not rewritten.

Every CLI invocation goes through the symlink with `AIO_PROXY_DESKTOP_EXEC=<symlink>` set, so any plist the desktop app writes always points at the symlink. The implementation plan must confirm that `service start` and `service stop` never rewrite an existing plist; only `install` and `restart` do today.

### Version rules

| Situation | Behavior |
| --- | --- |
| `runningVersion == bundledVersion` | Normal |
| Desktop-owned, versions differ (the app was just updated) | `service restart` via the symlink, wait for `/health`, re-run `__desktop-connect` |
| External, `desktop-summary` answers with a supported `protocolVersion` | Normal, plus a "proxy is version X" notice |
| External, `desktop-summary` missing (404) or unsupported `protocolVersion` | Degraded panel: status, endpoint, Open Dashboard, Reload only |

The app never replaces an external instance. Update coordination needs no pre-install proxy stop: the symlink path is stable, the old process keeps running on its old inode while Sparkle swaps the bundle, and the relaunched app restarts the desktop-owned service onto the new binary. This keeps proxy downtime to one restart. If the proxy happens to crash during the swap, the dangling-symlink guard below stops it cleanly, and the relaunched app's `service start` brings it back.

### Actions by ownership

| Action | `owner: desktop` | `owner: external` | No service (manual `aio-proxy run`) |
| --- | --- | --- | --- |
| Restart | `service restart` via the symlink (rewrites the plist to the current symlink) | `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent` (never rewrites the plist) | Not offered |
| Reload config | `POST /admin/reload` (already allowed from loopback without auth) | same | same |
| Stop | `service stop` | same | Not offered |
| Quit app | Proxy keeps running | same | same |

`service restart` must never run against an external service: `writeManagedUnit` rewrites the plist with the invoking binary, which would silently switch a user's npm/brew service to the desktop binary.

After any action the app initiates, it refetches immediately once `/health` answers; it does not wait for an SSE event.

"Proxy starts at login" is the launchd service itself (`RunAtLoad`). "App starts at login" is a separate toggle backed by `SMAppService`.

### Dangling symlink

The current launchd plist uses a conditional `KeepAlive` (`SuccessfulExit = false`): launchd relaunches only on a non-zero exit. The `/bin/sh` wrapper already maps exit 1 to 0 for this reason. The wrapper gains `[ -x "$0" ] || exit 0` before `"$0" run`, so a missing executable (app deleted, brew uninstalled) is a clean exit that launchd does not relaunch. `RunAtLoad` then makes it run once per login, exit 0, and stay quiet. Spike check 1 observes this for 10 minutes rather than trusting the documented semantics.

### Health check

- Timeout 2s. Two consecutive failures mark the proxy down.
- It only updates the tray icon state and triggers rediscovery (`__desktop-connect`). It never restarts anything. Crash recovery is launchd's `KeepAlive` for both desktop-owned and external services.
- Runs every 60s while the panel is closed, and immediately on panel open and on wake from sleep (`NSWorkspaceDidWakeNotification`).

## Server and CLI changes

### Local token

| Property | Rule |
| --- | --- |
| Location | `$AIO_PROXY_HOME/desktop-token`, mode `0600` |
| Created by | The server, at boot, if absent (write temp + rename). The CLI only reads it. |
| Lifetime | Persistent across restarts, service reinstalls, and app updates. Not tied to ownership. |
| Read by the server | From the file on each desktop-authorized request (two low-rate routes), so replacing the file rotates the token without a restart |
| Missing while the server runs | `__desktop-connect` returns `token: null`; the desktop app restarts a desktop-owned service or shows "restart the proxy" for an external one |
| Transport to the app | The stdout pipe of `__desktop-connect`. Never an environment variable, never a URL query. |
| Transport to the server | `Authorization: Bearer`, including on the SSE request |
| Logging | Never logged by the desktop app; the desktop app's logger redacts `Authorization` |

**Scope: least privilege.** The token authorizes exactly two routes, both `GET`:

- `GET /dashboard/api/desktop-summary`
- `GET /dashboard/api/events`

It is not a general dashboard session. The desktop app needs nothing else: reload goes through `/admin/reload`, which already accepts loopback requests without auth. Because both routes are `GET`, the same-origin CSRF guard (which only inspects state-changing methods) is untouched. No origin check is bypassed anywhere.

**Loopback.** The token is accepted only when the existing `isDashboardLoopbackRequest` passes. That check uses the socket peer from Bun's `requestIP`, not `Host`, `Origin`, or `X-Forwarded-For`, and already treats `127.0.0.0/8`, `::1`, and `::ffff:127.*` as loopback. The existing `requireLoopbackHost` Host-header guard against DNS rebinding stays in front of it.

A proxy bound to `0.0.0.0` still rejects the token from non-loopback peers.

### CLI

- Hidden command `__desktop-connect` as specified above.
- `resolveAgentExecutable` honors `AIO_PROXY_DESKTOP_EXEC` when set: the plist's executable becomes that path and the unit carries `AIO_PROXY_UPGRADE_METHOD=desktop`.
- The auto-update hooks treat `AIO_PROXY_UPGRADE_METHOD=desktop` as "never self-upgrade". Sparkle owns updates for desktop-owned services; a self-upgrade would break the app's code signature.
- The launchd wrapper guard described above.

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

The response carries `protocolVersion: 1` and `generatedAt`. Clients ignore unknown fields. "Today" means the existing rolling 24h window; no calendar-day range is added. One Provider's quota failure is reported on that Provider (`{ status: 'error' }`) and never fails the whole response.

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
- The summary calls `peek` then the existing `warm` (which already respects cooldown, dedupes in flight, and bounds each read with its own 15s timeout detached from any caller) for each quota-capable Provider. The summary holds no promise, so an aborted summary request leaves nothing behind but the cache's own bounded read.
- Each Provider's quota is `{ status: 'ready', snapshot, sampledAt, stale }`, `{ status: 'pending' }`, or `{ status: 'error' }`.
- `?refresh=true` forces a background refresh (bypassing cooldown) and still does not await it.

### Refresh policy (client)

The event stream carries `config.changed`, `events.dropped`, `trace.start`, `trace.delta`, `trace.end`. There is no service-status or quota event; service state changes the app causes itself are handled by the immediate post-action refetch above.

| Trigger | Response |
| --- | --- |
| Panel opens | Fetch immediately; subscribe to SSE |
| `config.changed`, `events.dropped` | Fetch immediately |
| `trace.end` | Trailing debounce 1s |
| `trace.start`, `trace.delta` | Ignored |
| 30s since the last fetch | Fetch (fallback for a silent stream) |
| Any Provider `pending` after a fetch | One shared refetch after 2s |
| Panel closes | Abort the SSE request, cancel all timers and the pending retry |

Rules:

- At most one fetch in flight. A trigger during a fetch marks "dirty"; one more fetch runs when it completes.
- Each fetch carries a generation number; a response older than the latest applied one is discarded.
- A newer fetch replaces a scheduled pending retry. If Providers are still `pending` after that one retry, render `pending` and wait for an event or a manual refresh; no polling loop.
- SSE reconnects with capped exponential backoff (1s doubling to 30s, reset on a successful event). A parse error closes and reconnects through the same backoff, never a tight loop. Reconnects re-fetch the summary; event IDs are not resumed.

## Desktop app structure

One Cargo binary crate at `desktop/`, outside the Bun workspace.

| Module | Responsibility |
| --- | --- |
| `main.rs` | GPUI application, tray creation, app lifecycle, wake notification |
| `tray.rs` | `tray-icon` setup; left click toggles the panel with the icon rect; right click opens a native menu (Open Dashboard, Quit); three icon states |
| `panel/` | PopUp window placement (below the menu bar, horizontally centered on the icon, clamped to the icon's screen) and views: stat cards, Provider quota list, 7-day trend, heatmap, action row |
| `connect.rs` | Symlink maintenance, `__desktop-connect` invocation and parsing, version rules, service commands, `launchctl kickstart` |
| `client.rs` | Summary fetch, SSE subscription, the refresh policy above |
| `summary.rs` | Serde types for `desktop-summary`, tolerant of unknown fields |
| `login_item.rs` | `SMAppService.mainApp` register/unregister |
| `updater.rs` | Sparkle controller |

Panel details:

- No arrow, matching arrowless system menu-bar popovers such as Control Center.
- The heatmap is a plain grid of cells. GPUI Kit has no heatmap component, and one is not needed for a fixed-size 365-cell grid.
- Window lifecycle on close is decided by spike check 3 (below); the summary model and last response survive either way.
- "Open logs" reveals `$AIO_PROXY_HOME/logs` in Finder. The app's own log goes to `~/Library/Logs/aio-proxy-desktop/`.
- The actions offered follow the ownership table above.

## Build, sign, release

### Bundle command

One top-level command, `bun run desktop:bundle` (script `desktop/scripts/bundle.ts`), used by both CI and release so no caller can produce a sidecar missing its embedded dashboard:

1. Verify required tools (`cargo`, `codesign`, `xcrun`, Sparkle tools) and fail fast.
2. `bun run build` (the workspace build, including the dashboard `dist` the compiled entry embeds).
3. `build-binary.ts darwin-arm64 <out>`; verify `THIRD_PARTY_NOTICES` was written next to it.
4. `cargo build --release --target aarch64-apple-darwin` with `MACOSX_DEPLOYMENT_TARGET=13.0`.
5. Assemble the `.app`:
   - `Contents/MacOS/aio-proxy-desktop`, `Contents/MacOS/aio-proxy`
   - `Contents/Frameworks/Sparkle.framework`, copied whole from the official release with its symlinks intact (it contains nested XPC services and helpers)
   - `Contents/Resources/THIRD_PARTY_NOTICES` (aio-proxy's, plus Sparkle's license)
   - `Info.plist`: `CFBundleIdentifier`, `CFBundleExecutable`, `CFBundleName`, `CFBundleDisplayName`, `CFBundleShortVersionString`, `CFBundleVersion`, `LSUIElement`, `LSMinimumSystemVersion`, `SUFeedURL`, `SUPublicEDKey`
6. Verify both executables are arm64 (`lipo -archs`).
7. `--unsigned` stops here with an ad-hoc signature (CI smoke). Release continues.

Version: `CFBundleShortVersionString` and `CFBundleVersion` are both the `version` of `npm/aio-proxy/package.json` (the product package; lockstep with every workspace package through the Changesets `fixed` group). A stable `X.Y.Z` is already monotonic and Sparkle compares it correctly, so no separate build counter. Canary builds skip the desktop, so prerelease strings never reach `CFBundleVersion`. If desktop prereleases are ever shipped, add a numeric `CFBundleVersion` then.

The Sparkle public key lives in `Info.plist`; the private key exists only as a CI secret.

### Signing and notarization

Entitlements for the sidecar are a committed, fixed file (`desktop/entitlements/aio-proxy.plist`) with a comment justifying each key. Spike check 1 derives the minimum set by removal, starting from `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`, and separately testing whether `com.apple.security.cs.disable-library-validation` is needed. Hardened-runtime acceptance covers a real proxied request, an OAuth Provider, a plugin load, and the SQLite database. The release script never adds entitlements dynamically. The host executable gets no entitlements unless the spike proves one necessary.

`build-binary.ts` already ad-hoc resigns the Bun output (Bun's linker signature is rejected on macOS 27); the Developer ID signature replaces it.

Order:

1. Sign inside-out with Developer ID, hardened runtime, and `--timestamp`: Sparkle's nested XPC services and helpers, `Sparkle.framework`, `aio-proxy` (with its entitlements), `aio-proxy-desktop`, then the `.app`. `--deep` is never used for signing.
2. Verify: `codesign --verify --deep --strict --verbose=2` and `spctl --assess --type execute --verbose=4` on the `.app`.
3. Zip the `.app` (`ditto -c -k --keepParent`), `notarytool submit --wait`, then `stapler staple` the `.app`.
4. Build the `.dmg` from the stapled `.app` with `hdiutil`, sign it, `notarytool submit --wait`, `stapler staple`.
5. Verify: `spctl --assess --type open --context context:primary-signature --verbose=4` on the `.dmg`; `stapler validate` on both.
6. Sign the `.dmg` for Sparkle (EdDSA) via `generate_appcast` below, and confirm it verifies against `SUPublicEDKey`.

### Appcast

- Generated by Sparkle's `generate_appcast`, never hand-written.
- The job downloads the previous release's `appcast.xml`, places it beside the new `.dmg`, and runs `generate_appcast` so prior items are kept (history, skipping, and future critical-update or minimum-system fields remain possible).
- Enclosure URLs are versioned: `https://github.com/aio-proxy/aio-proxy/releases/download/v<version>/aio-proxy-<version>-arm64.dmg`. Only the feed URL uses `releases/latest/download/appcast.xml`.
- Upload order: `.dmg` first, verify it downloads (HTTP 200 on the versioned URL), then `appcast.xml`. A failure before the appcast upload leaves the previous feed intact; re-running is safe because the existing upload step already refuses `--clobber`.
- Moving the feed to a fixed static host (the repo's website deploy) is a later option, not phase 1.

### Release workflow

- The existing `release` job runs on `macos-latest`. The desktop step pins its runner to an arm64 image, sets up Rust from `desktop/rust-toolchain.toml` with `rustup target add aarch64-apple-darwin`, and runs after "Upload platform tarballs and SHA256SUMS".
- Canary releases skip the desktop step.
- New secrets: Developer ID certificate (p12 + password), App Store Connect API key for `notarytool`, Sparkle EdDSA private key.

### CI

Two macOS jobs:

| Job | Paths | Runs |
| --- | --- | --- |
| Rust | `desktop/**` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` |
| Bundle smoke | `desktop/**`, `packages/cli/scripts/**`, `.github/workflows/**`, `bun.lock`, `.bun-version` | `bun run desktop:bundle --unsigned`; check bundle layout, `Info.plist` keys, arm64, `THIRD_PARTY_NOTICES`; launch the sidecar with `--version` |

Server and dashboard changes are not in the smoke paths: macOS runner minutes are expensive, and those changes cannot alter the bundle layout. The desktop's runtime contract with the server is guarded by the server-side `desktop-summary` tests instead.

### Changesets

`desktop/` is not a workspace package. Desktop release notes target `aio-proxy`, per the repo rule that user-facing changesets must target a product package. Server/CLI changes list `@aio-proxy/server` / `@aio-proxy/cli` alongside `aio-proxy`. A desktop-only changeset targeting `aio-proxy` still bumps the desktop version, because the bundle reads the product package version; `desktop/` does not need to become a workspace package for versioning.

## Phasing

The release/lifecycle risks block the plan, so they are proven before any product contract merges.

0. **Spike** (throwaway code; the output is the go/no-go below). Check 1 runs first.
1. **Server + CLI.** Local token, `__desktop-connect`, `AIO_PROXY_DESKTOP_EXEC`, `AIO_PROXY_UPGRADE_METHOD=desktop`, launchd wrapper guard, quota `peek`, `desktop-summary`.
2. **Desktop app** in `desktop/`.
3. **Release pipeline.**

### Spike checks

| # | Check | Pass | If it fails |
| --- | --- | --- | --- |
| 1 | A minimal Bun standalone sidecar signed with Developer ID + hardened runtime + the minimal entitlement set, inside a signed/notarized/stapled `.app` and `.dmg` per the order above; launched by launchd through the symlink; a minimal Sparkle update from one build to the next; then delete the app and watch `launchctl print` and the unified log for 10 minutes | All verification commands pass on a clean Mac; sidecar serves a request; the update installs; after deletion there are no relaunches and no log spam | Blocks the plan as specified |
| 2 | GPUI Kit PopUp + `tray-icon`: anchoring, hide on deactivation, absent from Dock and Cmd+Tab, multiple displays with different scale factors, full-screen Spaces, sleep/wake | Correct in every case | Create an `NSPanel` via objc2 and host GPUI content in it |
| 3 | Window lifecycle and resources | See matrix below; in every strategy the panel-closed RSS is ≤ 40 MB with ≤ 1 idle wakeup/s | — |

Check 3 decision matrix:

| Strategy | Choose when |
| --- | --- |
| Destroy/recreate | Reopen ≤ 100 ms, no visible flash, RSS drops after close, 100 cycles grow memory ≤ 10 MB |
| Hide/show | Destroy/recreate misses the reopen or flash criteria, and a hidden window still meets the closed-panel budget |
| Hybrid | Keep the model and last summary, destroy the window and its Metal surface; choose when it meets the destroy criteria with less reopen work |

Measured for each: RSS after close, whether the Metal surface is released, 100-cycle growth, first-frame flash, stale state after display changes.

## Testing

Each automated test guards one concrete failure.

- **Server**
  - The desktop token authorizes `desktop-summary` and `events` from a loopback peer and nothing else (another `/dashboard/api/*` route answers 401).
  - The token is rejected from a non-loopback peer, including when `Host`, `Origin`, or `X-Forwarded-For` claim loopback. Covers an IPv4, an IPv6, and an IPv4-mapped peer via injected connection metadata, plus one real-socket integration test.
  - Replacing the token file rotates the token without a restart.
  - `desktop-summary` returns promptly with `pending` quota when the quota reader never resolves (guards the measured 1.3s stall).
  - One Provider's quota error is reported on that Provider and the response is still 200.
- **CLI**
  - `__desktop-connect` reports `owner` correctly for desktop, external, and absent plists, and `token: null` when the file is missing.
  - The launchd wrapper exits 0 when its executable is missing, asserted by executing the wrapper, not by string-matching the template.
  - With `AIO_PROXY_DESKTOP_EXEC` set, the written plist points at that path and carries `AIO_PROXY_UPGRADE_METHOD=desktop`.
- **Rust**
  - Panel placement clamps to the screen for icons near an edge.
  - Summary deserialization ignores unknown fields; an unsupported `protocolVersion` selects the degraded panel.
  - The refresh scheduler: a stale response never overwrites a newer one; an event burst yields one fetch; closing the panel cancels the stream, the debounce, and the pending retry; SSE backoff caps at 30s and a parse error does not reconnect immediately.
  - Version rules pick the right action for each row of the version table.
  - Symlink maintenance replaces a dangling or wrong-target symlink atomically.
- **Release** (in the bundle script, failing the job): both executables are arm64; `codesign --verify --strict` and `spctl` pass for the `.app` and `.dmg`; `stapler validate` passes for both; the Sparkle signature verifies against `SUPublicEDKey`; the versioned `.dmg` URL answers 200 before the appcast is uploaded.
- **Manual acceptance (UI and lifecycle):** toggle via icon; click outside hides; not in Dock or Cmd+Tab; second display with a different scale factor; full-screen app in another Space; sleep/wake with panel open and closed; restart/stop/reload per ownership; an external service is never stopped or restarted by anything other than an explicit user action and never has its plist rewritten; quit leaves the proxy running; a Sparkle update restarts a desktop-owned proxy onto the new version; app deleted leaves launchd quiet.
