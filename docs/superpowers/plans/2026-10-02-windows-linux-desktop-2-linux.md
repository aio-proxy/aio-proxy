# Windows and Linux Desktop — Phase 2: Platform Layer and Linux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every macOS-only piece of `desktop/` behind `desktop/src/platform/`, replace libc/objc2 utilities with shared std/crate code, and bring up a working Linux desktop app (tray, panel window, login item, stable CLI copy, `aiop`, discovery).

**Architecture:** `platform/mod.rs` re-exports one of `platform/macos/`, `platform/linux/`, `platform/windows/` by `cfg(target_os)`. Shared logic (`app/`, `connect/`, `panel/` views, `summary`) calls only `platform::*` for OS work. The macOS module is a pure move of existing code. The copy-model install (`install/copy.rs`) is shared by Linux and Windows.

**Tech Stack:** Rust 1.98, GPUI via `gpui-kit` 0.7.0, `tray-icon` 0.25.1 (`ksni` on Linux), `gpui-pre-reqwest-client` 0.3.7, `chrono`, `zbus` (already in `Cargo.lock`), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 4), sections 1, 3, 4. Requires phase 1 (Linux discovery and lifecycle) merged.

## Global Constraints

- Linux paths: support `$XDG_DATA_HOME/aio-proxy-desktop` (default `~/.local/share/aio-proxy-desktop`), logs `$XDG_STATE_HOME/aio-proxy-desktop` (default `~/.local/state/aio-proxy-desktop`), stable copy `<support>/bin/aio-proxy`.
- Autostart file `~/.config/autostart/aio-proxy-desktop.desktop` (`$XDG_CONFIG_HOME` honored), `Exec=` is `$APPIMAGE`.
- Linux panel: `WindowKind::Normal`, resizable, minimum 360×560, gpui-kit `TitleBar`, opaque background, no close on deactivation.
- No-tray mode when no D-Bus owner of `org.kde.StatusNotifierWatcher`; closing the window quits; watch `NameOwnerChanged`.
- Linux tray menu adds "Open Panel" (id `open-panel`).
- Kickstart on Linux: `systemctl --user restart aio-proxy.service`.
- `aiop` on Linux: symlink `~/.local/bin/aiop` → stable copy; `aio-proxy` only when free.
- HTTP client: `ReqwestClient::new()` from `gpui-pre-reqwest-client` on all platforms; `http.rs` deleted.
- Health timer stays 60 s; no wake hook on Linux.
- macOS behavior must not change (except the HTTP client); `cargo test` on macOS stays green after every task.
- Commands: `cd desktop && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`.

## Review Focus

- Two AppImages of different versions launched alternately: the older one must refuse to replace the newer stable copy and run read-only — owned by Task 3.
- `$XDG_DATA_HOME` or `$XDG_CONFIG_HOME` set to a relative path or empty string must fall back to the home defaults (XDG says ignore non-absolute) — owned by Task 3 (`Paths`) and Task 4.
- An AppImage moved after autostart was enabled: the next start rewrites `Exec=` — owned by Task 4.
- The tray host disappears while the panel is closed (GNOME extension disabled) — owned by Task 8.
- `~/.local/bin` missing from the login shell's PATH: the `aiop` offer stays hidden — owned by Task 9.

---

### Task 1: Create `platform/` and move the macOS code into it

Pure move. No behavior change on macOS.

**Files:**
- Create: `desktop/src/platform/mod.rs`, `platform/macos/mod.rs`, `platform/macos/login_item.rs` (from `login_item.rs`), `platform/macos/updater.rs` (from `updater.rs`), `platform/macos/wake.rs` (`observe_wake` from `main.rs`), `platform/macos/panel.rs` (`anchor`, `frost`, `native_window`, animation-off from `panel/window.rs`), `platform/macos/host.rs` (kickstart command, `pid_alive`, `current_uid`), `platform/macos/peer.rs` (lsof parts of `client/listener.rs`)
- Modify: `desktop/src/lib.rs`, `main.rs`, `panel/window.rs`, `connect/cli.rs`, `client/listener.rs`, `client/transport.rs`, `app/lifecycle.rs`, `Cargo.toml` (`objc2*`, `block2` under `[target.'cfg(target_os = "macos")'.dependencies]`), `build.rs` (ServiceManagement / Sparkle links only when `CARGO_CFG_TARGET_OS == "macos"`)

