# macOS desktop client: spike findings

Date: 2026-09-30
Spec: `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (rev 4 folds these findings in)
Spike plan: `docs/superpowers/plans/2026-09-29-desktop-spike.md`
Spike code: branch `spike/desktop`, commits `d3c12c105` through `85b85767d`. The branch is never merged and is kept until the human checks below are done, because their scripts live only there: `spike/desktop-host/{bundle.sh,sign.sh,notarize.sh}`, `spike/desktop-host/workload/`, `spike/desktop-host/launchd/`, `spike/desktop-host/bench/`. Build outputs under `spike/out/` (sidecar, Sparkle, bundle) are git-ignored and stay on disk.

## Environment and limits

- macOS 27.0, arm64, Command Line Tools only (no Xcode.app), no Developer ID identity, no notary profile.
- Every signature in the spike is **ad-hoc with hardened runtime** (`flags=0x10002(adhoc,runtime)`). Developer ID signing, notarization and Gatekeeper were not run.
- The Mac was **locked with the display asleep** during Tasks 2 and 6. No window could become key and AppKit animations never finished. Numbers that depend on rendering are tagged **[locked]**.
- launchd experiments ran against a sandbox job `dev.aio-proxy.spike` bootstrapped from a temp path on port 19317. The real `com.aio-proxy.agent` job and `~/.aio-proxy` were not changed (one read-only `provider list` call reached the real :9317 by accident; nothing was written).

## Verdict

**CONDITIONAL GO.** Every automatable check passed or was settled by a ruling; each spike check still has human confirmation items.

| Check | Result | Still pending |
| --- | --- | --- |
| 1. Release sidecar, signing, launchd, update, recovery | **PENDING (sandboxed mechanics pass)**: ad-hoc bundle verified; entitlements minimized; launchd, recovery and Sparkle N→N+1 proven in a sandbox. A Developer ID signing or notarization failure still blocks the plan (spec: "If it fails: Blocks the plan as specified") | Developer ID signing and host launch without entitlements; Developer ID entitlement re-run; OAuth workload step; notarization of `.app` and `.dmg`; clean-Mac browser install; Developer ID Sparkle update from a DMG through "Install and Relaunch" with no signature-mismatch line |
| 2. Panel, tray, HTTP stack, Sparkle in the GPUI loop | **PENDING (not passed)**: anchoring, clamping, Dock/Cmd+Tab policy, HTTP stack and Sparkle startup pass | Click elsewhere closes; click icon again closes; second display with another scale factor; full-screen Space; sleep/wake. A click-away failure reopens the UI stack decision, since no fallback exists (see Panel) |
| 3. Window lifecycle, resources, summary cost | **GO, conditional**: summary ≤ 50 ms passes; closed budget passes by physical footprint [locked]; lifecycle hybrid, PROVISIONAL | Visible flash and on-screen reopen latency; unlocked re-measure; powermetrics wakeup cross-check |

Fallbacks taken: none. The NSPanel-hosting fallback for check 2 was not built (no automated check failed, and GPUI cannot host in an external view anyway). The summary query needs no cache.

## Resolved versions

| Component | Version |
| --- | --- |
| Rust | rustc 1.98.1, cargo 1.98.1 (via `mise`), target `aarch64-apple-darwin` |
| GPUI | `gpui-pre` 0.3.7 (`gpui-pre-platform`, `gpui-pre-macos` 0.3.7) |
| GPUI Kit | `gpui-kit` 0.7.0 (re-exports GPUI and `gpui-component` 0.7.0, `gpui-base` 0.7.0); depend on `gpui-kit`, as its `hello_world` does |
| Tray | `tray-icon` 0.21.3 (`muda` 0.17.2) |
| objc2 | `objc2` 0.6.4, `objc2-app-kit` 0.3.2, `objc2-foundation` 0.3.2 (0.5/0.2 also present transitively) |
| Measured, not chosen | `gpui-pre-reqwest` 0.12.15, `gpui-pre-reqwest-client` 0.3.7 |
| Sparkle | 2.10.0 |
| Sidecar | aio-proxy 0.35.1, `build-binary.ts darwin-arm64`, 78 MB |

Hello-world release binary 17.7 MiB; cold release build 45.8 s with dependencies already fetched (fetch time excluded). Only warning: a future-incompat notice for `block` 0.1.6.

## Panel behavior matrix (Task 2)

| Case | Result |
| --- | --- |
| Click icon: panel opens under the icon | PASS (geometry, automated): panel top equals the status item's bottom, centre within 0.5 pt. Visual check with a real click is pending |
| Click icon again: closes | PENDING (socket toggle closes it; the real-click path depends on key/deactivation order) |
| Click elsewhere: closes | PENDING. While locked the panel never became key and no activation callback fired |
| Not in Cmd+Tab, no Dock icon | PASS by policy (`accessory`, `lsappinfo` type `UIElement`) |
| Icon near a screen edge: clamped | PASS (simulated anchors at both edges) |
| Second display, different scale | PENDING (one display attached) |
| Full-screen app in another Space | PENDING (PopUp already sets `CanJoinAllSpaces \| FullScreenAuxiliary` at level 101) |
| Sleep/wake with panel open and closed | PENDING |

Facts established:

- GPUI forces `NSApplicationActivationPolicyRegular` in `applicationDidFinishLaunching`; the accessory policy is set in the `run` callback, and `LSUIElement` covers the launch.
- `WindowKind::PopUp` in gpui-pre 0.3.7 is already an `NSPanel` (`GPUIPanel`): `NonactivatingPanel`, level 101, `CanJoinAllSpaces | FullScreenAuxiliary`, utility-window animation. It is titled with a full-size content view, not borderless.
- **GPUI cannot be hosted in an external `NSView`/`NSPanel`.** `open_window` always allocates its own window and view, and every Mac platform type except `MacPlatform` is crate-private. The only escape hatch is `HasWindowHandle`, which reaches the GPUI-created panel for tuning (level, collection behaviour, animation, `makeKeyAndOrderFront`).
- The status item's frame is zero right after `TrayIconBuilder::build()`. Anchor only from a click (or the next runloop turn). tray-icon's rect is the button window frame × scale, flipped, in physical pixels; the spike anchors in AppKit points from the button's `NSWindow`.
- `cx.activate(true)` from a non-user trigger does not activate the app (cooperative activation).

## HTTP stack (Task 2)

Proxy environment variables were all pointed at `127.0.0.1:1` for every run.

| Rule | GPUI `ReqwestClient` over a hand-built `reqwest::Client` | `ReqwestClient::new()` | `reqwest::blocking` | std `TcpStream` HTTP/1.1 |
| --- | --- | --- | --- | --- |
| Proxy env ignored | PASS | FAIL (uses the env proxy) | PASS | PASS |
| No redirects | PASS | n/a | PASS | PASS |
| 1 s connect timeout | PASS (1.02 s) | not configurable (fixed 10 s) | PASS (1.10 s) | PASS (1.00 s) |
| 5 s total timeout | PASS (5.00 s) | not set | PASS (5.01 s) | PASS (5.00 s) |
| Cancelled on panel close | PASS (+25 ms) | n/a | FAIL (socket stays open) | PASS (+26 ms, including a drop between connect and send) |
| No second async runtime | FAIL (`tokio-rt-worker`) | FAIL | FAIL (`reqwest-internal-sync-runtime`) | PASS |

**Chosen: the minimal std `TcpStream` loopback client** (ruling), about 35 lines, cancelled by `shutdown(Both)` from a drop guard owned by the GPUI task, with the whole request raced against a GPUI 5 s timer. It is the only stack meeting all six rules. Production must add:

- `Transfer-Encoding: chunked` decoding (the spike reads to EOF with `Connection: close`) and a response size cap.
- An automated slow-drip test for the total deadline. In the spike the 5 s socket read timeout and the 5 s timer expired together, so the timer path was never seen firing on its own.

The system-proxy half of the proxy rule holds by construction (the client never consults proxies) and was not separately tested.

What the rule saves, measured against `SPIKE_HTTP=gpui` (Task 6): one permanent `tokio-rt-worker` thread, +2.9 to 3.1 MiB RSS, +1.8 to 1.9 MB physical footprint, and zero idle wakeups (the idle tokio worker parks). reqwest, rustls and aws-lc add about 6 MiB of binary when linked (17.7 → 23.6 MiB; not re-measured with it cfg-gated out).

## Bundle, Sparkle and signing (Task 3)

- Sparkle **2.10.0**, asset `Sparkle-2.10.0.tar.xz`, SHA-256 **`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`** (matches GitHub's asset digest). The asset is `.tar.xz`: extract with `tar -xJf` (symlinks kept), copy into the bundle with `ditto`.
- Framework binaries are universal (x86_64 + arm64), **minos 12.0**. Sidecar minos 13.0 (SDK 26.5); host minos 13.0. All ≤ 13.0.
- Host links `@rpath/Sparkle.framework/Versions/B/Sparkle` with `LC_RPATH @loader_path/../Frameworks`; dyld resolves it from the bundle.
- `Info.plist` also needs `CFBundlePackageType=APPL` and `CFBundleInfoDictionaryVersion=6.0`.
- Nested paths in 2.10.0 match the plan and Sparkle's sandboxing docs. Signing order used, each `-f -s "$ID" -o runtime`, plus `--timestamp` for a non-ad-hoc identity:
  1. `Sparkle.framework/Versions/B/XPCServices/Installer.xpc`
  2. `Sparkle.framework/Versions/B/XPCServices/Downloader.xpc` with `--preserve-metadata=entitlements`
  3. `Sparkle.framework/Versions/B/Autoupdate`
  4. `Sparkle.framework/Versions/B/Updater.app`
  5. `Sparkle.framework`
  6. `Contents/MacOS/aio-proxy` with `--entitlements aio-proxy.plist`
  7. `Contents/MacOS/aio-proxy-desktop`
  8. the `.app`
- The documented order re-signs `Autoupdate` without `--preserve-metadata`, dropping its `application-identifier` entitlement; that matches Sparkle's docs.
- **Signing the `.app` re-signs its main executable** and replaces step 7's signature. Any host entitlement must go on the `.app` step.
- `codesign --verify --deep --strict --verbose=2`: valid on disk, satisfies its Designated Requirement.
- **Ad-hoc plus hardened runtime blocks Sparkle**: library validation rejects the framework ("mapping process and mapped file (non-platform) have different Team IDs"), because ad-hoc signatures have no Team ID. The ad-hoc build gives the host `disable-library-validation`. Under Developer ID the host and framework share a Team ID, so the host should need no entitlement: pending.
- Sparkle started inside GPUI's main loop through objc2 (`SPUStandardUpdaterController`, `startingUpdater: true`) with no error. An `http://127.0.0.1` feed needed no ATS key (Task 5); the product feed is https.

