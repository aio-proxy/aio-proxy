# Windows and Linux Desktop — Phase 0: Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the four open platform questions the spec defers to phase 0, record the answers, and revise the spec where an answer contradicts it, before any product code is written.

**Architecture:** Throwaway probes on real machines. Nothing built here is kept: probe sources live under the scratch directory `spikes/` on a branch that is never merged; only `docs/superpowers/specs/2026-10-02-windows-linux-desktop-spike-findings.md` (and spec edits) are committed.

**Tech Stack:** Bun (`bun build --compile --target=bun-windows-x64`), `schtasks`, Windows 11 23H2+ desktop session (not a headless runner: console windows must be observed), `cargo-packager` NSIS output, `tray-icon` 0.25.1 with the `ksni` feature, GNOME and KDE sessions.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 4)

## Global Constraints

- Task path: `\AIO Proxy\aio-proxy-<current user SID>`; no admin rights anywhere.
- Task settings under test: logon trigger, `IgnoreNew`, no execution time limit, not stopped on battery, `RestartOnFailure` 1 minute × 3.
- Candidate hidden-console actions, in order: `conhost.exe --headless <exec> __service-run <spec>`; S4U logon type; a `--windows-hide-console` launcher.
- NSIS install mode: per-user into `%LOCALAPPDATA%\AIO Proxy\` (the template's fixed `currentUser` directory).
- Linux tray: `tray-icon` with `default-features = false, features = ["ksni"]`.

## Review Focus

- A non-ASCII, space-containing Windows profile path (`C:\Users\Zoë Chen\`): every spike action runs with the probe executable placed under such a path.
- A second Windows user on the same machine registering the same task name pattern.
- S4U and `conhost` variants: `%LOCALAPPDATA%` must resolve to the logged-in user's profile inside the task, or the desktop token path (spec 2b) breaks.
- GNOME on Wayland with the extension disabled mid-session (watcher name disappears).
- An interactive NSIS upgrade (running a newer installer by hand) versus the in-app Passive update.

---

### Task 1: Windows Task Scheduler probe

**Files:**
- Create (scratch, not merged): `spikes/task/probe.ts`, `spikes/task/task.xml`, `spikes/task/run.ps1`
- Create: `docs/superpowers/specs/2026-10-02-windows-linux-desktop-spike-findings.md` (section "Task Scheduler")

**Interfaces:**
- Produces: the chosen task action string and logon type, consumed by phase 1 Task 7 (`renderTaskXml`) and Task 9.

- [ ] **Step 1: Build the probe.** `probe.ts` with two modes: `probe.exe supervise <dir>` appends `supervisor <pid> <%LOCALAPPDATA%>` to `<dir>\log.txt`, spawns `probe.exe child <dir>` with `windowsHide: true` inside a kill-on-close Job Object (bun:ffi `CreateJobObjectW`, `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `AssignProcessToJobObject`), and waits; `child` appends a heartbeat line every second. Compile with `bun build --compile --target=bun-windows-x64 --outfile "C:\Users\Zoë Chen\spike\probe.exe"`.
- [ ] **Step 2: Variant A (`conhost --headless`).** Register `task.xml` with action `conhost.exe --headless "<probe.exe>" supervise "<dir>"`, run `schtasks /Run`. Record: console window visible (yes/no), log shows `%LOCALAPPDATA%` of the user.
- [ ] **Step 3: Variant B (S4U).** Same task with `<LogonType>S4U</LogonType>` as a standard user. Record: creation succeeds without elevation (yes/no), window visible, `%LOCALAPPDATA%` value, whether the task starts at logon.
- [ ] **Step 4: `/End` and the Job Object.** For the winning variant, `schtasks /End`, then `tasklist /FI "IMAGENAME eq probe.exe"`. Expected for a pass: no `probe.exe` left (child killed with the job).
- [ ] **Step 5: `RestartOnFailure` on a missing executable.** Rename `probe.exe` away, `schtasks /Run`, restore it after 20 s. Record whether Task Scheduler relaunches within ~1 minute and the task's Last Result codes.
- [ ] **Step 6: `/Create /F` on a running task.** While running, re-create with a different action. Record: running instance untouched (yes/no), next `/Run` uses the new action (yes/no), task enabled afterwards.
- [ ] **Step 7: Second user.** As another standard user, register `\AIO Proxy\aio-proxy-<their SID>`. Record: both tasks coexist; each user's `schtasks /Query /TN` sees its own.
- [ ] **Step 7b: `/HRESULT`.** `schtasks /Query /XML /TN "\AIO Proxy\does-not-exist" /HRESULT` — record the exit code (expected `0x80070002`) and that a valid query exits 0.
- [ ] **Step 8: Record the findings** in the findings doc: one table row per question with the observed result, the chosen variant, and the exact action string.
- [ ] **Step 9: Commit the findings doc only**

