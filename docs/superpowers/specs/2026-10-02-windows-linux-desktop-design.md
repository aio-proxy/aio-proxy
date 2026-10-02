# Windows and Linux desktop clients

Date: 2026-10-02
Status: draft (rev 1)
Builds on: `2026-09-29-desktop-client-design.md` (the macOS client), `2026-10-01-desktop-panel-design.md`

## Goal

Bring the desktop companion to Linux and Windows at feature parity with the macOS client: tray icon, summary
panel, launch at login, discovery and lifecycle of the managed proxy service, the `aiop` shell command, and
in-app updates. The macOS client keeps its behavior; this work extracts what is macOS-only behind a
platform layer and adds the two other implementations.

Windows also needs CLI work that does not exist yet: a `win32` binary and a Windows service backend.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | Linux and Windows designed together, shipped in the phases below |
| Architectures | Linux `x86_64` + `aarch64` (same as the CLI); Windows `x64` only (`arm64` when asked for) |
| Code structure | One crate; macOS-only code moves into `desktop/src/platform/`, selected by `cfg(target_os)` |
| Windows service manager | A per-user Task Scheduler task that starts at logon, driven by a CLI supervisor |
| Linux interaction | Tray menu plus an ordinary panel window; no tray → the window is the app |
| Distribution | Linux AppImage; Windows per-user NSIS installer; both built by `cargo-packager` |
| Updates | `cargo-packager-updater` on Linux and Windows, signed with the existing Sparkle Ed25519 key in minisign form; Sparkle unchanged on macOS |
| Windows Authenticode | Not in the first release; a `sign_command` hook is reserved |

## Non-goals

- `.deb`, `.rpm`, Flatpak, winget, Scoop. AppImage and the NSIS installer only; more formats are a
  `cargo-packager` config change later.
- Windows `arm64`.
- A wake-from-sleep hook on Linux and Windows. The 60 s health timer covers it.
- A popover anchored to the tray icon on Linux. Wayland gives no tray rect and no global positioning.
- Self-stopping a desktop-owned service after its AppImage is deleted (see Install, "Known ceiling").
- Windows system-scope services (SCM). User scope only, like launchd agents and `systemd --user`.

## 1. Platform layer (`desktop/src/platform/`)

`platform/mod.rs` only selects and re-exports: `#[cfg(target_os = "macos")] mod macos; pub use macos::*;`,
likewise `linux` and `windows`. The current objc2 code moves into `platform/macos/` unchanged. `objc2*` and
`block2` move under `[target.'cfg(target_os = "macos")'.dependencies]`; `build.rs` links ServiceManagement
and Sparkle only for macOS.

No `Platform` trait: each build has exactly one implementation, and `connect::run::Host` already provides
the test seam.

| Capability | macOS (unchanged) | Linux | Windows |
| --- | --- | --- | --- |
| `Paths` (support, logs, lock, stable exec) | `~/Library/...` | `$XDG_DATA_HOME/aio-proxy-desktop`, logs under `$XDG_STATE_HOME/aio-proxy-desktop` | `%LOCALAPPDATA%\aio-proxy-desktop` |
| Launch at login (`LoginItemStatus` unchanged) | `SMAppService` | write/remove `~/.config/autostart/aio-proxy-desktop.desktop` | HKCU `Software\Microsoft\Windows\CurrentVersion\Run` value |
| `pid_alive` | `kill(pid, 0)` | same | `OpenProcess` + `GetExitCodeProcess` |
| Listener ownership (security) | `lsof` | `/proc/net/tcp{,6}` uid column | `GetExtendedTcpTable` owner PID → process token SID equals ours |
| Kickstart (restart an external unit without rewriting it) | `launchctl kickstart -k` | `systemctl --user restart aio-proxy.service` | `schtasks /End` then `/Run` |
| Activation policy | `Accessory` | n/a | n/a |
| Wake notification | `NSWorkspaceDidWakeNotification` | none | none |
| Updater | Sparkle | `cargo-packager-updater` | `cargo-packager-updater` |

Shared across all three, replacing libc:

- HTTP client for GPUI (`img()` plugin icons): `gpui-pre-reqwest-client` on every platform; `http.rs`
  (NSURLSession) is deleted. reqwest's `macos-system-configuration` feature keeps the system proxy on
  macOS; tokio, rustls and reqwest are already in `Cargo.lock`.