## Entitlements (Task 4)

Workload per variant, under the ad-hoc hardened sidecar in a fresh temp home: `/health`; a raw-passthrough request, non-stream and stream; 200 timed requests; `plugin add @ai-sdk/openai-compatible` (runs `bun install`), then a restart that serves a model through the installed AI SDK package; `plugin list` and the dashboard plugins API; the SQLite trace count; and `vmmap` for the `JS JIT Generated Code` region before and after the restart.

| Key | Result | Decision |
| --- | --- | --- |
| `com.apple.security.cs.allow-jit` | Needed: without any JIT-capable key the `JS JIT` region disappears (4 → 0 vmmap lines) and latency rises from 0.93-1.07 ms to 1.30-1.34 ms per request | **Keep.** Apple's narrowest key for MAP_JIT |
| `allow-unsigned-executable-memory` | Alone also keeps JIT | Drop: broader than `allow-jit` |
| `disable-executable-page-protection` | Alone also keeps JIT | Drop: broader than `allow-jit` |
| `allow-dyld-environment-variables` | Never exercised (nothing sets `DYLD_*`) | Drop |
| `disable-library-validation` | Never exercised: no native `.node` addon or foreign dylib is loaded | Drop. **Native-addon plugins are unsupported under the desktop sidecar** (ruling; no first-party code uses `dlopen`, `bun:ffi` or `.node`) |