**Interfaces:**
- Produces (every platform module implements exactly these; later tasks add Linux and Windows bodies):
  - `platform::paths(home: &Path) -> install::Paths`
  - `platform::login_item::{status() -> LoginItemStatus, set_enabled(bool) -> Result<(), String>, open_settings()}` (`LoginItemStatus` moves to `platform/mod.rs`, unchanged)
  - `platform::updater::{start(events: UnboundedSender<AppEvent>), check_now()}`
  - `platform::on_launch(cx: &mut App, events: UnboundedSender<AppEvent>)` (macOS: Accessory policy + wake observer)
  - `platform::kickstart(user: &str) -> Vec<Command>` (run in order; macOS and Linux return one command, Windows two); `platform::current_user() -> String` (uid as text on Unix, SID string on Windows)
  - `platform::pid_alive(pid: u32) -> bool`
  - `platform::peer_owned_by_this_user(stream: &TcpStream, deadline: Instant) -> bool`
  - `platform::panel::{window_options(cx: &App, tray: &Tray) -> Option<WindowOptions>, after_open(window: &mut Window), closes_on_deactivate() -> bool}`

- [ ] **Step 1:** Move code into the files above; `panel/window.rs` keeps the open/close/toggle state machine and calls `platform::panel::*`; `connect/cli.rs` `SystemHost` stores `user: String` and runs every `Command` from `platform::kickstart(&self.user)` in order, and calls `platform::pid_alive`.
- [ ] **Step 1b:** Add compilable `platform/linux/mod.rs` and `platform/windows/mod.rs` skeletons implementing the whole interface with safe defaults (login item `Unavailable`, updater no-op with a log line, `pid_alive`/`peer_owned_by_this_user` → `false`, `panel::window_options` → a `Normal` 360×560 window, `closes_on_deactivate` → `false`), and move `tray-icon` to `default-features = false, features = ["ksni"]` under `[target.'cfg(target_os = "linux")'.dependencies]`. Later tasks replace the stubs; from here on the crate builds on all three platforms.
- [ ] **Step 2: Run** `cd desktop && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` on macOS — Expected: PASS with no test changes beyond `use` paths.
- [ ] **Step 3: Commit**

```bash
git add desktop
git commit -m "refactor(desktop): move macOS-only code behind a platform layer"
```

### Task 2: Shared replacements for libc and NSURLSession

**Files:**
- Delete: `desktop/src/http.rs`, `desktop/src/http/tests.rs`
- Modify: `desktop/Cargo.toml` (add `gpui-pre-reqwest-client = "=0.3.7"` as `reqwest_client`, `chrono = { version = "0.4", default-features = false, features = ["clock"] }`; drop NSURLSession features from `objc2-foundation`), `main.rs` (`cx.set_http_client(Arc::new(reqwest_client::ReqwestClient::new()))`), `install.rs` (`acquire_instance_lock` via `File::try_lock`), `process.rs` (`Child::kill` instead of `libc::kill`; `#[cfg(windows)]` `CREATE_NO_WINDOW` via `CommandExt::creation_flags(0x0800_0000)`), `panel/format.rs` (`local_utc_offset` via `chrono::Local`)
- Test: `desktop/src/install/tests.rs`, `desktop/src/process/tests.rs`, `desktop/src/panel/format/tests.rs`

