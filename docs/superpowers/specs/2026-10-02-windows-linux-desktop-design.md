# Windows and Linux desktop clients

Date: 2026-10-02
Status: draft (rev 4, after three Codex `gpt-6-astra` review rounds)
Builds on: `2026-09-29-desktop-client-design.md` (the macOS client), `2026-10-01-desktop-panel-design.md`

## Goal

Bring the desktop companion to Linux and Windows at feature parity with the macOS client: tray icon, summary
panel, launch at login, discovery and lifecycle of the managed proxy service, the `aiop` shell command, and
in-app updates. The macOS client keeps its behavior apart from the shared HTTP client (section 1); this work
extracts what is macOS-only behind a platform layer and adds the two other implementations.

Windows also needs CLI and core work that does not exist yet: a `win32` binary, a Windows service backend,
and a Windows-safe desktop token.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | Linux and Windows designed together, shipped in the phases below |
| Architectures | Linux `x86_64` + `aarch64` (same as the CLI); Windows `x64` only (`arm64` when asked for) |
| Code structure | One crate; macOS-only code moves into `desktop/src/platform/`, selected by `cfg(target_os)` |
| Windows service manager | A per-user Task Scheduler task that starts at logon, driven by a CLI supervisor |
| Linux interaction | Tray menu plus an ordinary, resizable panel window; no tray → the window is the app |
| Distribution | Linux AppImage; Windows per-user NSIS installer; both built by `cargo-packager` |
| Updates | `cargo-packager-updater` on Linux and Windows, signed with the existing Sparkle Ed25519 key in minisign form; Sparkle unchanged on macOS |
| GPUI HTTP client | `gpui-pre-reqwest-client` on all three platforms |
| Windows Authenticode | Not in the first release; a `sign_command` hook is reserved |

## Non-goals

- `.deb`, `.rpm`, Flatpak, winget, Scoop. AppImage and the NSIS installer only; more formats are a
  `cargo-packager` config change later.
- Windows `arm64`.
- A wake-from-sleep hook on Linux and Windows. The 60 s health timer covers it.
- A popover anchored to the tray icon on Linux. Wayland gives no tray rect and no global positioning.
- Self-stopping a desktop-owned service after its AppImage is deleted (see section 4, "Known ceilings").
- Windows system-scope services (SCM). User scope only, like launchd agents and `systemd --user`.
- PAC proxy support for plugin icons on macOS (see section 1).

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
| Connection ownership (security, section 2d) | `lsof` | `/proc/net/tcp{,6}`: the uid of the row matching the four-tuple | `GetExtendedTcpTable` (IPv4 and IPv6) → owner PID → process token SID |
| Kickstart (restart an external unit without rewriting it) | `launchctl kickstart -k` | `systemctl --user restart aio-proxy.service` | `schtasks /End` then `/Run` on the user's task path (section 2b) |
| Activation policy | `Accessory` | n/a | n/a |
| Wake notification | `NSWorkspaceDidWakeNotification` | none | none |
| Updater | Sparkle | `cargo-packager-updater` | `cargo-packager-updater` |

Shared across all three, replacing libc and objc2:

- HTTP client for GPUI (`img()` plugin icons): `gpui-pre-reqwest-client`; `http.rs` (NSURLSession) is
  deleted. **Known ceiling:** reqwest's `macos-system-configuration` reads only the static HTTP/HTTPS
  proxies, not PAC, and the client starts its own Tokio runtime. A macOS user behind a PAC-only proxy may
  not see remote plugin icons; restoring a platform NSURLSession client is the upgrade path.
- Single-instance lock: `std::fs::File::try_lock` (toolchain 1.98).
- Helper timeout kill: `std::process::Child::kill`.
- Helper spawning (`process.rs`): on Windows every CLI child gets `CREATE_NO_WINDOW`; a GUI-subsystem app
  starting a console program would otherwise flash a console.
- Local time in `panel/format.rs`: `chrono::Local` (`chrono` with its clock feature is already in
  `Cargo.lock`) instead of `libc::localtime_r`.

## 2. CLI and core

### 2a. Windows binary and POSIX assumptions

- `build-binary.ts` gains `bun-windows-x64`; new npm package `@aio-proxy/cli-win32-x64` (`os: ["win32"]`),
  added to `npm/aio-proxy` `optionalDependencies`. The launcher resolves `bin/aio-proxy.exe` on win32.
