# macOS menu-bar desktop client

Date: 2026-09-29
Status: draft (rev 3, after two review rounds)

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
| Panel window | GPUI `WindowKind::PopUp` | Borderless, above other windows; hide on deactivation via GPUI window-activation observation |
| No Dock / Cmd+Tab | `LSUIElement` in `Info.plist` | Native, zero code |
| App launch at login | `SMAppService.mainApp` via objc2 | Native API, macOS 13+ |
| Updates | Sparkle 2, pinned version and SHA-256, via objc2 (`SPUStandardUpdaterController`) | Standard for non-App-Store apps; EdDSA-verified |
| Local HTTP | Decided in spike check 2 between GPUI's `HttpClient` (`gpui-pre-reqwest-client`) and an explicitly declared client; must meet the transport rules below without adding a second async runtime | "Already in the dependency tree" is not an integration decision |
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
  "job": { "loaded": true, "disabled": false, "pid": 4312 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "matchesJob": true
  },
  "token": "<local token or null>"
}
```

- **`unit`** comes from parsing the plist. The aio-proxy path is not `ProgramArguments[0]` (that is `/bin/sh`); `wrapperValid` requires `ProgramArguments` to be exactly `["/bin/sh", "-c", <known wrapper>, <target>]`, and `target` is the fourth element. `home` is the plist's `AIO_PROXY_HOME`. `owner` is `desktop` when `target` equals the symlink path, `external` for any other valid target, `unknown` when the wrapper is not recognized, `null` when no plist exists.
- **`job`** comes from `launchctl print gui/<uid>/com.aio-proxy.agent` (loaded, pid) and `launchctl print-disabled gui/<uid>` (disabled). The disk plist and the loaded job can differ; both are reported.
- **`instance`** resolves the address with `AIO_PROXY_HOME` set to `unit.home` (the service's own config, not the calling process's environment), else the default home. A wildcard bind maps to its loopback (`0.0.0.0` → `127.0.0.1`, `::` → `::1`); a non-loopback bind yields `controlUrl: null` and no token is ever sent. `version` and `pid` come from `GET /dashboard/api/desktop-summary` (authenticated), not `/health`, so an instance is identified by a credential only a same-user process can read. `matchesJob` is `instance.pid == job.pid`.
- **`token`** is read from `<home>/desktop-token`; `null` if absent or failing the file checks below.
- Timeouts: 10s for the whole command, 2s per HTTP probe.

### What the app does automatically

Automatic mutation requires **`owner: desktop` and either `matchesJob: true` or no reachable instance**, plus a valid install location. Everything else is read-only until the user clicks.

| State | Automatic action |
| --- | --- |
| No plist | `service install` + `service start` (fresh install; the app now owns the service) |
| Desktop, loaded, enabled, no process | `service start` (which kickstarts, see CLI changes) — the recovery path after a dangling-symlink exit |
| Desktop, not loaded, enabled | `service start` |
| Desktop, disabled | Nothing. The user stopped it; show Stopped with a Start button |
| Desktop, running, `instance.version < bundledVersion` | `service restart`, then wait up to 30s for `/health` reporting `bundledVersion`. One attempt per app launch; on failure show the error, no retry loop |
| Desktop, running, `instance.version >= bundledVersion` | Nothing (never downgrade) |
| External or unknown owner, or `matchesJob: false` | Nothing, ever. Buttons act only on click |

The version-triggered restart interrupts in-flight requests: `shutdownProxyServer` is not a drain (`app.close()` then `server.stop(true)`). This is an accepted product decision for phase 1; the restart runs right after an update is installed, which the user has already consented to through Sparkle.

Every mutating command re-runs `__desktop-connect` first and aborts if ownership or `matchesJob` changed since the panel rendered.

### User actions

| Action | Desktop owner | External owner | Unknown owner / no plist |
| --- | --- | --- | --- |
| Start | `service start` | `service start` (does not rewrite an installed plist) | Not offered |
| Restart | `service restart` (rewrites the plist to the symlink) | `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent` (never rewrites the plist) | Not offered |
| Stop | `service stop` | `service stop` | Not offered |
| Reload config | `POST /admin/reload` (loopback, no auth) | same | same |

Completion conditions differ per action: Restart waits for `/health` with the expected version; Stop waits for `job.pid == null` and the instance unreachable; Reload reports the response (`409` carries `error` and `stage`). Then the panel refetches.

`service restart` is never used on an external service: `writeManagedUnit` rewrites the plist with the invoking binary.

"Proxy starts at login" is the launchd job itself (`RunAtLoad`). "App starts at login" is a separate toggle backed by `SMAppService`, whose UI reflects the real status including "requires approval" (with a link to System Settings).

### Dangling symlink

The launchd plist uses a conditional `KeepAlive` (`SuccessfulExit = false`); the `/bin/sh` wrapper already maps exit 1 to 0 so launchd does not relaunch on unrecoverable config errors. The wrapper gains `[ -x "$0" ] || exit 0` before `"$0" run`, so a missing executable is a clean exit launchd does not relaunch. The job stays loaded; recovery is the "loaded, enabled, no process" row above, which requires `service start` to kickstart a loaded job (CLI changes).

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
| Read checks | `lstat`: regular file, not a symlink, owned by the current uid, no group/other permission bits. A failing check means "no token" plus a logged reason; permissions are never widened or repaired silently |
| Lifetime | Loaded by the server once at boot. Persistent across restarts, reinstalls, and app updates. Rotation = replace the file and restart the proxy |
| Transport to the app | The stdout pipe of `__desktop-connect`. Never an environment variable or URL |
| Transport to the server | `Authorization: Bearer` |
| Logging | The Rust token type has a redacting `Debug`; the app never logs `__desktop-connect` stdout or `Authorization` |

This is a same-user local credential, not proof that the caller is the official app.

**Scope.** The token authorizes exactly one route: `GET /dashboard/api/desktop-summary`. That route has its own guard and always requires the desktop token, with or without a dashboard password. It is exempted from the dashboard session middleware; `DashboardAuthentication.verify()` is not changed, so the token is never a dashboard session. No other route accepts it. Being a `GET`, it never touches the CSRF guard.

**Loopback.** The route accepts the token only when `isDashboardLoopbackRequest` passes, which uses the socket peer from Bun's `requestIP` (`127.0.0.0/8`, `::1`, `::ffff:127.*`), not `Host`, `Origin`, or `X-Forwarded-For`. `requireLoopbackHost` also runs in front of `/dashboard/api/*`, but only when no dashboard password is set; the design does not rely on it.

**401 handling (client).** Re-run discovery once to pick up a replaced token. Still 401: show "authentication failed", never restart the proxy.

### CLI

- `__desktop-connect` as specified above.
- `serviceStart` on macOS: when the job is already loaded, `launchctl kickstart gui/<uid>/com.aio-proxy.agent` instead of `load -w` (which does not start an already-loaded job). Benefits CLI users too.
- `resolveAgentExecutable` checks `AIO_PROXY_DESKTOP_EXEC` first, before PATH and realpath resolution, and returns it verbatim (not passed through `resolveStableManagedExec`, so the symlink is never resolved into the bundle).
- When `AIO_PROXY_DESKTOP_EXEC` is set, `writeManagedUnit` writes the plist environment with `AIO_PROXY_DESKTOP_EXEC=<symlink>` and `AIO_PROXY_UPGRADE_METHOD=desktop`, skipping upgrade-method detection. Because the running daemon then inherits `AIO_PROXY_DESKTOP_EXEC`, every later rewrite from inside it (including `migratePreMarkerManagedUnit` at `run` startup) keeps the symlink and the marker. `UnitOptions.upgradeMethod` gains `'desktop'`.
- **No self-upgrade of desktop binaries.** `runUpgradeCommand` is the shared write path for `aio-proxy upgrade`, Dashboard "apply update" (`/dashboard/api/release/apply` → auto-update hooks), and background auto-update. It refuses when `AIO_PROXY_UPGRADE_METHOD=desktop` or the executable resolves inside a `.app` bundle, returning a result that tells the user to update through the desktop app.
- The launchd wrapper guard described above.

### Quota cache additions

The cache keeps successes in `entries`, first failures in `failures`, permanently unsupported Providers in `unsupported`, and running reads in `inFlight`. A peek of `entries` alone cannot tell "loading" from "first read failed". Two additions:

- `status(providerId)`, synchronous: `unsupported` | `failed` (in `failures`, no entry) | `ready` (entry; its `stale` flag means "last refresh failed, showing the previous snapshot", not "old") | `loading` (in flight, no entry) | `none`.
- `refresh(providerId)`: starts a background read bypassing cooldown, through the same `start()` so in-flight dedupe and generation isolation still apply. Never awaited by callers.

Read timeouts are already enforced by the host, not just signalled: `withOAuthAccountContext` wraps the plugin call in `withAbort(request.signal, …)` so a plugin that ignores its signal cannot hold the read past the cache's 15s `AbortSignal.timeout` (`oauth-account-context.ts`). A test still pins that `inFlight` clears after the timeout.

### `GET /dashboard/api/desktop-summary`

One versioned endpoint rather than several dashboard-internal ones: when the app attaches to an instance of a different version, this DTO is the contract. It is an explicit mapping, never a spread of internal objects.

```ts
type DesktopSummaryV1 = {
  protocolVersion: 1;
  generatedAt: string;                 // RFC 3339, UTC
  server: { version: string; pid: number };
  usage24h: {
    requests: string;                  // decimal integer strings, like the existing overview API
    failedRequests: string;
    inputTokens: string;
    outputTokens: string;
    estimatedCostNanoUsd: string | null; // null when no Provider has pricing
  };
  trend7d: Array<{ date: string /* YYYY-MM-DD, server-local */; requests: string; totalTokens: string; estimatedCostNanoUsd: string | null }>;
  activity: Array<{ date: string; requests: string }>; // up to 365 days
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    state: 'ok' | 'degraded' | 'cooldown' | 'disabled' | 'unknown';
    lastStatus: number | null;
    lastLatencyMs: number | null;
    quota:
      | { status: 'none' | 'unsupported' | 'loading' | 'failed' }
      | { status: 'ready'; sampledAt: string; refreshFailed: boolean;
          windows: Array<{ label: string; usedFraction: number | null; resetsAt: string | null }> };
  }>;
  alerts: Array<{ providerId: string; kind: 'credential' | 'cooldown' | 'quota_exhausted'; message: string }>;
};
```

Sources (the implementation plan confirms each mapping against the current type):

| Field | Source |
| --- | --- |
| `usage24h` | `traceStore.overviewDashboard({ range: '24h' }).summary`; `failedRequests` from `overviewDashboardDiagnostics({ range: '24h' })` |
| `trend7d` | `traceStore.overviewDashboard({ range: '7d' })` series |
| `activity` | `traceStore.overviewDashboardActivity()` |
| `providers` | `state.providerSummaries({ probe: false })` + `quotaCache.status()` / entry snapshot windows |
| `alerts` | Derived from providers |

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

Local aggregation costs the same in one endpoint or four: SQLite reads are synchronous on a single-threaded server. The summary then only reads `status()` and calls the existing `warm()`; it holds no quota promise. At the refresh policy below (at most every 15s, only while the panel is open) the ~3 ms event-loop hold is negligible. A larger database scales the 24h query; the spike re-measures on a synthetic 1 GB trace DB.

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
- The token is attached only when the URL host is a literal loopback IP (`127.0.0.1` or `::1`); never to a hostname, never to a non-loopback address.
- The token is never set as a default header on any client.

## Desktop app structure

One Cargo binary crate at `desktop/`, outside the Bun workspace.

| Module | Responsibility |
| --- | --- |
| `main.rs` | GPUI application, single-instance lock, tray creation, wake notification, `--version` |
| `tray.rs` | `tray-icon` setup; left click toggles the panel with the icon rect; right click opens a native menu (Open Dashboard, Quit); three icon states |
| `panel/` | PopUp placement (below the menu bar, centered on the icon, clamped to the icon's screen) and views: stat cards, Provider quota list, 7-day trend, heatmap, action row |
| `install.rs` | Install-location policy, symlink maintenance and no-downgrade rule |
| `connect.rs` | `__desktop-connect` invocation and parsing, automatic-action table, user actions with completion conditions |
| `client.rs` | Local HTTP transport and the refresh policy |
| `summary.rs` | `DesktopSummaryV1` types; version-first parsing |
| `login_item.rs` | `SMAppService.mainApp` register/unregister/status |
| `updater.rs` | Sparkle controller on the main thread |

Panel details:

- No arrow, matching arrowless system menu-bar popovers such as Control Center.
- The heatmap is a plain grid of cells; GPUI Kit has no heatmap component and a fixed 365-cell grid does not need one.
- Window lifecycle on close is decided by spike check 3; the model and last response survive either way.
- "Open logs" reveals `$AIO_PROXY_HOME/logs` in Finder. The app's own log goes to `~/Library/Logs/aio-proxy-desktop/`.
- An instance whose `desktop-summary` is missing (404, older version) or has an unsupported `protocolVersion` gets a degraded panel: status, endpoint, Open Dashboard, Reload.

## Build, sign, release

### Bundle command

`bun run desktop:bundle` (`desktop/scripts/bundle.ts`) is the only entry point for CI and release:

1. Verify tools (`cargo`, `codesign`, `xcrun notarytool`, `vtool`, pinned Sparkle tools) and fail fast.
2. `bun run build` (includes the dashboard `dist` the compiled entry embeds).
3. `build-binary.ts darwin-arm64 <out>`; require `THIRD_PARTY_NOTICES` next to it.
4. `cargo build --release --target aarch64-apple-darwin` with `MACOSX_DEPLOYMENT_TARGET=13.0`. `build.rs` links `Sparkle.framework` and adds the rpath `@loader_path/../Frameworks`.
5. Assemble the `.app`:
   - `Contents/MacOS/aio-proxy-desktop`, `Contents/MacOS/aio-proxy`
   - `Contents/Frameworks/Sparkle.framework`, the pinned release (SHA-256 checked), copied with symlinks intact
   - `Contents/Resources/THIRD_PARTY_NOTICES` (aio-proxy's plus Sparkle's license)
   - `Info.plist`: `CFBundleIdentifier`, `CFBundleExecutable`, `CFBundleName`, `CFBundleDisplayName`, `CFBundleShortVersionString`, `CFBundleVersion`, `LSUIElement`, `LSMinimumSystemVersion`, `SUFeedURL`, `SUPublicEDKey`
6. Checks: `lipo -archs` is `arm64` for every Mach-O; `vtool -show-build` `minos` ≤ 13.0 for every Mach-O; `aio-proxy-desktop --version` runs (proves dyld resolves Sparkle through the rpath).
7. Runtime smoke (below).
8. `--unsigned` stops here with an ad-hoc signature. Release continues to signing.

Version: `CFBundleShortVersionString` and `CFBundleVersion` are both the `version` of `npm/aio-proxy/package.json` (the product package; lockstep through the Changesets `fixed` group). A stable `X.Y.Z` is monotonic and Sparkle compares it correctly. Canary builds skip the desktop, so prerelease strings never reach `CFBundleVersion`; if desktop prereleases ship later, add a numeric build number then.

### Runtime smoke

Against the assembled bundle, with a temporary `AIO_PROXY_HOME` holding a minimal config on a free port, and `PATH=/usr/bin:/bin` (no Bun, Node, or user tools): start `aio-proxy run` from the bundle, then check `/health` reports the bundle version, `/dashboard` returns HTML and one asset it references returns 200, and `desktop-summary` answers 200 with the token from the temp home; then SIGTERM it. It never installs a launchd job.

### Signing and notarization

The sidecar's entitlements are a committed, fixed file (`desktop/entitlements/aio-proxy.plist`) with a comment justifying each key. Spike check 1 starts from Bun's documented standalone set (`allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`), confirms the real release sidecar works with it, then removes keys one at a time while re-running the workload: a proxied request, an OAuth Provider, a plugin load, and SQLite. The release script never adds entitlements. The host executable gets none unless the spike proves one necessary. Sparkle's components are signed per the pinned Sparkle version's documented procedure, including `--preserve-metadata=entitlements` on `Downloader.xpc`; they never receive the sidecar's file.

`build-binary.ts` ad-hoc resigns Bun output (its comment says the arm64 signer was fixed in Bun 1.4.1 and the x64 target still fails); the Developer ID signature replaces it either way.

Order:

1. Sign inside-out with Developer ID, hardened runtime, and `--timestamp`: Sparkle's nested helpers and XPC services, `Sparkle.framework`, `aio-proxy`, `aio-proxy-desktop`, then the `.app`. `--deep` is never used for signing.
2. `codesign --verify --deep --strict --verbose=2` on the `.app` (structure only; Gatekeeper assessment of an un-notarized app is expected to fail and is not a gate here).
3. Zip with `ditto -c -k --keepParent`, `notarytool submit --wait`, `stapler staple` the `.app`.
4. Gatekeeper assessment of the `.app`: `syspolicy_check distribution` and `spctl --assess --type execute`.
5. Build the `.dmg` from the stapled `.app`, sign it, `notarytool submit --wait`, `stapler staple`.
6. `spctl --assess --type open --context context:primary-signature` on the `.dmg`; `stapler validate` on both.
7. EdDSA-sign the final `.dmg` bytes (via `generate_appcast`) and verify against `SUPublicEDKey`.

### Release job and feed

- A separate `desktop` job, `needs: release`, on a pinned arm64 macOS runner label (the runner is per job, so it cannot be a step in the existing job). It sets up Bun from `.bun-version` and Rust from `desktop/rust-toolchain.toml` with `rustup target add aarch64-apple-darwin`.
- It also has a `workflow_dispatch` entry taking a release tag, so a failed desktop publish is resumed for the same immutable version without re-running the npm publish.
- Idempotence: if `aio-proxy-<version>-arm64.dmg` already exists on the tag's Release, the job downloads it and re-verifies it instead of rebuilding; it never uploads different bytes under the same name.
- **Feed.** `SUFeedURL` is `https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml`: a dedicated prerelease tag `desktop-feed` that never becomes "latest" and holds only `appcast.xml`. The Changesets Release becoming latest therefore never affects the feed.
- Publish sequence, with the feed upload as the single commit point:
  1. Upload the `.dmg` to the version's Release (or reuse it, above).
  2. Verify the versioned URL `https://github.com/aio-proxy/aio-proxy/releases/download/v<version>/aio-proxy-<version>-arm64.dmg` answers 200.
  3. Download the current `appcast.xml` from `desktop-feed`.
  4. Run the pinned `generate_appcast` with that file beside the new `.dmg`, `--download-url-prefix` set to the versioned Release URL, and `--maximum-versions 3` stated explicitly. It reads prior items from the existing XML; old `.dmg` files are not needed locally.
  5. `gh release upload desktop-feed appcast.xml --clobber`. The replace has a brief window where the feed 404s; Sparkle treats that as a failed check and retries on its schedule.