Final sidecar set: **`allow-jit` only** [ad-hoc-proven; Developer ID re-confirmation pending]. Every functional step passes even with no entitlements: Bun silently falls back to the interpreter. JIT is therefore verified through `vmmap`, never by "it runs". The workload script exits 3 when vmmap itself fails, so a failure cannot read as "no JIT".

Separate product bug found: compiled-binary `plugin add` prints "Unexpected internal error" (exit 2) after a successful install, identically with the unsigned and the Homebrew 0.35.1 binary. It is not caused by signing and is tracked separately.

## Notarization and Gatekeeper

Not run: no Developer ID identity or notary profile on the machine. `notarize.sh` holds the plan's commands; it does not fetch the notary log on `Invalid` (run `xcrun notarytool log <id> --keychain-profile aio-proxy-notary` by hand). Whether `xcrun stapler` works with Command Line Tools alone is unverified.

## launchd, update and recovery (Task 5)

- The job runs through the symlink: `lsof` resolves the sidecar's text to the bundle binary.
- **`launchctl print`'s `pid` is the `/bin/sh` wrapper**; the sidecar is its child in the same process group.
- `KeepAlive={SuccessfulExit=false}` with the spec wrapper:
  - Sidecar SIGKILL (exit 137): relaunched, `/health` back after 1 s.
  - Wrapper SIGKILL: launchd reaps the group, no orphan, relaunched.
  - Exit 1 (broken config): remapped to 0, not relaunched (checked for 60 s).
  - **A SIGTERM launchd did not send (user `kill`, `pkill`)**: `aio-proxy run` exits 0 gracefully and the job stays down.
