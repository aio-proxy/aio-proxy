# Windows and Linux Desktop — Phase 3: Windows Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill `desktop/src/platform/windows/` so the desktop app runs on Windows 11 x64 with parity: tray popup panel, launch at login, connection-owner checks, stable CLI copy with crash recovery, `aiop` shims on the user PATH, and Task Scheduler discovery/kickstart.

**Architecture:** Implements the `platform::*` interface fixed in phase 2 Task 1 for Windows, reusing phase 2's copy-model install. Win32 calls go through `windows-sys` / `windows-registry` (both already in `Cargo.lock`); pure functions (placement, PATH editing, TCP row matching) carry the tests, Win32 glue gets Windows-only integration tests.

**Tech Stack:** Rust 1.98, GPUI `gpui-pre-windows` backend, `tray-icon` 0.25.1 Win32 backend, `windows-sys`, `windows-registry`, `cargo test` on `windows-2025`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 3), sections 1, 3, 4. Requires phase 1 (Windows CLI and service) and phase 2 merged.

## Global Constraints

- Paths: support/logs/lock under `%LOCALAPPDATA%\aio-proxy-desktop`; stable copy `%LOCALAPPDATA%\aio-proxy-desktop\bin\aio-proxy.exe`; shims `%LOCALAPPDATA%\aio-proxy-desktop\bin\shims\`.
- Login item: HKCU `Software\Microsoft\Windows\CurrentVersion\Run`, value name `AIO Proxy`, data = quoted path of the running `aio-proxy-desktop.exe`.
- Task path `\AIO Proxy\aio-proxy-<current user SID>`; kickstart = `schtasks /End /TN <path>` then `schtasks /Run /TN <path>`.
- Tray: `with_guid(<fixed u128>)`; color from HKCU `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` `SystemUsesLightTheme` (1 → black mark, 0/missing → white mark).
- Panel: `WindowKind::PopUp`, no titlebar, no taskbar button, `WindowBackgroundAppearance::Blurred`, closes on deactivation, 360×560, placed beside the tray icon rect on the side facing the screen center, clamped to the work area.
- `main.rs`: `#![cfg_attr(windows, windows_subsystem = "windows")]`; every helper child `CREATE_NO_WINDOW` (phase 2 Task 2).
- `aiop.cmd` content: `@"<stable exe>" %*`; `shims` appended to the end of HKCU `Environment\Path`, then `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment")`.
- `aiop` probe PATH = expanded HKLM `SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` + `;` + expanded HKCU `Environment\Path`.
- Commands: `cd desktop && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` on Windows.

## Review Focus