- Canary releases skip the desktop job.
- New secrets: Developer ID certificate (p12 + password), App Store Connect API key for `notarytool`, Sparkle EdDSA private key.

### CI

| Job | Paths | Runs |
| --- | --- | --- |
| Rust | `desktop/**` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` |
| Bundle smoke | `desktop/**`, `packages/cli/scripts/**`, `.github/workflows/**`, `bun.lock`, `.bun-version` | `bun run desktop:bundle --unsigned` (includes the runtime smoke) |

Server and dashboard changes can break the compiled sidecar without changing the bundle layout. They are not in the PR smoke paths to spare macOS minutes, but the release `desktop` job always runs the full runtime smoke before signing, so a broken sidecar blocks only the desktop publish, which is resumable by tag.

### Changesets

`desktop/` is not a workspace package. Desktop release notes target `aio-proxy`, per the repo rule that user-facing changesets must target a product package. Server/CLI changes list `@aio-proxy/server` / `@aio-proxy/cli` alongside `aio-proxy`. A desktop-only changeset targeting `aio-proxy` still bumps the desktop version, because the bundle reads the product package version.

## Phasing

Release and lifecycle risks block the plan, so they are proven before any product contract merges.

0. **Spike** (throwaway code; the output is the go/no-go below). Check 1 first.
1. **Server + CLI.** Token, `__desktop-connect`, `serviceStart` kickstart, `AIO_PROXY_DESKTOP_EXEC` + marker, upgrade refusal, wrapper guard, quota `status`/`refresh`, `desktop-summary`.
2. **Desktop app** in `desktop/`.
3. **Release pipeline.**

### Spike checks

| # | Check | Pass | If it fails |
| --- | --- | --- | --- |
| 1 | The real release sidecar (not hello-world) and a minimal GPUI host with Sparkle, signed and notarized per the order above, as `.app` and `.dmg`; installed on a clean Mac by browser download (quarantine set); launched by launchd through the symlink; one Sparkle update from build N to N+1 with the proxy restarted onto N+1; then: delete the app, kill the running daemon so the wrapper's missing-executable branch actually runs, watch `launchctl print` and the unified log for 10 minutes, restore the app, launch it, and confirm the loaded job is kickstarted back | Every verification command passes; the sidecar serves the entitlement workload; the update installs; no relaunch or log spam while missing; recovery succeeds | Blocks the plan as specified |
| 2 | GPUI Kit PopUp + `tray-icon`: anchoring, hide on deactivation, absent from Dock and Cmd+Tab, multiple displays with different scale factors, full-screen Spaces, sleep/wake. Also fixes the local HTTP stack (meets the transport rules, cancellation, no second runtime) and Sparkle's integration with GPUI's main loop | Correct in every case | Try hosting GPUI content in an objc2-created `NSPanel`; unverified that the pinned GPUI supports this, so a failure here reopens the UI stack decision |
| 3 | Window lifecycle and resources; plus the 24h summary query on a synthetic 1 GB trace DB | Matrix below; panel-closed RSS ≤ 40 MB with ≤ 1 idle wakeup/s; summary ≤ 50 ms | Destroy vs hide per matrix; a slow summary moves aggregation behind a cache |

Check 3 decision matrix:

| Strategy | Choose when |
| --- | --- |
| Destroy/recreate | Reopen ≤ 100 ms, no visible flash, RSS drops after close, 100 cycles grow memory ≤ 10 MB |
| Hide/show | Destroy/recreate misses the reopen or flash criteria, and a hidden window still meets the closed-panel budget |
| Hybrid | Keep the model and last summary, destroy the window and its Metal surface; choose when it meets the destroy criteria with less reopen work |

## Testing

Each automated test guards one concrete failure.

- **Server**
  - `desktop-summary` accepts the desktop token from a loopback peer, with and without a dashboard password.
  - With a dashboard password set, the desktop token gets 401 on another `/dashboard/api/*` route (it adds no dashboard privilege). Without a password, a request with the token gets exactly what an anonymous loopback request gets.
  - The token is rejected from a non-loopback peer even when `Host`, `Origin`, or `X-Forwarded-For` claim loopback: IPv4, IPv6, and IPv4-mapped peers via injected connection metadata, plus one real-socket integration test.
  - Token file checks: a symlink, a group-readable file, and a file owned by another uid each yield "no token"; two concurrent creators end with one token both read.
  - `desktop-summary` returns promptly with `loading` quota when the quota reader never resolves (guards the measured 1.3s stall); a first-read failure shows `failed`, not `loading`; one Provider's failure leaves the response 200.
  - A never-settling quota read clears `inFlight` after the timeout and a later read can start.
  - The DTO: golden fixture shared with the Rust tests; internal fields added to Provider summaries do not appear in the response.
- **CLI**
  - `__desktop-connect`: `owner` for desktop, external, unrecognized-wrapper, and absent plists; `home` taken from the plist, not the environment; wildcard bind mapped to loopback; non-loopback bind yields `controlUrl: null`; stdout is exactly one JSON object when the command fails partway.
  - `serviceStart` kickstarts an already-loaded job and loads an unloaded one (manager calls injected).
  - With `AIO_PROXY_DESKTOP_EXEC` set, the written plist targets that exact path (not its realpath) and carries both env markers; a rewrite from a process that inherited the markers keeps them.
  - `runUpgradeCommand` refuses for a desktop-marked process and for an executable inside a `.app`, without invoking any installer.
  - The launchd wrapper exits 0 when its executable is missing, asserted by executing the wrapper.
- **Rust**
  - Panel placement clamps to the screen for icons near an edge.
  - Summary parsing: unknown fields ignored, unknown enum values map to `Unknown`, unsupported `protocolVersion` selects the degraded panel; the golden fixture parses.
  - The automatic-action table: every row, including never acting on external/unknown/mismatched instances and never downgrading.
  - Refresh scheduler: responses from a closed session, another instance, or an older counter are discarded; the 15s floor holds under a trigger storm; closing cancels everything.
  - Transport: the token is not attached to a hostname, a non-loopback IP, or a redirect target; proxy environment variables are ignored.
  - Install policy and symlink: outside `/Applications` nothing persistent happens; a newer installed copy is never re-pointed to an older one; a second instance exits.
  - The token type's `Debug` output is redacted.
- **Release** (the bundle script fails the job): arm64 and `minos` for every Mach-O; `codesign --verify --strict`; post-notarization `syspolicy_check`/`spctl` for the `.app` and `.dmg`; `stapler validate` for both; the Sparkle signature verifies against `SUPublicEDKey`; the versioned `.dmg` URL answers 200 before the feed is replaced.
- **Manual acceptance (UI and lifecycle):** toggle via icon; click outside hides; not in Dock or Cmd+Tab; second display with a different scale factor; full-screen app in another Space; sleep/wake with panel open and closed; each user action per ownership with its completion condition; an external service is never changed without a click and never has its plist rewritten; a user-stopped desktop service stays stopped across app relaunch; quit leaves the proxy running; a Sparkle update restarts a desktop-owned proxy onto the new version; opening an older app copy does not downgrade; app deleted leaves launchd quiet and restoring it recovers.