- **Missing app, then kill:** exactly one extra run hits `[ -x "$0" ] || exit 0`; `runs` stayed at 7 for 10 minutes, and the unified log held 2 launchd lines. Restoring the app does not revive the job.
- **`launchctl load -w` does not start an already-loaded job**, and on "Load failed: 5: Input/output error" it **exits 0**. `launchctl kickstart` revives the job.
- **Stop and restart signals.** `kickstart -k`, `bootout` and `unload -w` all deliver a graceful SIGTERM to the sidecar. launchd signals the wrapper, which dies at once, then SIGTERMs the rest of the process group. Evidence: the DB ownership lock was released, and a stand-in logged TERM even after `kill -9` of the wrapper.
- **launchd never escalates to SIGKILL.** Observed only with a shell stand-in that ignores SIGTERM: it survived 60 s as an orphan (ppid 1) while `kickstart -k` started a new instance. The real sidecar was never seen hanging: on every graceful path it released its DB lock, and `shutdownProxyServer` stops the listener synchronously once the handler runs. The stale-binary chain (new sidecar fails to bind, exits 1, is remapped to 0, service stays on the old binary) is an **inference**. It could only happen to the real binary if its JS thread were blocked before the handler ran, and then no in-process deadline would fire either. `kickstart -k` blocks about 7 s.
- A trap-forwarding wrapper variant changes nothing but the recorded exit code (143), so it was **not adopted**.
- **Sparkle N→N+1** (ad-hoc, zip archive, file-based EdDSA key, background check with `SUAutomaticallyUpdate`):
  - The feed and archive were fetched over `http://127.0.0.1` with no ATS change, and `Autoupdate` logged "EdDSA signature is correct".
  - It then logged "Code signature of the new version doesn't match the old version" (an ad-hoc designated requirement is the cdhash) and **installed anyway**: with a valid EdDSA signature Sparkle 2 does not refuse.
  - Install-on-quit does **not relaunch** the app.
  - The old sidecar kept serving from the old inode until `kickstart -k` moved it to the new binary.