**Interfaces:**
- Produces: `acquire_instance_lock(path: &Path) -> io::Result<Option<InstanceLock>>` (unchanged signature); `run_with_timeout(command, timeout)` (unchanged signature).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_second_instance_lock_on_the_same_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("instance.lock");
    let first = acquire_instance_lock(&path).unwrap();
    assert!(first.is_some());
    assert!(acquire_instance_lock(&path).unwrap().is_none());
    drop(first);
    assert!(acquire_instance_lock(&path).unwrap().is_some());
}
```

  (If an equivalent test already exists, keep it and skip to Step 3; it must pass after the change.) Existing timeout and `local_utc_offset` tests stay as they are.

- [ ] **Step 2: Run** `cd desktop && cargo test --locked install::tests` — Expected: PASS before, and must still PASS after Step 3.
- [ ] **Step 3: Implement** the replacements. `run_with_timeout` keeps the waiter thread but holds the `Child` behind `Arc<Mutex<Option<Child>>>` so the timeout path can `kill()`; stdout/stderr are taken and read on their own threads so a grandchild holding the pipes cannot block.
- [ ] **Step 4:** Gate the `/bin/sh`-based tests in `process/tests.rs` and the `std::os::unix` uses in `install/tests.rs` with `#[cfg(unix)]`; add one `#[cfg(windows)]` timeout test using `powershell -NoProfile -Command Start-Sleep 5`. **Run** `cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` — Expected: PASS. Manually: launch the app on macOS, open a panel with a remote plugin icon — the icon loads.
- [ ] **Step 5: Commit**

```bash
git add desktop
git commit -m "refactor(desktop): use std and shared crates for locks, timeouts, time and HTTP"
```

### Task 3: Copy-model install for Linux and Windows

**Files:**
- Create: `desktop/src/install/copy.rs`, `desktop/src/install/copy/tests.rs`
- Modify: `desktop/src/install.rs` (`Paths` gains `stable: PathBuf`; `sidecar_of`/`bundle_of` per platform; `InstallState` unchanged), `platform/linux/mod.rs` (`paths`), `app/lifecycle.rs` (`prepare_install` calls `copy::prepare` off macOS), `connect/cli.rs` (`SystemHost::new` uses `paths.stable` when it exists, else the sidecar)

**Interfaces:**
- Consumes: `version::compare`, `install::probe_version`.
- Produces:
  - `enum CopyPlan { Keep, Replace, Refuse(ReadOnlyReason) }`
  - `plan_copy(installed: Option<Option<String>>, own_version: &str) -> CopyPlan` — `None` = no file; `Some(None)` = unreadable version
  - `replace_copy(stable: &Path, sidecar: &Path, own_version: &str, probe: impl Fn(&Path) -> Option<String>) -> io::Result<()>` (stage `.aio-proxy.tmp` beside `stable`, probe it, commit per platform, roll back on a failed second rename on Windows)
  - `recover_backups(stable: &Path) -> io::Result<()>` (Windows: restore newest `.old-*` if `stable` is missing, then delete the rest; Unix: no-op)
  - `copy::prepare(paths: &Paths, sidecar: &Path, own_version: &str, probe) -> InstallState`
  - `persistent(sidecar: &Path, stable_dir: &Path) -> bool` (sidecar executable, `stable_dir` creatable and writable; the sidecar's own volume is never checked)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn copy_plan_never_downgrades_and_never_ranks_the_unreadable() {
    assert_eq!(plan_copy(None, "0.40.0"), CopyPlan::Replace);
    assert_eq!(plan_copy(Some(Some("0.39.0".into())), "0.40.0"), CopyPlan::Replace);
    assert_eq!(plan_copy(Some(Some("0.40.0".into())), "0.40.0"), CopyPlan::Keep);
    assert!(matches!(plan_copy(Some(Some("0.41.0".into())), "0.40.0"), CopyPlan::Refuse(ReadOnlyReason::NewerCopy { .. })));
    assert!(matches!(plan_copy(Some(None), "0.40.0"), CopyPlan::Refuse(ReadOnlyReason::UnreadableCopy { .. })));
}