- Audit POSIX assumptions in `packages/cli/src` and `packages/core/src` (`':'` PATH joins in
  `managedServicePath`, `/usr/sbin/lsof`, `/bin/sh`, `O_NOFOLLOW`, uid and mode checks) and use
  `path.delimiter` or a platform branch.
- `upgrade` accepts win32 end to end: the tarball entry is `package/bin/aio-proxy.exe`, package-manager
  detection (`upgrade/detect.ts`) recognizes `.exe` launchers and splits `PATH` on `path.delimiter`, and the
  native binary next to the JS shim is `aio-proxy.exe`. Binary self-upgrade keeps `upgrade/binary.ts`'s
  stage-verify-commit-rollback flow; on Windows the commit renames the running `.exe` to `.old` (allowed
  for a running image), renames the staged file in, and deletes `.old` on the next start.
- `update-notify` (the OS desktop notification for a new CLI version) stays macOS and Linux only; Windows CLI
  users see the update in the Dashboard and in `aio-proxy upgrade`, and desktop users get the app's own
  update prompt.
- `@aio-proxy/cli-win32-x64` joins the lockstep `fixed` group in `.changeset/config.json`.
- `isDesktopManagedInstall` also matches an executable under the desktop's stable-copy directory
  (`aio-proxy-desktop/bin/`, section 4), so `upgrade`, Dashboard apply and auto-update refuse a desktop
  copy reached through `aiop` without any environment marker, as they refuse `.app/Contents/MacOS/` today.

### 2b. Desktop token on Windows

`readDesktopToken` (`packages/core/src/desktop-token/`) rejects any file with `mode & 0o077`; Windows stat
reports `0o666`, so as written the token is always rejected. Tightening the ACL after writing would leave a
window in which another account opens a handle and keeps reading through it, and `icacls` output carries no
owner. Windows instead keeps the token where only this user can create files:

- Path: `%LOCALAPPDATA%\aio-proxy\desktop-tokens\<sha256 of the resolved AIO_PROXY_HOME, hex>`, not in
  `AIO_PROXY_HOME`. `%LOCALAPPDATA%`'s default ACL grants only the user, `SYSTEM` and Administrators, and a
  new file inherits it at creation, so there is no exposure window and no other account can plant a file
  or reparse point there. The hash keeps one token per home, as on POSIX.
- Create: the existing temp-file + `link` flow (exclusive, concurrent creators keep the first token), in
  that directory.
- Read: refuse a reparse point (`lstat` before opening); no ACL parsing. The POSIX checks (`O_NOFOLLOW`,
  owner uid, mode) stay as they are on macOS and Linux.
- Server and CLI resolve the path through the one `desktop-token` module, so both sides agree.

### 2c. `service` on Windows

- Task path: `\AIO Proxy\aio-proxy-<current user SID>`. The root task namespace is machine-wide; the SID
  keeps each user's task apart. Every probe and lifecycle command uses this one path. Install overwrites
  (`/F`) only a task whose principal is the current user; anything else fails.
- `service install` registers it with `schtasks /Create /XML <file> /TN <path> /F`: logon trigger for the
  current user, principal = the current user's SID, no execution time limit, `IgnoreNew` for multiple
  instances, not stopped on battery, and `RestartOnFailure` (1 minute, 3 times). Its only action is
  `<exec> __service-run <spec>`. `RestartOnFailure` covers a launch that fails because `<exec>` is
  mid-replace (section 4).