- Single-instance lock: `std::fs::File::try_lock` (toolchain 1.98).
- Helper timeout kill: `std::process::Child::kill`.
- Local time in `panel/format.rs`: `chrono::Local` (`chrono` with its clock feature is already in
  `Cargo.lock`) instead of `libc::localtime_r`.

## 2. CLI

### 2a. Windows binary

- `build-binary.ts` gains `bun-windows-x64`; new npm package `@aio-proxy/cli-win32-x64` (`os: ["win32"]`),
  added to `npm/aio-proxy` `optionalDependencies`. The launcher resolves `bin/aio-proxy.exe` on win32.
- Audit POSIX assumptions in `packages/cli/src` (`':'` PATH joins in `managedServicePath`, `/usr/sbin/lsof`,
  `/bin/sh`, file modes) and use `path.delimiter` or a platform branch.
- `upgrade` and `update-notify` accept win32. Binary self-upgrade renames the running `.exe` to `.old`
  (Windows allows renaming a running image), writes the new one, and deletes `.old` on the next start.

### 2b. `service` on Windows

- `service install` registers task `aio-proxy` with `schtasks /Create /XML <file> /TN aio-proxy /F`: logon
  trigger for the current user, no execution time limit, `IgnoreNew` for multiple instances, not stopped on
  battery.