#[test]
fn a_staged_copy_reporting_another_version_is_discarded_and_the_old_copy_stays() {
    let dir = tempfile::tempdir().unwrap();
    let (stable, sidecar) = (dir.path().join("bin/aio-proxy"), dir.path().join("sidecar"));
    fs::create_dir_all(stable.parent().unwrap()).unwrap();
    fs::write(&stable, b"old").unwrap();
    fs::write(&sidecar, b"new").unwrap();
    assert!(replace_copy(&stable, &sidecar, "0.40.0", |_| Some("0.39.9".into())).is_err());
    assert_eq!(fs::read(&stable).unwrap(), b"old");
    assert!(!dir.path().join("bin/.aio-proxy.tmp").exists());
}

#[test]
fn a_successful_replace_swaps_the_bytes() {
    // same setup, probe returns "0.40.0" → stable now reads b"new"
}

#[test]
fn the_sidecar_mount_being_read_only_does_not_block_persistence() {
    // sidecar under a dir with mode 0o555, stable dir writable → persistent(..) == true
}
```

- [ ] **Step 2: Run** `cd desktop && cargo test --locked install::copy` — Expected: FAIL.
- [ ] **Step 3: Implement.** `NewerCopy`/`UnreadableCopy` carry `app: stable.clone()` (the copy names itself). Linux `paths`: XDG variables honored only when absolute and non-empty. `sidecar_of` on Linux/Windows: the running executable's directory joined with `aio-proxy` / `aio-proxy.exe`; for an AppImage, `$APPDIR/usr/bin/aio-proxy` when `APPDIR` is set.
- [ ] **Step 4: Run** — Expected: PASS on macOS and Linux.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): keep a versioned CLI copy on Linux and Windows"
```

### Task 4: Linux login item

**Files:**
- Create: `desktop/src/platform/linux/login_item.rs`, `platform/linux/login_item/tests.rs`
- Modify: `platform/linux/mod.rs`, `app/lifecycle.rs` (`start`: if enabled, call `refresh_exec`)