- A Windows user name with spaces and non-ASCII characters (`C:\Users\Zoë Chen\`) in the Run value, the `aiop.cmd` target and the stable copy — owned by Tasks 1, 5.
- The taskbar on the top or left edge, and a tray icon living in the overflow flyout (its rect is the flyout's) — owned by Task 4.
- HKCU `Path` stored as `REG_EXPAND_SZ` with `%USERPROFILE%` entries: appending must keep the type and the unexpanded entries — owned by Task 5.
- A crash between the two renames of a stable-copy replace — owned by Task 3.
- The proxy listening on `[::1]` only — owned by Task 2.

---

### Task 1: Windows paths, login item and CI

**Files:**
- Create: `desktop/src/platform/windows/mod.rs`, `platform/windows/login_item.rs`, `platform/windows/login_item/tests.rs`
- Modify: `desktop/Cargo.toml` (`[target.'cfg(windows)'.dependencies]` `windows-sys` with features `Win32_Foundation`, `Win32_Security`, `Win32_System_Threading`, `Win32_NetworkManagement_IpHelper`, `Win32_Networking_WinSock`, `Win32_UI_WindowsAndMessaging`; `windows-registry`), `desktop/src/main.rs` (subsystem attribute; `HOME` fallback to `std::env::home_dir()`), `.github/workflows/ci.yml` (desktop matrix adds `windows-2025`)

**Interfaces:**
- Produces: Windows `platform::paths`; `login_item::{status, set_enabled, open_settings}` (`open_settings` opens `ms-settings:startupapps`); `run_value_matches(data: &str, exe: &Path) -> bool`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn run_value_matches_only_this_executable() {
    let exe = Path::new(r"C:\Users\Zoë Chen\AppData\Local\Programs\AIO Proxy\aio-proxy-desktop.exe");
    assert!(run_value_matches(r#""C:\Users\Zoë Chen\AppData\Local\Programs\AIO Proxy\aio-proxy-desktop.exe""#, exe));
    assert!(run_value_matches(r#""c:\users\zoë chen\appdata\local\programs\aio proxy\aio-proxy-desktop.exe""#, exe));
    assert!(!run_value_matches(r#""C:\Other\aio-proxy-desktop.exe""#, exe));
}

#[cfg(windows)]
#[test]
fn enabling_writes_a_quoted_run_value_and_disabling_removes_it() {
    // uses a test value name via an injected key name; status follows
}
```

- [ ] **Step 2: Run** on Windows CI — Expected: FAIL.
- [ ] **Step 3: Implement** (status: missing → `NotRegistered`; present and matching → `Enabled`; present and pointing elsewhere → `NotRegistered`, and enabling overwrites it).
- [ ] **Step 4: Run** — Expected: PASS; the whole crate builds on `windows-2025`.
- [ ] **Step 5: Commit**

```bash
git add desktop .github/workflows/ci.yml
git commit -m "feat(desktop): build on Windows and launch at login"
```

### Task 2: Windows connection ownership and process checks

**Files:**
- Create: `desktop/src/platform/windows/peer.rs`, `platform/windows/peer/tests.rs`, `platform/windows/process.rs`

**Interfaces:**
- Produces: `TcpRow { local: SocketAddr, remote: SocketAddr, pid: u32 }`; `serving_pid(rows: &[TcpRow], server: SocketAddr, client: SocketAddr) -> Option<u32>`; `tcp_rows(v6: bool) -> io::Result<Vec<TcpRow>>` (`GetExtendedTcpTable` with `TCP_TABLE_OWNER_PID_ALL`, `AF_INET`/`AF_INET6`); `process_user_sid(pid: u32) -> Option<Vec<u8>>`; `current_user_sid() -> Vec<u8>`; `sid_string(sid: &[u8]) -> String`; `platform::pid_alive(pid)` (`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess == STILL_ACTIVE`); `platform::current_user() -> String` = `sid_string(current_user_sid())`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_serving_row_is_the_one_whose_local_end_is_the_server() {
    let s: SocketAddr = "[::1]:4137".parse().unwrap();
    let c: SocketAddr = "[::1]:50001".parse().unwrap();
    let rows = [TcpRow { local: c, remote: s, pid: 1 }, TcpRow { local: s, remote: c, pid: 812 }];
    assert_eq!(serving_pid(&rows, s, c), Some(812));
    assert_eq!(serving_pid(&rows, s, "[::1]:50002".parse().unwrap()), None);
}

#[cfg(windows)]
#[test]
fn a_local_listener_of_this_process_is_owned_by_this_user() {
    let listener = std::net::TcpListener::bind("[::1]:0").unwrap();
    let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let _accepted = listener.accept().unwrap();
    assert!(platform::peer_owned_by_this_user(&client, Instant::now() + Duration::from_secs(2)));
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (retry every 25 ms until the deadline; any API failure → false).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/platform/windows
git commit -m "feat(desktop): verify connection owners on Windows"
```

### Task 3: Windows host — kickstart, stable copy replace and recovery

**Files:**
- Modify: `desktop/src/platform/windows/mod.rs` (`kickstart(sid)` returns `[schtasks /End /TN <path>, schtasks /Run /TN <path>]`, both `CREATE_NO_WINDOW`), `desktop/src/install/copy.rs` (Windows commit + `recover_backups`), `install/copy/tests.rs`, `app/lifecycle.rs` (call `recover_backups` before `copy::prepare`)

**Interfaces:**
- Consumes: phase 2 Task 1 `platform::kickstart(user) -> Vec<Command>` (`SystemHost::mutate` already runs them in order); phase 2 Task 3 `replace_copy`, `recover_backups`; phase 1 `taskPath` format.

- [ ] **Step 1: Write the failing tests** (run on all platforms by injecting the commit strategy)

```rust
#[test]
fn recovery_restores_the_newest_backup_when_the_copy_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let stable = dir.path().join("aio-proxy.exe");
    fs::write(dir.path().join("aio-proxy.exe.old-100"), b"older").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(dir.path().join("aio-proxy.exe.old-200"), b"newest").unwrap();
    recover_backups_windows(&stable).unwrap();
    assert_eq!(fs::read(&stable).unwrap(), b"newest");
    assert!(fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".old-")));
}

#[test]
fn a_failed_second_rename_puts_the_old_copy_back() {
    // commit_windows with a rename fn that fails on the temp → stable step:
    // afterwards `stable` holds the old bytes and no `.old-*` remains
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `commit_windows(stable, temp, rename)` and `recover_backups_windows(stable)` as plain functions (testable everywhere), wired under `cfg(windows)`.
- [ ] **Step 4: Run** — Expected: PASS. Manually on Windows: with the service running, start a newer build → the copy is replaced, the proxy restarts, `aio-proxy.exe.old-*` is gone after the next start.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): replace the CLI copy safely and restart services on Windows"
```

### Task 4: Windows tray and popup panel

**Files:**
- Create: `desktop/src/platform/windows/panel.rs`
- Modify: `desktop/src/panel/placement.rs` (+ `placement/tests.rs`), `desktop/src/tray.rs` (keep the last click rect from `TrayIconEvent::Click { rect, .. }`; `with_guid` on Windows; color from `platform::tray_color`), `platform/windows/mod.rs` (`tray_color` via registry)

**Interfaces:**
- Produces: `struct Rect { x: f64, y: f64, width: f64, height: f64 }` (top-down, physical pixels); `popup_origin(icon: Rect, work_area: Rect, panel: (f64, f64)) -> (f64, f64)`; Windows `window_options` uses the work area of the monitor containing the icon (`MonitorFromRect` + `GetMonitorInfoW`), `WindowKind::PopUp`, `WindowBackgroundAppearance::Blurred`; `closes_on_deactivate() == true`.

- [ ] **Step 1: Write the failing tests**

```rust
const WORK: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1032.0 }; // taskbar at the bottom
const PANEL: (f64, f64) = (360.0, 560.0);