- Task Scheduler sets no environment and its restart setting reacts only to launch failures, not to exit
  codes. A hidden subcommand `aio-proxy __service-run <spec>` supervises instead. It reads
  `%LOCALAPPDATA%\aio-proxy\service.json` — `{ exec, env }` where `env` carries `AIO_PROXY_HOME`,
  `AIO_PROXY_MANAGED`, `PATH`, `AIO_PROXY_UPGRADE_METHOD` and, for a desktop-owned unit,
  `AIO_PROXY_DESKTOP_EXEC` — writes its own PID to `service.state.json`, and runs `<exec> run` as a child
  with that environment:
  - exit 0 or 1 → stop (mirrors `RestartPreventExitStatus=1` and launchd's wrapper);
  - exit 75 (`EX_TEMPFAIL`, "restart me") → re-read `service.json` and run again at once;
  - any other exit → wait 5 s, run again;
  - `exec` missing → exit 0 (mirrors the launchd wrapper's `[ -x "$0" ] || exit 0`).
- On Windows `service.json` is the unit file: the counterpart of the plist and the `.service` file. The
  task XML and `service.json` are always written together.
- Restart from inside the service: Dashboard apply and auto-update call `restartService` from the running
  proxy (`upgrade.ts` `runUpgradeCommand`). On Windows `/End` would kill the supervisor and, through its
  Job Object, the caller before `/Run`. When `AIO_PROXY_MANAGED=1` on win32, `restartService` therefore
  rewrites `service.json` (and the task XML first when `<exec>` changed; `/Create /F` on a running task
  replaces its definition for the next launch), returns normally so the caller records the upgrade as
  installed, and schedules `process.exit(75)` one second later — the same "let the caller finish, then go"
  shape as the macOS detached `launchctl` helper. Throwing instead would be swallowed by the server's
  auto-update task (`packages/server/src/auto-update/auto-update.ts`), leaving the old proxy running.
- Lifecycle, so that a user's stop survives restarts (the policy reads `job.disabled` as the user's intent):

| Command | Linux | Windows |
| --- | --- | --- |
| `start` | `systemctl --user enable --now` | `/Change /ENABLE`, then `/Run` |
| `stop` | `systemctl --user disable --now` (today: `stop` only) | `/End`, then `/Change /DISABLE` |
| `restart` (from outside the service) | rewrite unit, `daemon-reload`, `enable`, `restart` | write new XML + spec to temp files; `/End`; `/Create /XML /F` (replaces the action, leaves the task enabled); move the spec into place; `/Run`. Any failure restores the previous XML and spec |
| `uninstall` | `disable --now`, remove unit, write the uninstall marker | `/End`, wait until the supervisor PID is gone (10 s, else fail), `/Delete /F`, remove spec and state, write the uninstall marker |
| `install` | remove the uninstall marker, write unit | remove the uninstall marker, write XML + spec |

  `/End` terminates the supervisor; the supervisor runs its child in a Job Object with
  `KILL_ON_JOB_CLOSE`, so the proxy ends with it. `schtasks /Delete` alone would leave both running.
- Uninstall marker: a per-user file at a fixed path beside where the unit lives, so it is found whatever
  `AIO_PROXY_HOME` the removed service used — Linux `<systemd user unit dir>/aio-proxy.service.uninstalled`,
  Windows `%LOCALAPPDATA%\aio-proxy\service.uninstalled`. Each user has at most one service, so one marker
  suffices. It plays the role of the disabled override that `launchctl unload -w` leaves on macOS: with no
  unit present, discovery reports `disabled: true` while the marker exists, so the app does not reinstall a
  service the user removed.
- Task Scheduler queries capture stdout and stderr and pass `/HRESULT`, so "the task does not exist"
  (`0x80070002`) is told apart from every other failure. Process identity checks (the state file's PID
  running `exec`) read the full image path with `QueryFullProcessImageNameW` through `bun:ffi`, beside the
  Job Object calls; `tasklist` reports only the image name. Account checks compare SIDs read from the
  process token (`OpenProcessToken` + `GetTokenInformation(TokenUser)`), never names that console tools
  print in the OEM code page, where distinct non-ASCII names can decode alike.
- Every child process the CLI spawns on win32 (`schtasks`, `netstat`, the proxy itself) uses
  `Bun.spawn`'s `windowsHide`.
- **Spike (phase 0):** a console program started by Task Scheduler opens a console window. Candidates
  without admin rights, in order of preference:
  1. task action `conhost.exe --headless <exec> __service-run <spec>`;
  2. S4U logon type ("run whether the user is logged on or not", no stored password), which runs in a
     non-interactive session;
  3. a separate launcher compiled with `--windows-hide-console` (costs a second ~100 MB Bun binary).

  The spike also confirms that `/End` reaches the child through the Job Object.

### 2d. `__desktop-connect` on every platform

The output stays `protocolVersion: 1` with the same `unit` / `job` / `instance` / `token` shape and field
meanings, so the Rust `Discovery` parser and the `policy` state machine are unchanged.
`DesktopConnectDeps.plistPath` becomes `unitPath`. Each platform supplies its probes:

| Probe | darwin (today) | linux | win32 |
| --- | --- | --- | --- |
| `readUnit` | `plutil` → `inspectUnit` | parse `ExecStart=` and `Environment=` | `schtasks /Query /XML /TN <path>`: the principal must be the current user's SID and the action `<exec> __service-run <spec path>` (through `conhost` if the spike picks it), else `wrapperValid: false`; then read `service.json` |
| `readJob` | `launchctl print`, `print-disabled` | `systemctl --user show -p LoadState,ActiveState,UnitFileState,MainPID` | `schtasks /Query /V /FO CSV`; `pid` from `service.state.json` when that process is alive and its image is `exec` |
| Connection ownership | `lsof` | `/proc/net/tcp{,6}`: the uid of the row matching the four-tuple | `netstat -ano -p TCP` and `-p TCPv6` → PID → that process's token SID equals ours |

- `matchesJob` keeps its meaning: the instance's PID or PPID equals `job.pid`. The proxy is the
  supervisor's (Windows) or `MainPID`'s (Linux) process or child, as it is the `/bin/sh` wrapper's child
  on macOS. Without that PID the policy would hide Stop/Restart (`policy.rs` `offered_actions`) and never
  restart an outdated instance (`automatic_action`).
- Two ownership checks stay distinct, on every platform:
  - discovery owner: `unitOwner` compares the unit's target with the **caller's** `AIO_PROXY_DESKTOP_EXEC`
    (today's rule);
  - upgrade protection: `readDesktopOwnedUnit` checks the unit's **own** marker
    (`AIO_PROXY_DESKTOP_EXEC` equals the target), ported from plist-only to the systemd unit and
    `service.json`. `renderSystemdUnit` gains the `desktopExec` environment line it lacks today.
- `disabled` distinguishes three cases, because `policy.rs` `automatic_action` installs on first run only
  when `disabled` is false:

| State | Linux | Windows | `disabled` |
| --- | --- | --- | --- |
| No unit, no uninstall marker | `LoadState=not-found` | the task query reports the task does not exist | `false` (first run: install) |
| No unit, uninstall marker present | same | same | `true` |
| Unit present | `UnitFileState` is not `enabled` | task status `Disabled` | `true` |
| Query failed for any other reason | — | — | `true` (fail closed) |

- All probes keep failing closed: an unreadable disabled state is `disabled: true`, an unreadable or
  mismatched task action or principal is `unknown`, an unreadable connection owner is not ours.
- **The token is sent only after the serving socket of the very connection that carries it is verified**,
  by its full four-tuple and address family, as `verified-get.ts` and `transport.rs` do today. A listener
  check alone is not enough: another account could accept the connection and hand the port back. This
  applies to the CLI's identity GET and to the Rust transport alike.

## 3. Tray and panel

### Tray (`tray-icon`)

- Linux uses the `ksni` backend (StatusNotifierItem over D-Bus) with default features off: no GTK event
  loop (GPUI's Linux backend runs none) and no GTK3 / libxdo / appindicator libraries in the AppImage. KSNI
  turns `activate` into `TrayIconEvent::Click`, so `click_event` is reused.
- Windows uses the default Win32 backend with `with_guid(<fixed u128>)`. For an unsigned binary Windows
  still keys the icon's settings on the executable path, so the "pinned to taskbar" choice survives updates
  because the per-user install path is fixed, not because of the GUID alone.
- Icon: Windows and Linux trays are square and have no template images. Add a square mark asset;
  `icon_rgba` takes a color. The three states (running, dimmed when down, attention dot) are unchanged.
  Color: Windows reads `SystemUsesLightTheme` (the taskbar's setting, distinct from the apps' one); Linux
  follows `cx.window_appearance()`.
- Linux's tray menu gains "Open Panel": some hosts (Ubuntu's AppIndicator extension) open the menu on left
  click and never send `activate`. It shows and focuses the panel (idempotent); only a tray click toggles.

### Panel window

| | macOS (unchanged) | Windows | Linux |
| --- | --- | --- | --- |
| Kind | `PopUp`, no titlebar | `PopUp`, no titlebar, no taskbar button | `Normal`, resizable, minimum 360×560, placed by the window manager |
| Titlebar | none | none | drawn by the app with gpui-kit's title bar (close button included) on X11 and Wayland alike; GPUI falls back to client decorations without server decorations, and GNOME offers none |
| Position | below the menu bar, centered on the icon | next to the icon rect from the `Click` event, on the side facing the screen center, clamped to the work area (taskbar on any edge) | not set |
| Close on deactivation | yes | yes (`observe_window_activation` is cross-platform) | no |
| Background | `NSVisualEffectView` | `WindowBackgroundAppearance::Blurred` | opaque theme background |

GPUI's Wayland backend ignores `is_resizable` (it sets only a minimum size), so Linux does not promise a
fixed size. `placement::panel_origin` stays a pure function and gains the four taskbar edges. It works in
logical pixels: the icon rect and the work area come from Win32 in physical pixels and are divided by the
scale factor of the monitor that holds the icon before placement. An icon inside the work area (the
overflow flyout) opens the panel above it when it sits in the lower half of the work area, else below it.

### No tray (Linux)

If no process owns the D-Bus name `org.kde.StatusNotifierWatcher` (GNOME without the extension), the app is
in no-tray mode: the panel window is open, and closing it quits the app. The proxy is owned by
`systemd --user`, so quitting only removes the monitor; keeping a hidden process alive would need a
second-instance IPC to show the window again.

The app checks at startup and then watches `NameOwnerChanged` for that name. Losing the watcher while
running (the user disables the extension) switches to no-tray mode and opens the window; a watcher that
appears later only adds the tray icon.

## 4. Install, stable exec, `aiop`, single instance

### Stable exec

macOS keeps its symlink `…/bin/aio-proxy` → the bundle's sidecar. That does not carry over: an AppImage's
sidecar exists only under its temporary read-only mount, and Windows symlinks need privileges while a
running `.exe` is locked.

Linux and Windows keep a real copy instead:

- Path: `$XDG_DATA_HOME/aio-proxy-desktop/bin/aio-proxy` / `%LOCALAPPDATA%\aio-proxy-desktop\bin\aio-proxy.exe`.
  `AIO_PROXY_DESKTOP_EXEC` points at it.
- Source: the sidecar next to the running executable (`$APPDIR/usr/bin/` in the AppImage, the install
  directory on Windows). `sidecar_of` / `bundle_of` gain these layouts.
- Replace (stage, verify, commit):
  1. copy to `bin/.aio-proxy.tmp` in the same directory and run it with `--version`; a mismatch with the
     app's version aborts and deletes the temp;
  2. commit — Linux: `rename` over the copy (atomic; a running process keeps the old inode). Windows: rename
     the current `aio-proxy.exe` to `aio-proxy.exe.old-<pid>`, then rename the temp into place; if that
     second rename fails, rename the `.old-<pid>` back at once;
  3. after a commit, the existing automatic-action table restarts the proxy.
- Startup recovery (Windows), before the no-downgrade check: if `aio-proxy.exe` is missing and an
  `.old-*` exists, rename the newest one back; then delete the remaining `.old-*` files (best effort).
  This covers a crash between the two renames. A task launch inside that window fails to start and is
  retried by the task's `RestartOnFailure` (section 2c).
- No-downgrade: compare `bin/aio-proxy --version` (`probe_version`) with the app's version. Missing or older
  → replace; equal → keep; newer or unreadable → refuse and run read-only. `plan_symlink` becomes a pure
  function over versions, shared by the copy model; macOS keeps its target-path check in front of it.
- Persistence policy: "inside an Applications folder on a writable volume" stays macOS-only. On Linux and
  Windows the install is persistent when the sidecar is executable and the stable copy's directory is
  writable; the AppImage's own mount is never checked for writability. Updates additionally need the
  `$APPIMAGE` file's directory to be writable (Linux); without it the panel offers the download page.
- Linux autostart's `Exec=` is `$APPIMAGE`; on each start with autostart enabled the app rewrites it, so a
  moved AppImage heals itself.

### `aiop`

| | macOS (unchanged) | Linux | Windows |
| --- | --- | --- | --- |
| Install | `/usr/local/bin` behind the admin prompt | symlink `~/.local/bin/aiop` → the stable copy | `bin\shims\aiop.cmd` (`@"<stable exe>" %*`); `shims` appended to the end of the user `PATH` (HKCU `Environment`, then broadcast `WM_SETTINGCHANGE`) |
| Probe | login shell, `command -v` | same | `where.exe` with a `PATH` rebuilt from the registry (HKLM then HKCU `Path`, expanded), since the app's own environment predates the install |
| `aio-proxy` name | only when free | only when free | `aio-proxy.cmd` only when free |

The Windows shims live apart from `bin\` so the real `.exe` never lands on `PATH`, and appending keeps an
existing npm `aio-proxy` first. Running the stable copy through `aiop` carries no environment marker; the
path rule in section 2a keeps it from self-upgrading.

### Single instance

`File::try_lock` on all platforms (section 1).

### Uninstall

- Windows, a user-initiated uninstall only: the NSIS uninstaller runs `aio-proxy service uninstall` when
  the unit is desktop-owned (which stops before deleting, section 2c), removes the `shims` entry from the
  user `PATH`, removes the HKCU `Run` value after checking its name and target, and deletes
  `%LOCALAPPDATA%\aio-proxy-desktop`.
- Windows, an upgrade: cargo-packager's NSIS template runs the previous version's uninstaller during an
  interactive upgrade. That run must skip all of the above, so the service definition, the user's
  stop/start intent, the `aiop` shims and the login item survive the upgrade. How the hook tells the two
  apart is part of the phase 0 NSIS spike.
- Linux: an AppImage has no uninstaller. Documented: run `aio-proxy service uninstall` before deleting it.

### Known ceilings

- Deleting the AppImage leaves the copy, and the service keeps running a version that no longer updates.
  Upgrade path if users hit it: the CLI stops a desktop-owned unit whose desktop app is gone.
- `cargo-packager-updater` replaces an AppImage by moving the old file aside and writing the new one in
  place, restoring the old file on an error but not across a crash. A crash mid-write leaves a broken
  AppImage the user downloads again; the stable copy and the service are unaffected.

## 5. Updates on Linux and Windows

- Library: `cargo-packager-updater`. The platform `updater` keeps the macOS module's interface —
  `start(events)`, `check_now()`, `AppEvent::UpdateAvailable(version)`, `AppEvent::UpdateAttended` — so the
  panel button, the tray attention dot and "Check for Updates…" need no change. The library brings its own
  HTTP client; GPUI's is not involved.
- Feed: `latest.json` on the `desktop-feed` prerelease, in the updater's format: `version` plus per-target
  `url`, `signature`, `format` for `linux-x86_64`, `linux-aarch64` (`appimage`) and `windows-x86_64`
  (`nsis`). macOS keeps `appcast.xml`.
- Checks: at launch and every 6 hours. "Install and Relaunch" in the panel downloads and verifies, then:
  - Windows: runs the NSIS installer in Passive mode and quits; the installer closes and relaunches the app;
  - Linux: replaces `$APPIMAGE` (see Known ceilings) and relaunches.
  The new app then refreshes the stable copy (section 4). No silent install, matching
  `SUAllowsAutomaticUpdates = false` on macOS.
- "Check for Updates…" with nothing pending checks now; when current, the panel's action line says the app
  is up to date (new `AppEvent::UpToDate`).

### Signature

The existing Sparkle Ed25519 key, in minisign form. One root of trust and one offline backup for all three
platforms; no new secret.

- Encoding: the updater base64-decodes both strings and then parses minisign **text**. So:
  - public key = `base64(` the two-line minisign public key file: an untrusted comment line, then
    `base64("Ed" ‖ key id ‖ 32-byte Sparkle public key)` `)`, with a fixed key id, compiled in;
  - `signature` = `base64(` the four-line `.minisig` text `)`: untrusted comment;
    `base64("ED" ‖ key id ‖ Ed25519(BLAKE2b-512(file)))`; `trusted comment: …`;
    `base64(Ed25519(signature ‖ trusted comment))`.
- The trusted comment binds the artifact: `aio-proxy-desktop <version> <target> <asset name>`. The updater
  compares only the unsigned `version` field, so before `install` the app parses the verified signature's
  trusted comment and refuses unless version, target and asset match the offer. A feed that labels an old,
  validly signed package as newer is rejected.
- Signing: a Bun script (`node:crypto` Ed25519 + `blake2b512`) writes the `.minisig` from
  `SPARKLE_ED_PRIVATE_KEY`. `cargo-packager`'s own signer is not used; it wants minisign's encrypted
  secret-key file.
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

**Spike (phase 0):** whether `cargo-packager`'s NSIS supports those hooks, and how the uninstall hook
tells a user uninstall from the previous version's uninstaller run during an upgrade; otherwise a custom
NSIS template.

Assets on `v<version>`: `aio-proxy-<v>-x86_64.AppImage`, `aio-proxy-<v>-aarch64.AppImage`,
`aio-proxy-<v>-x64-setup.exe`, and each one's `.minisig`.

### Release workflow (`desktop-release.yml`)

Permissions move from the workflow to each job. The macOS job keeps `contents: write` and its steps
unchanged, and publishes its DMG and `appcast.xml` on its own, so a Linux or Windows failure never holds a
macOS release. Added beside it:

0. `verify` (ubuntu, `contents: read`, no checkout): the same tag checks as the macOS job (a published,
   non-prerelease Release whose commit is on `main`), inline as there; outputs `version` and `sha`. A local
   composite action cannot run before the checkout it would come from, so the checks stay inline.
1. `build-linux` (`x86_64`, `aarch64` runners) and `build-windows`: `needs: verify`, `contents: read`,
   checkout of `verify.outputs.sha` with `persist-credentials: false`, no environment, no secrets; build the
   workspace packages the sidecar embeds, the sidecar and the app, package, upload as workflow artifacts.
2. `publish-assets` (ubuntu, `desktop-release` environment, `contents: write`, no concurrency group, needs
   every build job). Per platform, with uploads always in the order `.minisig`, then asset:
   - neither on `v<version>` → sign this run's asset, upload the `.minisig`, then the asset;
   - `.minisig` present, asset missing (an interrupted run) → upload this run's asset only if it verifies
     against the published `.minisig` and its trusted comment; otherwise fail and name the orphan
     `.minisig` to delete before re-dispatching. Builds are not reproducible, so this usually fails, which
     is the safe outcome: nothing ever signs bytes this run did not build;
   - both present → verify the pair against the public key and the trusted comment; a mismatch fails the
     job. A published asset is never rebuilt, re-signed or replaced;
   - asset present, `.minisig` missing cannot arise from this order; it fails the job.
3. `feed` (ubuntu, `desktop-release` environment, `contents: write`, `concurrency: desktop-feed-latest` with
   `cancel-in-progress: false`, needs `publish-assets`):
   1. Read `latest.json` from `desktop-feed`. The job never creates `desktop-feed`; a missing Release fails
      the job (the macOS job owns its creation, and `publish.ts` refuses a feed Release without
      `appcast.xml`).
   2. Choose the target version independently of the dispatch: the highest stable Release among the
      newest 20 whose three assets and `.minisig` files are all present and verify. Same as the feed →
      stop; lower → stop (never downgrade); higher → write `latest.json` from that Release and replace it.

Only the feed write is serialized. Because each `feed` run picks the highest complete version on its own,
GitHub replacing a pending run (a slow older build queuing after a newer one) cannot leave the feed behind:
the run that does execute after the last `publish-assets` publishes the newest complete version. The macOS
job keeps the `desktop-feed` group; the jobs write different files, so separate groups let neither cancel
the other's pending run. Any platform failing leaves that version out of `latest.json`; resume with
`gh workflow run desktop-release.yml -f tag=v<version>`.

### Windows signing hook

The build script passes `cargo-packager`'s `windows.sign_command` only when `WINDOWS_SIGN_COMMAND` is set.
`RELEASING.md` documents wiring Artifact Signing or `signtool` into it. No untested signing step is
committed to the workflow.

### CI (`ci.yml`)

- The desktop Rust job becomes a macOS / ubuntu / windows matrix running `cargo clippy` and `cargo test`;
  each platform's `cfg` code only compiles there.
- The CLI and core unit tests also run on a Windows runner (service, desktop-connect, desktop-token,
  upgrade).
- Native smoke on Linux and Windows before the first release, reusing `desktop/scripts/smoke`'s runtime
  checks (`/health`, Dashboard, authenticated summary): install the service from the packaged sidecar, run
  `__desktop-connect`, stop (and confirm it stays stopped after a new discovery), start, restart, uninstall
  (and confirm no process is left). `--version` alone proves nothing: `main.rs` returns before any backend
  starts.

### Docs and release note

`RELEASING.md` covers all three platforms; the README download section lists the new assets. One changeset,
`minor`, targeting `aio-proxy` plus the internal packages it changes (`@aio-proxy/cli`,
`@aio-proxy/core`), one paragraph.

## 7. Testing

Tests only where a user-visible break would fail them; no snapshots of static templates (`.desktop`, shims,
task XML).

| Area | Test | Why |
| --- | --- | --- |
| Rust `placement` | taskbar on each edge; clamping to the work area | visible misplacement; pure function |
| Rust `install` | copy plan: missing / older / equal / newer / unreadable; Windows startup recovery from `.old-*` | the no-downgrade invariant; a service never left without its executable |
| Connection ownership (Rust + TS) | `/proc` and netstat parsing, owner by SID on Windows; IPv4 and IPv6; four-tuple match; a port that changes owner between listen check and connect is refused | security boundary for the token |
| Desktop token (TS, win32) | path derives from the resolved home under `%LOCALAPPDATA%`; two homes get two tokens; a reparse point is rejected; server and CLI resolve the same path | the token's trust boundary on Windows |
| TS `desktop-connect` | systemd `show`, `schtasks` XML/CSV, `service.json` and state file → `unit` / `job`; a task whose action does not run `__service-run` with our spec, or whose principal is another user, is `unknown`; owner rules equal across platforms | the app's automatic actions depend on it |
| TS `disabled` mapping | no unit and no marker → `false`; no unit with the uninstall marker → `true`; disabled unit → `true`; failed query → `true` | first run installs; a user's uninstall or stop is not undone |
| TS lifecycle | stop then discover reports `disabled: true` on Linux and Windows; uninstall waits for the supervisor; Windows `restart` after `stop` re-enables and runs; a failed `restart` restores the previous XML and spec | the user's intent survives, and a broken restart leaves the old service |
| TS `__service-run` | exit-code decision: 0/1 stop, 75 re-read spec and relaunch at once, other restart after 5 s, missing exec stop | the systemd semantics it reproduces, and in-service upgrades |
| TS `restartService` (win32, managed) | inside the service it rewrites the spec, returns normally, and exits 75 a second later; no `schtasks /End` or `/Run` | an in-service upgrade does not kill itself before restarting, and the caller records success |
| TS `service` win32 | write and read back `service.json`, desktop-owned marker, paths with spaces | the unit-file contract |
| TS `upgrade` | an executable under `aio-proxy-desktop/bin/` without env markers is desktop-managed | a terminal `aiop upgrade` cannot fork the desktop's copy |
| Windows `PATH` edit | append/remove `shims` with duplicates, trailing `;`, case differences | breaking a user's PATH is costly |
| Signature | a Bun-signed fixture passes through `cargo-packager-updater`'s own verification entry point; a trusted comment with another version or target is refused | encoding contract; a mismatch fails every update or admits a downgrade |
| `latest.json` | target keys and `format` match the updater; missing platform refused; the highest complete version is chosen whatever the dispatched tag; older never replaces newer | the feed's all-or-nothing and monotonic rules |
| `publish-assets` plan | neither / signature only / both present → sign-and-upload / upload only a verifying asset, else fail / verify; asset without signature fails | an interrupted upload resumes, and nothing unbuilt is ever signed |

Manual checklist before each release:

- Linux: KDE (X11 and Wayland); GNOME with the AppIndicator extension; GNOME without it (no-tray mode, close
  quits); Ubuntu default (menu-only left click, "Open Panel" works).
- Windows 11: taskbar bottom and top; icon in the overflow area; light and dark taskbar; install, update
  through the in-app updater and by running a newer installer by hand (service, stop state, `aiop` and
  login item survive), uninstall (nothing left running, no `Run` value); a second Windows user installing
  the service; an auto-update triggered from the Dashboard while the proxy runs as the task.
- Linux: disabling the AppIndicator extension while the app runs switches it to no-tray mode.
- Updates end to end against a local feed: same version, newer version, bad signature, newer label on an
  older signed package.

## Phases

0. Spikes: hidden console for the Windows task, `/End` reaching the child through the Job Object, and
   `RestartOnFailure` retrying a launch whose executable is missing (2c); `cargo-packager` NSIS hooks and
   telling an upgrade's uninstaller run from a user uninstall (4, 6); `ksni` clicks on GNOME and KDE (3).
1. CLI and core: win32 binary, desktop token on Windows, Task Scheduler backend, `__service-run`, lifecycle
   persistence, `__desktop-connect` on all platforms, upgrade protection.
2. Desktop platform layer and Linux (sections 1, 3, 4).
3. Desktop Windows (the Windows parts of 3 and 4).
4. Updater (section 5).
5. Packaging, CI, release (section 6).

Each spike's result is recorded in `2026-10-02-windows-linux-desktop-spike-findings.md`; a result that
contradicts this spec revises it before the dependent phase starts.