**Interfaces:**
- Produces: `status_at(config_home: &Path, appimage: Option<&Path>) -> LoginItemStatus`; `set_enabled_at(config_home, appimage, bool) -> Result<(), String>`; `refresh_exec(config_home, appimage) -> Result<(), String>`; the `platform::login_item` functions call these with `$XDG_CONFIG_HOME` (absolute) or `~/.config` and `$APPIMAGE`. No `$APPIMAGE` → `LoginItemStatus::Unavailable`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn enabling_then_moving_the_appimage_heals_on_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let a = Path::new("/home/u/Apps/AIO Proxy.AppImage");
    set_enabled_at(dir.path(), Some(a), true).unwrap();
    assert_eq!(status_at(dir.path(), Some(a)), LoginItemStatus::Enabled);
    let b = Path::new("/home/u/Downloads/AIO Proxy.AppImage");
    refresh_exec(dir.path(), Some(b)).unwrap();
    let text = fs::read_to_string(dir.path().join("autostart/aio-proxy-desktop.desktop")).unwrap();
    assert!(text.contains("Exec=\"/home/u/Downloads/AIO Proxy.AppImage\""));
    set_enabled_at(dir.path(), Some(b), false).unwrap();
    assert_eq!(status_at(dir.path(), Some(b)), LoginItemStatus::NotRegistered);
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (desktop-entry `Exec` quoting: wrap in `"`, escape `"`, `` ` ``, `$`, `\`; `refresh_exec` is a no-op when the file is absent).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): launch at login on Linux"
```

### Task 5: Linux connection ownership and host

**Files:**
- Create: `desktop/src/platform/linux/peer.rs`, `platform/linux/peer/tests.rs`, `platform/unix.rs` (`pid_alive`, `current_user` shared by macOS and Linux)
- Modify: `platform/linux/mod.rs` (`kickstart` → `systemctl --user restart aio-proxy.service`)

**Interfaces:**
- Produces: `parse_proc_net(text: &str, v6: bool) -> Vec<ProcRow>` with `ProcRow { local: SocketAddr, remote: SocketAddr, listening: bool, uid: u32 }`; `serving_uid(rows: &[ProcRow], server: SocketAddr, client: SocketAddr) -> Option<u32>`; `platform::peer_owned_by_this_user` reads `/proc/net/tcp` or `/proc/net/tcp6` by the stream's family, retries every 25 ms until `deadline`, compares with `getuid()`.

- [ ] **Step 1: Write the failing tests** (same fixtures as phase 1 Task 5; the IPv6 fixture has both the `LISTEN` row and the established `[::1]:4137 → [::1]:50001` row, and the listening row must never match a connection)

```rust
#[test]
fn proc_rows_decode_both_families_and_match_the_four_tuple() {
    let rows = parse_proc_net(V4_FIXTURE, false);
    let server: SocketAddr = "127.0.0.1:4137".parse().unwrap();
    let client: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    assert_eq!(serving_uid(&rows, server, client), Some(1000));
    assert_eq!(serving_uid(&rows, server, "127.0.0.1:50001".parse().unwrap()), None);
    let rows6 = parse_proc_net(V6_FIXTURE, true);
    assert_eq!(serving_uid(&rows6, "[::1]:4137".parse().unwrap(), "[::1]:50001".parse().unwrap()), Some(1000));
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): verify connection owners and restart services on Linux"
```

### Task 6: Linux build and CI

**Files:**
- Modify: `.github/workflows/ci.yml` (desktop Rust job becomes a matrix `macos-15`, `ubuntu-24.04`; Linux installs `libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libvulkan-dev libx11-xcb-dev libxcb1-dev libfontconfig-dev libdbus-1-dev pkg-config`)

- [ ] **Step 1:** Confirm `cargo build --locked` succeeds on Linux with Task 1's skeleton (phase 4 fills `platform::updater`).
- [ ] **Step 2: Run** on Ubuntu: `cd desktop && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` — Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add desktop .github/workflows/ci.yml
git commit -m "ci(desktop): build and test the desktop app on Linux"
```

### Task 7: Linux tray

**Files:**
- Create: `desktop/assets/tray-mark-square.png` (32×32, from the brand mark; regenerate note as for `tray-mark.png`)
- Modify: `desktop/src/tray.rs` (`icon_rgba(state, color: [u8; 3])`; square asset off macOS; `with_icon_as_template` only on macOS), `tray/menu.rs` (`MenuCommand::OpenPanel`, id `open-panel`, listed first on Linux), `panel/window.rs` (new idempotent `panel::show(cx)`: opens, or focuses the open window), `main.rs` / `tray::run` (OpenPanel → `panel::show`; tray clicks keep `panel::toggle`), `platform/linux/mod.rs` (`tray_color(cx) -> [u8; 3]` from `cx.window_appearance()`)
- Test: `desktop/src/tray/tests.rs`, `tray/menu/tests.rs`

**Interfaces:**
- Produces: `icon_rgba(state: TrayState, color: [u8; 3]) -> Vec<u8>`; `MenuCommand::OpenPanel`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn icon_pixels_take_the_requested_color_and_keep_state_alpha() {
    let white = icon_rgba(TrayState::Running, [255, 255, 255]);
    assert!(white.chunks(4).filter(|p| p[3] > 0).all(|p| p[..3] == [255, 255, 255]));
    let dim = icon_rgba(TrayState::Down, [255, 255, 255]);
    assert!(dim.chunks(4).map(|p| p[3]).max() < white.chunks(4).map(|p| p[3]).max());
}

#[test]
fn open_panel_round_trips_through_its_menu_id() {
    assert_eq!(MenuCommand::from_id(MenuCommand::OpenPanel.id()), Some(MenuCommand::OpenPanel));
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; update the macOS call site to pass `[0, 0, 0]` (template images ignore color).
- [ ] **Step 4: Run** — Expected: PASS. Manually on KDE: icon visible, left click toggles, menu works.
- [ ] **Step 5: Commit**

```bash
git add desktop
git commit -m "feat(desktop): show the tray icon and menu on Linux"
```

### Task 8: Linux panel window and no-tray mode

**Files:**
- Create: `desktop/src/platform/linux/panel.rs`, `platform/linux/tray_host.rs`, `platform/linux/tray_host/tests.rs`
- Modify: `panel/view.rs` (activation close only when `platform::panel::closes_on_deactivate()`), `panel/window.rs` (Linux close → `CloseAction::Quit` in no-tray mode), `main.rs` (Linux: start the watcher; open the panel at launch in no-tray mode)

**Interfaces:**
- Produces: `enum TrayMode { Tray, NoTray }`; `next_mode(current: TrayMode, watcher_owned: bool) -> (TrayMode, bool /* open window */)`; `enum CloseAction { Hide, Quit }`; `close_action(mode: TrayMode) -> CloseAction`; `watch_tray_host(events: UnboundedSender<AppEvent>)` (zbus `NameOwnerChanged` on `org.kde.StatusNotifierWatcher`, emits new `AppEvent::TrayHost(bool)`); Linux `window_options`: `WindowKind::Normal`, `is_resizable: true`, min size 360×560, titlebar via gpui-kit `TitleBar` in `PanelView` on Linux, opaque background.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn losing_the_tray_host_opens_the_window_and_regaining_it_does_not_close_it() {
    assert_eq!(next_mode(TrayMode::Tray, false), (TrayMode::NoTray, true));
    assert_eq!(next_mode(TrayMode::NoTray, true), (TrayMode::Tray, false));
    assert_eq!(next_mode(TrayMode::Tray, true), (TrayMode::Tray, false));
}

#[test]
fn closing_the_window_quits_only_without_a_tray() {
    assert_eq!(close_action(TrayMode::NoTray), CloseAction::Quit);
    assert_eq!(close_action(TrayMode::Tray), CloseAction::Hide);
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS. Manually: GNOME without extension → window at launch, close quits; KDE → tray, window does not close on focus loss; disable the GNOME extension while running → window opens.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): show the panel as a window on Linux, with a no-tray mode"
```

### Task 9: `aiop` on Linux

**Files:**
- Modify: `desktop/src/cli_command.rs` (link dir per platform: `/usr/local/bin` on macOS, `~/.local/bin` on Linux; Linux installs without the admin prompt), `cli_command/tests.rs`, `app/lifecycle.rs` (`install_cli` targets `paths.stable` off macOS), `app.rs` (`can_link_cli`: macOS keeps the `/Applications` rule; Linux and Windows need only `persistent()`), `app/tests.rs`

**Interfaces:**
- Produces: `AppModel::can_link_cli()` per platform; `link_dir(home: &Path) -> PathBuf`; `install_links(dir: &Path, target: &Path, probe: Probe) -> io::Result<Vec<PathBuf>>` (creates `aiop`; `aio-proxy` only when `!probe.aio_proxy`; never replaces an existing file).

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn linux_links_aiop_and_only_a_free_aio_proxy_name() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("stable/aio-proxy");
    let made = install_links(dir.path(), &target, Probe { aiop: false, aio_proxy: true, link_dir_on_path: true }).unwrap();
    assert_eq!(made, vec![dir.path().join("aiop")]);
    assert_eq!(fs::read_link(dir.path().join("aiop")).unwrap(), target);
    assert!(!dir.path().join("aio-proxy").exists());
}

#[test]
fn a_persistent_linux_install_offers_aiop_without_an_applications_bundle() {
    // AppModel with install = Persistent and bundle = /home/u/Apps/AIO Proxy.AppImage → can_link_cli() on Linux
}

#[test]
fn an_existing_aiop_is_never_replaced() {
    // pre-create dir/aiop as a regular file → install_links returns Err and the file is unchanged
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; the offer stays hidden when `link_dir_on_path` is false (existing rule).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): install the aiop command on Linux"
```

### Task 10: Linux end-to-end check

No changeset in this phase: nothing user-visible ships until phase 5 publishes the AppImage, and phase 1's
note already covers the CLI changes.

- [ ] **Step 1:** On a Linux desktop with phase 1's CLI installed: `cargo run --release` from `desktop/`; first run installs and starts the service (fresh home), panel shows usage, Stop → relaunch app → still stopped, Restart works, `aiop` installs.
- [ ] **Step 2: Run** `bun run preflight` and the desktop CI matrix — Expected: PASS. Nothing to commit if both pass.