- Task Scheduler sets no environment and its "restart on failure" reacts only to launch failures, not to
  exit codes. A hidden subcommand `aio-proxy __service-run <spec>` supervises instead. It reads
  `%LOCALAPPDATA%\aio-proxy\service.json` — `{ exec, env }` where `env` carries `AIO_PROXY_HOME`,
  `AIO_PROXY_MANAGED`, `PATH`, `AIO_PROXY_UPGRADE_METHOD` and, for a desktop-owned unit,
  `AIO_PROXY_DESKTOP_EXEC` — and runs `<exec> run` as a child with that environment:
  - exit 0 or 1 → stop (mirrors `RestartPreventExitStatus=1` and launchd's wrapper);
  - any other exit → wait 5 s, run again;
  - `exec` missing → exit 0 (mirrors the launchd wrapper's `[ -x "$0" ] || exit 0`).
- On Windows `service.json` is the unit file: the counterpart of the plist and the `.service` file.
  Desktop ownership is the same rule as on macOS: `env.AIO_PROXY_DESKTOP_EXEC` equals `exec`.
- `start` / `stop` / `restart` / `uninstall` map to `schtasks /Run`, `/End`, rewrite + `/End` + `/Run`, and
  `/Delete /F` plus removing `service.json`.
- **Spike (phase 0):** a console program started by Task Scheduler opens a console window. Candidates
  without admin rights, in order of preference:
  1. task action `conhost.exe --headless <exec> __service-run <spec>`;
  2. S4U logon type ("run whether the user is logged on or not", no stored password), which runs in a
     non-interactive session;
  3. a separate launcher compiled with `--windows-hide-console` (costs a second ~100 MB Bun binary).

### 2c. `__desktop-connect` on every platform

The output stays `protocolVersion: 1` with the same `unit` / `job` / `instance` / `token` shape, so the Rust
`Discovery` parser and the `policy` state machine are unchanged. `DesktopConnectDeps.plistPath` becomes
`unitPath`. Each platform supplies three probes:

| Probe | darwin (today) | linux | win32 |
| --- | --- | --- | --- |
| `readUnit` | `plutil` → `inspectUnit` | parse `ExecStart=` and `Environment=` | read `service.json` |
| `readJob` (`loaded`, `disabled`, `pid`) | `launchctl print`, `print-disabled` | `systemctl --user show -p LoadState,ActiveState,UnitFileState,MainPID` | `schtasks /Query /TN aio-proxy /V /FO CSV`; `pid: null` |
| Listener ownership | `lsof` | `/proc/net/tcp{,6}` | `netstat -ano -p TCP` → PID → `tasklist /V /FI "PID eq <pid>" /FO CSV` user equals ours |

A null `job.pid` makes `matchesJob` null, which the policy already treats as "cannot tell". All probes keep
failing closed: an unreadable disabled state is `disabled: true`, an unreadable listener is not ours.

## 3. Tray and panel

### Tray (`tray-icon`)

- Linux uses the `ksni` backend (StatusNotifierItem over D-Bus) with default features off: no GTK event
  loop (GPUI's Linux backend runs none) and no GTK3 / libxdo / appindicator libraries in the AppImage. KSNI
  turns `activate` into `TrayIconEvent::Click`, so `click_event` is reused.
- Windows uses the default Win32 backend with `with_id(<fixed GUID>)`, so the user's "pinned to taskbar"
  choice survives updates.
- Icon: Windows and Linux trays are square and have no template images. Add a square mark asset;
  `icon_rgba` takes a color. The three states (running, dimmed when down, attention dot) are unchanged.
  Color: Windows reads `SystemUsesLightTheme` (the taskbar's setting, distinct from the apps' one); Linux
  follows `cx.window_appearance()`.
- Linux's tray menu gains "Open Panel": some hosts (Ubuntu's AppIndicator extension) open the menu on left
  click and never send `activate`.

### Panel window

| | macOS (unchanged) | Windows | Linux |
| --- | --- | --- | --- |
| Kind | `PopUp`, no titlebar | `PopUp`, no titlebar, no taskbar button | `Normal`, titled, 360×560, not resizable, placed by the window manager |
| Position | below the menu bar, centered on the icon | next to the icon rect from the `Click` event, on the side facing the screen center, clamped to the work area (taskbar on any edge) | not set |
| Close on deactivation | yes | yes (`observe_window_activation` is cross-platform) | no |
| Background | `NSVisualEffectView` | `WindowBackgroundAppearance::Blurred` | opaque theme background |

`placement::panel_origin` stays a pure function and gains the four taskbar edges.

### No tray (Linux)

At startup, if no process owns the D-Bus name `org.kde.StatusNotifierWatcher` (GNOME without the extension),
the app opens the panel window directly, and closing that window quits the app. The proxy is owned by
`systemd --user`, so quitting only removes the monitor; keeping a hidden process alive would need a
second-instance IPC to show the window again.

## 4. Install, stable exec, `aiop`, single instance

### Stable exec

macOS keeps its symlink `…/bin/aio-proxy` → the bundle's sidecar. That does not carry over: an AppImage's
sidecar exists only under its temporary mount, and Windows symlinks need privileges while a running `.exe` is
locked.

Linux and Windows keep a real copy instead:

- Path: `$XDG_DATA_HOME/aio-proxy-desktop/bin/aio-proxy` / `%LOCALAPPDATA%\aio-proxy-desktop\bin\aio-proxy.exe`.
  `AIO_PROXY_DESKTOP_EXEC` points at it.
- Source: the sidecar next to the running executable (`$APPDIR/usr/bin/` in the AppImage, the install
  directory on Windows). `sidecar_of` / `bundle_of` gain these layouts.
- Replace: copy to `bin/.aio-proxy.tmp`, then
  - Linux: `rename` over the copy (atomic; a running process keeps the old inode);
  - Windows: rename the current `aio-proxy.exe` to `aio-proxy.exe.old-<pid>`, rename the temp into place,
    and delete leftover `.old-*` files on the next start (best effort).
  After a replace, the existing automatic-action table restarts the proxy.
- No-downgrade: compare `bin/aio-proxy --version` (`probe_version`) with the app's version. Missing or older
  → replace; equal → keep; newer or unreadable → refuse and run read-only. `plan_symlink` becomes a pure
  function over versions, shared by the copy model; macOS keeps its target-path check in front of it.
- Location policy: "inside an Applications folder" stays macOS-only. On Linux and Windows the install is
  persistent when the sidecar exists and its volume is writable.
- Linux autostart's `Exec=` is `$APPIMAGE`; on each start with autostart enabled the app rewrites it, so a
  moved AppImage heals itself.

### `aiop`

| | macOS (unchanged) | Linux | Windows |
| --- | --- | --- | --- |
| Install | `/usr/local/bin` behind the admin prompt | symlink `~/.local/bin/aiop` → the stable copy | `bin\shims\aiop.cmd` (`@"<stable exe>" %*`); `shims` appended to the end of the user `PATH` (HKCU `Environment`, then broadcast `WM_SETTINGCHANGE`) |
| Probe | login shell, `command -v` | same | `where.exe` on the process `PATH` |
| `aio-proxy` name | only when free | only when free | `aio-proxy.cmd` only when free |

The Windows shims live apart from `bin\` so the real `.exe` never lands on `PATH`, and appending keeps an
existing npm `aio-proxy` first.

### Single instance

`File::try_lock` on all platforms (section 1).

### Uninstall

- Windows: the NSIS uninstaller runs `aio-proxy service uninstall` when the unit is desktop-owned, removes
  the `shims` entry from the user `PATH`, and deletes `%LOCALAPPDATA%\aio-proxy-desktop`.
- Linux: an AppImage has no uninstaller. **Known ceiling:** deleting the AppImage leaves the copy, and the
  service keeps running a version that no longer updates. Documented: run `aio-proxy service uninstall`
  before deleting the AppImage. Upgrade path if users hit it: the supervisor or the CLI stops a
  desktop-owned unit whose desktop app is gone.

## 5. Updates on Linux and Windows

- Library: `cargo-packager-updater`. The platform `updater` keeps the macOS module's interface —
  `start(...)`, `check_now()`, `AppEvent::UpdateAvailable(version)`, `AppEvent::UpdateAttended` — so the
  panel button, the tray attention dot and "Check for Updates…" need no change. `start` gains `cx` for the
  HTTP client.
- Feed: `latest.json` on the `desktop-feed` prerelease, in the updater's format: `version` plus per-target
  `url`, `signature`, `format` for `linux-x86_64`, `linux-aarch64` (`appimage`) and `windows-x86_64`
  (`nsis`). macOS keeps `appcast.xml`.
- Checks: at launch and every 6 hours. "Install and Relaunch" in the panel downloads and verifies, then:
  - Windows: runs the NSIS installer in Passive mode and quits; the installer closes and relaunches the app;
  - Linux: renames the new AppImage over `$APPIMAGE` and relaunches.
  The new app then refreshes the stable copy (section 4). No silent install, matching
  `SUAllowsAutomaticUpdates = false` on macOS.
- "Check for Updates…" with nothing pending checks now; when current, the panel's action line says the app
  is up to date (new `AppEvent::UpToDate`).
- Signature: the existing Sparkle Ed25519 key in minisign form.
  - Public key: `base64("Ed" ‖ key id ‖ 32-byte Sparkle public key)` with a fixed key id, compiled in.
  - Signing: a Bun script (`node:crypto` Ed25519 + `blake2b512`) writes minisign prehashed signatures from
    `SPARKLE_ED_PRIVATE_KEY`: signature over BLAKE2b-512 of the file, global signature over
    signature ‖ trusted comment. `cargo-packager`'s own signer is not used; it wants minisign's encrypted
    secret-key file.
  - One root of trust and one offline backup for all three platforms; no new secret.
- Rehearsal: `AIO_PROXY_DESKTOP_FEED_URL` overrides the feed for a local build, like `SPARKLE_FEED_URL`;
  `desktop:publish` refuses such a build.

## 6. Packaging, CI, release

### Packaging (`cargo-packager`)

| | Linux | Windows |
| --- | --- | --- |
| Format | AppImage, `x86_64` and `aarch64` | NSIS, per-user into `%LOCALAPPDATA%\Programs\AIO Proxy\`, no admin |
| Contents | app, `usr/bin/aio-proxy`, `.desktop`, PNG icons | `aio-proxy-desktop.exe`, `aio-proxy.exe`, `.ico` |
| Sidecar | `packages/cli/scripts/build-binary.ts` on the native runner | same, `bun-windows-x64` |
| Notes | built on the oldest supported Ubuntu LTS runner for a low glibc floor; linuxdeploy bundles GPUI's X11 / Wayland / xkbcommon / Vulkan loader libraries | `main.rs` gets `#![cfg_attr(windows, windows_subsystem = "windows")]`; NSIS hooks: close the running app before install, section 4 cleanup on uninstall |

**Spike (phase 0):** whether `cargo-packager`'s NSIS supports those hooks; otherwise a custom NSIS template.

Assets: `aio-proxy-<v>-x86_64.AppImage`, `aio-proxy-<v>-aarch64.AppImage`, `aio-proxy-<v>-x64-setup.exe`.

### Release workflow (`desktop-release.yml`)

The macOS job is unchanged and publishes its DMG and `appcast.xml` on its own, so a Windows failure never
holds a macOS release. Added beside it:

1. `build-linux` (`x86_64`, `aarch64` runners) and `build-windows`: the same tag checks as the macOS job (a
   published, non-prerelease Release whose commit is on `main`; checkout pins that commit), build the
   sidecar and the app, package, upload as workflow artifacts. **No secrets.**
2. `feed` (ubuntu, `desktop-release` environment, `concurrency: desktop-feed`, needs every build job): sign
   with `SPARKLE_ED_PRIVATE_KEY`, upload the assets to `v<version>`, write `latest.json`, replace it on
   `desktop-feed`.

Invariants carried over from macOS: a published version is never rebuilt or replaced; a re-dispatch reuses
the Release's assets and re-verifies their signatures before touching the feed. Any platform failing leaves
`latest.json` untouched; resume with `gh workflow run desktop-release.yml -f tag=v<version>`.

### Windows signing hook

The build script passes `cargo-packager`'s `windows.sign_command` only when `WINDOWS_SIGN_COMMAND` is set.
`RELEASING.md` documents wiring Artifact Signing or `signtool` into it. No untested signing step is
committed to the workflow.

### CI (`ci.yml`)

- The desktop Rust job becomes a macOS / ubuntu / windows matrix running `cargo clippy` and `cargo test`;
  each platform's `cfg` code only compiles there.
- Linux smoke: build the AppImage and run it with `--version`. A Windows smoke follows once the first
  release is stable.

### Docs and release note

`RELEASING.md` covers all three platforms; the README download section lists the new assets; one changeset
targeting `aio-proxy` (minor), one paragraph.

## 7. Testing

Tests only where a user-visible break would fail them; no snapshots of static templates (`.desktop`, shims,
task XML).

| Area | Test | Why |
| --- | --- | --- |
| Rust `placement` | taskbar on each edge; clamping to the work area | visible misplacement; pure function |
| Rust `install` | copy plan: missing / older / equal / newer / unreadable | the no-downgrade invariant |
| Listener ownership (Rust + TS) | `/proc/net/tcp{,6}` parsing; netstat + tasklist parsing; no IPv4/IPv6 cross-match | security boundary for the token |
| TS `desktop-connect` | systemd `show`, `schtasks` CSV and `service.json` → `unit` / `job`; owner rules equal across platforms | the app's automatic actions depend on it |
| TS `__service-run` | exit-code decision: 0/1 stop, other restart, missing exec stop | the systemd semantics it reproduces |
| TS `service` win32 | write and read back `service.json`, desktop-owned marker, paths with spaces | the unit-file contract |
| Windows `PATH` edit | append/remove `shims` with duplicates, trailing `;`, case differences | breaking a user's PATH is costly |
| Signature format | a Bun-generated signature fixture verified by Rust `minisign-verify` | cross-language contract; a mismatch fails every update |
| `latest.json` | target keys and `format` match the updater; refuses a missing platform | the feed's all-or-nothing rule |

CI runs the Rust tests on all three platforms.

Manual checklist before each release:

- Linux: KDE (X11 and Wayland); GNOME with the AppIndicator extension; GNOME without it (no-tray mode, close
  quits); Ubuntu default (menu-only left click, "Open Panel" works).
- Windows 11: taskbar bottom and top; icon in the overflow area; light and dark taskbar; install, update,
  uninstall.
- Updates end to end against a local feed: same version, newer version, bad signature.

## Phases

0. Spikes: hidden console for the Windows task (2b); `cargo-packager` NSIS hooks (6); `ksni` clicks on
   GNOME and KDE (3).
1. CLI: win32 binary, Task Scheduler backend, `__service-run`, `__desktop-connect` on all platforms.
2. Desktop platform layer and Linux (sections 1, 3, 4).
3. Desktop Windows (the Windows parts of 3 and 4).
4. Updater (section 5).
5. Packaging, CI, release (section 6).

Each spike's result is recorded in `2026-10-02-windows-linux-desktop-spike-findings.md`; a result that
contradicts this spec revises it before the dependent phase starts.