#[test]
fn bottom_taskbar_opens_above_the_icon_clamped_to_the_right_edge() {
    let icon = Rect { x: 1880.0, y: 1040.0, width: 24.0, height: 32.0 };
    assert_eq!(popup_origin(icon, WORK, PANEL), (1920.0 - 360.0, 1032.0 - 560.0));
}

#[test]
fn top_taskbar_opens_below_the_icon() {
    let work = Rect { x: 0.0, y: 48.0, width: 1920.0, height: 1032.0 };
    let icon = Rect { x: 900.0, y: 8.0, width: 24.0, height: 32.0 };
    assert_eq!(popup_origin(icon, work, PANEL), (912.0 - 180.0, 48.0));
}

#[test]
fn left_and_right_taskbars_open_beside_the_icon() {
    let work_l = Rect { x: 60.0, y: 0.0, width: 1860.0, height: 1080.0 };
    assert_eq!(popup_origin(Rect { x: 10.0, y: 900.0, width: 32.0, height: 24.0 }, work_l, PANEL), (60.0, 1080.0 - 560.0));
    let work_r = Rect { x: 0.0, y: 0.0, width: 1860.0, height: 1080.0 };
    assert_eq!(popup_origin(Rect { x: 1878.0, y: 100.0, width: 32.0, height: 24.0 }, work_r, PANEL), (1860.0 - 360.0, 0.0)); // centered would be -168, clamped to the top
}
```

  Rule the tests pin: the taskbar edge is the side of `icon` outside `work_area`; the panel sits flush against that edge of the work area, centered on the icon along the edge, clamped inside the work area.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; macOS keeps `panel_origin` unchanged.
- [ ] **Step 4: Run** — Expected: PASS. Manually: taskbar bottom and top, icon in overflow, light/dark taskbar, click-away closes, no taskbar button.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): open the panel beside the Windows tray icon"
```

### Task 5: `aiop` on Windows

**Files:**
- Create: `desktop/src/platform/windows/shell_path.rs`, `platform/windows/shell_path/tests.rs`
- Modify: `desktop/src/cli_command.rs` (Windows branch: probe and install via `shell_path`)

**Interfaces:**
- Produces: `path_with(value: &str, dir: &str) -> String` (appends `dir` unless an entry equals it case-insensitively, ignoring a trailing `\`; keeps every other entry byte-for-byte); `path_without(value: &str, dir: &str) -> String`; `shim_text(target: &Path) -> String` = `@"<target>" %*\r\n`; `effective_path() -> String` (registry HKLM + HKCU, expanded); Windows `install(target, probe)` writes `aiop.cmd` (and `aio-proxy.cmd` only when free), updates HKCU `Path` keeping its value type, broadcasts `WM_SETTINGCHANGE`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn appending_the_shims_dir_is_idempotent_and_preserves_other_entries() {
    let dir = r"C:\Users\Zoë Chen\AppData\Local\aio-proxy-desktop\bin\shims";
    let v = r"%USERPROFILE%\bin;C:\Tools;";
    let once = path_with(v, dir);
    assert_eq!(once, format!(r"%USERPROFILE%\bin;C:\Tools;{dir}"));
    assert_eq!(path_with(&once, &dir.to_uppercase()), once);
    assert_eq!(path_with(&format!("{once}\\"), dir), format!("{once}\\"));
    assert_eq!(path_without(&once, dir), r"%USERPROFILE%\bin;C:\Tools");
    assert_eq!(path_with("", dir), dir);
}
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS. Manually: install `aiop` from the panel → it reports installed immediately; a new terminal runs `aiop --version`.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): install the aiop command on Windows"
```

### Task 6: Windows end-to-end check

- [ ] **Step 1:** On Windows 11 with phase 1's CLI built: `cargo run --release` from `desktop/` with the sidecar beside the executable. Check: first run installs the task and starts the proxy; panel shows usage; Stop → relaunch app → still stopped; Restart; Kickstart of an external (CLI-installed) task; launch at login toggles the Run value; no console window appears at any point.
- [ ] **Step 2: Run** the desktop CI matrix — Expected: PASS on all three platforms. Nothing to commit if both pass.