- Sparkle warned that a background (`LSUIElement`) app has no "gentle reminders" for scheduled update checks. Since every update goes through the UI dialog, Phase 2 must implement `SPUStandardUserDriverDelegate` gentle-reminder support (e.g. surface the pending update in the menu-bar icon or panel).
- `generate_appcast --account <name>` blocked for 5 minutes on a Keychain ACL prompt (`SecurityAgent`); `--ed-key-file` works non-interactively.

## Resources and window lifecycle (Task 6)

Measured on the bundled ad-hoc app, default std HTTP. Wakeups come from `proc_pid_rusage` interrupt wakeups (validated against a 20/s control; `top`'s IDLEW reads 0 for everything here).

| State | RSS | Physical footprint | Interrupt wakeups/s |
| --- | --- | --- | --- |
| Launched, never opened | 82.1 MB | 24.7 MB | 0.10 |
| Open [locked] | 92.4 MB | 48.5 MB | 1.10 (1 s ticker) |
| Closed after one open (destroy/hybrid) | 92.1 MB | **32.4 MB** | **0.37** [locked] |
| Reference: bare Swift `NSStatusItem` app | 44.1 MB | 12.4 MB | 0.05 |

- **Closed-panel budget restated as physical footprint ≤ 40 MB** (ruling). RSS counts shared framework and dyld-cache pages, and a bare AppKit status-item app is already 44.1 MB (45,136 KB) RSS, so no AppKit menu-bar app can meet 40 MB RSS. Measured 32.4 MB footprint: PASS [locked]. "Memory drops after close" is judged by footprint too: −16 MB, with the IOSurface and IOAccelerator memory released, while RSS moves only −0.5 MB.
- Every window creation briefly allocates about 190 MB of graphics memory (`owned unmapped (graphics)`) for about 1.2 s, likely GPUI's per-window `MetalRenderer`, then falls to 48 MB [locked]. Hide re-show has no such spike.

100 open/close cycles:

| | destroy | destroy, animation None [locked] | hide [locked] | hybrid |
| --- | --- | --- | --- | --- |
| Footprint growth | +10.5 MB [locked] | +0.6 MB | −5.9 MB | +10.4 MB [locked] |
| Closed footprint | 32-43 MB | 32.6 MB | 42.2 MB (over budget) | 32-43 MB |
| Metal surface when closed | released | released | kept | released |
| Toggle → next frame, p50 / p95 (GPUI callback proxy, not on-screen) | 13.7 / 14.5 ms [locked] | 13.5 / 14.2 ms | not measurable while locked | 14.2 / 15.6 ms [locked] |
| Closed wakeups/s | 0.37 | 0.37 | 0.40 | 0.37 |

- The ~10 MB growth with default animation is one leaked `NSAnimation` thread per cycle, because the locked session never finishes the utility-window animation. `NSWindowAnimationBehaviorNone` removes it (flat after cycle 25, 7 threads).
- **Window lifecycle: hybrid, PROVISIONAL** (ruling). On close, destroy the window and its Metal surface, and keep the summary model and last response in an app-level entity. Set `NSWindowAnimationBehaviorNone` on the GPUI panel after creation. Hybrid over destroy is a UX choice (no empty panel on reopen), not a measured difference. Switch to destroy if flash or latency testing argues against it; hide fails the closed budget.
- Open questions: the rise from 0.10 to 0.37 wakeups/s after the first open/close (in every variant, so not the animation leak), and 7.7 MB of footprint that stays after the first open/close (mostly IOAccelerator +2.9 MB and malloc +3.6 MB; flat afterwards).

## Summary query on a 1 GB trace DB (Task 6)

Seeded with `spike/desktop-host/bench/seed-trace-db.ts` (`openDb` + `createTraceStore`). Each DB was about 1.07 GB, with 615,000 traces, 1.55 M spans and a 365-day spread, and was deleted afterwards. Timings are in-process, page cache warm, 30 runs × 2 processes:

| DB | Roots in 24 h | 24 h overview p50 | Sum of the three queries, p50 / p95 / first |
| --- | --- | --- | --- |
| Scattered layout (random start times): upper bound | 33,320 | 54.7 ms | 55.7 / 60.2 / 67.6 ms |
| Chronological, heavy | 36,082 | 29.1-29.3 ms | **31.1 / 32.5-33.3 / 38.7-39.6 ms** |
| Chronological, moderate | 3,987 | 3.0 ms | **4.8 / 5.8 / 11.6 ms** |

- Only the 24 h overview reads `trace_span`. It aggregates every root in the window in JS, at about 0.8 µs per row with production's chronological inserts. The 7-day and activity queries read the `usage_daily` rollup in under 2 ms.
- Cost is linear in requests per 24 h, nearly independent of DB size. The 50 ms budget holds up to roughly **55-60k requests per 24 h**.
- The queries are synchronous `bun:sqlite` calls, so each poll blocks the server's Bun thread for their duration (about 31 ms per 15 s poll for a heavy user). The numbers exclude the HTTP hop and JSON serialization.
- **Decision** (ruling): accept without a cache or rollup; revisit with an hourly rollup if a user exceeds the ceiling. Cold-cache timing was not measured.

## Spec contradictions and resolutions

| # | Finding | Resolution (ruling) |
| --- | --- | --- |
| C1 | `matchesJob = instance.pid == job.pid` is always false: `job.pid` is the `/bin/sh` wrapper | `desktop-summary.server` gains `ppid` (`process.ppid`); `matchesJob = instance.pid == job.pid \|\| instance.ppid == job.pid`. A reparented sidecar (wrapper gone) does not match, the safe direction |
| C2 | A graceful SIGTERM of the sidecar exits 0, so launchd leaves the service down | Documented. The app's automatic table (or the user) starts it again |
| C3 | The automatic "loaded, enabled, no process → service start" row has no attempt limit; broken config (exit 1 → 0) looks identical, so it would loop | One attempt per app launch; on failure show the error, no retry loop |
| C4 | `launchctl load -w` exits 0 on "Load failed: 5" | `serviceStart` enables the job, kickstarts a loaded one or bootstraps an unloaded one (`launchctl bootstrap gui/<uid> <plist>`), then verifies with `launchctl print`; `serviceRestart` does bootout + the same |
| C5 | Sparkle's background install-on-quit does not relaunch the app, deferring the proxy restart to the next launch | No silent auto-install: `SUAutomaticallyUpdate` is never set and `SUAllowsAutomaticUpdates=false`; updates go through "Install and Relaunch", and the relaunched app restarts the desktop-owned proxy |
| C6 | Sparkle installs on EdDSA alone when the code signature mismatches | The EdDSA private key is the update root of trust (CI secret only). The Developer ID update run must show no signature-mismatch line |
| C7 | `generate_appcast --account` blocks on a Keychain ACL prompt | The release pipeline uses `--ed-key-file` from the CI secret, never `--account` |
| C8 | launchd never SIGKILLs a sidecar that ignores or outlives SIGTERM; a stand-in ignoring TERM survived as an orphan (the port-holding, stale-binary chain for the real binary is inferred) | `aio-proxy run` force-exits 3 s after SIGTERM/SIGINT, which bounds how long an orphan and its background work outlive a stop. The stale-binary guard is the desktop Restart check: the old sidecar pid is gone and `/health` reports the expected version |

Other spec corrections: host entitlements (none under Developer ID), `allow-jit`-only sidecar, native-addon plugins unsupported, Sparkle archive format and signing list, extra `Info.plist` keys, the `arm64` check tolerating Sparkle's universal binaries, the HTTP stack, the PopUp description, the no-fallback note for check 2, the footprint budget, and the provisional lifecycle. The Phase 1 plan (`docs/superpowers/plans/2026-09-29-desktop-server-cli.md`) implements C1, C4 and C8.

## Human checklist (priority order)

Setup for all items: `git switch spike/desktop` (or `git worktree add ../aio-spike spike/desktop`), unlock the Mac, keep the display awake (`caffeinate -d &`), and work from `spike/desktop-host`. Rebuild with `mise exec -- ./bundle.sh && ./sign.sh -` (ad-hoc) unless an item says otherwise; the app is `../out/AIO Proxy Spike.app`, host `Contents/MacOS/aio-proxy-desktop`. `bundle.sh` rebuilds only the host: rebuild the sidecar into `spike/out/aio-proxy` with `bun run build && bun packages/cli/scripts/build-binary.ts darwin-arm64 spike/out/aio-proxy` when an item needs a new one. Record the stderr log for each item.

1. **Click elsewhere closes the panel (non-key PopUp).** This can reopen the UI stack decision.
   - Run the host and click "AIO" in the menu bar.
   - Click the desktop, then repeat by clicking another app's window.
   - Pass: the panel closes every time, and stderr shows `window active=true` on open, then `window active=false`.
   - If `window active=true` never appears, the panel is not becoming key. Rerun with `SPIKE_NO_ACTIVATE=1` and report both runs.
   - Fail means GPUI PopUp cannot hide on deactivation, and there is no external-panel fallback.
2. **Click the icon again closes it.**
   - With the panel open, click "AIO".
   - Pass: it closes and stays closed. stderr shows `toggle: panel just closed by deactivation, not reopening` when deactivation raced the click.
   - Known flake: the 300 ms guard is measured from mouse-up.
3. **Second display with a different scale factor.**
   - Attach a 1x display and open the panel from the menu bar on each display.
   - Pass: it is anchored under the icon on that display, and the text is crisp. The `anchor:` log line names the screen and scale.
4. **Full-screen Space.**
   - Put any app in full screen, reveal the menu bar, and click "AIO".
   - Pass: the panel appears over the full-screen app.
5. **Sleep/wake.**
   - Open the panel, sleep (Apple menu > Sleep), then wake.
   - Pass: no crash, and closing and reopening still anchors correctly.
   - Repeat once with the panel closed before sleep.
6. **Developer ID signing and host launch.**
   - `xcrun notarytool store-credentials aio-proxy-notary --apple-id <id> --team-id <TEAMID>`
   - `mise exec -- ./bundle.sh && ./sign.sh "Developer ID Application: <Team> (<TEAMID>)"`
   - Launch the host.
   - Pass: `codesign --verify --deep --strict` passes, and the host starts with Sparkle loaded (no "different Team IDs" error) with **no** host entitlements (`codesign -d --entitlements - "<app>/Contents/MacOS/aio-proxy-desktop"` is empty).
7. **Developer ID entitlement re-confirmation.**
   - `ENT=entitlements/variants/baseline.plist ./sign.sh "<identity>" && sh workload/workload.sh dev-id-baseline`
   - Then the same with `variants/none.plist`, then plain `./sign.sh "<identity>"` (the committed `allow-jit`-only file) and `workload.sh dev-id-final`.
   - Pass: every row has `vmmap=ok` and all functional fields PASS. Baseline and final have `jit_*` > 0. None has `jit_*` = 0 with latency about 30% higher.
8. **OAuth Provider workload step.**
   - With the final signature: `AIO_PROXY_HOME=$(mktemp -d) "<app>/Contents/MacOS/aio-proxy" run --port 19317`
   - Open `http://127.0.0.1:19317/dashboard` and add a built-in OAuth Provider (e.g. GitHub Copilot). Log in, then send one request through it.
   - Pass: the Provider is healthy, the request succeeds, and `vmmap <pid> | grep "JS JIT"` is non-empty.
9. **Notarize the `.app` and `.dmg`.**
   - `./notarize.sh "<identity>"`
   - Pass: both submissions are Accepted, `syspolicy_check distribution` and both `spctl --assess` runs pass, and `stapler validate` passes for both.
   - On `Invalid`, record `xcrun notarytool log <id> --keychain-profile aio-proxy-notary` verbatim, minus secrets.
10. **Clean-Mac browser install.** Use a Mac that never saw the build.
    - Serve `spike.dmg` from a private release or another machine, download it in Safari, and run `xattr -l ~/Downloads/spike.dmg`.
    - Drag the app to `/Applications` and open it.
    - Pass: `com.apple.quarantine` is present, only the standard "downloaded from the Internet" prompt appears, and `spctl -a -vv "/Applications/AIO Proxy Spike.app"` says `source=Notarized Developer ID`.
11. **Developer ID Sparkle update through the UI.**
    - Export the spike key non-interactively: `../out/sparkle/bin/generate_keys --account aio-proxy-desktop-spike -x <file>`. Dismiss any leftover Keychain prompt from the 01:14 run with Deny.
    - Sign v1 and v2 (bump both `CFBundleShortVersionString`/`CFBundleVersion` **and** the sidecar version) with the same Developer ID. Ship v2 as a notarized, stapled DMG, and run `generate_appcast --ed-key-file <file>`.
    - Install v1 and set up the job with `launchd/setup.sh`. Run v1 with `SPIKE_CHECK_UPDATES=ui` and click **Install and Relaunch**.
    - Pass:
      - The app relaunches as v2.
      - `/usr/bin/log show --last 10m --predicate 'subsystem == "org.sparkle-project.Sparkle"'` has **no** "Code signature of the new version doesn't match" line.
      - The old sidecar pid serves `/health` until `launchctl kickstart -k gui/$(id -u)/dev.aio-proxy.spike`, after which `/health` reports the new version.
    - Delete the key file afterwards.
12. **Visible flash and on-screen reopen latency.** This decides the provisional hybrid.
    - For each `SPIKE_CLOSE=destroy|hide|hybrid`, with and without `SPIKE_NO_ANIM=1`, record the menu-bar area in QuickTime at 60 fps and click "AIO" about 10 times.
    - Pass: no blank or white frame before content, no stale content on re-show, no ghost after close, and click-highlight → full content ≤ 100 ms (frames × 16.7 ms), reported as median and max.
13. **Unlocked resource re-measure.**
    - `bench/measure.sh m-std; bench/measure.sh m-gpui SPIKE_HTTP=gpui`
    - `for s in destroy hide hybrid; do bench/cycles.sh c-$s SPIKE_CLOSE=$s > /tmp/spike6/c-$s.out; done`
    - `bench/cycles.sh c-destroy-noanim SPIKE_CLOSE=destroy SPIKE_NO_ANIM=1 > /tmp/spike6/c-destroy-noanim.out`
    - Do not touch the input devices while cycles run.
    - Pass: closed footprint ≤ 40 MB; 100-cycle growth ≤ 10 MB with animation None; hide logs `next_frame_ms`. Report whether default-animation growth disappears (about 7 threads in `ps -M`) and whether the ~190 MB transient reproduces (`/tmp/spike6/fp <pid> 2000` around a toggle).
14. **powermetrics wakeups.**
    - After `bench/measure.sh m-std` has opened and closed the panel once: `sudo powermetrics --samplers tasks --show-process-wakeups -i 10000 -n 3 | grep -A2 aio-proxy-desktop`
    - Pass: ≤ 1 interrupt wakeup/s (expect about 0.4). Report whether the 0.10 → 0.37/s rise after the first open reproduces.
15. Optional: cold-cache summary timing.
    - `H=$(mktemp -d); AIO_PROXY_BENCH_HOME=$H LAYOUT=ascending bun spike/desktop-host/bench/seed-trace-db.ts seed` (the script refuses an unset home or one containing `.aio-proxy`)
    - `sudo purge; AIO_PROXY_BENCH_HOME=$H bun spike/desktop-host/bench/seed-trace-db.ts time`
    - `rm -rf "$H"`

## Residue

- `launchctl print-disabled gui/<uid>` keeps a harmless `"dev.aio-proxy.spike" => enabled` override. launchctl has no verb to remove it.
- An empty `dev.aio-proxy.desktop.spike` defaults plist remains.
- The spike EdDSA key sits in the login Keychain under account `aio-proxy-desktop-spike`; delete it when item 11 is done.
