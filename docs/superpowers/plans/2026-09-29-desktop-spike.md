# Desktop Client — Phase 0 Spike Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This is a spike: every line of code written here is throwaway and is never merged. The deliverable is the findings document in Task 7. Several steps need a human (Apple Developer credentials, a clean Mac, physical display changes); they are marked **[human]**.

**Goal:** Decide go/no-go for the desktop design by proving, on real hardware, that a notarized app can ship and run the Bun sidecar under launchd, update itself with Sparkle, and host a GPUI Kit menu-bar panel within the resource budget.

**Architecture:** A throwaway Cargo crate (`spike/desktop-host`) with GPUI Kit + `tray-icon` + Sparkle, bundling the real release sidecar from `packages/cli/scripts/build-binary.ts`. Everything is built, signed, notarized, installed, updated, broken, and measured by hand, with results recorded in a findings doc.

**Tech Stack:** Rust (via mise), GPUI Kit `gpui-kit` 0.7 (`gpui-pre =0.3.7`), `tray-icon`, `objc2`, Sparkle 2, Bun `build --compile`, `codesign`, `notarytool`, `stapler`, `launchctl`.

**Spec:** `docs/superpowers/specs/2026-09-29-desktop-client-design.md` — sections "Spike checks", "Signing and notarization", "Service model", "Platform baseline".

## Global Constraints

- Work on a branch named `spike/desktop` that is never merged; the only artifact carried forward is `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md`, committed on the main feature branch.
- arm64 only; `MACOSX_DEPLOYMENT_TARGET=13.0`.
- Use the **real** release sidecar (`bun packages/cli/scripts/build-binary.ts darwin-arm64 <out>` after `bun run build`), never a hello-world binary.
- Never run spike experiments against the developer's real `~/.aio-proxy` or real `com.aio-proxy.agent` job: use a temporary `AIO_PROXY_HOME` and, for launchd experiments, a test Mac user account or a clean VM. If the only machine has a real service installed, `launchctl bootout gui/$(id -u)/com.aio-proxy.agent` it first and restore it afterwards with `aio-proxy service start`.
- Never paste the desktop token, the Developer ID password, or API keys into logs, the findings doc, or chat.

## Review Focus

- A Gatekeeper cache on the build machine can hide a notarization defect: final acceptance must be a browser download with quarantine on a machine that never saw the build.
- A running daemon survives app deletion, so "no respawn" is only proven after the daemon is killed.
- Entitlement minimization must re-run the full workload after each removal, not just `--version`.
- Resource numbers must be taken after the panel has been opened and closed at least once (first-open allocations skew idle RSS).
- A slow summary on a large DB would change the refresh design; measure it before the go decision.

---

### Task 1: Toolchain and throwaway crate

**Files (spike branch only):**
- Create: `spike/desktop-host/Cargo.toml`, `spike/desktop-host/src/main.rs`, `spike/desktop-host/rust-toolchain.toml`

- [ ] **Step 1: Branch and install Rust through mise**

```bash
git switch -c spike/desktop
mise use --path spike/desktop-host rust@stable
rustup target add aarch64-apple-darwin
cargo --version
```

- [ ] **Step 2: Create the crate pinned to GPUI Kit's snapshot**

```toml
# spike/desktop-host/Cargo.toml
[package]
name = "aio-proxy-desktop-spike"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
gpui = { package = "gpui-pre", version = "=0.3.7" }
gpui-component = { version = "=0.7.0" }
tray-icon = "0.21"
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSStatusItem", "NSWorkspace", "NSApplication"] }
objc2-foundation = "0.3"
```

Check the exact `gpui-component` crate name/version and any required `gpui_platform` features against `https://github.com/longbridge/gpui-component/blob/main/Cargo.toml` and its `examples/hello_world`; copy that example's `Cargo.toml` dependency block if it differs. Record the resolved versions from `Cargo.lock` in the findings doc.

- [ ] **Step 3: Build the upstream hello world to prove the toolchain**

Copy `examples/hello_world/src/main.rs` from gpui-component into `src/main.rs`, then:

```bash
cd spike/desktop-host && MACOSX_DEPLOYMENT_TARGET=13.0 cargo build --release --target aarch64-apple-darwin
```

Expected: builds; running it opens a window. Record build time and binary size.

---

### Task 2: Menu-bar panel behavior (spike check 2)

- [ ] **Step 1: Tray icon + PopUp window**