```bash
git add docs/superpowers/specs/2026-10-02-windows-linux-desktop-spike-findings.md
git commit -m "docs(desktop): record Task Scheduler spike findings"
```

### Task 2: cargo-packager NSIS probe

**Files:**
- Create (scratch): `spikes/nsis/` (a hello-world GPUI-free Rust binary with `[package.metadata.packager]`)
- Modify: findings doc (section "NSIS")

**Interfaces:**
- Produces: the hook mechanism (built-in hooks or a custom template path) and the condition that tells an upgrade's uninstaller run from a user uninstall, consumed by phase 5 Task 1.

- [ ] **Step 1: Package v0.0.1 and v0.0.2** of the hello binary with `cargo packager --formats nsis`, per-user install mode, a second resource file `aio-proxy.exe` (any small exe).
- [ ] **Step 2: Hooks.** Check the vendored `cargo-packager` NSIS template (`crates/packager/src/package/nsis/installer.nsi`) for pre-install / pre-uninstall hook points. Record whether a hook can run `"$INSTDIR\aio-proxy.exe" service uninstall` and edit HKCU.
- [ ] **Step 3: Upgrade versus uninstall.** Install v0.0.1, then run v0.0.2's installer interactively. Record the arguments and variables visible to v0.0.1's uninstaller during the upgrade (e.g. `/UPDATE`, `$UpdateMode`) versus a Control Panel uninstall. A pass names one condition that is true only for the user uninstall.
- [ ] **Step 4: Passive mode.** Run v0.0.2's installer the way `cargo-packager-updater` does (Passive) over a running v0.0.1. Record whether it closes the running app and relaunches it.
- [ ] **Step 5: Record and commit** the findings doc section.

```bash
git add docs/superpowers/specs/2026-10-02-windows-linux-desktop-spike-findings.md
git commit -m "docs(desktop): record NSIS spike findings"
```

### Task 3: Linux tray (`ksni`) probe

**Files:**
- Create (scratch): `spikes/tray/` (GPUI app from `gpui-kit` 0.7.0 + `tray-icon` 0.25.1 `ksni`, plus `zbus` watching `NameOwnerChanged` for `org.kde.StatusNotifierWatcher`)
- Modify: findings doc (section "Linux tray")

**Interfaces:**
- Produces: confirmed event behavior per desktop, consumed by phase 2 Tasks 7–8.

- [ ] **Step 1: Build** the probe printing every `TrayIconEvent` and `MenuEvent`, and every watcher owner change.
- [ ] **Step 2: Run** on KDE X11, KDE Wayland, GNOME + AppIndicator extension, Ubuntu default session. Record per session: left click → `Click` event (yes/no), right click → menu, menu items fire `MenuEvent`.
- [ ] **Step 3: Watcher changes.** On GNOME, disable then re-enable the extension while running. Record the `NameOwnerChanged` sequence and whether the tray icon reappears after re-enable without restarting.
- [ ] **Step 4: Window behavior.** Open a `WindowKind::Normal` window with `is_resizable: false` on GNOME Wayland; record server- vs client-side decorations and whether resizing is possible (expected per spec: client decorations, resizable).
- [ ] **Step 5: Record and commit** the findings doc section.

```bash
git add docs/superpowers/specs/2026-10-02-windows-linux-desktop-spike-findings.md
git commit -m "docs(desktop): record Linux tray spike findings"
```

### Task 4: Fold the findings into the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md`
- Modify (only if a finding changes them): `docs/superpowers/plans/2026-10-02-windows-linux-desktop-1-cli-core.md`, `-2-linux.md`, `-5-release.md`

- [ ] **Step 1:** For each finding that contradicts the spec (a variant fails, a hook is missing), edit the spec section it names and bump `Status:` to the next revision; list the changes at the end of the findings doc.
- [ ] **Step 2:** Update the affected plan steps: the action string in phase 1 Task 7, the uninstall condition in phase 5 Task 1, the tray handling in phase 2 Task 7.
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans
git commit -m "docs(desktop): apply phase 0 spike findings"
```