Replace `main.rs` with: an app that sets `LSUIElement` behavior at runtime via `NSApplication::setActivationPolicy(Accessory)` (the bundle's `Info.plist` does it in Task 3), creates a `tray_icon::TrayIcon`, and on `TrayIconEvent::Click { rect, .. }` opens a GPUI window with `WindowKind::PopUp`, no titlebar, 360×520 pt, positioned with its top-center at `(rect.x + rect.w/2, rect.y + rect.h)` clamped to the icon's screen. Content: four stat cards, a 7-bar chart from GPUI Kit's bar chart, a 365-cell grid, a scrolling list of 20 rows, and a button that opens `http://127.0.0.1:9317/dashboard` with `open`. Update one card every second with a counter to simulate live data. Close on window deactivation (GPUI window-activation observation).

Use gpui-component's `examples/` (chart and list stories in `crates/story`) as the API reference for charts and lists.

- [ ] **Step 2: [human] Behavior matrix** — record pass/fail for each:

| Case | Expected |
| --- | --- |
| Click icon | Panel opens anchored under the icon |
| Click icon again | Panel closes |
| Click elsewhere | Panel closes |
| Cmd+Tab | App not listed |
| Dock | No icon |
| Icon near right screen edge | Panel clamped on-screen |
| Second display, different scale factor | Correct position and crisp text |
| Full-screen app in another Space | Panel appears over it in that Space |
| Sleep/wake with panel open, then closed | No crash, icon still works |

- [ ] **Step 3: Fallback probe (only if Step 2 fails anchoring or hiding)**

Create an `NSPanel` via `objc2-app-kit` (non-activating, borderless, `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary`) and try to host GPUI content in it. Record whether the pinned GPUI exposes any way to attach to an external `NSView`; if not, record "no fallback — UI stack decision reopens".

- [ ] **Step 4: Local HTTP stack**

In the same binary, fetch `http://127.0.0.1:<port>/health` every 15 s while the panel is open using GPUI's `HttpClient` (`gpui-pre-reqwest-client`). Verify and record: proxy env vars (`HTTPS_PROXY=http://127.0.0.1:1`) are ignored when configured to; redirects are not followed; a request is cancelled when the panel closes; no second async runtime appears in `sample <pid>` thread names. If GPUI's client cannot be configured this way, try `reqwest` with its blocking client on a background thread and record which one meets the transport rules.

---

### Task 3: Bundle, sign, notarize (spike check 1, part A)

**Files (spike branch only):** `spike/desktop-host/bundle.sh`, `spike/desktop-host/entitlements/aio-proxy.plist`, `spike/desktop-host/Info.plist`

- [ ] **Step 1: Build the real sidecar**

```bash
bun run build
bun packages/cli/scripts/build-binary.ts darwin-arm64 spike/out/aio-proxy
vtool -show-build spike/out/aio-proxy | grep minos
```

Record `minos` (must be ≤ 13.0).

- [ ] **Step 2: Add Sparkle, pinned**

Download the latest Sparkle 2 release archive from `https://github.com/sparkle-project/Sparkle/releases`, record its version and `shasum -a 256`, and extract `Sparkle.framework` preserving symlinks (`ditto -x -k`). Link it from the host with `-framework Sparkle` and rpath `@loader_path/../Frameworks` (a `build.rs` emitting `cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks` and `cargo:rustc-link-search=framework=<dir>`). In `main.rs`, instantiate `SPUStandardUpdaterController` via `objc2` with `startingUpdater: true`. Generate keys once with Sparkle's `generate_keys` (the private key stays in the login Keychain for the spike).

- [ ] **Step 3: Assemble**

`bundle.sh` builds `spike/out/AIO Proxy Spike.app` with `Contents/MacOS/{aio-proxy-desktop,aio-proxy}`, `Contents/Frameworks/Sparkle.framework`, `Contents/Resources/THIRD_PARTY_NOTICES`, and an `Info.plist` containing `CFBundleIdentifier=dev.aio-proxy.desktop.spike`, `CFBundleExecutable`, `CFBundleName`, `CFBundleShortVersionString=0.0.1`, `CFBundleVersion=0.0.1`, `LSUIElement=true`, `LSMinimumSystemVersion=13.0`, `SUFeedURL` (a local `http://127.0.0.1:8000/appcast.xml`), `SUPublicEDKey`.

- [ ] **Step 4: Entitlements baseline — Bun's documented set**

```xml
<!-- spike/desktop-host/entitlements/aio-proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
```

- [ ] **Step 5: [human] Sign inside-out**

```bash
ID="Developer ID Application: <Team Name> (<TEAMID>)"
APP="spike/out/AIO Proxy Spike.app"
# Sparkle components first, per the pinned Sparkle version's documented order:
codesign -f -s "$ID" -o runtime --timestamp "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc"
codesign -f -s "$ID" -o runtime --timestamp --preserve-metadata=entitlements "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc"
codesign -f -s "$ID" -o runtime --timestamp "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate"
codesign -f -s "$ID" -o runtime --timestamp "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app"
codesign -f -s "$ID" -o runtime --timestamp "$APP/Contents/Frameworks/Sparkle.framework"
codesign -f -s "$ID" -o runtime --timestamp --entitlements spike/desktop-host/entitlements/aio-proxy.plist "$APP/Contents/MacOS/aio-proxy"
codesign -f -s "$ID" -o runtime --timestamp "$APP/Contents/MacOS/aio-proxy-desktop"
codesign -f -s "$ID" -o runtime --timestamp "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

If the pinned Sparkle version's documentation lists different nested paths, follow it and record the exact list.

- [ ] **Step 6: [human] Notarize the app, then the DMG**

```bash
ditto -c -k --keepParent "$APP" spike/out/app.zip
xcrun notarytool submit spike/out/app.zip --keychain-profile aio-proxy-notary --wait
xcrun stapler staple "$APP"
syspolicy_check distribution "$APP"
spctl --assess --type execute --verbose=4 "$APP"
hdiutil create -volname "AIO Proxy Spike" -srcfolder "$APP" -ov -format UDZO spike/out/spike.dmg
codesign -s "$ID" --timestamp spike/out/spike.dmg
xcrun notarytool submit spike/out/spike.dmg --keychain-profile aio-proxy-notary --wait
xcrun stapler staple spike/out/spike.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 spike/out/spike.dmg
xcrun stapler validate "$APP" && xcrun stapler validate spike/out/spike.dmg
```

Expected: every command succeeds. Record any `notarytool log` issues verbatim (minus secrets).

---

### Task 4: Real workload under hardened runtime, then minimize entitlements (spike check 1, part B)

- [ ] **Step 1: Workload script**

With `AIO_PROXY_HOME=$(mktemp -d)` and a config containing one API Provider pointing at a real or local OpenAI-compatible upstream and one OAuth Provider the tester can log into:

```bash
H=$(mktemp -d); export AIO_PROXY_HOME=$H
"$APP/Contents/MacOS/aio-proxy" run --port 19317 &
sleep 3
curl -sf http://127.0.0.1:19317/health
curl -sf http://127.0.0.1:19317/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<model>","messages":[{"role":"user","content":"ping"}]}'
"$APP/Contents/MacOS/aio-proxy" plugin add <a real plugin package>
curl -sf -H "authorization: Bearer $(cat $H/desktop-token 2>/dev/null)" http://127.0.0.1:19317/dashboard/api/overview?range=24h >/dev/null || true
kill %1
```

(the desktop-token line only applies once Phase 1 exists; skip it in the spike). Also log in to the OAuth Provider through the Dashboard. Record: pass/fail per step with the baseline entitlements.

- [ ] **Step 2: Remove one entitlement at a time**

For each of the five keys: delete it, re-sign `aio-proxy` and the `.app` (Task 3 Step 5, last three commands), rerun the full Step 1 workload. Keep the key only if some step fails without it. Record the final minimal set with the failing step that justifies each kept key.

---

### Task 5: launchd, update, and recovery (spike check 1, part C) — **[human]** on a clean Mac

- [ ] **Step 1: Clean install by browser download**

Upload `spike.dmg` somewhere reachable (a private GitHub release on a fork, or a local HTTP server on another machine), download it with Safari on a Mac that never saw the build, drag the app to `/Applications`, open it. Expected: opens without Gatekeeper warnings beyond the standard first-launch prompt; `xattr -l` shows quarantine on the downloaded DMG.

- [ ] **Step 2: launchd through the symlink**

```bash
L="$HOME/Library/Application Support/aio-proxy-desktop/bin"
mkdir -p "$L" && ln -sfn "/Applications/AIO Proxy Spike.app/Contents/MacOS/aio-proxy" "$L/aio-proxy"
```

Write a user LaunchAgent plist `~/Library/LaunchAgents/dev.aio-proxy.spike.plist` using the spec's wrapper (`[ -x "$0" ] || exit 0; "$0" run; status=$?; …`) with `ProgramArguments = ["/bin/sh","-c",<wrapper>,"$L/aio-proxy"]`, `EnvironmentVariables.AIO_PROXY_HOME` = a temp home with port 19317, `KeepAlive = { SuccessfulExit = false }`, `RunAtLoad = true`. Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.aio-proxy.spike.plist
curl -sf http://127.0.0.1:19317/health
```

Expected: healthy.

- [ ] **Step 3: Sparkle update N → N+1**

Bump `CFBundleShortVersionString`/`CFBundleVersion` to `0.0.2`, rebuild, sign, notarize, DMG (Task 3), then serve an appcast generated by the pinned `generate_appcast` over a directory holding both DMGs from `python3 -m http.server 8000`. Trigger "Check for Updates" in the spike app. Expected: installs and relaunches as 0.0.2; the old daemon keeps serving until `launchctl kickstart -k gui/$(id -u)/dev.aio-proxy.spike`, after which `/health` reports the new binary's version.

- [ ] **Step 4: Delete, kill, observe, restore**

```bash
mv "/Applications/AIO Proxy Spike.app" ~/.Trash/
pkill -f 'aio-proxy run'          # forces the wrapper's missing-executable branch on the next launch
sleep 600
launchctl print gui/$(id -u)/dev.aio-proxy.spike | grep -E 'state|runs|last exit'
log show --last 10m --predicate 'process == "launchd" AND eventMessage CONTAINS "dev.aio-proxy.spike"' | wc -l
```

Expected: `runs` does not keep increasing; `last exit code = 0`; a handful of log lines, not hundreds. Then restore the app from Trash and run `launchctl kickstart gui/$(id -u)/dev.aio-proxy.spike`. Expected: `/health` answers again. Also confirm that `launchctl load -w` on the still-loaded job does **not** start it (this is why Phase 1 Task 8 uses kickstart).

- [ ] **Step 5: Clean up**

```bash
launchctl bootout gui/$(id -u)/dev.aio-proxy.spike
rm ~/Library/LaunchAgents/dev.aio-proxy.spike.plist "$L/aio-proxy"
```

---

### Task 6: Resources and summary cost (spike check 3)

- [ ] **Step 1: Idle and open RSS, wakeups**

With the spike app running and the panel opened and closed once:

```bash
PID=$(pgrep -f aio-proxy-desktop)
ps -o rss= -p $PID                                  # panel closed
sudo powermetrics --samplers tasks --show-process-wakeups -i 10000 -n 3 | grep -A2 aio-proxy-desktop
```

Open the panel, repeat `ps`. Expected: closed RSS ≤ 40 MB, ≤ 1 idle wakeup/s.

- [ ] **Step 2: Destroy vs hide vs hybrid**

Implement each close strategy behind a CLI flag in the spike host. For each: script 100 open/close cycles with `osascript` clicks on the status item (or a debug hotkey), record RSS before/after, reopen latency (log a timestamp on click and on first frame), visible flash (screen recording), and whether RSS drops after close. Fill the spec's decision matrix and pick one.

- [ ] **Step 3: Summary query on a 1 GB trace DB**

```bash
H=$(mktemp -d)
AIO_PROXY_HOME=$H bun packages/core/scripts/benchmark-trace-store.ts   # adjust MEASURED_REQUESTS until $H/aio-proxy.db ≈ 1 GB
```

Then time `traceStore.overview({ range: '24h', metric: 'requests', groupBy: 'provider' })`, `overviewDashboard({ range: '7d' })`, and `overviewDashboardActivity()` against that DB with a small `bun -e` script using `openDb({ home: H })` and `createTraceStore`. Expected: combined ≤ 50 ms. Record the numbers.

---

### Task 7: Findings and decision

**Files:**
- Create (on the feature branch, not the spike branch): `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md`

- [ ] **Step 1: Write the findings**

Sections: resolved crate versions; behavior matrix (Task 2); chosen HTTP stack; Sparkle version + SHA-256 + exact signing list; minimal entitlement set with justification per key; notarization/Gatekeeper results; launchd update and recovery observations (including whether `load -w` starts a loaded job); resource numbers and the chosen window lifecycle; summary timings on 1 GB; and a one-line **GO / NO-GO** per spike check with the spec's fallback taken if any failed.

- [ ] **Step 2: Update the spec where findings contradict it**

Edit `docs/superpowers/specs/2026-09-29-desktop-client-design.md` for any fact the spike disproved (entitlement list, Sparkle paths, HTTP stack, window lifecycle), then commit both files:

```bash
git add docs/superpowers/specs/2026-09-29-desktop-spike-findings.md docs/superpowers/specs/2026-09-29-desktop-client-design.md
git commit -m "docs(desktop): record spike findings"
```

- [ ] **Step 3: Delete the spike branch** once the findings are committed: `git branch -D spike/desktop`.
