# Desktop Client — Phase 2 (macOS app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `desktop/` Rust crate: a runnable, ad-hoc-signed Apple Silicon menu-bar app that discovers, installs and manages the aio-proxy launchd service under the spec's ownership rules and shows the summary panel, plus the unsigned bundle command that assembles and smoke-tests it.

**Architecture:** One Cargo package at `desktop/` (not a Bun workspace package) with a library (`src/lib.rs`: every module, pure logic unit-tested without GPUI or AppKit) and a thin binary (`src/main.rs`: GPUI application, lock, tray, wake observer). Decisions live in pure modules (`summary`, `connect::{discovery,policy,run}`, `client::{transport,refresh,health}`, `install`); GPUI/AppKit glue (`app/`, `tray`, `panel/`, `login_item`, `updater`) only moves work between the main thread and background threads and renders the `AppModel` global. `desktop/scripts/bundle.ts --unsigned` assembles `AIO Proxy.app` with the bundled sidecar and Sparkle, checks every Mach-O, runs the runtime smoke and ad-hoc signs it.

**Tech Stack:** Rust 1.98.1 (edition 2024), `gpui-kit =0.7.0` (GPUI `gpui-pre` 0.3.7), `tray-icon` 0.21.3 (`muda` 0.17.2), `objc2` 0.6.4 + `objc2-app-kit`/`objc2-foundation` 0.3.2 + `block2` 0.6.2, `serde`/`serde_json`, `semver`, `url`, `libc`, `futures`; Sparkle 2.10.0; Bun 1.4.2 for `desktop/scripts/*.ts`; mise for the local toolchain.

**Spec:** `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (rev 4) and `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md`. Phase 1 contracts consumed here: `packages/cli/src/desktop-connect/desktop-connect.ts`, `packages/cli/src/desktop-connect/launchd-inspect.ts`, `packages/types/src/desktop-summary/desktop-summary.ts` and its golden fixture `packages/types/src/desktop-summary/fixtures/v1.json`, `packages/server/src/dashboard-routes/desktop-summary/route.ts`.

**How this plan was checked:** every Rust file below was compiled against the real crates (registry sources of the pinned versions), and each task's end state passed `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` (103 tests at the end). The unsigned bundle ran end to end against a sidecar built from this branch (Mach-O checks, runtime smoke including `desktop-summary` 200, ad-hoc signing, signed host `--version`), and the bundled app started with Sparkle's updater and the wake observer. GPUI/AppKit behavior beyond startup (panel on screen, SMAppService, Sparkle UI, wake delivery) is covered only by the manual acceptance list in Task 15.

## Global Constraints

- Architecture `arm64` only: `cargo build --target aarch64-apple-darwin`; the host and the bundled sidecar must report exactly `arm64` from `lipo -archs`; Sparkle's Mach-Os must include `arm64` (2.10.0 ships them universal and they are kept as shipped).
- Minimum macOS **13.0**, one value everywhere: `desktop/.cargo/config.toml` sets `MACOSX_DEPLOYMENT_TARGET = "13.0"` (forced) for every cargo command, `LSMinimumSystemVersion` is `13.0`, and the bundle step checks every Mach-O's `vtool -show-build` `minos` is ≤ 13.0 (sidecar 13.0, Sparkle 12.0 measured). `sparkle:minimumSystemVersion` in the appcast is Phase 3.
- `gpui-kit = "=0.7.0"` is pinned exactly (it pins an exact `gpui-pre` snapshot); bump it deliberately.
- Sparkle **2.10.0**, archive `Sparkle-2.10.0.tar.xz`, SHA-256 **`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`**, extracted with `tar -xJf`, copied into the bundle with `ditto`. `Info.plist` sets `SUAllowsAutomaticUpdates` to `false` and never sets `SUAutomaticallyUpdate`; updates install only through Sparkle's "Install and Relaunch".
- Footprint budget: panel closed physical footprint ≤ 40 MB (Activity Monitor "Memory", not RSS) with ≤ 1 idle interrupt wakeup/s. Hybrid window lifecycle (destroy the window, keep the model) with `NSWindowAnimationBehaviorNone`; hide/show is not allowed (fails the closed budget).
- Local HTTP transport: std `TcpStream` HTTP/1.1 on its own thread (no async runtime, no `reqwest`); plain HTTP to `127.0.0.1`/`::1` only; no proxy settings ever read; no redirects followed; connect timeout 1 s; one 5 s total deadline over the whole request (not a per-read timeout); decodes `Transfer-Encoding: chunked`; response capped at 4 MiB; dropping a pending request shuts its socket.
- Token: attached only as `Authorization: Bearer` on a request whose URL is a literal loopback IP, never as a default header; the `Token` type's `Debug` is redacted; the app never logs `__desktop-connect` stdout or `Authorization`; error strings built from discovery never include stdout.
- Environment contract: `__desktop-connect` and every `aio-proxy service …` command run with `AIO_PROXY_DESKTOP_EXEC=<~/Library/Application Support/aio-proxy-desktop/bin/aio-proxy>`, through the symlink when it resolves, else the bundle's sidecar. The app removes inherited `AIO_PROXY_HOME`, `AIO_PROXY_MANAGED` and `XPC_SERVICE_NAME` from those children and sets `AIO_PROXY_HOME` to the plist's `unit.home` for service commands when the plist names one.
- Automation: only when the install location is persistent (`/Applications` or `~/Applications`, writable volume, no newer copy owning the symlink) and `owner: desktop` with `matchesJob: true` or no reachable instance (`matchesJob: null` counts as not matching); the fresh-install row additionally requires that nothing answers the control address. `job.disabled` means nothing happens. Each automatic row runs at most once per app launch; a failure shows the error and never retries. Every mutation re-runs `__desktop-connect` first and aborts if `unit.owner`, `instance.matchesJob` or `job.disabled` changed. Never downgrade.
- Ownership table: Start = `service start` (desktop and external); Restart = `service restart` for desktop, `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent` for external (never `service restart`, which rewrites the plist); Stop = `service stop`; unknown owner or no plist: no service buttons. Reload = `POST /admin/reload` (loopback, no auth) for any reachable instance.
- Completion: Restart waits up to 30 s for the pre-restart `instance.pid` to be gone and `/health` to report the expected version (`bundledVersion` for desktop; any version for external); Stop waits up to 30 s for `job.pid == null` and the instance unreachable; Reload reports the response (`409` carries `error` and `stage`). Then the panel refetches.
- Health: `GET /health` with a 2 s total deadline, every 60 s plus on panel open and on `NSWorkspaceDidWakeNotification`; two consecutive failures mark the proxy down; a transition updates the icon and triggers rediscovery and nothing else.
- Refresh: at most one summary request in flight; panel open, user action, manual refresh and a post-401 rediscovery bypass the 15 s floor; ticks do not; any `loading` quota gets one shared refetch after 2 s; manual refresh sends `?refresh=true`; closing the panel cancels the request and all timers; responses are tagged (session, instance, counter) and stale ones discarded. A 401 re-runs discovery once, then shows "authentication failed" and never restarts the proxy.
- Single instance: exclusive `flock` on `~/Library/Application Support/aio-proxy-desktop/instance.lock`; a second copy exits 0. No-downgrade: re-point the symlink only when its target is missing or `<target> --version` proves it is not newer; an unreadable version counts as "do not touch". Re-pointing is create-temp-symlink + `rename`.
- `LSUIElement` in `Info.plist`, and `NSApplicationActivationPolicyAccessory` set inside GPUI's `run` callback (GPUI forces Regular at launch).
- App version = `version` of `npm/aio-proxy/package.json` (build.rs → `AIO_PROXY_VERSION`; bundle.ts → `CFBundleShortVersionString` and `CFBundleVersion`). `CFBundleIdentifier` is `com.aio-proxy.desktop` and must never change (Sparkle and SMAppService key on it).
- Every handwritten non-test file stays under 500 lines (largest here: `client/transport.rs`, 386). Rust tests live next to their module as `foo.rs` + `foo/tests.rs` (`#[cfg(test)] mod tests;`); TypeScript as `foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`.
- Rust test files that sit under a module importing `gpui_kit::*` must not `use super::*`: that glob brings gpui's own `test` attribute, which shadows the built-in one (compile error "recursion limit reached while expanding `#[test]`"). Import the needed names explicitly.
- oxfmt formats TOML and YAML too: after editing `desktop/Cargo.toml`, `desktop/rust-toolchain.toml`, `desktop/.cargo/config.toml`, `mise.toml` or `.github/workflows/ci.yml`, run `bun run format` (the files below are already in its style; `Cargo.lock` and `.rs` files are not touched by it).
- Rust commands run from `desktop/` through the pinned toolchain (`desktop/rust-toolchain.toml`; rustup honors it, and `mise exec -- cargo …` works after `mise trust`). `desktop/` is not a Bun workspace package; desktop changesets target `aio-proxy`.
- Do not run anything that installs or changes the real `com.aio-proxy.agent` job or `~/.aio-proxy` during Tasks 1–14. Only Task 15's manual acceptance does that, preferably in a separate macOS user account.

## Review Focus

These are the inputs most likely to bite a real user that the spec does not spell out; each has a pinned test in the owning task.

1. A desktop-owned service whose plist names a non-default `AIO_PROXY_HOME`: an app-issued `service restart` would rewrite the plist to `~/.aio-proxy` unless the child gets the plist's home. Pinned by `service_commands_carry_the_plist_home` (Task 8, `connect/run/tests.rs`) and `a_service_command_carries_the_plist_home` (Task 8, `connect/cli/tests.rs`).
2. `__desktop-connect` stdout that is not exactly one clean object (empty, a crash message, two objects, a failing exit with partial JSON): it must be a discovery error, never "no plist" (which would trigger a fresh install), and the error must not echo stdout. Pinned by `rejects_another_protocol_version_and_non_json`, `every_other_owner_shape_fails_closed_to_unknown` (Task 3) and `discovery_reads_the_childs_stdout_and_reports_failures_without_it` (Task 8).
3. No plist, but a hand-started `aio-proxy run` already answers the control address: installing a service would fight it for the port, so nothing automatic may happen. Pinned by `no_plist_with_a_hand_started_instance_on_the_port_is_left_alone` (Task 7).
4. The symlink points at another installed copy whose `--version` cannot be read (crashed, corrupt, prints an error): that copy may be newer, so it must not be re-pointed. Pinned by `an_unreadable_installed_copy_is_left_alone` (Task 6) and `reads_the_version_line_from_cli_output` (Task 1).
5. The app launched in an environment that carries launchd markers (`AIO_PROXY_MANAGED=1`, `XPC_SERVICE_NAME`) or the user's `AIO_PROXY_HOME`: `service restart` would take the in-job detached helper path, or discovery would read the wrong home. Pinned by `every_cli_child_gets_the_symlink_marker_and_no_inherited_home` (Task 8).

---

## File Structure

```text
mise.toml                                   # local toolchain: Bun from .bun-version, Rust from desktop/rust-toolchain.toml
desktop/
├── Cargo.toml, Cargo.lock                  # binary + library crate `aio-proxy-desktop`
├── rust-toolchain.toml, rustfmt.toml, .cargo/config.toml
├── build.rs                                # AIO_PROXY_VERSION; ServiceManagement; Sparkle link + rpath when SPARKLE_DIR is set
├── entitlements/{aio-proxy.plist,adhoc-host.plist}
├── scripts/                                # bun run desktop:bundle --unsigned
│   ├── bundle.ts, tsconfig.json
│   ├── info-plist/{index.ts,info-plist.ts,info-plist.test.ts}
│   ├── macho/{index.ts,macho.ts,macho.test.ts}
│   ├── smoke/{index.ts,smoke.ts}
│   └── sparkle/{index.ts,sparkle.ts}
└── src/
    ├── main.rs                             # GPUI app, lock, tray, wake observer, --version
    ├── lib.rs
    ├── version.rs          (+ version/tests.rs)
    ├── summary.rs          (+ summary/tests.rs)        # DesktopSummaryV1, version-first parsing, degraded selection
    ├── token.rs                                         # redacting Token
    ├── process.rs          (+ process/tests.rs)         # helper processes with a hard timeout
    ├── install.rs          (+ install/tests.rs)         # location policy, symlink, no-downgrade, lock
    ├── connect.rs
    ├── connect/discovery.rs (+ discovery/{tests.rs,fixture.rs})
    ├── connect/policy.rs    (+ policy/tests.rs)         # automatic + user action tables, completion conditions
    ├── connect/run.rs       (+ run/tests.rs)            # fresh discovery → precondition → mutation → wait
    ├── connect/cli.rs       (+ cli/tests.rs)            # the real Host: CLI, launchctl, transport
    ├── client.rs
    ├── client/transport.rs  (+ transport/tests.rs)
    ├── client/refresh.rs    (+ refresh/tests.rs)
    ├── client/health.rs     (+ health/tests.rs)
    ├── log.rs
    ├── tray.rs              (+ tray/tests.rs)
    ├── app.rs, app/{lifecycle.rs,refresh.rs,health.rs}  # AppModel global + GPUI glue
    ├── panel.rs, panel/{window.rs,view.rs,actions.rs,degraded.rs,footer.rs,charts.rs,providers.rs,status.rs,format.rs,placement.rs}
    │                        (+ tests for placement, status, format, charts, providers)
    ├── login_item.rs
    └── updater.rs
```

Spec module table mapping: `connect.rs` → `connect/{discovery,policy,run,cli}.rs`; `client.rs` → `client/{transport,refresh,health}.rs`. Added modules: `app/` (the app-level model that outlives the panel window), `token.rs`, `process.rs`, `version.rs`, `log.rs`.


### Task 1: Toolchain, crate skeleton, version rules, Rust CI job

**Files:**
- Create: `mise.toml`, `desktop/rust-toolchain.toml`, `desktop/rustfmt.toml`, `desktop/.cargo/config.toml`, `desktop/Cargo.toml`, `desktop/Cargo.lock` (generated), `desktop/build.rs`, `desktop/src/lib.rs`, `desktop/src/main.rs`, `desktop/src/version.rs`
- Modify: `.gitignore`, `oxc.ts`, `.github/workflows/ci.yml`
- Test: `desktop/src/version/tests.rs`

**Interfaces:**
- Consumes: `npm/aio-proxy/package.json` `version` (the product package; lockstep through Changesets).
- Produces: `aio_proxy_desktop::version::{APP_VERSION: &str, compare(a: &str, b: &str) -> Option<std::cmp::Ordering>, parse_version_output(stdout: &str) -> Option<String>}`; build-time env `AIO_PROXY_VERSION`; the `aio-proxy-desktop` binary answering `--version`; CI job `rust`.

- [ ] **Step 1: Write the failing test**

Create the toolchain and crate files first (they carry no logic):

`mise.toml` (repository root):

```toml
# Local toolchain. Each tool keeps one version source, and CI reads the same files:
# Bun from .bun-version, Rust from desktop/rust-toolchain.toml (active under desktop/).
[settings]
idiomatic_version_file_enable_tools = ["bun", "rust"]
```

`desktop/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.98.1"
components = ["rustfmt", "clippy"]
targets = ["aarch64-apple-darwin"]
profile = "minimal"
```

`desktop/rustfmt.toml` (matches the repository's 120-column style):

```toml
max_width = 120
use_small_heuristics = "Max"
```

`desktop/.cargo/config.toml`:

```toml
[env]
# One deployment target for every cargo command; LSMinimumSystemVersion and the bundle minos check use the same 13.0.
MACOSX_DEPLOYMENT_TARGET = { value = "13.0", force = true }
```

`desktop/Cargo.toml`:

```toml
[package]
name = "aio-proxy-desktop"
# The shipped version comes from npm/aio-proxy/package.json (build.rs); this one is never published.
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
# GPUI Kit pins an exact gpui-pre snapshot; bump this deliberately.
gpui-kit = "=0.7.0"
tray-icon = "0.21.3"
objc2 = "0.6.4"
objc2-app-kit = { version = "0.3.2", features = [
  "NSApplication",
  "NSButton",
  "NSControl",
  "NSResponder",
  "NSScreen",
  "NSStatusBarButton",
  "NSStatusItem",
  "NSView",
  "NSWindow",
  "NSWorkspace",
] }
objc2-foundation = { version = "0.3.2", features = [
  "NSArray",
  "NSBundle",
  "NSDictionary",
  "NSError",
  "NSNotification",
  "NSOperation",
  "NSString",
  "NSURL",
  "NSValue",
  "block2",
] }
block2 = "0.6.2"
raw-window-handle = "0.6.2"
futures = "0.3.34"
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
semver = "1.0.28"
url = "2.5.8"
libc = "0.2.189"

[dev-dependencies]
tempfile = "3.27.0"

[build-dependencies]
serde_json = "1.0.151"

[profile.release]
lto = "thin"
```

The objc2 feature lists name what the code uses; both crates' default features already enable every feature (checked in the registry sources: `objc2-foundation-0.3.2/Cargo.toml` and `objc2-app-kit-0.3.2/Cargo.toml` `default = [...]`), so the lists document intent and cannot silently drop a binding.

`desktop/build.rs`:

```rust
// The app's version is the product package's: CFBundleShortVersionString, `--version` and the
// no-downgrade rule all read this one value, so it cannot drift from the bundled sidecar.
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let package = manifest.join("../npm/aio-proxy/package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let text = fs::read_to_string(&package).expect("read npm/aio-proxy/package.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse npm/aio-proxy/package.json");
    let version = json["version"].as_str().expect("npm/aio-proxy/package.json has a string version");
    println!("cargo:rustc-env=AIO_PROXY_VERSION={version}");
}
```

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod version;
```

`desktop/src/main.rs`:

```rust
use aio_proxy_desktop::version::APP_VERSION;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{APP_VERSION}");
        return;
    }
    // Replaced by the GPUI menu-bar app in Task 10.
    eprintln!("aio-proxy-desktop {APP_VERSION}: only --version is available in this build");
    std::process::exit(64);
}
```

Create `desktop/src/version.rs` with only the test hook:

```rust
#[cfg(test)]
mod tests;
```

and the test:

`desktop/src/version/tests.rs`:

```rust
use std::cmp::Ordering;

use super::*;

#[test]
fn compares_by_semver_precedence_not_string_order() {
    assert_eq!(compare("0.9.0", "0.10.0"), Some(Ordering::Less));
    assert_eq!(compare("0.36.0", "0.37.0"), Some(Ordering::Less));
    assert_eq!(compare("0.37.0", "0.37.0"), Some(Ordering::Equal));
    assert_eq!(compare("1.0.0", "0.99.9"), Some(Ordering::Greater));
}

#[test]
fn a_prerelease_is_older_than_its_release() {
    assert_eq!(compare("0.37.0-canary.20260930", "0.37.0"), Some(Ordering::Less));
}

#[test]
fn an_unparsable_version_is_unknown_not_older() {
    assert_eq!(compare("garbage", "0.37.0"), None);
    assert_eq!(compare("0.37.0", ""), None);
}

#[test]
fn reads_the_version_line_from_cli_output() {
    assert_eq!(parse_version_output("0.37.0\n").as_deref(), Some("0.37.0"));
    assert_eq!(parse_version_output("Unexpected internal error\n"), None);
    assert_eq!(parse_version_output(""), None);
}

#[test]
fn app_version_is_a_valid_semver() {
    assert!(semver::Version::parse(APP_VERSION).is_ok(), "build.rs read {APP_VERSION:?}");
}
```

Append to `.gitignore`:

```gitignore

# desktop app build outputs and the downloaded Sparkle archive
desktop/target/
desktop/vendor/
```

In `oxc.ts`, add two entries to `ignorePatterns` right after `'packages/ui/src/components/**',`:

```ts
  // Cargo output and the downloaded Sparkle archive.
  'desktop/target/**',
  'desktop/vendor/**',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib version` (with mise instead of rustup: `mise trust` once at the root, then `cd desktop && mise exec -- cargo test --lib version`)
Expected: FAIL to compile with `` error[E0425]: cannot find function `compare` in this scope `` (and the same for `parse_version_output` and `APP_VERSION`). The first run downloads the pinned toolchain and every crate, and writes `desktop/Cargo.lock`.

- [ ] **Step 3: Implement**

`desktop/src/version.rs`:

```rust
//! aio-proxy version rules: semver precedence, never string order ("0.10.0" is newer than "0.9.0").

use std::cmp::Ordering;

/// This app's version, which is also its bundled sidecar's (both come from npm/aio-proxy/package.json).
pub const APP_VERSION: &str = env!("AIO_PROXY_VERSION");

/// Compares two versions by semver precedence. `None` when either side does not parse, which every
/// caller treats as "unknown": never as older, so an unreadable version can never cause a downgrade.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let a = semver::Version::parse(a.trim()).ok()?;
    let b = semver::Version::parse(b.trim()).ok()?;
    Some(a.cmp_precedence(&b))
}

/// Parses `aio-proxy --version` stdout, which is the bare version on one line.
pub fn parse_version_output(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    semver::Version::parse(line).ok().map(|_| line.to_string())
}

#[cfg(test)]
mod tests;
```

Add the Rust job to `.github/workflows/ci.yml`, after the existing `preflight-and-unit` job (same indentation level under `jobs:`). The crate only builds on macOS, so a cheap Linux job decides whether it needs to run; besides `desktop/`, the crate reads the product version and the shared golden fixture.

```yaml
  desktop-changes:
    if: github.event_name == 'push' || !github.event.pull_request.draft
    runs-on: ubuntu-latest
    outputs:
      rust: ${{ steps.diff.outputs.rust }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: diff
        env:
          BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
        run: |
          paths="desktop npm/aio-proxy/package.json packages/types/src/desktop-summary/fixtures"
          if [ -z "$BASE" ] || ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
            echo "rust=true" >> "$GITHUB_OUTPUT"
          elif git diff --quiet "$BASE...HEAD" -- $paths; then
            echo "rust=false" >> "$GITHUB_OUTPUT"
          else
            echo "rust=true" >> "$GITHUB_OUTPUT"
          fi

  rust:
    needs: desktop-changes
    if: needs.desktop-changes.outputs.rust == 'true'
    runs-on: macos-15
    defaults:
      run:
        working-directory: desktop
    steps:
      - uses: actions/checkout@v7
      - name: Install the pinned Rust toolchain
        run: |
          channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
          rustup toolchain install "$channel" --profile minimal --component rustfmt,clippy --target aarch64-apple-darwin
      - uses: actions/cache@v6
        with:
          path: |
            ~/.cargo/registry/index
            ~/.cargo/registry/cache
            ~/.cargo/git/db
            desktop/target
          key: ${{ runner.os }}-desktop-${{ hashFiles('desktop/rust-toolchain.toml', 'desktop/Cargo.lock') }}
          restore-keys: |
            ${{ runner.os }}-desktop-
      - run: cargo fmt --check
      - run: cargo clippy --locked --all-targets -- -D warnings
      - run: cargo test --locked
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo run -- --version`
Expected: fmt and clippy silent apart from the known `block v0.1.6` future-incompatibility note; `test result: ok. 5 passed`; `--version` prints the `version` from `npm/aio-proxy/package.json` (for example `0.35.1`).
Run: `bun run format:check && bun run lint`
Expected: both pass (the new ignore patterns keep `desktop/target` out).

- [ ] **Step 5: Commit**

```bash
git add mise.toml .gitignore oxc.ts .github/workflows/ci.yml desktop/rust-toolchain.toml desktop/rustfmt.toml desktop/.cargo/config.toml desktop/Cargo.toml desktop/Cargo.lock desktop/build.rs desktop/src/lib.rs desktop/src/main.rs desktop/src/version.rs desktop/src/version/tests.rs
git commit -m "feat(desktop): add the desktop crate skeleton, toolchain and Rust CI job"
```

### Task 2: `DesktopSummaryV1` parsing and degraded-panel selection

**Files:**
- Create: `desktop/src/summary.rs`
- Modify: `desktop/src/lib.rs`
- Test: `desktop/src/summary/tests.rs` (reads the golden fixture `packages/types/src/desktop-summary/fixtures/v1.json` through `CARGO_MANIFEST_DIR/..`)

**Interfaces:**
- Consumes: the wire shape in `packages/types/src/desktop-summary/desktop-summary.ts` (counts are decimal strings; `label` is a string or a `{ default, … }` map; every object is strict on the server, lenient here).
- Produces (`aio_proxy_desktop::summary`): `SummaryV1 { generated_at: String, server: ServerInfo { version: String, pid: u32, ppid: Option<u32> }, usage24h: Usage24h { requests, failed_requests, input_tokens, output_tokens, estimated_cost_nano_usd: u128, pricing_coverage: Option<f64> }, trend7d: Vec<TrendBucket { start: String, requests, total_tokens, estimated_cost_nano_usd: u128 }>, activity: Vec<ActivityDay { date: String, total_tokens: u128 }>, providers: Vec<Provider { id, name: String, enabled: bool, state: ProviderState, diagnostic: Option<Diagnostic { code, summary }>, quota: Quota }>, alerts: Vec<Alert { provider_id, kind: AlertKind, message }> }`; `SummaryV1::any_quota_loading(&self) -> bool`; `ProviderState::{Ok, Degraded, Unavailable, Disabled, Unknown}`; `Quota::{None, Unsupported, Loading, Failed, Ready { sampled_at: String, refresh_failed: bool, windows: Vec<QuotaWindow> }, Unknown}`; `QuotaWindow { id: String, label: LocalizedText, remaining_ratio: Option<f64>, resets_at: Option<String>, window_minutes: Option<u32> }`; `LocalizedText::text(&self) -> &str`; `AlertKind::{Diagnostic, QuotaExhausted, Unknown}`; `parse(body: &[u8]) -> Parsed { V1(Box<SummaryV1>), Unsupported(Option<u64>), Invalid(String) }`; `DegradedReason::{Missing, UnsupportedVersion(Option<u64>)}`; `FetchOutcome::{Summary(Box<SummaryV1>), Degraded(DegradedReason), Unauthorized, Failed(String)}`; `classify(status: u16, body: &[u8]) -> FetchOutcome`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/summary.rs` with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod summary;
pub mod version;
```

`desktop/src/summary/tests.rs`:

```rust
use super::*;

const GOLDEN: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/types/src/desktop-summary/fixtures/v1.json"));

fn v1(body: &str) -> SummaryV1 {
    match parse(body.as_bytes()) {
        Parsed::V1(summary) => *summary,
        other => panic!("expected v1, got {other:?}"),
    }
}

#[test]
fn the_golden_fixture_parses() {
    let summary = v1(GOLDEN);
    assert_eq!(summary.server.version, "0.36.0");
    assert_eq!(summary.server.ppid, Some(4310));
    assert_eq!(summary.usage24h.requests, 257);
    assert_eq!(summary.usage24h.estimated_cost_nano_usd, 20_521_353_840);
    assert_eq!(summary.trend7d.len(), 1);
    assert_eq!(summary.activity[0].date, "2026-09-29");
    let codex = &summary.providers[0];
    assert_eq!(codex.state, ProviderState::Ok);
    let Quota::Ready { windows, refresh_failed, .. } = &codex.quota else {
        panic!("codex quota should be ready");
    };
    assert!(!refresh_failed);
    assert_eq!(windows[0].label.text(), "5 hours");
    assert_eq!(windows[0].remaining_ratio, Some(0.4));
    assert!(matches!(summary.providers[1].quota, Quota::Loading));
    assert_eq!(summary.alerts[0].kind, AlertKind::Diagnostic);
    assert!(summary.any_quota_loading());
}

#[test]
fn unknown_fields_are_ignored_everywhere() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["futureTopLevel"] = serde_json::json!({ "x": 1 });
    json["server"]["startedAt"] = serde_json::json!("2026-09-29T00:00:00Z");
    json["providers"][0]["quota"]["windows"][0]["futureField"] = serde_json::json!(true);
    json["providers"][1]["quota"]["hint"] = serde_json::json!("warming");
    let summary = v1(&json.to_string());
    assert!(matches!(summary.providers[1].quota, Quota::Loading));
}

#[test]
fn unknown_enum_values_map_to_unknown() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["providers"][0]["state"] = serde_json::json!("rate_limited");
    json["providers"][1]["quota"] = serde_json::json!({ "status": "throttled", "retryAt": "soon" });
    json["alerts"][0]["kind"] = serde_json::json!("budget_warning");
    let summary = v1(&json.to_string());
    assert_eq!(summary.providers[0].state, ProviderState::Unknown);
    assert!(matches!(summary.providers[1].quota, Quota::Unknown));
    assert_eq!(summary.alerts[0].kind, AlertKind::Unknown);
}

#[test]
fn an_unsupported_protocol_version_selects_the_degraded_panel() {
    let body = br#"{ "protocolVersion": 2, "usage": "a shape v1 cannot read" }"#;
    assert!(matches!(classify(200, body), FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(Some(2)))));
    assert!(matches!(
        classify(200, br#"{ "status": "ok" }"#),
        FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(None))
    ));
}

#[test]
fn a_missing_route_selects_the_degraded_panel() {
    assert!(matches!(classify(404, b"Not Found"), FetchOutcome::Degraded(DegradedReason::Missing)));
}

#[test]
fn unauthorized_and_server_errors_are_distinct_outcomes() {
    assert!(matches!(classify(401, br#"{"error":"unauthorized"}"#), FetchOutcome::Unauthorized));
    assert!(matches!(classify(500, b""), FetchOutcome::Failed(_)));
    assert!(matches!(classify(200, b"<html>"), FetchOutcome::Failed(_)));
}

#[test]
fn a_count_beyond_2_pow_53_survives() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["usage24h"]["inputTokens"] = serde_json::json!("18014398509481985");
    assert_eq!(v1(&json.to_string()).usage24h.input_tokens, 18_014_398_509_481_985);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib summary`
Expected: FAIL to compile: `` error[E0425]: cannot find function `parse` in this scope ``, `` cannot find type `SummaryV1` ``, `` cannot find function `classify` ``.

- [ ] **Step 3: Implement**

`desktop/src/summary.rs`:

```rust
//! `DesktopSummaryV1` (packages/types/src/desktop-summary) as the app reads it: `protocolVersion`
//! first, unknown fields ignored, unknown enum values mapped to `Unknown`.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryV1 {
    pub generated_at: String,
    pub server: ServerInfo,
    pub usage24h: Usage24h,
    #[serde(default)]
    pub trend7d: Vec<TrendBucket>,
    #[serde(default)]
    pub activity: Vec<ActivityDay>,
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub pid: u32,
    #[serde(default)]
    pub ppid: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage24h {
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub failed_requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub input_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub output_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
    pub pricing_coverage: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendBucket {
    pub start: String,
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub total_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDay {
    pub date: String,
    #[serde(deserialize_with = "decimal")]
    pub total_tokens: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub state: ProviderState,
    pub diagnostic: Option<Diagnostic>,
    pub quota: Quota,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderState {
    Ok,
    Degraded,
    Unavailable,
    Disabled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Quota {
    None,
    Unsupported,
    Loading,
    Failed,
    Ready {
        #[serde(rename = "sampledAt")]
        sampled_at: String,
        #[serde(rename = "refreshFailed")]
        refresh_failed: bool,
        windows: Vec<QuotaWindow>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub label: LocalizedText,
    pub remaining_ratio: Option<f64>,
    pub resets_at: Option<String>,
    pub window_minutes: Option<u32>,
}

/// A label is either plain text or a map of language tags that always carries `default`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum LocalizedText {
    Plain(String),
    Localized(BTreeMap<String, String>),
}

impl LocalizedText {
    /// The panel is English-only, so it shows the `default` entry.
    pub fn text(&self) -> &str {
        match self {
            LocalizedText::Plain(text) => text,
            LocalizedText::Localized(map) => {
                map.get("default").or_else(|| map.values().next()).map_or("", String::as_str)
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub provider_id: String,
    pub kind: AlertKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Diagnostic,
    QuotaExhausted,
    #[serde(other)]
    Unknown,
}

impl SummaryV1 {
    /// Drives the refresh policy's one shared refetch after 2 s.
    pub fn any_quota_loading(&self) -> bool {
        self.providers.iter().any(|p| matches!(p.quota, Quota::Loading))
    }
}

/// Counts are decimal integer strings on the wire (they can exceed 2^53).
fn decimal<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
    let text = String::deserialize(deserializer)?;
    text.parse::<u128>().map_err(serde::de::Error::custom)
}

#[derive(Debug)]
pub enum Parsed {
    V1(Box<SummaryV1>),
    /// A `protocolVersion` this app does not know (or none at all): degraded panel.
    Unsupported(Option<u64>),
    Invalid(String),
}

/// Reads `protocolVersion` before anything else, so a future body shape never reaches the v1 parser.
pub fn parse(body: &[u8]) -> Parsed {
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<serde_json::Value>,
    }
    let probe: Probe = match serde_json::from_slice(body) {
        Ok(probe) => probe,
        Err(error) => return Parsed::Invalid(error.to_string()),
    };
    match probe.protocol_version.as_ref().and_then(serde_json::Value::as_u64) {
        Some(1) => match serde_json::from_slice::<SummaryV1>(body) {
            Ok(summary) => Parsed::V1(Box::new(summary)),
            Err(error) => Parsed::Invalid(error.to_string()),
        },
        other => Parsed::Unsupported(other),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DegradedReason {
    /// 404: an instance older than `desktop-summary`.
    Missing,
    UnsupportedVersion(Option<u64>),
}

#[derive(Debug)]
pub enum FetchOutcome {
    Summary(Box<SummaryV1>),
    Degraded(DegradedReason),
    /// 401: re-run discovery once to pick up a replaced token, then report "authentication failed".
    Unauthorized,
    Failed(String),
}

/// Maps one `GET /dashboard/api/desktop-summary` response to what the panel shows.
pub fn classify(status: u16, body: &[u8]) -> FetchOutcome {
    match status {
        200 => match parse(body) {
            Parsed::V1(summary) => FetchOutcome::Summary(summary),
            Parsed::Unsupported(version) => FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(version)),
            Parsed::Invalid(error) => FetchOutcome::Failed(format!("invalid desktop summary: {error}")),
        },
        401 => FetchOutcome::Unauthorized,
        404 => FetchOutcome::Degraded(DegradedReason::Missing),
        other => FetchOutcome::Failed(format!("desktop summary answered HTTP {other}")),
    }
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib summary && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 7 passed`; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/summary.rs desktop/src/summary/tests.rs
git commit -m "feat(desktop): parse the desktop summary version-first"
```

### Task 3: Redacting token and `__desktop-connect` parsing

**Files:**
- Create: `desktop/src/token.rs`, `desktop/src/connect.rs`, `desktop/src/connect/discovery.rs`, `desktop/src/connect/discovery/fixture.rs`
- Modify: `desktop/src/lib.rs`
- Test: `desktop/src/connect/discovery/tests.rs`, the test module inside `desktop/src/token.rs`

**Interfaces:**
- Consumes: the JSON printed by `packages/cli/src/desktop-connect/desktop-connect.ts` (`printDesktopConnect`: exactly one line; `failedDiscovery` reports `owner: "unknown"`; `readJob` fails closed to `disabled: true`).
- Produces: `aio_proxy_desktop::token::Token { new(impl Into<String>) -> Token, expose(&self) -> &str }` (redacted `Debug`, no `Display`); `aio_proxy_desktop::connect::discovery::{Owner::{Desktop, External, Unknown, NoPlist}, Unit { present: bool, wrapper_valid: bool, target: Option<String>, home: Option<String>, owner: Owner }, Job { loaded: bool, disabled: bool, pid: Option<u32> }, Instance { control_url: Option<String>, dashboard_url: Option<String>, reachable: bool, version: Option<String>, pid: Option<u32>, ppid: Option<u32>, matches_job: Option<bool> }, Discovery { bundled_version: String, unit: Unit, job: Job, instance: Instance, token: Option<Token> }, parse_discovery(stdout: &[u8]) -> Result<Discovery, String>}`; test-only `connect::discovery::fixture::{SPEC_EXAMPLE: &str, discovery_with(patch: impl FnOnce(&mut serde_json::Value)) -> Result<Discovery, String>}`.

- [ ] **Step 1: Write the failing test**

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod connect;
pub mod summary;
pub mod token;
pub mod version;
```

`desktop/src/connect.rs`:

```rust
//! `__desktop-connect` discovery, the automatic-action table, and user actions with their
//! completion conditions. Everything that changes the service goes through here.

pub mod discovery;
```

Create `desktop/src/token.rs` with only its test module (the implementation replaces the file in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::Token;

    #[test]
    fn debug_output_is_redacted() {
        let token = Token::new("s3cr3t-desktop-token");
        let printed = format!("{token:?} {:?}", Some(&token));
        assert!(!printed.contains("s3cr3t"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }
}
```

Create `desktop/src/connect/discovery.rs` with only:

```rust
#[cfg(test)]
pub(crate) mod fixture;
#[cfg(test)]
mod tests;
```

`desktop/src/connect/discovery/fixture.rs`:

```rust
//! A `__desktop-connect` result shared by the connect tests: the spec's example, patched per case.

use super::{Discovery, parse_discovery};

pub(crate) const SPEC_EXAMPLE: &str = r#"{
  "protocolVersion": 1,
  "bundledVersion": "0.37.0",
  "unit": {
    "present": true,
    "wrapperValid": true,
    "target": "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
    "home": "/Users/me/.aio-proxy",
    "owner": "desktop"
  },
  "job": { "loaded": true, "disabled": false, "pid": 4310 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "ppid": 4310,
    "matchesJob": true
  },
  "token": "tok-abc"
}
"#;

/// The spec example with `patch` applied to its JSON before parsing.
pub(crate) fn discovery_with(patch: impl FnOnce(&mut serde_json::Value)) -> Result<Discovery, String> {
    let mut value: serde_json::Value = serde_json::from_str(SPEC_EXAMPLE).expect("fixture is JSON");
    patch(&mut value);
    parse_discovery(value.to_string().as_bytes())
}
```

`desktop/src/connect/discovery/tests.rs`:

```rust
use super::fixture::{SPEC_EXAMPLE, discovery_with as with};
use super::*;

#[test]
fn parses_the_spec_example() {
    let d = parse_discovery(SPEC_EXAMPLE.as_bytes()).unwrap();
    assert_eq!(d.bundled_version, "0.37.0");
    assert_eq!(d.unit.owner, Owner::Desktop);
    assert_eq!(d.unit.home.as_deref(), Some("/Users/me/.aio-proxy"));
    assert_eq!(d.job.pid, Some(4310));
    assert!(!d.job.disabled);
    assert_eq!(d.instance.matches_job, Some(true));
    assert_eq!(d.token.as_ref().map(Token::expose), Some("tok-abc"));
}

#[test]
fn owner_null_without_a_plist_is_the_only_fresh_install_signal() {
    let d = with(|v| {
        v["unit"] =
            serde_json::json!({ "present": false, "wrapperValid": false, "target": null, "home": null, "owner": null });
    })
    .unwrap();
    assert_eq!(d.unit.owner, Owner::NoPlist);
}

#[test]
fn every_other_owner_shape_fails_closed_to_unknown() {
    let null_but_present = with(|v| v["unit"]["owner"] = serde_json::Value::Null).unwrap();
    assert_eq!(null_but_present.unit.owner, Owner::Unknown);
    let missing = with(|v| {
        v["unit"].as_object_mut().unwrap().remove("owner");
    })
    .unwrap();
    assert_eq!(missing.unit.owner, Owner::Unknown);
    let future = with(|v| v["unit"]["owner"] = serde_json::json!("desktop-v2")).unwrap();
    assert_eq!(future.unit.owner, Owner::Unknown);
    let external = with(|v| v["unit"]["owner"] = serde_json::json!("external")).unwrap();
    assert_eq!(external.unit.owner, Owner::External);
}

#[test]
fn a_missing_disabled_flag_reads_as_disabled() {
    let d = with(|v| {
        v["job"].as_object_mut().unwrap().remove("disabled");
    })
    .unwrap();
    assert!(d.job.disabled);
}

#[test]
fn matches_job_null_stays_unknown() {
    let d = with(|v| v["instance"]["matchesJob"] = serde_json::Value::Null).unwrap();
    assert_eq!(d.instance.matches_job, None);
}

#[test]
fn rejects_another_protocol_version_and_non_json() {
    assert!(with(|v| v["protocolVersion"] = serde_json::json!(2)).is_err());
    assert!(parse_discovery(b"").is_err());
    assert!(parse_discovery(b"Unexpected internal error").is_err());
    assert!(parse_discovery(format!("{SPEC_EXAMPLE}\n{{}}").as_bytes()).is_err());
}

#[test]
fn neither_errors_nor_debug_output_leak_the_token() {
    let d = parse_discovery(SPEC_EXAMPLE.as_bytes()).unwrap();
    assert!(!format!("{d:?}").contains("tok-abc"));
    let broken = SPEC_EXAMPLE.replace("\"bundledVersion\": \"0.37.0\"", "\"bundledVersion\": 7");
    let error = parse_discovery(broken.as_bytes()).unwrap_err();
    assert!(!error.contains("tok-abc"), "{error}");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib`
Expected: FAIL to compile: `` cannot find type `Token` ``, `` cannot find function `parse_discovery` ``, `` cannot find type `Discovery` ``.

- [ ] **Step 3: Implement**

`desktop/src/token.rs`:

```rust
//! The desktop token: a same-user local credential for exactly one route. It never reaches a log.

use std::fmt;

use serde::Deserialize;

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Only the transport's `Authorization` header reads this.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::Token;

    #[test]
    fn debug_output_is_redacted() {
        let token = Token::new("s3cr3t-desktop-token");
        let printed = format!("{token:?} {:?}", Some(&token));
        assert!(!printed.contains("s3cr3t"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }
}
```

`desktop/src/connect/discovery.rs`:

```rust
//! Parses the one JSON object `aio-proxy __desktop-connect` prints on stdout
//! (packages/cli/src/desktop-connect/desktop-connect.ts). Every ambiguity fails closed: a field the
//! app cannot read never permits more automation than an explicit value would.

use serde::Deserialize;

use crate::token::Token;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Owner {
    /// The plist's wrapper target is this app's symlink.
    Desktop,
    /// A valid wrapper pointing anywhere else (a CLI install).
    External,
    /// Unrecognized wrapper, or anything the app cannot read.
    #[default]
    Unknown,
    /// `owner: null` with `present: false`: no plist, so a fresh install is allowed.
    NoPlist,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    #[serde(default = "yes")]
    pub present: bool,
    #[serde(default)]
    pub wrapper_valid: bool,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(skip)]
    pub owner: Owner,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    #[serde(default)]
    pub loaded: bool,
    /// A missing value reads as disabled: the app must never `enable` a job the user stopped.
    #[serde(default = "yes")]
    pub disabled: bool,
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    #[serde(default)]
    pub control_url: Option<String>,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub reachable: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub ppid: Option<u32>,
    /// `None` (unknown) counts as not matching for automation.
    #[serde(default)]
    pub matches_job: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub bundled_version: String,
    pub unit: Unit,
    pub job: Job,
    pub instance: Instance,
    #[serde(default)]
    pub token: Option<Token>,
}

fn yes() -> bool {
    true
}

/// Parses `__desktop-connect` stdout. Errors name only serde's error category: a data error's
/// message can quote a value, and stdout carries the token.
pub fn parse_discovery(stdout: &[u8]) -> Result<Discovery, String> {
    let value: serde_json::Value = serde_json::from_slice(stdout.trim_ascii())
        .map_err(|error| format!("__desktop-connect printed invalid JSON ({:?})", error.classify()))?;
    match value.get("protocolVersion").and_then(serde_json::Value::as_u64) {
        Some(1) => {}
        other => return Err(format!("unsupported __desktop-connect protocolVersion {other:?}")),
    }
    let owner = owner(&value["unit"]);
    let mut discovery: Discovery = serde_json::from_value(value)
        .map_err(|error| format!("__desktop-connect printed an unexpected shape ({:?})", error.classify()))?;
    discovery.unit.owner = if owner == Owner::NoPlist && discovery.unit.present { Owner::Unknown } else { owner };
    Ok(discovery)
}

fn owner(unit: &serde_json::Value) -> Owner {
    match unit.get("owner") {
        Some(serde_json::Value::Null) => Owner::NoPlist,
        Some(serde_json::Value::String(owner)) if owner == "desktop" => Owner::Desktop,
        Some(serde_json::Value::String(owner)) if owner == "external" => Owner::External,
        _ => Owner::Unknown,
    }
}

#[cfg(test)]
pub(crate) mod fixture;
#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 20 passed`; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/token.rs desktop/src/connect.rs desktop/src/connect/discovery.rs desktop/src/connect/discovery/fixture.rs desktop/src/connect/discovery/tests.rs
git commit -m "feat(desktop): parse __desktop-connect and redact the desktop token"
```

### Task 4: Loopback HTTP transport

**Files:**
- Create: `desktop/src/client.rs`, `desktop/src/client/transport.rs`
- Modify: `desktop/src/lib.rs`
- Test: `desktop/src/client/transport/tests.rs`

**Interfaces:**
- Consumes: `token::Token` (Task 3).
- Produces (`aio_proxy_desktop::client::transport`): `Limits { connect: Duration, total: Duration, max_body: usize }` (`Default` = 1 s / 5 s / 4 MiB); `LocalUrl::parse(base: &str, path: &str) -> Result<LocalUrl, HttpError>`; `Method::{Get, Post}`; `Request { method: Method, url: LocalUrl, bearer: Option<Token> }`; `Response { status: u16, body: Vec<u8> }`; `HttpError::{NotLoopback, InvalidPath, Connect(io::Error), Timeout, Io(io::Error), Malformed(&'static str), TooLarge, Cancelled}` with `Display`; `Cancel` (`Default`, `Clone`, `cancel(&self)`); `send(request: &Request, limits: Limits, cancel: &Cancel) -> Result<Response, HttpError>` (blocking); `Pending: Future<Output = Result<Response, HttpError>>` that shuts its socket on drop; `spawn(request: Request, limits: Limits) -> Pending`.

The drop-guard slot is the spike's (`git show spike/desktop:spike/desktop-host/src/main.rs`, lines 199-257: `Slot { cancelled, stream }` under one lock, `shutdown(Both)` on drop). What is new: the total deadline is enforced by setting each read's socket timeout to what is left of one deadline (so a slow drip cannot extend it, and no GPUI timer race is needed), plus chunked decoding and the size cap the findings require.

- [ ] **Step 1: Write the failing test**

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod client;
pub mod connect;
pub mod summary;
pub mod token;
pub mod version;
```

`desktop/src/client.rs`:

```rust
//! The local HTTP transport, the summary refresh policy and the health check.

pub mod transport;
```

Create `desktop/src/client/transport.rs` with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/client/transport/tests.rs`:

```rust
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use super::*;

/// One-shot local server: runs `respond` on the first connection and returns the request head.
fn serve(respond: impl FnOnce(&mut TcpStream) + Send + 'static) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let head = read_head(&mut stream);
        respond(&mut stream);
        head
    });
    (base, handle)
}

fn read_head(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
            return head;
        }
        head.push_str(&line);
    }
}

fn get(base: &str, bearer: Option<Token>) -> Request {
    Request { method: Method::Get, url: LocalUrl::parse(base, "/dashboard/api/desktop-summary").unwrap(), bearer }
}

fn send_default(request: &Request) -> Result<Response, HttpError> {
    send(request, Limits::default(), &Cancel::default())
}

#[test]
fn only_a_literal_loopback_ip_over_plain_http_is_addressable() {
    for base in [
        "http://localhost:9317",
        "http://192.168.1.2:9317",
        "http://10.0.0.1:9317",
        "http://127.0.0.1.nip.io:9317",
        "https://127.0.0.1:9317",
        "http://user:pw@127.0.0.1:9317",
        "not a url",
    ] {
        assert!(matches!(LocalUrl::parse(base, "/health"), Err(HttpError::NotLoopback)), "{base}");
    }
    assert!(LocalUrl::parse("http://127.0.0.1:9317", "/health").is_ok());
    assert!(LocalUrl::parse("http://[::1]:9317", "/health").is_ok());
    assert!(matches!(LocalUrl::parse("http://127.0.0.1:9317", "/x\r\nEvil: 1"), Err(HttpError::InvalidPath)));
}

#[test]
fn sends_the_bearer_only_on_the_request_that_carries_it() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
    });
    let response = send_default(&get(&base, Some(Token::new("tok-1")))).unwrap();
    assert_eq!((response.status, response.body.as_slice()), (200, &b"ok"[..]));
    let head = server.join().unwrap();
    assert!(head.starts_with("GET /dashboard/api/desktop-summary HTTP/1.1\r\n"), "{head}");
    assert!(head.contains("Authorization: Bearer tok-1\r\n"), "{head}");

    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    send_default(&get(&base, None)).unwrap();
    assert!(!server.join().unwrap().to_ascii_lowercase().contains("authorization"));
}

#[test]
fn a_redirect_is_returned_not_followed() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!("http://{}/steal", target.local_addr().unwrap());
    let (base, server) = serve(move |s| {
        write!(s, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    let response = send_default(&get(&base, Some(Token::new("tok-2")))).unwrap();
    assert_eq!(response.status, 302);
    server.join().unwrap();
    thread::sleep(Duration::from_millis(200));
    assert!(target.accept().is_err(), "the redirect target was contacted");
}

#[test]
fn proxy_environment_variables_are_ignored() {
    // SAFETY: no other test in this crate reads these variables.
    unsafe {
        for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            std::env::set_var(name, "http://127.0.0.1:1");
        }
    }
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    assert_eq!(send_default(&get(&base, None)).unwrap().status, 200);
    server.join().unwrap();
}

#[test]
fn a_slow_drip_is_cut_off_at_the_total_deadline() {
    let (base, server) = serve(|s| {
        let _ = s.write_all(b"HTTP/1.1 200 OK\r\n");
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(100));
            if s.write_all(b"X").is_err() {
                return;
            }
        }
    });
    let limits = Limits { total: Duration::from_millis(700), ..Limits::default() };
    let started = Instant::now();
    let result = send(&get(&base, None), limits, &Cancel::default());
    let elapsed = started.elapsed();
    assert!(matches!(result, Err(HttpError::Timeout)), "{result:?}");
    assert!(elapsed >= Duration::from_millis(650) && elapsed < Duration::from_millis(1200), "{elapsed:?}");
    server.join().unwrap();
}

#[test]
fn decodes_a_chunked_body() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\nX-Trailer: t\r\n\r\n")
            .unwrap();
    });
    assert_eq!(send_default(&get(&base, None)).unwrap().body, br#"{"a":1}"#);
    server.join().unwrap();
}

#[test]
fn an_oversized_response_is_refused() {
    let limits = Limits { max_body: 16, ..Limits::default() };
    let bodies: [&'static [u8]; 3] = [
        b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n11\r\n",
        b"HTTP/1.1 200 OK\r\n\r\n",
    ];
    for head in bodies {
        let (base, server) = serve(move |s| {
            let _ = s.write_all(head);
            let _ = s.write_all(&[b'x'; 64]);
        });
        let result = send(&get(&base, None), limits, &Cancel::default());
        assert!(matches!(result, Err(HttpError::TooLarge)), "{result:?}");
        server.join().unwrap();
    }
}

#[test]
fn dropping_a_pending_request_shuts_its_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let pending = spawn(get(&base, None), Limits::default());
    let (mut stream, _) = listener.accept().unwrap();
    read_head(&mut stream);
    drop(pending);
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(stream.read(&mut byte).unwrap(), 0, "peer should see EOF after the drop");
}

#[test]
fn a_spawned_request_resolves_through_its_future() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    let response = futures::executor::block_on(spawn(get(&base, None), Limits::default())).unwrap();
    assert_eq!(response.status, 404);
    server.join().unwrap();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib client::transport`
Expected: FAIL to compile: `` cannot find type `LocalUrl` ``, `` cannot find function `send` ``, `` cannot find function `spawn` ``.

- [ ] **Step 3: Implement**

`desktop/src/client/transport.rs`:

```rust
//! A minimal HTTP/1.1 client for the local instance only (spike check 2: the one stack meeting every
//! transport rule). It never reads proxy settings, never follows redirects, speaks plain HTTP only to
//! a literal loopback IP, and bounds the whole exchange by one total deadline.

use std::fmt;
use std::future::Future;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures::channel::oneshot;

use crate::token::Token;

const MAX_HEADER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connect: Duration,
    /// Raced against the whole request: connect, write, and every read share this one deadline.
    pub total: Duration,
    pub max_body: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { connect: Duration::from_secs(1), total: Duration::from_secs(5), max_body: 4 * 1024 * 1024 }
    }
}

/// A URL on the local instance. Constructing one is the only way to address a request, so a
/// hostname, a non-loopback address or HTTPS can never carry the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUrl {
    addr: SocketAddr,
    path: String,
}

impl LocalUrl {
    /// `base` is `instance.controlUrl` (`http://127.0.0.1:9317`, `http://[::1]:9317`); `path` is
    /// absolute, with an optional query.
    pub fn parse(base: &str, path: &str) -> Result<Self, HttpError> {
        let url = url::Url::parse(base).map_err(|_| HttpError::NotLoopback)?;
        if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
            return Err(HttpError::NotLoopback);
        }
        let ip = match url.host() {
            Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
            _ => return Err(HttpError::NotLoopback),
        };
        if ip != IpAddr::V4(Ipv4Addr::LOCALHOST) && ip != IpAddr::V6(Ipv6Addr::LOCALHOST) {
            return Err(HttpError::NotLoopback);
        }
        if !path.starts_with('/') || path.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control()) {
            return Err(HttpError::InvalidPath);
        }
        let port = url.port_or_known_default().ok_or(HttpError::NotLoopback)?;
        Ok(Self { addr: SocketAddr::new(ip, port), path: path.to_string() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: Method,
    pub url: LocalUrl,
    /// Set per request, never as a default; the URL type already guarantees a loopback literal.
    pub bearer: Option<Token>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum HttpError {
    NotLoopback,
    InvalidPath,
    Connect(io::Error),
    Timeout,
    Io(io::Error),
    Malformed(&'static str),
    TooLarge,
    Cancelled,
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HttpError::NotLoopback => f.write_str("the control address is not a loopback IP"),
            HttpError::InvalidPath => f.write_str("invalid request path"),
            HttpError::Connect(error) => write!(f, "cannot connect: {error}"),
            HttpError::Timeout => f.write_str("timed out"),
            HttpError::Io(error) => write!(f, "connection error: {error}"),
            HttpError::Malformed(what) => write!(f, "malformed response: {what}"),
            HttpError::TooLarge => f.write_str("response too large"),
            HttpError::Cancelled => f.write_str("cancelled"),
        }
    }
}

/// `cancelled` and the stream share one lock, so the worker either registers its stream before a
/// cancel (and gets shut down) or sees `cancelled` and never sends.
#[derive(Default)]
struct Slot {
    cancelled: bool,
    stream: Option<TcpStream>,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<Mutex<Slot>>);

impl Cancel {
    pub fn cancel(&self) {
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.cancelled = true;
        if let Some(stream) = slot.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancelled
    }

    fn register(&self, stream: &TcpStream) -> Result<(), HttpError> {
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.cancelled {
            return Err(HttpError::Cancelled);
        }
        slot.stream = Some(stream.try_clone().map_err(HttpError::Io)?);
        Ok(())
    }

    fn release(&self) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).stream = None;
    }
}

/// Blocking exchange on the calling thread. `cancel` from another thread shuts the socket down.
pub fn send(request: &Request, limits: Limits, cancel: &Cancel) -> Result<Response, HttpError> {
    let deadline = Instant::now() + limits.total;
    let result = exchange(request, limits, deadline, cancel);
    cancel.release();
    match result {
        Err(_) if cancel.is_cancelled() => Err(HttpError::Cancelled),
        other => other,
    }
}

fn exchange(request: &Request, limits: Limits, deadline: Instant, cancel: &Cancel) -> Result<Response, HttpError> {
    let connect_for = limits.connect.min(remaining(deadline)?);
    let mut stream = TcpStream::connect_timeout(&request.url.addr, connect_for).map_err(|error| {
        if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
            HttpError::Timeout
        } else {
            HttpError::Connect(error)
        }
    })?;
    cancel.register(&stream)?;
    stream.set_write_timeout(Some(remaining(deadline)?)).map_err(HttpError::Io)?;
    stream.write_all(head(request).as_bytes()).map_err(io_error)?;
    let mut reader = Reader { stream, buf: Vec::new(), pos: 0, deadline };
    read_response(&mut reader, limits.max_body)
}

fn head(request: &Request) -> String {
    let method = match request.method {
        Method::Get => "GET",
        Method::Post => "POST",
    };
    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\n",
        request.url.path, request.url.addr
    );
    if request.method == Method::Post {
        head.push_str("Content-Length: 0\r\n");
    }
    if let Some(token) = &request.bearer {
        head.push_str(&format!("Authorization: Bearer {}\r\n", token.expose()));
    }
    head.push_str("\r\n");
    head
}

fn remaining(deadline: Instant) -> Result<Duration, HttpError> {
    deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()).ok_or(HttpError::Timeout)
}

fn io_error(error: io::Error) -> HttpError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => HttpError::Timeout,
        _ => HttpError::Io(error),
    }
}

struct Reader {
    stream: TcpStream,
    buf: Vec<u8>,
    pos: usize,
    deadline: Instant,
}

impl Reader {
    /// Reads more bytes, with the socket timeout set to whatever is left of the total deadline, so
    /// a server dripping one byte at a time still hits the deadline. `false` at EOF.
    fn fill(&mut self) -> Result<bool, HttpError> {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        let mut chunk = [0_u8; 8192];
        loop {
            self.stream.set_read_timeout(Some(remaining(self.deadline)?)).map_err(HttpError::Io)?;
            match self.stream.read(&mut chunk) {
                Ok(0) => return Ok(false),
                Ok(n) => {
                    self.buf.extend_from_slice(&chunk[..n]);
                    return Ok(true);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(io_error(error)),
            }
        }
    }

    fn line(&mut self, max: usize) -> Result<Vec<u8>, HttpError> {
        loop {
            if let Some(at) = self.buf[self.pos..].iter().position(|&b| b == b'\n') {
                let mut line = self.buf[self.pos..self.pos + at].to_vec();
                self.pos += at + 1;
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(line);
            }
            if self.buf.len() - self.pos > max {
                return Err(HttpError::TooLarge);
            }
            if !self.fill()? {
                return Err(HttpError::Malformed("connection closed mid-line"));
            }
        }
    }

    fn exact(&mut self, n: usize) -> Result<Vec<u8>, HttpError> {
        while self.buf.len() - self.pos < n {
            if !self.fill()? {
                return Err(HttpError::Malformed("connection closed mid-body"));
            }
        }
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(out)
    }

    fn rest(&mut self, max: usize) -> Result<Vec<u8>, HttpError> {
        while self.fill()? {
            if self.buf.len() - self.pos > max {
                return Err(HttpError::TooLarge);
            }
        }
        if self.buf.len() - self.pos > max {
            return Err(HttpError::TooLarge);
        }
        Ok(self.buf[self.pos..].to_vec())
    }
}

fn read_response(reader: &mut Reader, max_body: usize) -> Result<Response, HttpError> {
    let status_line = reader.line(MAX_HEADER_BYTES)?;
    let status = std::str::from_utf8(&status_line)
        .ok()
        .filter(|line| line.starts_with("HTTP/1."))
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(HttpError::Malformed("status line"))?;
    let mut content_length = None;
    let mut chunked = false;
    let mut header_bytes = status_line.len();
    loop {
        let line = reader.line(MAX_HEADER_BYTES)?;
        header_bytes += line.len();
        if header_bytes > MAX_HEADER_BYTES {
            return Err(HttpError::TooLarge);
        }
        if line.is_empty() {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let Some((name, value)) = text.split_once(':') else {
            return Err(HttpError::Malformed("header line"));
        };
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(value.parse::<usize>().map_err(|_| HttpError::Malformed("content-length"))?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.split(',').any(|coding| coding.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    let body = if status == 204 || status == 304 {
        Vec::new()
    } else if chunked {
        read_chunked(reader, max_body)?
    } else if let Some(length) = content_length {
        if length > max_body {
            return Err(HttpError::TooLarge);
        }
        reader.exact(length)?
    } else {
        reader.rest(max_body)?
    };
    Ok(Response { status, body })
}

fn read_chunked(reader: &mut Reader, max_body: usize) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    loop {
        let line = reader.line(MAX_HEADER_BYTES)?;
        let size = String::from_utf8_lossy(&line);
        let size = size.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size, 16).map_err(|_| HttpError::Malformed("chunk size"))?;
        if size == 0 {
            while !reader.line(MAX_HEADER_BYTES)?.is_empty() {}
            return Ok(body);
        }
        if body.len().saturating_add(size) > max_body {
            return Err(HttpError::TooLarge);
        }
        body.extend(reader.exact(size)?);
        if !reader.line(MAX_HEADER_BYTES)?.is_empty() {
            return Err(HttpError::Malformed("chunk terminator"));
        }
    }
}

/// A request running on its own thread. Dropping it shuts the socket down, which is how closing the
/// panel cancels a fetch.
pub struct Pending {
    rx: oneshot::Receiver<Result<Response, HttpError>>,
    cancel: Cancel,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Future for Pending {
    type Output = Result<Response, HttpError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.rx).poll(cx) {
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(oneshot::Canceled)) => Poll::Ready(Err(HttpError::Cancelled)),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Starts `request` on a new thread at once (no async runtime).
pub fn spawn(request: Request, limits: Limits) -> Pending {
    let cancel = Cancel::default();
    let (tx, rx) = oneshot::channel();
    let worker = cancel.clone();
    // A failed spawn drops `tx`, which the future reports as Cancelled.
    let _ = std::thread::Builder::new().name("aio-proxy-http".into()).spawn(move || {
        let _ = tx.send(send(&request, limits, &worker));
    });
    Pending { rx, cancel }
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib client::transport && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 9 passed` in under 2 s (the drip test is bounded at 700 ms); clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/client.rs desktop/src/client/transport.rs desktop/src/client/transport/tests.rs
git commit -m "feat(desktop): add the loopback-only HTTP transport"
```

### Task 5: Refresh scheduler and health tracker

**Files:**
- Create: `desktop/src/client/refresh.rs`, `desktop/src/client/health.rs`
- Modify: `desktop/src/client.rs`
- Test: `desktop/src/client/refresh/tests.rs`, `desktop/src/client/health/tests.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks (clock-injected, pure).
- Produces (`aio_proxy_desktop::client::refresh`): `REFRESH_INTERVAL` (15 s), `LOADING_RETRY` (2 s); `Tag { session: u64, instance: u64, counter: u64 }`; `FetchOrder { tag: Tag, refresh_quota: bool }`; `Trigger::{Tick, ActionDone, Manual, Rediscovered}`; `Finished::{Summary { any_loading: bool }, Failed}`; `Scheduler` (`Default`) with `is_open(&self) -> bool`, `open(&mut self, now: Instant) -> Option<FetchOrder>`, `close(&mut self)`, `set_instance(&mut self, instance: u64, now: Instant) -> Option<FetchOrder>`, `trigger(&mut self, trigger: Trigger, now: Instant) -> Option<FetchOrder>`, `finished(&mut self, tag: Tag, outcome: Finished, now: Instant) -> (bool, Option<FetchOrder>)`, `next_wake(&self) -> Option<Instant>`, `wake(&mut self, now: Instant) -> Option<FetchOrder>`.
- Produces (`aio_proxy_desktop::client::health`): `HEALTH_INTERVAL` (60 s), `HEALTH_TIMEOUT` (2 s); `HealthState::{Unknown, Up, Down}`; `HealthTracker` (`Default`) with `state(&self) -> HealthState`, `record(&mut self, ok: bool) -> Option<HealthState>` (the new state only on a transition); `HealthReport { version: Option<String> }`; `parse_health(status: u16, body: &[u8]) -> Option<HealthReport>`.

The next fetch is always 15 s after the last one started, so the tick and the floor are one rule; the GPUI glue (Task 10) keeps a single timer armed at `next_wake()`.

- [ ] **Step 1: Write the failing test**

`desktop/src/client.rs`:

```rust
//! The local HTTP transport, the summary refresh policy and the health check.

pub mod health;
pub mod refresh;
pub mod transport;
```

Create `desktop/src/client/refresh.rs` and `desktop/src/client/health.rs`, each with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/client/refresh/tests.rs`:

```rust
use std::time::{Duration, Instant};

use super::*;

const DONE: Finished = Finished::Summary { any_loading: false };
const LOADING: Finished = Finished::Summary { any_loading: true };

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[test]
fn opening_fetches_at_once_without_quota_refresh() {
    let mut s = Scheduler::default();
    let order = s.open(Instant::now()).expect("panel open fetches");
    assert!(!order.refresh_quota);
}

#[test]
fn a_response_from_a_closed_session_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let first = s.open(t0).unwrap();
    s.close();
    assert_eq!(s.finished(first.tag, DONE, t0), (false, None));
    let second = s.open(t0 + secs(1)).unwrap();
    assert!(!s.finished(first.tag, DONE, t0 + secs(1)).0);
    assert!(s.finished(second.tag, DONE, t0 + secs(1)).0);
}

#[test]
fn a_response_from_another_instance_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let old = s.open(t0).unwrap();
    let new = s.set_instance(7, t0).expect("a new instance refetches");
    assert_eq!(new.tag.instance, 7);
    assert!(!s.finished(old.tag, DONE, t0).0);
    assert!(s.finished(new.tag, DONE, t0).0);
}

#[test]
fn a_response_with_an_older_counter_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    let older = Tag { counter: order.tag.counter - 1, ..order.tag };
    assert!(!s.finished(older, DONE, t0).0);
    assert!(s.finished(order.tag, DONE, t0).0);
}

#[test]
fn the_15_second_floor_holds_under_a_trigger_storm() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, DONE, t0 + secs(1));
    for ms in (1_000..15_000).step_by(50) {
        let now = t0 + Duration::from_millis(ms);
        assert_eq!(s.trigger(Trigger::Tick, now), None, "fetched at {ms} ms");
        assert_eq!(s.wake(now), None, "woke into a fetch at {ms} ms");
    }
    assert_eq!(s.next_wake(), Some(t0 + secs(15)));
    assert!(s.wake(t0 + secs(15)).is_some());
}

#[test]
fn manual_refresh_bypasses_the_floor_and_refreshes_quota() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, DONE, t0);
    let manual = s.trigger(Trigger::Manual, t0 + secs(2)).expect("manual refresh fetches now");
    assert!(manual.refresh_quota);
    s.finished(manual.tag, DONE, t0 + secs(2));
    assert!(s.trigger(Trigger::ActionDone, t0 + secs(3)).is_some());
}

#[test]
fn a_trigger_during_a_request_runs_exactly_one_more_fetch() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    assert_eq!(s.trigger(Trigger::Manual, t0), None);
    assert_eq!(s.trigger(Trigger::ActionDone, t0), None);
    let (accepted, follow) = s.finished(order.tag, DONE, t0 + secs(1));
    assert!(accepted);
    let follow = follow.expect("the dirty trigger runs once the request finishes");
    assert!(follow.refresh_quota);
    assert_eq!(s.finished(follow.tag, DONE, t0 + secs(2)), (true, None));
}

#[test]
fn a_dirty_tick_still_waits_for_the_floor() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    assert_eq!(s.trigger(Trigger::Tick, t0), None);
    assert_eq!(s.finished(order.tag, DONE, t0 + secs(1)), (true, None));
    assert_eq!(s.next_wake(), Some(t0 + secs(15)));
}

#[test]
fn loading_quota_gets_one_shared_retry_after_two_seconds() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, LOADING, t0 + secs(1));
    assert_eq!(s.next_wake(), Some(t0 + secs(3)));
    assert_eq!(s.wake(t0 + Duration::from_millis(2_900)), None);
    let retry = s.wake(t0 + secs(3)).expect("one retry after 2 s");
    // Still loading: no second retry, just the next 15 s tick.
    assert_eq!(s.finished(retry.tag, LOADING, t0 + secs(4)), (true, None));
    assert_eq!(s.next_wake(), Some(t0 + secs(18)));
}

#[test]
fn closing_cancels_everything() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, LOADING, t0);
    s.close();
    assert!(!s.is_open());
    assert_eq!(s.next_wake(), None);
    assert_eq!(s.wake(t0 + secs(60)), None);
    assert_eq!(s.trigger(Trigger::Manual, t0 + secs(60)), None);
    assert_eq!(s.set_instance(9, t0 + secs(60)), None);
}
```

`desktop/src/client/health/tests.rs`:

```rust
use super::*;

#[test]
fn one_failure_is_not_down_two_are() {
    let mut h = HealthTracker::default();
    assert_eq!(h.record(true), Some(HealthState::Up));
    assert_eq!(h.record(false), None);
    assert_eq!(h.state(), HealthState::Up);
    assert_eq!(h.record(false), Some(HealthState::Down));
    assert_eq!(h.record(false), None, "a transition is reported once");
}

#[test]
fn a_success_resets_the_failure_count() {
    let mut h = HealthTracker::default();
    h.record(true);
    h.record(false);
    h.record(true);
    assert_eq!(h.record(false), None);
    assert_eq!(h.state(), HealthState::Up);
}

#[test]
fn only_the_aio_proxy_marker_counts_as_healthy() {
    let ok = parse_health(200, br#"{"status":"ok","uptime":1.5,"version":"0.37.0"}"#);
    assert_eq!(ok, Some(HealthReport { version: Some("0.37.0".into()) }));
    assert_eq!(parse_health(200, br#"{"status":"degraded"}"#), None);
    assert_eq!(parse_health(200, b"OK"), None);
    assert_eq!(parse_health(503, br#"{"status":"ok"}"#), None);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib client`
Expected: FAIL to compile: `` cannot find type `Scheduler` ``, `` cannot find type `HealthTracker` ``, `` cannot find function `parse_health` ``.

- [ ] **Step 3: Implement**

`desktop/src/client/refresh.rs`:

```rust
//! The panel's refresh policy as a clock-injected state machine. The GPUI glue owns the timer and the
//! in-flight request; this decides when to fetch and which responses still count.

use std::time::{Duration, Instant};

pub const REFRESH_INTERVAL: Duration = Duration::from_secs(15);
pub const LOADING_RETRY: Duration = Duration::from_secs(2);

/// Every response is tagged; one from a closed session, another instance or an older counter is discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tag {
    pub session: u64,
    pub instance: u64,
    pub counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchOrder {
    pub tag: Tag,
    /// `?refresh=true`: only for a manual refresh.
    pub refresh_quota: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Subject to the 15 s floor.
    Tick,
    /// A user action finished its completion condition.
    ActionDone,
    /// Manual refresh: bypasses the floor and asks the server to refresh quota.
    Manual,
    /// Discovery re-ran after a 401 and may carry a replaced token.
    Rediscovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finished {
    Summary { any_loading: bool },
    Failed,
}

#[derive(Debug, Default, Clone, Copy)]
struct Dirty {
    bypass: bool,
    refresh_quota: bool,
}

#[derive(Debug, Default)]
pub struct Scheduler {
    session: Option<u64>,
    sessions: u64,
    instance: u64,
    counter: u64,
    /// The one request allowed in flight, and whether it is the loading retry.
    in_flight: Option<(Tag, bool)>,
    dirty: Option<Dirty>,
    last_start: Option<Instant>,
    retry_at: Option<Instant>,
}

impl Scheduler {
    pub fn is_open(&self) -> bool {
        self.session.is_some()
    }

    /// Panel opened: a new session that fetches at once.
    pub fn open(&mut self, now: Instant) -> Option<FetchOrder> {
        self.close();
        self.sessions += 1;
        self.session = Some(self.sessions);
        self.issue(now, false, false)
    }

    /// Panel closed: forget the in-flight request and every timer. The glue drops both tasks.
    pub fn close(&mut self) {
        self.session = None;
        self.in_flight = None;
        self.dirty = None;
        self.last_start = None;
        self.retry_at = None;
    }

    /// Discovery found a different instance: stale responses stop counting, and an open panel refetches.
    pub fn set_instance(&mut self, instance: u64, now: Instant) -> Option<FetchOrder> {
        if instance == self.instance {
            return None;
        }
        self.instance = instance;
        self.in_flight = None;
        self.dirty = None;
        self.retry_at = None;
        self.issue(now, false, false)
    }

    pub fn trigger(&mut self, trigger: Trigger, now: Instant) -> Option<FetchOrder> {
        self.session?;
        let bypass = trigger != Trigger::Tick;
        let refresh_quota = trigger == Trigger::Manual;
        if self.in_flight.is_some() {
            let dirty = self.dirty.get_or_insert_default();
            dirty.bypass |= bypass;
            dirty.refresh_quota |= refresh_quota;
            return None;
        }
        if !bypass && self.floor_blocks(now) {
            return None;
        }
        self.issue(now, refresh_quota, false)
    }

    /// A request finished. Returns whether its result may be shown, plus a follow-up fetch.
    pub fn finished(&mut self, tag: Tag, outcome: Finished, now: Instant) -> (bool, Option<FetchOrder>) {
        let Some((current, is_retry)) = self.in_flight else {
            return (false, None);
        };
        if current != tag || self.session != Some(tag.session) || self.instance != tag.instance {
            return (false, None);
        }
        self.in_flight = None;
        if outcome == (Finished::Summary { any_loading: true }) && !is_retry && self.retry_at.is_none() {
            self.retry_at = Some(now + LOADING_RETRY);
        }
        let follow = match self.dirty.take() {
            Some(dirty) if dirty.bypass || !self.floor_blocks(now) => self.issue(now, dirty.refresh_quota, false),
            _ => None,
        };
        (true, follow)
    }

    /// When the glue's single timer should fire next; `None` while closed or while a request runs.
    pub fn next_wake(&self) -> Option<Instant> {
        self.session?;
        if self.in_flight.is_some() {
            return None;
        }
        let tick = self.last_start.map(|start| start + REFRESH_INTERVAL);
        match (tick, self.retry_at) {
            (Some(tick), Some(retry)) => Some(tick.min(retry)),
            (tick, retry) => tick.or(retry),
        }
    }

    pub fn wake(&mut self, now: Instant) -> Option<FetchOrder> {
        self.session?;
        if self.in_flight.is_some() {
            return None;
        }
        if self.retry_at.is_some_and(|at| at <= now) {
            self.retry_at = None;
            return self.issue(now, false, true);
        }
        if self.floor_blocks(now) {
            return None;
        }
        self.issue(now, false, false)
    }

    fn floor_blocks(&self, now: Instant) -> bool {
        self.last_start.is_some_and(|start| now < start + REFRESH_INTERVAL)
    }

    fn issue(&mut self, now: Instant, refresh_quota: bool, is_retry: bool) -> Option<FetchOrder> {
        let session = self.session?;
        self.counter += 1;
        let tag = Tag { session, instance: self.instance, counter: self.counter };
        self.in_flight = Some((tag, is_retry));
        self.last_start = Some(now);
        if !is_retry {
            // The response re-arms the retry if quota is still loading.
            self.retry_at = None;
        }
        Some(FetchOrder { tag, refresh_quota })
    }
}

#[cfg(test)]
mod tests;
```

`desktop/src/client/health.rs`:

```rust
//! `GET /health` bookkeeping: two consecutive failures mark the proxy down. Transitions trigger
//! rediscovery; nothing here ever mutates the service.

use std::time::Duration;

use serde::Deserialize;

pub const HEALTH_INTERVAL: Duration = Duration::from_secs(60);
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HealthState {
    #[default]
    Unknown,
    Up,
    Down,
}

#[derive(Debug, Default)]
pub struct HealthTracker {
    state: HealthState,
    failures: u32,
}

impl HealthTracker {
    pub fn state(&self) -> HealthState {
        self.state
    }

    /// Records one probe; returns the new state only when it changed.
    pub fn record(&mut self, ok: bool) -> Option<HealthState> {
        let next = if ok {
            self.failures = 0;
            HealthState::Up
        } else {
            self.failures += 1;
            if self.failures < 2 {
                return None;
            }
            HealthState::Down
        };
        (next != self.state).then(|| {
            self.state = next;
            next
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub version: Option<String>,
}

/// Only aio-proxy's own `status: "ok"` marker counts, so another service on the port reads as down.
pub fn parse_health(status: u16, body: &[u8]) -> Option<HealthReport> {
    #[derive(Deserialize)]
    struct Body {
        status: Option<String>,
        version: Option<String>,
    }
    if !(200..300).contains(&status) {
        return None;
    }
    let body: Body = serde_json::from_slice(body).ok()?;
    (body.status.as_deref() == Some("ok")).then_some(HealthReport { version: body.version })
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib client && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 22 passed` (9 transport + 10 refresh + 3 health); clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/client.rs desktop/src/client/refresh.rs desktop/src/client/refresh/tests.rs desktop/src/client/health.rs desktop/src/client/health/tests.rs
git commit -m "feat(desktop): add the refresh scheduler and health tracker"
```

### Task 6: Install policy, stable symlink, no-downgrade, single instance

**Files:**
- Create: `desktop/src/process.rs`, `desktop/src/install.rs`
- Modify: `desktop/src/lib.rs`
- Test: `desktop/src/process/tests.rs`, `desktop/src/install/tests.rs`

**Interfaces:**
- Consumes: `version::{compare, parse_version_output}` (Task 1).
- Produces (`aio_proxy_desktop::process`): `run_with_timeout(command: std::process::Command, timeout: Duration) -> io::Result<std::process::Output>` (stdin null, stdout/stderr piped, SIGKILL on timeout, `ErrorKind::TimedOut`); `tail(bytes: &[u8], max: usize) -> String`.
- Produces (`aio_proxy_desktop::install`): `Paths { home, support, symlink, lock, logs: PathBuf }` with `Paths::for_home(home: &Path) -> Paths`; `bundle_of(exe: &Path) -> Option<PathBuf>`; `sidecar_of(bundle: &Path) -> PathBuf`; `ReadOnlyReason::{Location, NewerCopy { app: PathBuf, version: String }, UnreadableCopy { app: PathBuf }, SymlinkFailed(String)}`; `InstallState::{Persistent, ReadOnly(ReadOnlyReason)}`; `location_allows_persistence(bundle: &Path, home: &Path, read_only_volume: bool) -> bool`; `volume_is_read_only(path: &Path) -> bool`; `SymlinkPlan::{Keep, Repoint, Refuse(ReadOnlyReason)}`; `plan_symlink(current: Option<&Path>, own_sidecar: &Path, own_version: &str, target_version: impl FnOnce(&Path) -> Option<String>) -> SymlinkPlan`; `repoint(symlink: &Path, target: &Path) -> io::Result<()>`; `prepare(paths: &Paths, bundle: &Path, location_ok: bool, own_version: &str, target_version: impl FnOnce(&Path) -> Option<String>) -> InstallState`; `probe_version(exec: &Path) -> Option<String>`; `InstanceLock`; `acquire_instance_lock(path: &Path) -> io::Result<Option<InstanceLock>>`.

`statvfs` was checked on this machine: `/Applications` and `~/Applications` report writable, `/` (the sealed system volume) reports `ST_RDONLY`, so the volume check does not misfire through the firmlink.

- [ ] **Step 1: Write the failing test**

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod client;
pub mod connect;
pub mod install;
pub mod process;
pub mod summary;
pub mod token;
pub mod version;
```

Create `desktop/src/process.rs` and `desktop/src/install.rs`, each with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/process/tests.rs`:

```rust
use std::process::Command;
use std::time::{Duration, Instant};

use super::*;

fn sh(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

#[test]
fn a_command_past_its_timeout_is_killed() {
    let started = Instant::now();
    let error = run_with_timeout(sh("sleep 30"), Duration::from_millis(200)).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn captures_stdout_stderr_and_status() {
    let output = run_with_timeout(sh("printf out; printf err >&2; exit 3"), Duration::from_secs(5)).unwrap();
    assert_eq!(output.stdout, b"out");
    assert_eq!(tail(&output.stderr, 10), "err");
    assert_eq!(output.status.code(), Some(3));
}

#[test]
fn tail_keeps_the_end() {
    assert_eq!(tail(b"0123456789", 3), "789");
}
```

`desktop/src/install/tests.rs`:

```rust
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::*;

const HOME: &str = "/Users/me";

fn allowed(bundle: &str) -> bool {
    location_allows_persistence(Path::new(bundle), Path::new(HOME), false)
}

#[test]
fn only_an_applications_folder_on_a_writable_volume_is_persistent() {
    assert!(allowed("/Applications/AIO Proxy.app"));
    assert!(allowed("/Applications/Utilities/AIO Proxy.app"));
    assert!(allowed("/Users/me/Applications/AIO Proxy.app"));
    for bundle in [
        "/Volumes/AIO Proxy/AIO Proxy.app",
        "/Users/me/Downloads/AIO Proxy.app",
        "/private/var/folders/xy/T/AppTranslocation/1234/d/AIO Proxy.app",
        "/Applications2/AIO Proxy.app",
        "/Applications/../tmp/AIO Proxy.app",
        "/Applications",
        "Applications/AIO Proxy.app",
        "/Users/other/Applications/AIO Proxy.app",
    ] {
        assert!(!allowed(bundle), "{bundle}");
    }
    assert!(!location_allows_persistence(Path::new("/Applications/AIO Proxy.app"), Path::new(HOME), true));
}

#[test]
fn finds_the_bundle_from_the_executable() {
    assert_eq!(
        bundle_of(Path::new("/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop")),
        Some(PathBuf::from("/Applications/AIO Proxy.app"))
    );
    assert_eq!(bundle_of(Path::new("/Users/me/desktop/target/debug/aio-proxy-desktop")), None);
}

struct Fixture {
    _dir: tempfile::TempDir,
    paths: Paths,
    bundle: PathBuf,
    other: PathBuf,
}

/// A fake home with this app's bundle and another installed copy, each holding a sidecar file.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::for_home(dir.path());
    let make = |name: &str| {
        let bundle = dir.path().join(name);
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(sidecar_of(&bundle), b"#!/bin/sh\n").unwrap();
        bundle
    };
    let bundle = make("Applications/AIO Proxy.app");
    let other = make("Other/AIO Proxy.app");
    Fixture { _dir: dir, paths, bundle, other }
}

#[test]
fn outside_an_applications_folder_nothing_persistent_happens() {
    let f = fixture();
    let state = prepare(&f.paths, &f.bundle, false, "0.37.0", |_| panic!("must not probe"));
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::Location));
    assert!(fs::symlink_metadata(&f.paths.symlink).is_err(), "no symlink may be created");
}

#[test]
fn a_missing_or_dangling_symlink_is_pointed_at_this_copy() {
    let f = fixture();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));

    repoint(&f.paths.symlink, Path::new("/nonexistent/AIO Proxy.app/Contents/MacOS/aio-proxy")).unwrap();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));
}

#[test]
fn a_newer_installed_copy_is_never_repointed_to_an_older_one() {
    let f = fixture();
    repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some("0.38.0".into()));
    assert_eq!(
        state,
        InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app: f.other.clone(), version: "0.38.0".into() })
    );
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.other));
}

#[test]
fn an_older_or_equal_copy_is_repointed_to_this_one() {
    for found in ["0.36.9", "0.37.0"] {
        let f = fixture();
        repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
        assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some(found.into())), InstallState::Persistent);
        assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));
    }
}

#[test]
fn an_unreadable_installed_copy_is_left_alone() {
    let f = fixture();
    repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None);
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app: f.other.clone() }));
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.other));
}

#[test]
fn a_second_instance_cannot_take_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("support/instance.lock");
    let _first = acquire_instance_lock(&lock).unwrap().expect("the first copy takes the lock");
    assert!(acquire_instance_lock(&lock).unwrap().is_none(), "a second copy must exit");
}

#[test]
fn probes_a_copy_version_with_its_cli() {
    let dir = tempfile::tempdir().unwrap();
    let exec = dir.path().join("aio-proxy");
    fs::write(&exec, "#!/bin/sh\necho 0.38.0\n").unwrap();
    fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probe_version(&exec).as_deref(), Some("0.38.0"));
    assert_eq!(probe_version(&dir.path().join("missing")), None);
}
```

The lock test does not assert re-acquisition after drop: another test's child process can briefly inherit the descriptor between `fork` and `exec` (std opens it `O_CLOEXEC`, but the window exists), which made that assertion flaky in parallel runs. The kernel releasing an `flock` at process exit is not ours to test.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib`
Expected: FAIL to compile: `` cannot find function `run_with_timeout` ``, `` cannot find function `location_allows_persistence` ``, `` cannot find function `prepare` ``, `` cannot find function `acquire_instance_lock` ``.

- [ ] **Step 3: Implement**

`desktop/src/process.rs`:

```rust
//! Runs a helper process with a hard timeout. Output is returned, never logged: `__desktop-connect`
//! stdout carries the token.

use std::io;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub fn run_with_timeout(mut command: Command, timeout: Duration) -> io::Result<Output> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new().name("aio-proxy-child".into()).spawn(move || {
        let _ = tx.send(child.wait_with_output());
    })?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            // SAFETY: plain kill(2) on the pid we spawned; the waiter thread still reaps it. Not waiting
            // here: a grandchild holding the pipes open would block us past the timeout.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            Err(io::Error::new(io::ErrorKind::TimedOut, format!("timed out after {timeout:?}")))
        }
    }
}

/// The last `max` bytes of a stream, for error messages built from stderr.
pub fn tail(bytes: &[u8], max: usize) -> String {
    let start = bytes.len().saturating_sub(max);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

#[cfg(test)]
mod tests;
```

`desktop/src/install.rs`:

```rust
//! Install-location policy, the stable symlink, the no-downgrade rule and the single-instance lock.

use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::process::run_with_timeout;
use crate::version;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub home: PathBuf,
    pub support: PathBuf,
    /// `AIO_PROXY_DESKTOP_EXEC`: the only path a desktop-owned plist ever points at.
    pub symlink: PathBuf,
    pub lock: PathBuf,
    /// The app's own log directory.
    pub logs: PathBuf,
}

impl Paths {
    pub fn for_home(home: &Path) -> Self {
        let support = home.join("Library/Application Support/aio-proxy-desktop");
        Self {
            home: home.to_path_buf(),
            symlink: support.join("bin/aio-proxy"),
            lock: support.join("instance.lock"),
            logs: home.join("Library/Logs/aio-proxy-desktop"),
            support,
        }
    }
}

/// `…/X.app/Contents/MacOS/aio-proxy-desktop` → `…/X.app`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let ok = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|ext| ext == "app");
    ok.then(|| bundle.to_path_buf())
}

pub fn sidecar_of(bundle: &Path) -> PathBuf {
    bundle.join("Contents/MacOS/aio-proxy")
}

/// `…/X.app/Contents/MacOS/aio-proxy` → `…/X.app`, for naming a copy in a notice.
fn app_of_sidecar(sidecar: &Path) -> PathBuf {
    sidecar
        .ancestors()
        .nth(3)
        .filter(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or(sidecar)
        .to_path_buf()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnlyReason {
    /// Not in /Applications or ~/Applications on a writable volume: "Move to Applications".
    Location,
    NewerCopy {
        app: PathBuf,
        version: String,
    },
    /// The symlink's target exists but its version could not be read; never overwrite what we cannot rank.
    UnreadableCopy {
        app: PathBuf,
    },
    SymlinkFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallState {
    Persistent,
    ReadOnly(ReadOnlyReason),
}

/// A location policy, not translocation detection: a translocated or mounted copy simply is not
/// under an Applications folder.
pub fn location_allows_persistence(bundle: &Path, home: &Path, read_only_volume: bool) -> bool {
    if read_only_volume || !bundle.is_absolute() {
        return false;
    }
    if bundle.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return false;
    }
    let under = |root: &Path| bundle.starts_with(root) && bundle != root;
    under(Path::new("/Applications")) || under(&home.join("Applications"))
}

/// Unknown counts as read-only.
pub fn volume_is_read_only(path: &Path) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return true;
    };
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: statvfs writes the struct on success; we read it only then.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    rc != 0 || unsafe { stats.assume_init() }.f_flag & libc::ST_RDONLY != 0
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymlinkPlan {
    Keep,
    Repoint,
    Refuse(ReadOnlyReason),
}

/// The no-downgrade rule: re-point only when the target is missing or provably not newer.
pub fn plan_symlink(
    current: Option<&Path>,
    own_sidecar: &Path,
    own_version: &str,
    target_version: impl FnOnce(&Path) -> Option<String>,
) -> SymlinkPlan {
    let Some(target) = current else {
        return SymlinkPlan::Repoint;
    };
    if target == own_sidecar {
        return SymlinkPlan::Keep;
    }
    if !target.exists() {
        return SymlinkPlan::Repoint;
    }
    let app = app_of_sidecar(target);
    match target_version(target) {
        Some(found) => match version::compare(&found, own_version) {
            Some(Ordering::Greater) => SymlinkPlan::Refuse(ReadOnlyReason::NewerCopy { app, version: found }),
            Some(_) => SymlinkPlan::Repoint,
            None => SymlinkPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
        },
        None => SymlinkPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
    }
}

/// Create-temp-symlink + rename, so the service never sees a missing link.
pub fn repoint(symlink: &Path, target: &Path) -> io::Result<()> {
    let dir = symlink.parent().ok_or_else(|| io::Error::other("symlink has no parent"))?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".aio-proxy.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temp);
    std::os::unix::fs::symlink(target, &temp)?;
    fs::rename(&temp, symlink)
}

/// Startup install step. Outside an Applications folder nothing on disk changes.
pub fn prepare(
    paths: &Paths,
    bundle: &Path,
    location_ok: bool,
    own_version: &str,
    target_version: impl FnOnce(&Path) -> Option<String>,
) -> InstallState {
    if !location_ok {
        return InstallState::ReadOnly(ReadOnlyReason::Location);
    }
    let sidecar = sidecar_of(bundle);
    let current = fs::read_link(&paths.symlink).ok();
    match plan_symlink(current.as_deref(), &sidecar, own_version, target_version) {
        SymlinkPlan::Keep => InstallState::Persistent,
        SymlinkPlan::Repoint => match repoint(&paths.symlink, &sidecar) {
            Ok(()) => InstallState::Persistent,
            Err(error) => InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error.to_string())),
        },
        SymlinkPlan::Refuse(reason) => InstallState::ReadOnly(reason),
    }
}

/// `<target> --version`, bounded so a hung copy cannot stall startup.
pub fn probe_version(exec: &Path) -> Option<String> {
    let mut command = Command::new(exec);
    command.arg("--version");
    let output = run_with_timeout(command, Duration::from_secs(5)).ok()?;
    output.status.success().then(|| version::parse_version_output(&String::from_utf8_lossy(&output.stdout)))?
}

/// Held for the life of the process; the kernel drops the flock when it exits.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

/// `Ok(None)` when another copy holds the lock: this one must exit.
pub fn acquire_instance_lock(path: &Path) -> io::Result<Option<InstanceLock>> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
    // SAFETY: flock on a descriptor we own.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(InstanceLock { _file: file }));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) { Ok(None) } else { Err(error) }
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 54 passed`; clippy clean. Run the suite three times; it must pass every time.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/process.rs desktop/src/process/tests.rs desktop/src/install.rs desktop/src/install/tests.rs
git commit -m "feat(desktop): add the install-location policy, symlink and instance lock"
```

### Task 7: Automatic-action table, user actions and completion conditions

**Files:**
- Create: `desktop/src/connect/policy.rs`
- Modify: `desktop/src/connect.rs`, `desktop/src/connect/discovery/fixture.rs`
- Test: `desktop/src/connect/policy/tests.rs`

**Interfaces:**
- Consumes: `connect::discovery::{Discovery, Owner}` (Task 3), `version::compare` (Task 1).
- Produces (`aio_proxy_desktop::connect::policy`): `AutoAction::{InstallAndStart, StartNotLoaded, StartNoProcess, RestartForVersion}`; `AutoAttempts` (`Default`) with `used(&self, AutoAction) -> bool`, `mark(&mut self, AutoAction)`; `automatic_action(d: &Discovery, persistent: bool, attempts: &AutoAttempts) -> Option<AutoAction>`; `UserAction::{Start, Restart, Stop, Reload}`; `Offered { start, restart, stop, reload: bool }` (`Default`); `offered_actions(d: &Discovery, persistent: bool) -> Offered`; `Mutation::{Service(&'static str), Kickstart}`; `auto_mutations(AutoAction) -> &'static [Mutation]`; `user_mutations(UserAction, Owner) -> Option<&'static [Mutation]>`; `unchanged(before: &Discovery, now: &Discovery) -> bool`; `restart_complete(old_pid_alive: bool, health_version: Option<&str>, expected: Option<&str>) -> bool`; `stop_complete(d: &Discovery) -> bool`; `ReloadOutcome::{Reloaded, Rejected { error: String, stage: Option<String> }, Failed(String)}`; `parse_reload(status: u16, body: &[u8]) -> ReloadOutcome`; test-only `fixture::discovery(patch) -> Discovery`.

Two deliberate readings of the spec, both in the safe direction: every automatic row (not only the two the spec names) runs at most once per launch, and the "no plist" install additionally requires that nothing answers the control address (Review Focus 3).

- [ ] **Step 1: Write the failing test**

`desktop/src/connect.rs`:

```rust
//! `__desktop-connect` discovery, the automatic-action table, and user actions with their
//! completion conditions. Everything that changes the service goes through here.

pub mod discovery;
pub mod policy;
```

Replace `desktop/src/connect/discovery/fixture.rs` (adds `discovery`, used by the policy, run and panel tests):

```rust
//! A `__desktop-connect` result shared by the connect tests: the spec's example, patched per case.

use super::{Discovery, parse_discovery};

pub(crate) const SPEC_EXAMPLE: &str = r#"{
  "protocolVersion": 1,
  "bundledVersion": "0.37.0",
  "unit": {
    "present": true,
    "wrapperValid": true,
    "target": "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
    "home": "/Users/me/.aio-proxy",
    "owner": "desktop"
  },
  "job": { "loaded": true, "disabled": false, "pid": 4310 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "ppid": 4310,
    "matchesJob": true
  },
  "token": "tok-abc"
}
"#;

/// The spec example with `patch` applied to its JSON before parsing.
pub(crate) fn discovery_with(patch: impl FnOnce(&mut serde_json::Value)) -> Result<Discovery, String> {
    let mut value: serde_json::Value = serde_json::from_str(SPEC_EXAMPLE).expect("fixture is JSON");
    patch(&mut value);
    parse_discovery(value.to_string().as_bytes())
}

/// Same, for tests that only build valid discoveries.
pub(crate) fn discovery(patch: impl FnOnce(&mut serde_json::Value)) -> Discovery {
    discovery_with(patch).expect("patched fixture parses")
}
```

Create `desktop/src/connect/policy.rs` with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/connect/policy/tests.rs`:

```rust
use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;

fn none() -> AutoAttempts {
    AutoAttempts::default()
}

fn auto(patch: impl FnOnce(&mut Value)) -> Option<AutoAction> {
    automatic_action(&discovery(patch), true, &none())
}

fn no_plist(v: &mut Value) {
    v["unit"] = json!({ "present": false, "wrapperValid": false, "target": null, "home": null, "owner": null });
    v["job"] = json!({ "loaded": false, "disabled": false, "pid": null });
    v["instance"] = json!({ "controlUrl": "http://127.0.0.1:9317", "reachable": false, "matchesJob": null });
}

fn stopped_process(v: &mut Value) {
    v["job"]["pid"] = Value::Null;
    v["instance"]["reachable"] = json!(false);
    v["instance"]["pid"] = Value::Null;
    v["instance"]["matchesJob"] = Value::Null;
}

#[test]
fn no_plist_installs_and_starts() {
    assert_eq!(auto(no_plist), Some(AutoAction::InstallAndStart));
}

#[test]
fn no_plist_with_a_hand_started_instance_on_the_port_is_left_alone() {
    assert_eq!(
        auto(|v| {
            no_plist(v);
            v["instance"]["reachable"] = json!(true);
        }),
        None
    );
}

#[test]
fn desktop_loaded_enabled_without_a_process_is_started() {
    assert_eq!(auto(stopped_process), Some(AutoAction::StartNoProcess));
}

#[test]
fn desktop_not_loaded_but_enabled_is_started() {
    assert_eq!(
        auto(|v| {
            stopped_process(v);
            v["job"]["loaded"] = json!(false);
        }),
        Some(AutoAction::StartNotLoaded)
    );
}

#[test]
fn a_user_stopped_desktop_service_is_never_started() {
    assert_eq!(
        auto(|v| {
            stopped_process(v);
            v["job"]["loaded"] = json!(false);
            v["job"]["disabled"] = json!(true);
        }),
        None
    );
}

#[test]
fn an_older_running_desktop_instance_is_restarted() {
    assert_eq!(auto(|_| {}), Some(AutoAction::RestartForVersion));
}

#[test]
fn a_same_or_newer_running_instance_is_never_downgraded() {
    for version in ["0.37.0", "0.38.0", "not-a-version"] {
        assert_eq!(auto(|v| v["instance"]["version"] = json!(version)), None, "{version}");
    }
}

#[test]
fn external_unknown_and_mismatched_instances_are_never_touched() {
    for owner in ["external", "unknown"] {
        assert_eq!(auto(|v| v["unit"]["owner"] = json!(owner)), None, "{owner}");
        assert_eq!(
            auto(|v| {
                v["unit"]["owner"] = json!(owner);
                stopped_process(v);
            }),
            None,
            "{owner}"
        );
    }
    assert_eq!(auto(|v| v["instance"]["matchesJob"] = json!(false)), None);
    assert_eq!(auto(|v| v["instance"]["matchesJob"] = Value::Null), None, "unknown counts as not matching");
}

#[test]
fn nothing_is_automatic_outside_a_persistent_install() {
    assert_eq!(automatic_action(&discovery(no_plist), false, &none()), None);
    assert_eq!(automatic_action(&discovery(stopped_process), false, &none()), None);
}

#[test]
fn each_automatic_action_runs_once_per_launch() {
    let d = discovery(stopped_process);
    let mut attempts = none();
    attempts.mark(AutoAction::StartNoProcess);
    assert_eq!(automatic_action(&d, true, &attempts), None);
    let older = discovery(|_| {});
    attempts.mark(AutoAction::RestartForVersion);
    assert_eq!(automatic_action(&older, true, &attempts), None);
}

#[test]
fn restart_uses_kickstart_for_external_and_service_restart_only_for_desktop() {
    assert_eq!(user_mutations(UserAction::Restart, Owner::Desktop), Some(&[Mutation::Service("restart")][..]));
    assert_eq!(user_mutations(UserAction::Restart, Owner::External), Some(&[Mutation::Kickstart][..]));
    for action in [UserAction::Start, UserAction::Restart, UserAction::Stop] {
        assert_eq!(user_mutations(action, Owner::Unknown), None);
        assert_eq!(user_mutations(action, Owner::NoPlist), None);
    }
    assert_eq!(user_mutations(UserAction::Start, Owner::External), Some(&[Mutation::Service("start")][..]));
}

#[test]
fn buttons_follow_ownership_and_running_state() {
    let running = offered_actions(&discovery(|_| {}), true);
    assert_eq!(running, Offered { start: false, restart: true, stop: true, reload: true });
    let stopped = offered_actions(&discovery(stopped_process), true);
    assert_eq!(stopped, Offered { start: true, restart: false, stop: false, reload: false });
    let unknown = offered_actions(&discovery(|v| v["unit"]["owner"] = json!("unknown")), true);
    assert_eq!(unknown, Offered { reload: true, ..Offered::default() });
    let read_only = offered_actions(&discovery(|_| {}), false);
    assert_eq!(read_only, Offered { reload: true, ..Offered::default() });
}

#[test]
fn a_changed_owner_match_or_disabled_flag_invalidates_the_decision() {
    let before = discovery(|_| {});
    assert!(unchanged(&before, &discovery(|v| v["job"]["pid"] = json!(9999))));
    assert!(!unchanged(&before, &discovery(|v| v["unit"]["owner"] = json!("external"))));
    assert!(!unchanged(&before, &discovery(|v| v["instance"]["matchesJob"] = json!(false))));
    assert!(!unchanged(&before, &discovery(|v| v["job"]["disabled"] = json!(true))));
}

#[test]
fn restart_completes_only_after_the_old_pid_is_gone_and_the_version_matches() {
    assert!(!restart_complete(true, Some("0.37.0"), Some("0.37.0")), "old sidecar still alive");
    assert!(!restart_complete(false, Some("0.36.0"), Some("0.37.0")), "old binary still serving");
    assert!(!restart_complete(false, None, Some("0.37.0")), "nothing answers yet");
    assert!(restart_complete(false, Some("0.37.0"), Some("0.37.0")));
    assert!(restart_complete(false, Some("0.35.0"), None), "external: any version");
}

#[test]
fn stop_completes_when_no_process_runs_and_nothing_answers() {
    assert!(!stop_complete(&discovery(|_| {})));
    assert!(stop_complete(&discovery(stopped_process)));
}

#[test]
fn reload_reports_the_409_error_and_stage() {
    assert_eq!(parse_reload(200, br#"{"ok":true,"diff":{}}"#), ReloadOutcome::Reloaded);
    assert_eq!(
        parse_reload(409, br#"{"ok":false,"error":"providers.x: bad key","stage":"validate"}"#),
        ReloadOutcome::Rejected { error: "providers.x: bad key".into(), stage: Some("validate".into()) }
    );
    assert!(matches!(parse_reload(403, b"Forbidden"), ReloadOutcome::Failed(_)));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib connect::policy`
Expected: FAIL to compile: `` cannot find function `automatic_action` ``, `` cannot find type `AutoAttempts` ``, `` cannot find function `user_mutations` ``.

- [ ] **Step 3: Implement**

`desktop/src/connect/policy.rs`:

```rust
//! The spec's automatic-action and user-action tables, and each action's completion condition.
//! Pure: callers pass a discovery and get a decision.

use std::cmp::Ordering;

use serde::Deserialize;

use super::discovery::{Discovery, Owner};
use crate::version;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoAction {
    /// No plist: `service install` + `service start`; the app now owns the service.
    InstallAndStart,
    /// Desktop, not loaded, enabled.
    StartNotLoaded,
    /// Desktop, loaded, enabled, no process: the recovery path.
    StartNoProcess,
    /// Desktop, running an older version than the symlink's.
    RestartForVersion,
}

/// Each automatic action runs at most once per app launch; a failure shows an error and never
/// loops (a broken config's exit 1 is remapped to 0 and looks identical to a clean stop).
#[derive(Debug, Default, Clone)]
pub struct AutoAttempts(Vec<AutoAction>);

impl AutoAttempts {
    pub fn used(&self, action: AutoAction) -> bool {
        self.0.contains(&action)
    }

    pub fn mark(&mut self, action: AutoAction) {
        if !self.used(action) {
            self.0.push(action);
        }
    }
}

/// `persistent` is the install-location check (and no newer copy owning the symlink).
pub fn automatic_action(d: &Discovery, persistent: bool, attempts: &AutoAttempts) -> Option<AutoAction> {
    if !persistent {
        return None;
    }
    let action = match d.unit.owner {
        // A hand-started `aio-proxy run` answering the port is not ours to replace.
        Owner::NoPlist if !d.instance.reachable => AutoAction::InstallAndStart,
        Owner::Desktop => {
            let ours = d.instance.matches_job == Some(true) || !d.instance.reachable;
            if !ours || d.job.disabled {
                return None;
            }
            if !d.job.loaded {
                AutoAction::StartNotLoaded
            } else if d.job.pid.is_none() {
                AutoAction::StartNoProcess
            } else {
                let running = d.instance.version.as_deref().filter(|_| d.instance.reachable)?;
                // Never downgrade: only strictly older instances restart; unknown versions do not.
                if version::compare(running, &d.bundled_version) != Some(Ordering::Less) {
                    return None;
                }
                AutoAction::RestartForVersion
            }
        }
        Owner::NoPlist | Owner::External | Owner::Unknown => return None,
    };
    (!attempts.used(action)).then_some(action)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserAction {
    Start,
    Restart,
    Stop,
    Reload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Offered {
    pub start: bool,
    pub restart: bool,
    pub stop: bool,
    pub reload: bool,
}

/// Which buttons the panel shows. Service actions need a persistent install and a desktop or
/// external owner; Reload only needs a reachable instance.
pub fn offered_actions(d: &Discovery, persistent: bool) -> Offered {
    let service = persistent && matches!(d.unit.owner, Owner::Desktop | Owner::External);
    let running = d.job.loaded && d.job.pid.is_some();
    Offered {
        start: service && !running,
        restart: service && running,
        stop: service && running,
        reload: d.instance.reachable && d.instance.control_url.is_some(),
    }
}

/// One step the CLI (or launchctl) performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mutation {
    /// `aio-proxy service <verb>`, always with `AIO_PROXY_DESKTOP_EXEC` set.
    Service(&'static str),
    /// `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent`: restarts an external service without
    /// rewriting its plist (`service restart` would rewrite it to the invoking binary).
    Kickstart,
}

pub fn auto_mutations(action: AutoAction) -> &'static [Mutation] {
    match action {
        AutoAction::InstallAndStart => &[Mutation::Service("install"), Mutation::Service("start")],
        AutoAction::StartNotLoaded | AutoAction::StartNoProcess => &[Mutation::Service("start")],
        AutoAction::RestartForVersion => &[Mutation::Service("restart")],
    }
}

/// The ownership table. `None` means not offered; Reload is HTTP and has no mutation.
pub fn user_mutations(action: UserAction, owner: Owner) -> Option<&'static [Mutation]> {
    match (action, owner) {
        (UserAction::Start, Owner::Desktop | Owner::External) => Some(&[Mutation::Service("start")]),
        (UserAction::Restart, Owner::Desktop) => Some(&[Mutation::Service("restart")]),
        (UserAction::Restart, Owner::External) => Some(&[Mutation::Kickstart]),
        (UserAction::Stop, Owner::Desktop | Owner::External) => Some(&[Mutation::Service("stop")]),
        _ => None,
    }
}

/// A mutation proceeds only if a fresh discovery agrees with the one it was decided on.
pub fn unchanged(before: &Discovery, now: &Discovery) -> bool {
    before.unit.owner == now.unit.owner
        && before.instance.matches_job == now.instance.matches_job
        && before.job.disabled == now.job.disabled
}

/// Restart is done once the pre-restart sidecar is gone and `/health` answers with the expected
/// version (`None` for an external service, whose binary version the app does not know). This guards
/// the case where the old sidecar outlives SIGTERM and keeps serving the old binary.
pub fn restart_complete(old_pid_alive: bool, health_version: Option<&str>, expected: Option<&str>) -> bool {
    if old_pid_alive {
        return false;
    }
    match (health_version, expected) {
        (Some(found), Some(expected)) => version::compare(found, expected) == Some(Ordering::Equal),
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// Stop is done once launchd reports no process and nothing answers.
pub fn stop_complete(d: &Discovery) -> bool {
    d.job.pid.is_none() && !d.instance.reachable
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReloadOutcome {
    Reloaded,
    /// 409 carries `error` and `stage`.
    Rejected {
        error: String,
        stage: Option<String>,
    },
    Failed(String),
}

pub fn parse_reload(status: u16, body: &[u8]) -> ReloadOutcome {
    #[derive(Deserialize)]
    struct Body {
        error: Option<String>,
        stage: Option<String>,
    }
    match status {
        200..=299 => ReloadOutcome::Reloaded,
        409 => match serde_json::from_slice::<Body>(body) {
            Ok(body) => ReloadOutcome::Rejected {
                error: body.error.unwrap_or_else(|| "config rejected".into()),
                stage: body.stage,
            },
            Err(_) => ReloadOutcome::Rejected { error: "config rejected".into(), stage: None },
        },
        other => ReloadOutcome::Failed(format!("reload answered HTTP {other}")),
    }
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib connect && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 23 passed` (7 discovery + 16 policy); clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/connect.rs desktop/src/connect/policy.rs desktop/src/connect/policy/tests.rs desktop/src/connect/discovery/fixture.rs
git commit -m "feat(desktop): encode the automatic and user action tables"
```

### Task 8: Action runner and the real CLI host

**Files:**
- Create: `desktop/src/connect/run.rs`, `desktop/src/connect/cli.rs`
- Modify: `desktop/src/connect.rs`
- Test: `desktop/src/connect/run/tests.rs`, `desktop/src/connect/cli/tests.rs`

**Interfaces:**
- Consumes: `connect::discovery::{Discovery, Owner, parse_discovery}` (Task 3); `connect::policy::*` (Task 7); `client::transport::{Cancel, Limits, LocalUrl, Method, Request, send}` (Task 4); `client::health::{HEALTH_TIMEOUT, parse_health}` (Task 5); `install::{Paths, sidecar_of}` and `process::{run_with_timeout, tail}` (Task 6).
- Produces (`aio_proxy_desktop::connect::run`): `RESTART_WAIT` (30 s), `STOP_WAIT` (30 s), `POLL_EVERY` (500 ms); `trait Host { fn discover(&self) -> Result<Discovery, String>; fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String>; fn pid_alive(&self, pid: u32) -> bool; fn health_version(&self, control_url: &str) -> Option<String>; fn reload(&self, control_url: &str) -> ReloadOutcome; fn sleep(&self, duration: Duration); fn now(&self) -> Instant; }`; `RunError::{Changed, NotOffered, Discovery(String), Command(String), TimedOut(&'static str)}` with `Display`; `run_auto(host: &impl Host, decided_on: &Discovery, action: AutoAction) -> Result<Discovery, RunError>`; `run_user(host: &impl Host, rendered: &Discovery, action: UserAction) -> Result<Discovery, RunError>`; `run_reload(host: &impl Host, rendered: &Discovery) -> Result<ReloadOutcome, RunError>`.
- Produces (`aio_proxy_desktop::connect::cli`): `LAUNCHD_LABEL` (`com.aio-proxy.agent`), `DISCOVERY_TIMEOUT` (15 s), `SERVICE_TIMEOUT` (60 s); `SystemHost { exec: PathBuf, desktop_exec: PathBuf, uid: u32 }` with `SystemHost::new(paths: &Paths, bundle: Option<&Path>) -> Option<SystemHost>`, `cli(&self, args: &[&str], home: Option<&str>) -> std::process::Command`, and `impl Host`.

The restart wait checks the old sidecar pid with `kill(pid, 0)` and only then asks `/health`: this is the guard against an old sidecar that outlives SIGTERM and keeps serving the old binary (spec, Stop and restart signals; findings C8). `service restart` itself waits up to 10 s for bootout and `kickstart -k` blocks about 7 s (findings, Task 5), hence the 60 s command timeout.

- [ ] **Step 1: Write the failing test**

`desktop/src/connect.rs`:

```rust
//! `__desktop-connect` discovery, the automatic-action table, and user actions with their
//! completion conditions. Everything that changes the service goes through here.

pub mod cli;
pub mod discovery;
pub mod policy;
pub mod run;
```

Create `desktop/src/connect/run.rs` and `desktop/src/connect/cli.rs`, each with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/connect/run/tests.rs`:

```rust
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;

/// Scripted host: discoveries, liveness and health answers are consumed in order (the last one
/// repeats); sleeping advances a fake clock.
struct Fake {
    discoveries: RefCell<VecDeque<Discovery>>,
    alive: RefCell<VecDeque<bool>>,
    health: RefCell<VecDeque<Option<String>>>,
    mutations: RefCell<Vec<(Mutation, Option<String>)>>,
    clock: Cell<Instant>,
}

fn next<T: Clone>(queue: &RefCell<VecDeque<T>>) -> T {
    let mut queue = queue.borrow_mut();
    if queue.len() > 1 { queue.pop_front().unwrap() } else { queue.front().cloned().expect("script ran dry") }
}

impl Fake {
    fn new(discoveries: Vec<Discovery>) -> Self {
        Self {
            discoveries: RefCell::new(discoveries.into()),
            alive: RefCell::new(VecDeque::from([false])),
            health: RefCell::new(VecDeque::from([None])),
            mutations: RefCell::default(),
            clock: Cell::new(Instant::now()),
        }
    }

    fn mutations(&self) -> Vec<Mutation> {
        self.mutations.borrow().iter().map(|(m, _)| *m).collect()
    }
}

impl Host for Fake {
    fn discover(&self) -> Result<Discovery, String> {
        Ok(next(&self.discoveries))
    }
    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String> {
        self.mutations.borrow_mut().push((mutation, home.map(str::to_string)));
        Ok(())
    }
    fn pid_alive(&self, _pid: u32) -> bool {
        next(&self.alive)
    }
    fn health_version(&self, _control_url: &str) -> Option<String> {
        next(&self.health)
    }
    fn reload(&self, _control_url: &str) -> ReloadOutcome {
        ReloadOutcome::Reloaded
    }
    fn sleep(&self, duration: Duration) {
        self.clock.set(self.clock.get() + duration);
    }
    fn now(&self) -> Instant {
        self.clock.get()
    }
}

fn stopped(v: &mut Value) {
    v["job"]["pid"] = Value::Null;
    v["instance"]["reachable"] = json!(false);
    v["instance"]["pid"] = Value::Null;
    v["instance"]["matchesJob"] = Value::Null;
}

#[test]
fn a_user_stop_between_discovery_and_an_automatic_start_wins() {
    let decided = discovery(stopped);
    let host = Fake::new(vec![discovery(|v| {
        stopped(v);
        v["job"]["disabled"] = json!(true);
    })]);
    assert_eq!(run_auto(&host, &decided, AutoAction::StartNoProcess).unwrap_err(), RunError::Changed);
    assert!(host.mutations().is_empty());
}

#[test]
fn a_click_is_refused_when_the_service_changed_owner() {
    let rendered = discovery(|_| {});
    let host = Fake::new(vec![discovery(|v| v["unit"]["owner"] = json!("external"))]);
    assert_eq!(run_user(&host, &rendered, UserAction::Stop).unwrap_err(), RunError::Changed);
    assert!(host.mutations().is_empty());
}

#[test]
fn install_and_start_run_in_order() {
    let no_plist = |v: &mut Value| {
        v["unit"] = json!({ "present": false, "owner": null });
        stopped(v);
        v["job"]["loaded"] = json!(false);
    };
    let host = Fake::new(vec![discovery(no_plist)]);
    run_auto(&host, &discovery(no_plist), AutoAction::InstallAndStart).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("install"), Mutation::Service("start")]);
    assert_eq!(host.mutations.borrow()[0].1, None, "a fresh install uses the default home");
}

#[test]
fn service_commands_carry_the_plist_home() {
    let host = Fake::new(vec![discovery(stopped)]);
    run_user(&host, &discovery(stopped), UserAction::Start).unwrap();
    assert_eq!(host.mutations.borrow()[0], (Mutation::Service("start"), Some("/Users/me/.aio-proxy".into())));
}

#[test]
fn an_external_restart_kickstarts_and_never_rewrites_the_plist() {
    let external = |v: &mut Value| v["unit"]["owner"] = json!("external");
    let host = Fake::new(vec![discovery(external)]);
    *host.health.borrow_mut() = VecDeque::from([Some("0.20.0".to_string())]);
    run_user(&host, &discovery(external), UserAction::Restart).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Kickstart]);
}

#[test]
fn restart_waits_for_the_old_sidecar_to_die_and_the_new_version_to_answer() {
    let host = Fake::new(vec![discovery(|_| {})]);
    *host.alive.borrow_mut() = VecDeque::from([true, true, false]);
    *host.health.borrow_mut() = VecDeque::from([Some("0.36.0".to_string()), Some("0.37.0".to_string())]);
    let started = host.now();
    run_auto(&host, &discovery(|_| {}), AutoAction::RestartForVersion).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("restart")]);
    assert_eq!(host.now() - started, POLL_EVERY * 3, "two polls with the old pid alive, one on the old version");
}

#[test]
fn restart_times_out_when_the_old_sidecar_never_exits() {
    let host = Fake::new(vec![discovery(|_| {})]);
    *host.alive.borrow_mut() = VecDeque::from([true]);
    let started = host.now();
    let error = run_user(&host, &discovery(|_| {}), UserAction::Restart).unwrap_err();
    assert_eq!(error, RunError::TimedOut("restart"));
    let waited = host.now() - started;
    assert!(waited >= RESTART_WAIT && waited <= RESTART_WAIT + POLL_EVERY, "{waited:?}");
}

#[test]
fn stop_waits_for_no_process_and_no_answer() {
    let host = Fake::new(vec![discovery(|_| {}), discovery(|_| {}), discovery(stopped)]);
    let done = run_user(&host, &discovery(|_| {}), UserAction::Stop).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("stop")]);
    assert!(stop_complete(&done));
}

#[test]
fn unknown_owners_get_no_service_action() {
    let unknown = discovery(|v| v["unit"]["owner"] = json!("unknown"));
    let host = Fake::new(vec![unknown.clone()]);
    assert_eq!(run_user(&host, &unknown, UserAction::Restart).unwrap_err(), RunError::NotOffered);
    assert_eq!(run_reload(&host, &unknown).unwrap(), ReloadOutcome::Reloaded);
}
```

`desktop/src/connect/cli/tests.rs`:

```rust
use std::ffi::OsStr;
use std::path::PathBuf;

use super::*;

fn host(exec: &str) -> SystemHost {
    SystemHost {
        exec: PathBuf::from(exec),
        desktop_exec: PathBuf::from("/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy"),
        uid: 501,
    }
}

fn env_of<'a>(command: &'a Command, name: &str) -> Option<Option<&'a OsStr>> {
    command.get_envs().find(|(key, _)| *key == name).map(|(_, value)| value)
}

#[test]
fn every_cli_child_gets_the_symlink_marker_and_no_inherited_home() {
    let command = host("/bin/sh").cli(&["__desktop-connect"], None);
    assert_eq!(
        env_of(&command, "AIO_PROXY_DESKTOP_EXEC"),
        Some(Some(OsStr::new("/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy")))
    );
    assert_eq!(env_of(&command, "AIO_PROXY_HOME"), Some(None), "removed, not inherited");
    assert_eq!(env_of(&command, "AIO_PROXY_MANAGED"), Some(None));
    assert_eq!(env_of(&command, "XPC_SERVICE_NAME"), Some(None));
}

#[test]
fn a_service_command_carries_the_plist_home() {
    let command = host("/bin/sh").cli(&["service", "restart"], Some("/Users/me/.aio-proxy-work"));
    assert_eq!(env_of(&command, "AIO_PROXY_HOME"), Some(Some(OsStr::new("/Users/me/.aio-proxy-work"))));
}

#[test]
fn discovery_reads_the_childs_stdout_and_reports_failures_without_it() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("aio-proxy");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n[ \"$1\" = __desktop-connect ] || exit 9\ncat <<'JSON'\n{}JSON\n",
            crate::connect::discovery::fixture::SPEC_EXAMPLE
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let found = SystemHost { exec: script.clone(), ..host("/bin/sh") }.discover().unwrap();
    assert_eq!(found.bundled_version, "0.37.0");

    std::fs::write(&script, "#!/bin/sh\necho '{\"token\":\"tok-leak\"}'\necho boom >&2\nexit 2\n").unwrap();
    let error = SystemHost { exec: script, ..host("/bin/sh") }.discover().unwrap_err();
    assert!(error.contains("boom") && !error.contains("tok-leak"), "{error}");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib connect`
Expected: FAIL to compile: `` cannot find trait `Host` ``, `` cannot find function `run_auto` ``, `` cannot find type `SystemHost` ``.

- [ ] **Step 3: Implement**

`desktop/src/connect/run.rs`:

```rust
//! Runs a decided action end to end: fresh discovery, precondition, mutation, completion wait.
//! Blocking; the app calls it on a background thread. `Host` is the seam the tests fake.

use std::fmt;
use std::time::{Duration, Instant};

use super::discovery::{Discovery, Owner};
use super::policy::{
    AutoAction, Mutation, ReloadOutcome, UserAction, auto_mutations, restart_complete, stop_complete, unchanged,
    user_mutations,
};

pub const RESTART_WAIT: Duration = Duration::from_secs(30);
pub const STOP_WAIT: Duration = Duration::from_secs(30);
pub const POLL_EVERY: Duration = Duration::from_millis(500);

pub trait Host {
    fn discover(&self) -> Result<Discovery, String>;
    /// `home` is the plist's `AIO_PROXY_HOME`, so a rewrite keeps the service's own config.
    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String>;
    fn pid_alive(&self, pid: u32) -> bool;
    /// `/health`'s version, or `None` when nothing healthy answers.
    fn health_version(&self, control_url: &str) -> Option<String>;
    fn reload(&self, control_url: &str) -> ReloadOutcome;
    fn sleep(&self, duration: Duration);
    fn now(&self) -> Instant;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// Ownership, `matchesJob` or `job.disabled` changed since the decision; nothing was done.
    Changed,
    NotOffered,
    Discovery(String),
    Command(String),
    TimedOut(&'static str),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Changed => f.write_str("the service changed since the panel was shown; nothing was done"),
            RunError::NotOffered => f.write_str("this action is not available for this service"),
            RunError::Discovery(error) => write!(f, "could not inspect the service: {error}"),
            RunError::Command(error) => f.write_str(error),
            RunError::TimedOut(what) => write!(f, "{what} did not finish in time"),
        }
    }
}

enum Wait {
    Nothing,
    Restart { old_pid: Option<u32>, expected: Option<String>, control_url: Option<String> },
    Stop,
}

pub fn run_auto(host: &impl Host, decided_on: &Discovery, action: AutoAction) -> Result<Discovery, RunError> {
    let now = fresh(host, decided_on)?;
    let wait = match action {
        AutoAction::RestartForVersion => restart_wait(&now, Some(now.bundled_version.clone())),
        _ => Wait::Nothing,
    };
    execute(host, &now, auto_mutations(action), wait)
}

pub fn run_user(host: &impl Host, rendered: &Discovery, action: UserAction) -> Result<Discovery, RunError> {
    let mutations = user_mutations(action, rendered.unit.owner).ok_or(RunError::NotOffered)?;
    let now = fresh(host, rendered)?;
    let wait = match action {
        UserAction::Restart => {
            let expected = (now.unit.owner == Owner::Desktop).then(|| now.bundled_version.clone());
            restart_wait(&now, expected)
        }
        UserAction::Stop => Wait::Stop,
        UserAction::Start | UserAction::Reload => Wait::Nothing,
    };
    execute(host, &now, mutations, wait)
}

/// Reload is plain HTTP to the instance and carries no ownership precondition.
pub fn run_reload(host: &impl Host, rendered: &Discovery) -> Result<ReloadOutcome, RunError> {
    let url = rendered.instance.control_url.as_deref().ok_or(RunError::NotOffered)?;
    Ok(host.reload(url))
}

fn fresh(host: &impl Host, decided_on: &Discovery) -> Result<Discovery, RunError> {
    let now = host.discover().map_err(RunError::Discovery)?;
    if unchanged(decided_on, &now) { Ok(now) } else { Err(RunError::Changed) }
}

fn restart_wait(now: &Discovery, expected: Option<String>) -> Wait {
    Wait::Restart { old_pid: now.instance.pid, expected, control_url: now.instance.control_url.clone() }
}

fn execute(host: &impl Host, now: &Discovery, mutations: &[Mutation], wait: Wait) -> Result<Discovery, RunError> {
    for &mutation in mutations {
        host.mutate(mutation, now.unit.home.as_deref()).map_err(RunError::Command)?;
    }
    match wait {
        Wait::Nothing => {}
        Wait::Restart { old_pid, expected, control_url } => {
            poll(host, RESTART_WAIT, "restart", || {
                let alive = old_pid.is_some_and(|pid| host.pid_alive(pid));
                let health = match (&control_url, alive) {
                    (Some(url), false) => host.health_version(url),
                    _ => None,
                };
                Ok(restart_complete(alive, health.as_deref(), expected.as_deref()) || (control_url.is_none() && !alive))
            })?;
        }
        Wait::Stop => {
            poll(host, STOP_WAIT, "stop", || Ok(stop_complete(&host.discover().map_err(RunError::Discovery)?)))?;
        }
    }
    host.discover().map_err(RunError::Discovery)
}

fn poll(
    host: &impl Host,
    budget: Duration,
    what: &'static str,
    mut done: impl FnMut() -> Result<bool, RunError>,
) -> Result<(), RunError> {
    let deadline = host.now() + budget;
    loop {
        if done()? {
            return Ok(());
        }
        if host.now() >= deadline {
            return Err(RunError::TimedOut(what));
        }
        host.sleep(POLL_EVERY);
    }
}

#[cfg(test)]
mod tests;
```

`desktop/src/connect/cli.rs`:

```rust
//! The real `Host`: the bundled CLI (through the symlink when it exists), launchctl, and the local
//! transport. Every CLI child gets `AIO_PROXY_DESKTOP_EXEC=<symlink>`, the only input that makes a
//! plist desktop-owned.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::discovery::{Discovery, parse_discovery};
use super::policy::{Mutation, ReloadOutcome, parse_reload};
use super::run::Host;
use crate::client::health::{HEALTH_TIMEOUT, parse_health};
use crate::client::transport::{Cancel, Limits, LocalUrl, Method, Request, send};
use crate::install::{Paths, sidecar_of};
use crate::process::{run_with_timeout, tail};

pub const LAUNCHD_LABEL: &str = "com.aio-proxy.agent";
/// The CLI bounds `__desktop-connect` at 10 s; this only catches a wedged process.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// `service restart` may wait 10 s for bootout, and `kickstart -k` blocks about 7 s.
pub const SERVICE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct SystemHost {
    /// The symlink when it resolves, else this bundle's sidecar.
    pub exec: PathBuf,
    pub desktop_exec: PathBuf,
    pub uid: u32,
}

impl SystemHost {
    pub fn new(paths: &Paths, bundle: Option<&Path>) -> Option<Self> {
        let exec = if paths.symlink.exists() { paths.symlink.clone() } else { sidecar_of(bundle?) };
        exec.exists().then(|| Self {
            exec,
            desktop_exec: paths.symlink.clone(),
            // SAFETY: getuid never fails.
            uid: unsafe { libc::getuid() },
        })
    }

    /// The child environment contract. The app never passes its own `AIO_PROXY_HOME` (discovery
    /// reads the plist's), and drops the markers that would make `service restart` think it runs
    /// inside the launchd job.
    pub fn cli(&self, args: &[&str], home: Option<&str>) -> Command {
        let mut command = Command::new(&self.exec);
        command
            .args(args)
            .env("AIO_PROXY_DESKTOP_EXEC", &self.desktop_exec)
            .env_remove("AIO_PROXY_HOME")
            .env_remove("AIO_PROXY_MANAGED")
            .env_remove("XPC_SERVICE_NAME");
        if let Some(home) = home {
            command.env("AIO_PROXY_HOME", home);
        }
        command
    }
}

fn check(command: Command, timeout: Duration, what: &str) -> Result<Vec<u8>, String> {
    let output = run_with_timeout(command, timeout).map_err(|error| format!("{what}: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(format!("{what} failed ({}): {}", output.status, tail(&output.stderr, 600)))
    }
}

impl Host for SystemHost {
    fn discover(&self) -> Result<Discovery, String> {
        parse_discovery(&check(self.cli(&["__desktop-connect"], None), DISCOVERY_TIMEOUT, "__desktop-connect")?)
    }

    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String> {
        match mutation {
            Mutation::Service(verb) => {
                check(self.cli(&["service", verb], home), SERVICE_TIMEOUT, &format!("service {verb}")).map(drop)
            }
            Mutation::Kickstart => {
                let mut command = Command::new("/bin/launchctl");
                command.args(["kickstart", "-k", &format!("gui/{}/{LAUNCHD_LABEL}", self.uid)]);
                check(command, SERVICE_TIMEOUT, "launchctl kickstart -k").map(drop)
            }
        }
    }

    fn pid_alive(&self, pid: u32) -> bool {
        // SAFETY: signal 0 only checks existence.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        // EPERM: it exists under another user.
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn health_version(&self, control_url: &str) -> Option<String> {
        let url = LocalUrl::parse(control_url, "/health").ok()?;
        let limits = Limits { total: HEALTH_TIMEOUT, ..Limits::default() };
        let response = send(&Request { method: Method::Get, url, bearer: None }, limits, &Cancel::default()).ok()?;
        parse_health(response.status, &response.body)?.version
    }

    fn reload(&self, control_url: &str) -> ReloadOutcome {
        let url = match LocalUrl::parse(control_url, "/admin/reload") {
            Ok(url) => url,
            Err(error) => return ReloadOutcome::Failed(error.to_string()),
        };
        match send(&Request { method: Method::Post, url, bearer: None }, Limits::default(), &Cancel::default()) {
            Ok(response) => parse_reload(response.status, &response.body),
            Err(error) => ReloadOutcome::Failed(error.to_string()),
        }
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 82 passed`; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/connect.rs desktop/src/connect/run.rs desktop/src/connect/run/tests.rs desktop/src/connect/cli.rs desktop/src/connect/cli/tests.rs
git commit -m "feat(desktop): run service actions with preconditions and completion waits"
```


### Task 9: Sparkle fetch, build.rs linking and the unsigned bundle command

**Files:**
- Create: `desktop/scripts/bundle.ts`, `desktop/scripts/tsconfig.json`, `desktop/scripts/macho/{index.ts,macho.ts}`, `desktop/scripts/info-plist/{index.ts,info-plist.ts}`, `desktop/scripts/sparkle/{index.ts,sparkle.ts}`, `desktop/scripts/smoke/{index.ts,smoke.ts}`, `desktop/entitlements/aio-proxy.plist`, `desktop/entitlements/adhoc-host.plist`
- Modify: `desktop/build.rs`, `package.json`
- Test: `desktop/scripts/macho/macho.test.ts`, `desktop/scripts/info-plist/info-plist.test.ts`; the bundle run itself (runtime smoke)

**Interfaces:**
- Consumes: `packages/cli/scripts/build-binary.ts darwin-arm64 <outfile>` (writes `THIRD_PARTY_NOTICES` beside the outfile); `aio-proxy run --port <n>` bootstrapping a config in an empty `AIO_PROXY_HOME` and creating `desktop-token` there; the binary's `--version` (Task 1).
- Produces: `bun run desktop:bundle --unsigned [--sidecar <path>]` → `desktop/target/bundle/AIO Proxy.app` (ad-hoc hardened signature). Env: `SPARKLE_PUBLIC_ED_KEY` (writes `SUFeedURL` + `SUPublicEDKey`; without it the updater stays off), `SPARKLE_FEED_URL` (default `https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml`). `build.rs` links `Sparkle.framework` from `SPARKLE_DIR` and adds the rpath `@loader_path/../Frameworks` only when `SPARKLE_DIR` is set, so `cargo test`/`cargo run` need no framework. TS: `machOProblems(check: MachOCheck) -> string[]`, `parseMinos(vtoolOutput) -> string[]`, `versionAtMost(a, b) -> boolean`, `MINIMUM_MACOS`; `renderInfoPlist(options: InfoPlistOptions) -> string`, `BUNDLE_ID`, `DEFAULT_FEED_URL`; `fetchSparkle(vendorDir) -> Promise<string>`, `SPARKLE_VERSION`, `SPARKLE_SHA256`; `runtimeSmoke(app, version) -> Promise<void>`.

Derived from the spike: `spike/desktop-host/build.rs` (framework search path, `-framework Sparkle`, rpath), `spike/desktop-host/bundle.sh` (layout; `ditto` for the framework), `spike/desktop-host/sign.sh` (inside-out order, `--preserve-metadata=entitlements` on `Downloader.xpc`, host entitlements repeated on the `.app` step because signing the `.app` re-signs its main executable), `spike/desktop-host/entitlements/adhoc-host.plist`. Read them with `git show spike/desktop:<path>`.

The spec's order is kept: checks (step 6), runtime smoke (step 7), then the ad-hoc signature (step 8, "`--unsigned` stops here"). The host's `--version` runs both before and after signing: after signing it proves the hardened ad-hoc host still loads Sparkle through `disable-library-validation`. Step 1 skips `notarytool`, `stapler` and the Sparkle signing tools under `--unsigned`; Phase 3 adds them with signing.

Entitlement files keep their justification comments inside `<dict>`, and an XML comment must never contain `--` (AMFI rejects the file with "AMFIUnserializeXML: syntax error"; a comment mentioning the `--unsigned` flag did exactly that).

- [ ] **Step 1: Write the failing test**

`desktop/scripts/macho/macho.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { machOProblems, parseMinos, versionAtMost } from './macho';

const UNIVERSAL = `Sparkle (architecture x86_64):
Load command 9
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 12.0
      sdk 15.0
Sparkle (architecture arm64):
Load command 9
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 12.0
      sdk 15.0
`;

test('reads every slice minos', () => {
  expect(parseMinos(UNIVERSAL)).toEqual(['12.0', '12.0']);
});

test('compares dotted versions numerically', () => {
  expect(versionAtMost('12.0', '13.0')).toBe(true);
  expect(versionAtMost('13.0', '13.0')).toBe(true);
  expect(versionAtMost('13.1', '13.0')).toBe(false);
  expect(versionAtMost('9.9', '13.0')).toBe(true);
});

test('the host and sidecar must be arm64 only; Sparkle only needs to include it', () => {
  const vtool = ' platform MACOS\n    minos 13.0\n';
  expect(machOProblems({ path: 'host', archs: 'arm64\n', vtool, exactArm64: true })).toEqual([]);
  expect(machOProblems({ path: 'host', archs: 'x86_64 arm64', vtool, exactArm64: true })).toHaveLength(1);
  expect(machOProblems({ path: 'Sparkle', archs: 'x86_64 arm64', vtool: UNIVERSAL, exactArm64: false })).toEqual([]);
});

test('a minos above 13.0 or a missing one fails', () => {
  expect(machOProblems({ path: 'x', archs: 'arm64', vtool: '    minos 14.0\n', exactArm64: true })).toHaveLength(1);
  expect(machOProblems({ path: 'x', archs: 'arm64', vtool: 'garbage', exactArm64: true })).toEqual([
    'x: vtool reported no minos',
  ]);
});
```

`desktop/scripts/info-plist/info-plist.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { renderInfoPlist } from './info-plist';

test('updates are user-driven: automatic updates are off and never silently installed', () => {
  const plist = renderInfoPlist({
    version: '0.37.0',
    sparkle: { feedUrl: 'https://example.test/appcast.xml', publicEdKey: 'KEY=' },
  });
  expect(plist).toContain('<key>SUAllowsAutomaticUpdates</key><false/>');
  expect(plist).not.toContain('SUAutomaticallyUpdate');
  expect(plist).toContain('<key>LSUIElement</key><true/>');
  expect(plist).toContain('<key>LSMinimumSystemVersion</key><string>13.0</string>');
  expect(plist).toContain('<key>CFBundleVersion</key><string>0.37.0</string>');
});

test('without a public key the feed is left out, so the app keeps its updater off', () => {
  const plist = renderInfoPlist({ version: '0.37.0' });
  expect(plist).not.toContain('SUFeedURL');
  expect(plist).not.toContain('SUPublicEDKey');
});
```

In `package.json`, change the `test:unit` script so the new tests run:

```json
    "test:unit": "bun test ./scripts ./desktop/scripts && turbo run test:unit --filter=!@aio-proxy/website",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./desktop/scripts`
Expected: FAIL: `Cannot find module './macho'` and `Cannot find module './info-plist'`.

- [ ] **Step 3: Implement**

`desktop/scripts/macho/macho.ts`:

```ts
// Parsers for the bundle checks. A parse miss must fail the check, never pass it.

export const MINIMUM_MACOS = '13.0';

/** Every `minos` in `vtool -show-build` output; one per architecture slice. */
export function parseMinos(vtoolOutput: string): string[] {
  return [...vtoolOutput.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gmu)].map((match) => match[1] ?? '');
}

/** `a <= b` for dotted numeric versions (`12.0` vs `13.0`). */
export function versionAtMost(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

export type MachOCheck = {
  readonly path: string;
  readonly archs: string;
  readonly vtool: string;
  readonly exactArm64: boolean;
};

/** Problems with one Mach-O; empty when it passes. */
export function machOProblems({ path, archs, vtool, exactArm64 }: MachOCheck): string[] {
  const problems: string[] = [];
  const list = archs.trim().split(/\s+/u).filter(Boolean);
  if (exactArm64 ? list.join(' ') !== 'arm64' : !list.includes('arm64')) {
    problems.push(`${path}: architectures "${archs.trim()}", expected ${exactArm64 ? 'exactly' : 'to include'} arm64`);
  }
  const minos = parseMinos(vtool);
  if (minos.length === 0) problems.push(`${path}: vtool reported no minos`);
  for (const version of minos) {
    if (!versionAtMost(version, MINIMUM_MACOS)) problems.push(`${path}: minos ${version} is above ${MINIMUM_MACOS}`);
  }
  return problems;
}
```

`desktop/scripts/macho/index.ts`:

```ts
export { MINIMUM_MACOS, machOProblems, parseMinos, versionAtMost, type MachOCheck } from './macho';
```

`desktop/scripts/info-plist/info-plist.ts`:

```ts
import { MINIMUM_MACOS } from '../macho';

export const BUNDLE_ID = 'com.aio-proxy.desktop';
export const DEFAULT_FEED_URL = 'https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml';

export type InfoPlistOptions = {
  readonly version: string;
  /** Written only with a public key: without one the app keeps its updater off. */
  readonly sparkle?: { readonly feedUrl: string; readonly publicEdKey: string };
};

const escape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const entry = (key: string, value: string | boolean): string =>
  typeof value === 'boolean'
    ? `  <key>${key}</key><${value}/>`
    : `  <key>${key}</key><string>${escape(value)}</string>`;

/** `SUAutomaticallyUpdate` is never written: a silent install-on-quit would not relaunch the app. */
export function renderInfoPlist({ version, sparkle }: InfoPlistOptions): string {
  const entries: (readonly [string, string | boolean])[] = [
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', 'aio-proxy-desktop'],
    ['CFBundleName', 'AIO Proxy'],
    ['CFBundleDisplayName', 'AIO Proxy'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['LSUIElement', true],
    ['LSMinimumSystemVersion', MINIMUM_MACOS],
    ['SUAllowsAutomaticUpdates', false],
    ...(sparkle === undefined
      ? []
      : ([
          ['SUFeedURL', sparkle.feedUrl],
          ['SUPublicEDKey', sparkle.publicEdKey],
        ] as const)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([key, value]) => entry(key, value)).join('\n')}
</dict>
</plist>
`;
}
```

`desktop/scripts/info-plist/index.ts`:

```ts
export { BUNDLE_ID, DEFAULT_FEED_URL, renderInfoPlist, type InfoPlistOptions } from './info-plist';
```

`desktop/scripts/sparkle/sparkle.ts`:

```ts
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { $ } from 'bun';

export const SPARKLE_VERSION = '2.10.0';
export const SPARKLE_SHA256 = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';
const ARCHIVE = `Sparkle-${SPARKLE_VERSION}.tar.xz`;
const URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/${ARCHIVE}`;

const sha256 = async (path: string): Promise<string> =>
  new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');

/**
 * Downloads (once) and verifies the pinned Sparkle archive, then extracts it with `tar -xJf` so the
 * framework's symlinks survive. Returns the directory holding `Sparkle.framework` and `bin/`.
 */
export async function fetchSparkle(vendorDir: string): Promise<string> {
  mkdirSync(vendorDir, { recursive: true });
  const archive = join(vendorDir, ARCHIVE);
  if (!existsSync(archive)) {
    const response = await fetch(URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`download ${URL}: HTTP ${response.status}`);
    await Bun.write(archive, response);
  }
  const actual = await sha256(archive);
  if (actual !== SPARKLE_SHA256) {
    throw new Error(`${archive}: SHA-256 ${actual}, expected ${SPARKLE_SHA256}. Delete it and retry.`);
  }
  const dir = join(vendorDir, `sparkle-${SPARKLE_VERSION}`);
  if (!existsSync(join(dir, 'Sparkle.framework'))) {
    mkdirSync(dir, { recursive: true });
    await $`tar -xJf ${archive} -C ${dir}`;
  }
  return dir;
}
```

`desktop/scripts/sparkle/index.ts`:

```ts
export { SPARKLE_SHA256, SPARKLE_VERSION, fetchSparkle } from './sparkle';
```

`desktop/scripts/smoke/smoke.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = (): number => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

async function waitForHealth(base: string, deadline: number): Promise<{ version?: string }> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return (await response.json()) as { version?: string };
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${base}/health never answered`);
}

const expectStatus = async (label: string, response: Response, status: number): Promise<Response> => {
  if (response.status !== status) throw new Error(`${label}: HTTP ${response.status}, expected ${status}`);
  return response;
};

/**
 * Runs the bundled sidecar with a throwaway home on a free port and no user tools on PATH, checks
 * what the app depends on, then SIGTERMs it. It never installs a launchd job.
 */
export async function runtimeSmoke(app: string, version: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-smoke-'));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const proxy = Bun.spawn([join(app, 'Contents/MacOS/aio-proxy'), 'run', '--port', String(port)], {
    env: { PATH: '/usr/bin:/bin', HOME: home, AIO_PROXY_HOME: home, NO_PROXY: '*', no_proxy: '*' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    const health = await waitForHealth(base, Date.now() + 30_000);
    if (health.version !== version) throw new Error(`/health reports ${health.version}, bundle is ${version}`);
    const html = await (await expectStatus('/dashboard', await fetch(`${base}/dashboard`), 200)).text();
    const asset = /(?:src|href)="(\/dashboard\/static\/[^"]+)"/u.exec(html)?.[1];
    if (asset === undefined) throw new Error('/dashboard HTML references no static asset');
    await expectStatus(asset, await fetch(`${base}${asset}`), 200);
    const token = (await Bun.file(join(home, 'desktop-token')).text()).trim();
    await expectStatus(
      'desktop-summary',
      await fetch(`${base}/dashboard/api/desktop-summary`, { headers: { authorization: `Bearer ${token}` } }),
      200,
    );
  } finally {
    proxy.kill('SIGTERM');
    await proxy.exited;
    rmSync(home, { recursive: true, force: true });
  }
}
```

`desktop/scripts/smoke/index.ts`:

```ts
export { runtimeSmoke } from './smoke';
```

`desktop/scripts/bundle.ts`:

```ts
// The only entry point that assembles the macOS app: `bun run desktop:bundle --unsigned`.
// Phase 2 implements the unsigned path (steps 1-8 of the spec's Bundle command, ending in an ad-hoc
// signature). Release signing and notarization extend this file in Phase 3.
//
//   --unsigned           required for now; stops after the ad-hoc signature
//   --sidecar <path>     reuse an already-built `aio-proxy` (with THIRD_PARTY_NOTICES beside it)
//                        instead of `bun run build` + build-binary.ts
// Env: SPARKLE_PUBLIC_ED_KEY enables the updater; SPARKLE_FEED_URL overrides the release feed.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { DEFAULT_FEED_URL, renderInfoPlist } from './info-plist';
import { MINIMUM_MACOS, machOProblems } from './macho';
import { runtimeSmoke } from './smoke';
import { fetchSparkle } from './sparkle';

const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');
const app = join(out, 'AIO Proxy.app');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { unsigned: { type: 'boolean', default: false }, sidecar: { type: 'string' } },
});
if (!values.unsigned) {
  console.error('Only `--unsigned` is implemented; release signing lands with the release pipeline.');
  process.exit(2);
}

const step = (name: string): void => console.error(`\n==> ${name}`);

step('1. verify tools');
for (const tool of ['cargo', 'codesign', 'vtool', 'lipo', 'ditto', 'tar']) {
  if (Bun.which(tool) === null) throw new Error(`missing tool: ${tool}`);
}
const sparkle = await fetchSparkle(join(desktop, 'vendor'));
const version = ((await Bun.file(join(root, 'npm/aio-proxy/package.json')).json()) as { version: string }).version;

let sidecar = values.sidecar;
if (sidecar === undefined) {
  step('2. bun run build');
  await $`bun run build`.cwd(root);
  step('3. build-binary.ts darwin-arm64');
  sidecar = join(out, 'sidecar', 'aio-proxy');
  await $`bun packages/cli/scripts/build-binary.ts darwin-arm64 ${sidecar}`.cwd(root);
} else {
  step('2-3. reuse --sidecar');
}
const notices = join(dirname(sidecar), 'THIRD_PARTY_NOTICES');
if (!existsSync(notices)) throw new Error(`${notices} is missing`);

step('4. cargo build --release');
await $`cargo build --release --target aarch64-apple-darwin`
  .cwd(desktop)
  .env({ ...process.env, MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS, SPARKLE_DIR: sparkle });

step('5. assemble the .app');
rmSync(app, { recursive: true, force: true });
for (const dir of ['MacOS', 'Frameworks', 'Resources']) mkdirSync(join(app, 'Contents', dir), { recursive: true });
const host = join(app, 'Contents/MacOS/aio-proxy-desktop');
const bundledSidecar = join(app, 'Contents/MacOS/aio-proxy');
cpSync(join(desktop, 'target/aarch64-apple-darwin/release/aio-proxy-desktop'), host);
cpSync(sidecar, bundledSidecar);
const framework = join(app, 'Contents/Frameworks/Sparkle.framework');
// ditto keeps the framework's Versions/Current symlinks.
await $`ditto ${join(sparkle, 'Sparkle.framework')} ${framework}`;
await Bun.write(
  join(app, 'Contents/Resources/THIRD_PARTY_NOTICES'),
  `${await Bun.file(notices).text()}\n\n--- Sparkle ---\n\n${await Bun.file(join(sparkle, 'LICENSE')).text()}`,
);
const publicEdKey = process.env['SPARKLE_PUBLIC_ED_KEY'];
await Bun.write(
  join(app, 'Contents/Info.plist'),
  renderInfoPlist({
    version,
    ...(publicEdKey === undefined || publicEdKey === ''
      ? {}
      : { sparkle: { feedUrl: process.env['SPARKLE_FEED_URL'] ?? DEFAULT_FEED_URL, publicEdKey } }),
  }),
);
await $`plutil -lint ${join(app, 'Contents/Info.plist')}`.quiet();

step('6. architecture, minos and dyld checks');
const sparkleBinaries = [
  join(framework, 'Versions/B/Sparkle'),
  join(framework, 'Versions/B/Autoupdate'),
  join(framework, 'Versions/B/Updater.app/Contents/MacOS/Updater'),
  join(framework, 'Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer'),
  join(framework, 'Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader'),
];
const machOs = [
  { path: host, exactArm64: true },
  { path: bundledSidecar, exactArm64: true },
  // Sparkle 2.10.0 ships universal binaries; they are kept as shipped.
  ...sparkleBinaries.map((path) => ({ path, exactArm64: false })),
];
const problems: string[] = [];
for (const { path, exactArm64 } of machOs) {
  problems.push(
    ...machOProblems({
      path,
      exactArm64,
      archs: await $`lipo -archs ${path}`.text(),
      vtool: await $`vtool -show-build ${path}`.text(),
    }),
  );
}
if (problems.length > 0) throw new Error(`Mach-O checks failed:\n${problems.join('\n')}`);

// The host runs only if dyld resolves Sparkle through the rpath.
const hostRuns = async (when: string): Promise<void> => {
  const reported = (await $`${host} --version`.text()).trim();
  if (reported !== version)
    throw new Error(`${when}: aio-proxy-desktop --version printed ${reported}, expected ${version}`);
};
await hostRuns('before signing');

step('7. runtime smoke');
await runtimeSmoke(app, version);

step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');
// An ad-hoc signature has no Team ID, so hardened-runtime library validation would reject Sparkle;
// the host gets disable-library-validation for this build only. Developer ID signing never uses it.
const sign = (path: string, ...extra: string[]) => $`codesign -f -s - -o runtime ${extra} ${path}`.quiet();
await sign(join(framework, 'Versions/B/XPCServices/Installer.xpc'));
await sign(join(framework, 'Versions/B/XPCServices/Downloader.xpc'), '--preserve-metadata=entitlements');
await sign(join(framework, 'Versions/B/Autoupdate'));
await sign(join(framework, 'Versions/B/Updater.app'));
await sign(framework);
await sign(bundledSidecar, '--entitlements', join(desktop, 'entitlements/aio-proxy.plist'));
const hostEntitlements = ['--entitlements', join(desktop, 'entitlements/adhoc-host.plist')];
await sign(host, ...hostEntitlements);
// Signing the .app re-signs its main executable, so the host entitlement goes on this step too.
await sign(app, ...hostEntitlements);
await $`codesign --verify --deep --strict --verbose=2 ${app}`;
await hostRuns('after signing');

console.error(`\n${app}`);
```

`desktop/scripts/tsconfig.json` (same compiler options as `scripts/tsconfig.json`, so `lint:types` can type-check these files):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["**/*.ts"]
}
```

`desktop/entitlements/aio-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- The bundled aio-proxy sidecar's only entitlement. JavaScriptCore needs MAP_JIT under the
       hardened runtime; without it Bun silently falls back to the interpreter (no "JS JIT Generated
       Code" region in vmmap, about 30% slower requests). allow-jit is the narrowest JIT-capable key.
       Native-addon plugins are unsupported under the desktop sidecar, so library validation stays on. -->
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
```

`desktop/entitlements/adhoc-host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- Ad-hoc (unsigned) bundles only: an ad-hoc signature has no Team ID, so the hardened runtime's
       library validation rejects the ad-hoc Sparkle.framework. Developer ID signing never uses this
       file, because the host and Sparkle then share a Team ID. No double hyphens in XML comments. -->
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
```

Replace `desktop/build.rs`:

```rust
// The app's version is the product package's: CFBundleShortVersionString, `--version` and the
// no-downgrade rule all read this one value, so it cannot drift from the bundled sidecar.
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let package = manifest.join("../npm/aio-proxy/package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let text = fs::read_to_string(&package).expect("read npm/aio-proxy/package.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse npm/aio-proxy/package.json");
    let version = json["version"].as_str().expect("npm/aio-proxy/package.json has a string version");
    println!("cargo:rustc-env=AIO_PROXY_VERSION={version}");

    // Sparkle links only for a bundle build (desktop/scripts/bundle.ts sets SPARKLE_DIR). `cargo test`
    // and `cargo run` then need no framework; the updater finds no class and stays off.
    println!("cargo:rerun-if-env-changed=SPARKLE_DIR");
    if let Ok(dir) = env::var("SPARKLE_DIR") {
        println!("cargo:rustc-link-search=framework={dir}");
        println!("cargo:rustc-link-lib=framework=Sparkle");
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path/../Frameworks");
    }
}
```

In `package.json`, add the entry point after `"build:dashboard"`:

```json
    "desktop:bundle": "bun desktop/scripts/bundle.ts",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./desktop/scripts`
Expected: `6 pass, 0 fail`.
Run: `bun run desktop:bundle --unsigned`
Expected (several minutes on a cold tree): steps `1.`–`8.` print in order; the runtime smoke logs `AIO Proxy listening at http://127.0.0.1:<port>`; `codesign --verify` ends with `valid on disk` and `satisfies its Designated Requirement`; the last line is `…/desktop/target/bundle/AIO Proxy.app`. The first run downloads `Sparkle-2.10.0.tar.xz` into `desktop/vendor/` and verifies its SHA-256.
Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`
Expected: the same result in well under a minute (reuses the sidecar).
Run: `vtool -show-build "desktop/target/bundle/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop" | grep minos && otool -l "desktop/target/bundle/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop" | grep -A2 LC_RPATH`
Expected: `minos 13.0`; `path @loader_path/../Frameworks`.
Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings` then, from the root, `bun run format:check && bun run lint`
Expected: all pass (82 Rust tests; `cargo test` links no Sparkle).

- [ ] **Step 5: Commit**

```bash
git add package.json desktop/build.rs desktop/entitlements desktop/scripts
git commit -m "feat(desktop): add the unsigned bundle command with Sparkle and a runtime smoke"
```

### Task 10: App shell: GPUI application, tray, model, discovery and automatic actions

**Files:**
- Create: `desktop/src/log.rs`, `desktop/src/tray.rs`, `desktop/src/app.rs`, `desktop/src/app/lifecycle.rs`, `desktop/src/app/refresh.rs`, `desktop/src/app/health.rs`
- Modify: `desktop/src/lib.rs`, `desktop/src/main.rs`
- Test: `desktop/src/tray/tests.rs`

**Interfaces:**
- Consumes: everything from Tasks 1–8: `install::{Paths, bundle_of, acquire_instance_lock, prepare, location_allows_persistence, volume_is_read_only, probe_version, InstallState, ReadOnlyReason}`, `connect::cli::SystemHost`, `connect::run::{Host, run_auto, run_user, run_reload}`, `connect::policy::{automatic_action, AutoAttempts, AutoAction, UserAction, ReloadOutcome}`, `client::refresh::{Scheduler, FetchOrder, Finished, Tag, Trigger}`, `client::transport::{spawn, Limits, LocalUrl, Method, Request, Response, HttpError}`, `client::health::{HealthTracker, HealthState, HEALTH_INTERVAL, HEALTH_TIMEOUT, parse_health}`, `summary::{classify, FetchOutcome, SummaryV1, DegradedReason}`.
- Produces: `log::{init(dir: &Path), info(message: impl AsRef<str>)}`; `tray::{ICON_PX: u32, TrayState::{Running, Down, Attention}, tray_state(health: HealthState, attention: bool) -> TrayState, icon_rgba(state: TrayState) -> Vec<u8>, Tray { pub icon: TrayIcon } (Global), build(events: UnboundedSender<AppEvent>) -> Result<Tray, String>, sync(cx: &mut App)}`; `app::{AppEvent::{OpenDashboard, Quit, Wake}, SummaryState::{Waiting, Ready(Box<SummaryV1>), Degraded(DegradedReason), AuthFailed, Unavailable(String)}, ActionState::{Idle, Running(UserAction), Automatic(AutoAction), Done(String), Failed(String)} (+ is_busy), AppModel { pub paths, pub bundle, pub install: Option<InstallState>, pub discovery: Option<Discovery>, pub discovery_error, pub health: HealthTracker, pub summary: SummaryState, pub summary_error, pub action: ActionState, … } (Global) with new(paths: Paths, bundle: Option<PathBuf>), persistent(), needs_attention(), changed(cx: &mut App), start, rediscover, run_user_action(cx, UserAction), open_dashboard, open_logs, panel_opened, panel_closed, manual_refresh, check_health, start_health_timer}` (every function takes `cx: &mut App`).

Glue derived from the spike (`git show spike/desktop:spike/desktop-host/src/main.rs`): the accessory policy inside `run` (lines 521-525), the tray built inside `run` with events forwarded over a `futures` unbounded channel to one foreground task (530-538, 564-569), `cx.spawn(async move |cx| …)` with `cx.background_executor().timer(..)` and `cx.update(..)` (115-145, 558-562). Checked in the registry sources: `AsyncApp::update` returns the closure's value directly (`gpui-pre-0.3.7/src/app/async_context.rs:170`), `App::refresh_windows` (`app.rs:1156`), `App::open_url` (`app.rs:1608`), `App::reveal_path` (`app.rs:1712`), `BackgroundExecutor::spawn` for blocking work (`executor.rs:103`); `tray-icon-0.21.3` shows the context menu on right click natively when `menu_on_left_click` is false (`src/platform_impl/macos/mod.rs:471-485`) and scales an icon to 18 pt tall (`mod.rs:279`), so a 36 px template image is crisp at 2x; `muda-0.17.2` `Menu::with_items`, `MenuItem::with_id` (`src/items/normal.rs:47`), `MenuEvent::set_event_handler` (`src/lib.rs:516`). The wake observer uses `objc2-app-kit-0.3.2` `NSWorkspace::notificationCenter` (`src/generated/NSWorkspace.rs:54`) and `NSWorkspaceDidWakeNotification` (`:724`), and `objc2-foundation-0.3.2` `addObserverForName_object_queue_usingBlock` (`src/generated/NSNotification.rs:212`) with `NSOperationQueue::mainQueue` (`src/generated/NSOperation.rs:460`); none of that ran in the spike.

Only one mutation runs at a time (`ActionState::is_busy`): a discovery that lands mid-restart (seeing "no process") must not start a second command.

- [ ] **Step 1: Write the failing test**

Add `pub mod tray;` to `desktop/src/lib.rs` (keep the list sorted) and create `desktop/src/tray.rs` with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/tray/tests.rs`:

```rust
use super::*;

#[test]
fn only_a_healthy_proxy_shows_running_or_attention() {
    assert_eq!(tray_state(HealthState::Up, false), TrayState::Running);
    assert_eq!(tray_state(HealthState::Up, true), TrayState::Attention);
    assert_eq!(tray_state(HealthState::Down, true), TrayState::Down);
    assert_eq!(tray_state(HealthState::Unknown, false), TrayState::Down);
}

#[test]
fn the_three_states_have_distinct_icons() {
    let icons = [TrayState::Running, TrayState::Down, TrayState::Attention].map(icon_rgba);
    for icon in &icons {
        assert_eq!(icon.len(), (ICON_PX * ICON_PX * 4) as usize);
        assert!(icon.chunks(4).any(|px| px[3] == 255), "icon is not empty");
    }
    assert_ne!(icons[0], icons[1]);
    assert_ne!(icons[0], icons[2]);
    assert_ne!(icons[1], icons[2]);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib tray`
Expected: FAIL to compile: `` cannot find function `tray_state` ``, `` cannot find type `TrayState` ``, `` cannot find function `icon_rgba` ``.

- [ ] **Step 3: Implement**

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod client;
pub mod connect;
pub mod install;
pub mod log;
pub mod process;
pub mod summary;
pub mod token;
pub mod tray;
pub mod version;
```

`desktop/src/log.rs`:

```rust
//! The app's own log: `~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log`, mirrored to stderr.
//! Callers never pass the token, an `Authorization` header or `__desktop-connect` stdout.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

// ponytail: no rotation; one line per event keeps it small. Rotate if a user reports a large file.
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(dir.join("aio-proxy-desktop.log")) {
        let _ = FILE.set(Mutex::new(file));
    }
}

pub fn info(message: impl AsRef<str>) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let line = format!("{secs} {}\n", message.as_ref());
    eprint!("{line}");
    if let Some(Ok(mut file)) = FILE.get().map(Mutex::lock) {
        let _ = file.write_all(line.as_bytes());
    }
}
```

`desktop/src/tray.rs`:

```rust
//! The menu-bar icon: right click opens a native menu, and the icon shows one of three states.
//! Task 11 adds the left-click panel toggle.

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{App, Global};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::app::{AppEvent, AppModel};
use crate::client::health::HealthState;

/// 18 pt tall at 2x.
pub const ICON_PX: u32 = 36;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Running,
    Down,
    /// Running, but something wants the user: an alert, a failed action, or a pending update.
    Attention,
}

pub fn tray_state(health: HealthState, attention: bool) -> TrayState {
    match (health, attention) {
        (HealthState::Up, true) => TrayState::Attention,
        (HealthState::Up, false) => TrayState::Running,
        _ => TrayState::Down,
    }
}

/// Template-image pixels: a disc (running), a ring (down), a disc with a hole (attention). AppKit
/// tints template images for light and dark menu bars.
pub fn icon_rgba(state: TrayState) -> Vec<u8> {
    let centre = (ICON_PX as f32 - 1.0) / 2.0;
    let mut rgba = Vec::with_capacity((ICON_PX * ICON_PX * 4) as usize);
    for y in 0..ICON_PX {
        for x in 0..ICON_PX {
            let d = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            let on = match state {
                TrayState::Running => d <= 12.0,
                TrayState::Down => (9.0..=12.0).contains(&d),
                TrayState::Attention => (4.5..=12.0).contains(&d),
            };
            rgba.extend_from_slice(if on { &[0, 0, 0, 255] } else { &[0, 0, 0, 0] });
        }
    }
    rgba
}

fn icon(state: TrayState) -> Icon {
    Icon::from_rgba(icon_rgba(state), ICON_PX, ICON_PX).expect("icon buffer matches its size")
}

pub struct Tray {
    pub icon: TrayIcon,
    shown: Option<TrayState>,
}

impl Global for Tray {}

const OPEN_DASHBOARD: &str = "open-dashboard";
const QUIT: &str = "quit";

/// Must run on the main thread inside the GPUI `run` callback.
pub fn build(events: UnboundedSender<AppEvent>) -> Result<Tray, String> {
    let menu = Menu::with_items(&[
        &MenuItem::with_id(OPEN_DASHBOARD, "Open Dashboard", true, None),
        &PredefinedMenuItem::separator(),
        &MenuItem::with_id(QUIT, "Quit AIO Proxy", true, None),
    ])
    .map_err(|error| error.to_string())?;
    let icon = TrayIconBuilder::new()
        .with_icon(icon(TrayState::Down))
        .with_icon_as_template(true)
        .with_tooltip("AIO Proxy")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .map_err(|error| error.to_string())?;
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let message = match event.id.0.as_str() {
            OPEN_DASHBOARD => AppEvent::OpenDashboard,
            QUIT => AppEvent::Quit,
            _ => return,
        };
        let _ = events.unbounded_send(message);
    }));
    Ok(Tray { icon, shown: Some(TrayState::Down) })
}

/// Re-derives the icon from the model; cheap when nothing changed.
pub fn sync(cx: &mut App) {
    let Some(model) = cx.try_global::<AppModel>() else {
        return;
    };
    let state = tray_state(model.health.state(), model.needs_attention());
    let Some(tray) = cx.try_global::<Tray>() else {
        return;
    };
    if tray.shown == Some(state) {
        return;
    }
    let _ = tray.icon.set_icon_with_as_template(Some(icon(state)), true);
    cx.global_mut::<Tray>().shown = Some(state);
}

#[cfg(test)]
mod tests;
```

`desktop/src/app.rs`:

```rust
//! The app-level model, a GPUI global. It outlives the panel window (hybrid lifecycle), so a
//! reopened panel renders the last numbers at once while a fresh fetch runs.

mod health;
mod lifecycle;
mod refresh;

use std::path::PathBuf;

use gpui_kit::{App, Global, Task};

pub use health::{check_now as check_health, start_timer as start_health_timer};
pub use lifecycle::{open_dashboard, open_logs, rediscover, run_user_action, start};
pub use refresh::{manual_refresh, panel_closed, panel_opened};

use crate::client::health::HealthTracker;
use crate::client::refresh::Scheduler;
use crate::connect::discovery::Discovery;
use crate::connect::policy::{AutoAction, AutoAttempts, UserAction};
use crate::install::{InstallState, Paths};
use crate::summary::{DegradedReason, SummaryV1};

/// Everything that reaches the GPUI loop from AppKit callbacks, delivered over one channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    OpenDashboard,
    Quit,
    Wake,
}

pub enum SummaryState {
    Waiting,
    Ready(Box<SummaryV1>),
    Degraded(DegradedReason),
    AuthFailed,
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionState {
    Idle,
    Running(UserAction),
    Automatic(AutoAction),
    Done(String),
    Failed(String),
}

impl ActionState {
    pub fn is_busy(&self) -> bool {
        matches!(self, ActionState::Running(_) | ActionState::Automatic(_))
    }
}

pub struct AppModel {
    pub paths: Paths,
    pub bundle: Option<PathBuf>,
    /// `None` until the startup install step finishes; nothing is automatic before that.
    pub install: Option<InstallState>,
    pub discovery: Option<Discovery>,
    pub discovery_error: Option<String>,
    pub health: HealthTracker,
    pub summary: SummaryState,
    /// Set when a fetch fails while the last good summary stays on screen.
    pub summary_error: Option<String>,
    pub action: ActionState,
    attempts: AutoAttempts,
    discovering: bool,
    rediscover_again: bool,
    auth_retry_used: bool,
    refetch_after_discovery: bool,
    scheduler: Scheduler,
    instance: Option<(String, Option<u32>)>,
    instance_epoch: u64,
    fetch_task: Option<Task<()>>,
    timer_task: Option<Task<()>>,
}

impl Global for AppModel {}

impl AppModel {
    pub fn new(paths: Paths, bundle: Option<PathBuf>) -> Self {
        Self {
            paths,
            bundle,
            install: None,
            discovery: None,
            discovery_error: None,
            health: HealthTracker::default(),
            summary: SummaryState::Waiting,
            summary_error: None,
            action: ActionState::Idle,
            attempts: AutoAttempts::default(),
            discovering: false,
            rediscover_again: false,
            auth_retry_used: false,
            refetch_after_discovery: false,
            scheduler: Scheduler::default(),
            instance: None,
            instance_epoch: 0,
            fetch_task: None,
            timer_task: None,
        }
    }

    pub fn persistent(&self) -> bool {
        self.install == Some(InstallState::Persistent)
    }

    pub fn needs_attention(&self) -> bool {
        let alerts = matches!(&self.summary, SummaryState::Ready(summary) if !summary.alerts.is_empty());
        alerts
            || matches!(self.action, ActionState::Failed(_))
            || matches!(self.summary, SummaryState::AuthFailed | SummaryState::Degraded(_))
    }
}

/// Call after any model change: updates the icon and re-renders the panel.
pub fn changed(cx: &mut App) {
    crate::tray::sync(cx);
    cx.refresh_windows();
}
```

`desktop/src/app/lifecycle.rs`:

```rust
//! Startup install step, discovery, the automatic-action table and user actions, wired to GPUI.
//! The decisions live in `connect`; this only moves work to background threads and back.

use std::path::{Path, PathBuf};

use gpui_kit::App;

use super::{ActionState, AppModel, changed, refresh};
use crate::connect::cli::SystemHost;
use crate::connect::discovery::Discovery;
use crate::connect::policy::{ReloadOutcome, UserAction, automatic_action};
use crate::connect::run::{Host, run_auto, run_reload, run_user};
use crate::install::{self, InstallState, Paths, ReadOnlyReason};
use crate::log;
use crate::version::APP_VERSION;

pub fn start(cx: &mut App) {
    let (paths, bundle) = {
        let model = cx.global::<AppModel>();
        (model.paths.clone(), model.bundle.clone())
    };
    let task = cx.background_executor().spawn(async move { prepare_install(&paths, bundle.as_deref()) });
    cx.spawn(async move |cx| {
        let install = task.await;
        cx.update(|cx| {
            log::info(format!("install: {install:?}"));
            cx.global_mut::<AppModel>().install = Some(install);
            changed(cx);
            rediscover(cx);
        });
    })
    .detach();
}

fn prepare_install(paths: &Paths, bundle: Option<&Path>) -> InstallState {
    let Some(bundle) = bundle else {
        return InstallState::ReadOnly(ReadOnlyReason::Location);
    };
    let location_ok = install::location_allows_persistence(bundle, &paths.home, install::volume_is_read_only(bundle));
    install::prepare(paths, bundle, location_ok, APP_VERSION, install::probe_version)
}

fn host(model: &AppModel) -> Option<SystemHost> {
    SystemHost::new(&model.paths, model.bundle.as_deref())
}

pub fn rediscover(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    if model.discovering {
        model.rediscover_again = true;
        return;
    }
    let Some(host) = host(model) else {
        model.discovery_error = Some("The bundled aio-proxy binary was not found.".into());
        changed(cx);
        return;
    };
    model.discovering = true;
    let task = cx.background_executor().spawn(async move { host.discover() });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| apply_discovery(cx, result));
    })
    .detach();
}

fn apply_discovery(cx: &mut App, result: Result<Discovery, String>) {
    let again = {
        let model = cx.global_mut::<AppModel>();
        model.discovering = false;
        match result {
            Ok(discovery) => {
                model.discovery_error = None;
                model.discovery = Some(discovery);
            }
            Err(error) => {
                log::info(format!("discovery failed: {error}"));
                model.discovery_error = Some(error);
            }
        }
        std::mem::take(&mut model.rediscover_again)
    };
    refresh::instance_maybe_changed(cx);
    maybe_automatic(cx);
    changed(cx);
    if again {
        rediscover(cx);
    }
}

fn maybe_automatic(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    if model.action.is_busy() {
        return;
    }
    let Some(discovery) = model.discovery.clone() else {
        return;
    };
    let Some(action) = automatic_action(&discovery, model.persistent(), &model.attempts) else {
        return;
    };
    let Some(host) = host(model) else {
        return;
    };
    model.attempts.mark(action);
    model.action = ActionState::Automatic(action);
    log::info(format!("automatic action: {action:?}"));
    let task = cx.background_executor().spawn(async move { run_auto(&host, &discovery, action) });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let model = cx.global_mut::<AppModel>();
            match result {
                Ok(after) => {
                    log::info(format!("automatic action {action:?} finished"));
                    model.action = ActionState::Idle;
                    apply_discovery(cx, Ok(after));
                    refresh::after_action(cx);
                }
                Err(error) => {
                    log::info(format!("automatic action {action:?} failed: {error}"));
                    model.action = ActionState::Failed(format!("Automatic {action:?} failed: {error}"));
                    changed(cx);
                    rediscover(cx);
                }
            }
        });
    })
    .detach();
}

pub fn run_user_action(cx: &mut App, action: UserAction) {
    let model = cx.global_mut::<AppModel>();
    if model.action.is_busy() {
        return;
    }
    let (Some(rendered), Some(host)) = (model.discovery.clone(), host(model)) else {
        return;
    };
    model.action = ActionState::Running(action);
    changed(cx);
    let task = cx.background_executor().spawn(async move { execute(&host, &rendered, action) });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let model = cx.global_mut::<AppModel>();
            match result {
                Ok((note, after)) => {
                    model.action = ActionState::Done(note);
                    if let Some(after) = after {
                        apply_discovery(cx, Ok(after));
                    }
                    refresh::after_action(cx);
                    changed(cx);
                }
                Err(error) => {
                    log::info(format!("{action:?} failed: {error}"));
                    model.action = ActionState::Failed(error);
                    changed(cx);
                    rediscover(cx);
                }
            }
        });
    })
    .detach();
}

fn execute(host: &impl Host, rendered: &Discovery, action: UserAction) -> Result<(String, Option<Discovery>), String> {
    if action == UserAction::Reload {
        return match run_reload(host, rendered).map_err(|error| error.to_string())? {
            ReloadOutcome::Reloaded => Ok(("Configuration reloaded.".into(), None)),
            ReloadOutcome::Rejected { error, stage } => {
                Err(format!("Reload rejected{}: {error}", stage.map(|s| format!(" at {s}")).unwrap_or_default()))
            }
            ReloadOutcome::Failed(error) => Err(error),
        };
    }
    let after = run_user(host, rendered, action).map_err(|error| error.to_string())?;
    Ok((format!("{action:?} finished."), Some(after)))
}

pub fn open_dashboard(cx: &mut App) {
    let url = cx.global::<AppModel>().discovery.as_ref().and_then(|d| d.instance.dashboard_url.clone());
    if let Some(url) = url {
        cx.open_url(&url);
    }
}

/// Reveals `$AIO_PROXY_HOME/logs`, the service's own home when the plist names one.
pub fn open_logs(cx: &mut App) {
    let model = cx.global::<AppModel>();
    let home = model
        .discovery
        .as_ref()
        .and_then(|d| d.unit.home.clone())
        .map(PathBuf::from)
        .unwrap_or_else(|| model.paths.home.join(".aio-proxy"));
    cx.reveal_path(&home.join("logs"));
}
```

`desktop/src/app/refresh.rs`:

```rust
//! Summary fetching: the refresh scheduler's orders become transport requests, and responses
//! come back through the scheduler's tag check.

use std::time::Instant;

use gpui_kit::App;

use super::{AppModel, SummaryState, changed};
use crate::client::refresh::{FetchOrder, Finished, Tag, Trigger};
use crate::client::transport::{self, HttpError, Limits, LocalUrl, Method, Request, Response};
use crate::summary::{FetchOutcome, classify};

const SUMMARY_PATH: &str = "/dashboard/api/desktop-summary";

pub fn panel_opened(cx: &mut App) {
    let order = cx.global_mut::<AppModel>().scheduler.open(Instant::now());
    dispatch(cx, order);
    super::check_health(cx);
    super::rediscover(cx);
}

pub fn panel_closed(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    model.scheduler.close();
    // Dropping the fetch task drops its `Pending`, which shuts the socket down.
    model.fetch_task = None;
    model.timer_task = None;
}

pub fn manual_refresh(cx: &mut App) {
    trigger(cx, Trigger::Manual);
}

pub(super) fn after_action(cx: &mut App) {
    trigger(cx, Trigger::ActionDone);
}

fn trigger(cx: &mut App, trigger: Trigger) {
    let order = cx.global_mut::<AppModel>().scheduler.trigger(trigger, Instant::now());
    dispatch(cx, order);
}

/// Called after every discovery: a new (address, pid) pair is a new instance.
pub(super) fn instance_maybe_changed(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    let key = model.discovery.as_ref().map(|d| (d.instance.control_url.clone().unwrap_or_default(), d.instance.pid));
    if key != model.instance {
        model.instance = key;
        model.instance_epoch += 1;
        model.auth_retry_used = false;
        model.refetch_after_discovery = false;
        let order = model.scheduler.set_instance(model.instance_epoch, Instant::now());
        dispatch(cx, order);
    } else if std::mem::take(&mut model.refetch_after_discovery) {
        trigger(cx, Trigger::Rediscovered);
    }
}

fn dispatch(cx: &mut App, order: Option<FetchOrder>) {
    if let Some(order) = order {
        start_fetch(cx, order);
    }
    arm_timer(cx);
}

fn summary_request(model: &AppModel, refresh_quota: bool) -> Result<Request, SummaryState> {
    let Some(discovery) = &model.discovery else {
        return Err(SummaryState::Waiting);
    };
    let Some(base) = discovery.instance.control_url.as_deref().filter(|_| discovery.instance.reachable) else {
        return Err(SummaryState::Unavailable("aio-proxy is not running.".into()));
    };
    let Some(token) = discovery.token.clone() else {
        return Err(SummaryState::AuthFailed);
    };
    let path = if refresh_quota { format!("{SUMMARY_PATH}?refresh=true") } else { SUMMARY_PATH.to_string() };
    let url = LocalUrl::parse(base, &path).map_err(|error| SummaryState::Unavailable(error.to_string()))?;
    Ok(Request { method: Method::Get, url, bearer: Some(token) })
}

fn start_fetch(cx: &mut App, order: FetchOrder) {
    match summary_request(cx.global::<AppModel>(), order.refresh_quota) {
        Ok(request) => {
            let pending = transport::spawn(request, Limits::default());
            let task = cx.spawn(async move |cx| {
                let result = pending.await;
                cx.update(|cx| finish(cx, order.tag, result));
            });
            cx.global_mut::<AppModel>().fetch_task = Some(task);
        }
        Err(state) => {
            let model = cx.global_mut::<AppModel>();
            model.scheduler.finished(order.tag, Finished::Failed, Instant::now());
            show(model, state);
            changed(cx);
        }
    }
}

/// Keeps the last good summary on screen and reports the problem next to it.
fn show(model: &mut AppModel, state: SummaryState) {
    match (&model.summary, state) {
        (SummaryState::Ready(_), SummaryState::Unavailable(error)) => model.summary_error = Some(error),
        (_, state) => model.summary = state,
    }
}

fn finish(cx: &mut App, tag: Tag, result: Result<Response, HttpError>) {
    let outcome = result.map(|response| classify(response.status, &response.body));
    let finished = match &outcome {
        Ok(FetchOutcome::Summary(summary)) => Finished::Summary { any_loading: summary.any_quota_loading() },
        _ => Finished::Failed,
    };
    let model = cx.global_mut::<AppModel>();
    let (accepted, follow) = model.scheduler.finished(tag, finished, Instant::now());
    if !accepted {
        return;
    }
    let mut retry_discovery = false;
    match outcome {
        Ok(FetchOutcome::Summary(summary)) => {
            model.summary = SummaryState::Ready(summary);
            model.summary_error = None;
            model.auth_retry_used = false;
        }
        Ok(FetchOutcome::Degraded(reason)) => {
            model.summary = SummaryState::Degraded(reason);
            model.summary_error = None;
        }
        // One rediscovery picks up a replaced token; a second 401 is final. Never restart the proxy.
        Ok(FetchOutcome::Unauthorized) if !model.auth_retry_used => {
            model.auth_retry_used = true;
            model.refetch_after_discovery = true;
            retry_discovery = true;
        }
        Ok(FetchOutcome::Unauthorized) => model.summary = SummaryState::AuthFailed,
        Ok(FetchOutcome::Failed(error)) => show(model, SummaryState::Unavailable(error)),
        Err(error) => show(model, SummaryState::Unavailable(format!("desktop summary: {error}"))),
    }
    dispatch(cx, follow);
    changed(cx);
    if retry_discovery {
        super::rediscover(cx);
    }
}

fn arm_timer(cx: &mut App) {
    let next = cx.global::<AppModel>().scheduler.next_wake();
    let task = next.map(|at| {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(at.saturating_duration_since(Instant::now())).await;
            cx.update(|cx| {
                let order = cx.global_mut::<AppModel>().scheduler.wake(Instant::now());
                dispatch(cx, order);
            });
        })
    });
    cx.global_mut::<AppModel>().timer_task = task;
}
```

`desktop/src/app/health.rs`:

```rust
//! The health check: `GET /health` every 60 s, on panel open and on wake. It only updates the icon
//! and triggers rediscovery on a transition; it never mutates the service.

use gpui_kit::App;

use super::{AppModel, changed};
use crate::client::health::{HEALTH_INTERVAL, HEALTH_TIMEOUT, parse_health};
use crate::client::transport::{self, Limits, LocalUrl, Method, Request};

pub fn start_timer(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.update(check_now);
            cx.background_executor().timer(HEALTH_INTERVAL).await;
        }
    })
    .detach();
}

pub fn check_now(cx: &mut App) {
    let Some(discovery) = cx.global::<AppModel>().discovery.as_ref() else {
        // Nothing to probe until the first discovery lands; it re-runs the check itself.
        return;
    };
    let url = discovery.instance.control_url.as_deref().and_then(|base| LocalUrl::parse(base, "/health").ok());
    let Some(url) = url else {
        record(cx, false);
        return;
    };
    let limits = Limits { total: HEALTH_TIMEOUT, ..Limits::default() };
    let pending = transport::spawn(Request { method: Method::Get, url, bearer: None }, limits);
    cx.spawn(async move |cx| {
        let ok = pending.await.ok().and_then(|r| parse_health(r.status, &r.body)).is_some();
        cx.update(|cx| record(cx, ok));
    })
    .detach();
}

fn record(cx: &mut App, ok: bool) {
    let transition = cx.global_mut::<AppModel>().health.record(ok);
    if transition.is_some() {
        changed(cx);
        super::rediscover(cx);
    }
}
```

Replace `desktop/src/main.rs`:

```rust
//! The menu-bar app: GPUI application, single-instance lock, tray, wake notification, `--version`.

use std::path::PathBuf;
use std::ptr::NonNull;

use aio_proxy_desktop::app::{self, AppEvent, AppModel};
use aio_proxy_desktop::install::{self, Paths};
use aio_proxy_desktop::version::APP_VERSION;
use aio_proxy_desktop::{log, tray};
use block2::RcBlock;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui_kit::App;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::{NSNotification, NSOperationQueue};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{APP_VERSION}");
        return;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("aio-proxy-desktop: HOME is not set");
        std::process::exit(1);
    };
    let paths = Paths::for_home(&home);
    log::init(&paths.logs);
    // Held until the process exits; the kernel drops the flock then.
    let _lock = match install::acquire_instance_lock(&paths.lock) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            log::info("another copy is already running; exiting");
            return;
        }
        Err(error) => {
            log::info(format!("cannot take the instance lock: {error}"));
            std::process::exit(1);
        }
    };
    let bundle =
        std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok()).and_then(|exe| install::bundle_of(&exe));
    log::info(format!("aio-proxy-desktop {APP_VERSION} starting from {bundle:?}"));

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        // GPUI forces the Regular policy in applicationDidFinishLaunching; LSUIElement covers launch.
        let mtm = MainThreadMarker::new().expect("GPUI runs this callback on the main thread");
        NSApplication::sharedApplication(mtm).setActivationPolicy(NSApplicationActivationPolicy::Accessory);

        let (events, mut inbox) = mpsc::unbounded::<AppEvent>();
        cx.set_global(AppModel::new(paths, bundle));
        cx.set_global(tray::build(events.clone()).expect("create the menu-bar icon"));
        observe_wake(events);
        app::start(cx);
        app::start_health_timer(cx);
        cx.spawn(async move |cx| {
            while let Some(event) = inbox.next().await {
                cx.update(|cx| handle(cx, event));
            }
        })
        .detach();
    });
}

fn handle(cx: &mut App, event: AppEvent) {
    match event {
        AppEvent::OpenDashboard => app::open_dashboard(cx),
        // Quitting leaves the proxy running: launchd owns it.
        AppEvent::Quit => cx.quit(),
        AppEvent::Wake => app::check_health(cx),
    }
}

/// `NSWorkspaceDidWakeNotification` on the main queue, for the life of the app.
fn observe_wake(events: UnboundedSender<AppEvent>) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        let _ = events.unbounded_send(AppEvent::Wake);
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: AppKit's static notification name; the main queue runs the block on the main thread.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    std::mem::forget(observer);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 84 passed`; clippy clean.
Run (isolated home, so nothing touches your real service or `~/.aio-proxy`):

```bash
cd desktop && cargo build && H=$(mktemp -d) \
  && (HOME=$H ./target/debug/aio-proxy-desktop & echo $! > "$H/pid") && sleep 6 \
  && HOME=$H ./target/debug/aio-proxy-desktop; echo "second copy exit=$?"; \
  kill "$(cat "$H/pid")"; cat "$H/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log"; rm -rf "$H"
```

Expected: during the 6 s a ring icon (proxy down) sits in the menu bar and right click shows Open Dashboard and Quit AIO Proxy; the second copy prints `another copy is already running; exiting` and `second copy exit=0`; the log contains `aio-proxy-desktop <version> starting from None` and `install: ReadOnly(Location)` (a binary outside a bundle is never persistent).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/main.rs desktop/src/log.rs desktop/src/tray.rs desktop/src/tray/tests.rs desktop/src/app.rs desktop/src/app/lifecycle.rs desktop/src/app/refresh.rs desktop/src/app/health.rs
git commit -m "feat(desktop): add the menu-bar shell with discovery and automatic actions"
```

### Task 11: Anchored panel: placement, hybrid PopUp lifecycle, header, actions, degraded panel

**Files:**
- Create: `desktop/src/panel.rs`, `desktop/src/panel/placement.rs`, `desktop/src/panel/window.rs`, `desktop/src/panel/view.rs`, `desktop/src/panel/status.rs`, `desktop/src/panel/actions.rs`, `desktop/src/panel/degraded.rs`, `desktop/src/panel/format.rs`
- Modify: `desktop/src/lib.rs`, `desktop/src/app.rs`, `desktop/src/tray.rs`, `desktop/src/main.rs`
- Test: `desktop/src/panel/placement/tests.rs`, `desktop/src/panel/status/tests.rs`, `desktop/src/panel/format/tests.rs`

**Interfaces:**
- Consumes: `app::{AppModel, SummaryState, ActionState, run_user_action, manual_refresh, open_logs, open_dashboard, panel_opened, panel_closed}` (Task 10), `tray::Tray` (Task 10), `connect::policy::{offered_actions, UserAction}` (Task 7), `install::{InstallState, ReadOnlyReason}` (Task 6), `summary::DegradedReason` (Task 2).
- Produces: `panel::{PanelWindow (Global, Default), toggle(cx: &mut App)}`; `app::AppEvent::TogglePanel`; private `panel::placement::{Frame { x, y, width, height: f64 }, panel_origin(status_window: Frame, screen: Frame, panel_width: f64) -> (f64, f64)}`; `panel::status::{headline(&AppModel) -> String, endpoint(&AppModel) -> Option<String>, notice(&AppModel) -> Option<String>}`; `panel::format::{compact(u128) -> String, usd(u128) -> String}`; `panel::window::{PANEL_WIDTH, PANEL_HEIGHT, close(window: &mut Window, cx: &mut App)}`.

Glue derived from the spike (`git show spike/desktop:spike/desktop-host/src/main.rs`): the anchor from the status item button's `NSWindow` frame, its `NSScreen` and `NSScreenNumber` (lines 64-89; `tray.rect()` is physical pixels, the spike and this code work in AppKit points), `WindowOptions` for `WindowKind::PopUp` (412-427), `show: false` then `setAnimationBehavior(None)` and `makeKeyAndOrderFront` (419, 435-439), the `NSWindow` reached through `HasWindowHandle` (452-458), `observe_window_activation` → close on deactivation (99-108), `remove_window` (345-358), the 300 ms reopen guard and `cx.activate(true)` (382-390). `gpui_kit::open_window` wraps the view in `Root` (`gpui-kit-0.7.0/src/lib.rs:144-158`), so GPUI Kit components work inside it. `DisplayId::new` takes a `u64` (`gpui-pre-0.3.7/src/platform.rs:530`).

Lifecycle is **hybrid** (PROVISIONAL per the spec): closing destroys the window and its Metal surface; the `AppModel` global keeps the last summary, so a reopen renders it at once while a fresh fetch runs. Animation is off from the first frame. If the human flash/latency checks (Task 15) argue against hybrid, fall back to plain destroy by resetting `AppModel.summary` to `SummaryState::Waiting` in `app::panel_closed`; hide/show is not an option (fails the closed budget).

- [ ] **Step 1: Write the failing test**

Add `pub mod panel;` to `desktop/src/lib.rs`, and create `desktop/src/panel.rs` with only:

```rust
mod format;
mod placement;
mod status;
```

Create `desktop/src/panel/placement.rs`, `desktop/src/panel/status.rs` and `desktop/src/panel/format.rs`, each with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/panel/placement/tests.rs`:

```rust
use super::*;

const W: f64 = 360.0;
const MAIN: Frame = Frame { x: 0.0, y: 0.0, width: 3008.0, height: 1692.0 };

fn item(x: f64) -> Frame {
    // The spike's measured status item: 43x33 at the top of a 1692-pt-tall screen.
    Frame { x, y: 1660.0, width: 43.0, height: 33.0 }
}

#[test]
fn centres_the_panel_under_the_icon_below_the_menu_bar() {
    assert_eq!(panel_origin(item(2298.0), MAIN, W), (2140.0, 32.0));
}

#[test]
fn clamps_to_the_right_and_left_screen_edges() {
    assert_eq!(panel_origin(item(2990.0), MAIN, W), (2648.0, 32.0));
    assert_eq!(panel_origin(item(5.0), MAIN, W), (0.0, 32.0));
}

#[test]
fn uses_the_icon_screen_coordinates_on_a_secondary_display() {
    let left_display = Frame { x: -1920.0, y: 200.0, width: 1920.0, height: 1080.0 };
    let icon = Frame { x: -100.0, y: 1256.0, width: 30.0, height: 24.0 };
    assert_eq!(panel_origin(icon, left_display, W), (1560.0, 24.0));
}

#[test]
fn a_screen_narrower_than_the_panel_pins_it_to_the_left_edge() {
    let tiny = Frame { x: 0.0, y: 0.0, width: 300.0, height: 600.0 };
    assert_eq!(panel_origin(Frame { x: 150.0, y: 576.0, width: 20.0, height: 24.0 }, tiny, W), (0.0, 24.0));
}
```

`desktop/src/panel/status/tests.rs`:

```rust
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;
use crate::install::Paths;

fn model(patch: impl FnOnce(&mut Value)) -> AppModel {
    let mut model = AppModel::new(Paths::for_home(Path::new("/Users/me")), None);
    model.install = Some(InstallState::Persistent);
    model.discovery = Some(discovery(patch));
    model
}

#[test]
fn a_newer_copy_notice_names_that_copy() {
    let mut m = model(|_| {});
    m.install = Some(InstallState::ReadOnly(ReadOnlyReason::NewerCopy {
        app: PathBuf::from("/Applications/AIO Proxy.app"),
        version: "0.38.0".into(),
    }));
    assert_eq!(
        notice(&m).as_deref(),
        Some("A newer copy (0.38.0) is installed at /Applications/AIO Proxy.app. This copy is read-only.")
    );
}

#[test]
fn a_failed_action_is_shown_before_anything_else() {
    let mut m = model(|v| v["unit"]["owner"] = json!("external"));
    m.action = ActionState::Failed("service start failed".into());
    assert_eq!(notice(&m).as_deref(), Some("service start failed"));
}

#[test]
fn ownership_explains_why_the_app_will_not_act() {
    assert!(notice(&model(|v| v["unit"]["owner"] = json!("external"))).unwrap().contains("CLI"));
    assert!(notice(&model(|v| v["job"]["disabled"] = json!(true))).unwrap().contains("Stopped by you"));
}

#[test]
fn the_headline_tells_stopped_from_running() {
    assert_eq!(headline(&model(|_| {})), "Running 0.36.0");
    assert_eq!(
        headline(&model(|v| {
            v["job"]["pid"] = Value::Null;
            v["instance"]["reachable"] = json!(false);
        })),
        "Stopped"
    );
}
```

`desktop/src/panel/format/tests.rs`:

```rust
use super::*;

#[test]
fn compacts_counts() {
    assert_eq!(compact(999), "999");
    assert_eq!(compact(1_204), "1.2K");
    assert_eq!(compact(14_815_402), "14.8M");
    assert_eq!(compact(148_000_000), "148M");
    assert_eq!(compact(1_500_000), "1.5M");
    assert_eq!(compact(18_014_398_509_481_985), "18014T");
}

#[test]
fn formats_nano_usd() {
    assert_eq!(usd(20_521_353_840), "$20.52");
    assert_eq!(usd(0), "$0.00");
    assert_eq!(usd(1), "<$0.01");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib panel`
Expected: FAIL to compile: `` cannot find function `panel_origin` ``, `` cannot find type `Frame` ``, `` cannot find function `notice` ``, `` cannot find function `compact` ``.

- [ ] **Step 3: Implement**

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod client;
pub mod connect;
pub mod install;
pub mod log;
pub mod panel;
pub mod process;
pub mod summary;
pub mod token;
pub mod tray;
pub mod version;
```

`desktop/src/panel.rs`:

```rust
//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod actions;
mod degraded;
mod format;
mod placement;
mod status;
mod view;
mod window;

pub use window::{PanelWindow, toggle};
```

`desktop/src/panel/placement.rs`:

```rust
//! Where the panel goes: below the menu bar, centred on the icon, clamped to the icon's screen.

/// A rectangle in AppKit global points (origin bottom-left, y up).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The panel's top-left in the screen's own top-down points, as GPUI's `display_id` bounds expect.
/// `status_window` is the status item button's window frame; `screen` is that window's screen.
pub fn panel_origin(status_window: Frame, screen: Frame, panel_width: f64) -> (f64, f64) {
    let anchor = status_window.x + status_window.width / 2.0;
    let max_left = (screen.x + screen.width - panel_width).max(screen.x);
    let left = (anchor - panel_width / 2.0).min(max_left).max(screen.x);
    // Rounded: AppKit turns a .5 origin into a 1-pt-wider window.
    let x = (left - screen.x).round();
    let y = (screen.y + screen.height) - status_window.y;
    (x, y)
}

#[cfg(test)]
mod tests;
```

`desktop/src/panel/format.rs`:

```rust
//! Pure display formatting: counts and money. Task 12 adds reset times and calendar days.

pub fn compact(n: u128) -> String {
    const UNITS: [(u128, &str); 4] = [(1_000_000_000_000, "T"), (1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (scale, unit) in UNITS {
        if n >= scale {
            let tenths = n * 10 / scale;
            return if tenths >= 1_000 {
                format!("{}{unit}", tenths / 10)
            } else {
                format!("{}.{}{unit}", tenths / 10, tenths % 10)
            };
        }
    }
    n.to_string()
}

/// Nano-USD to dollars, two decimals; a non-zero amount below a cent reads `<$0.01`.
pub fn usd(nano: u128) -> String {
    let cents = nano / 10_000_000;
    if cents == 0 && nano > 0 {
        return "<$0.01".into();
    }
    format!("${}.{:02}", cents / 100, cents % 100)
}

#[cfg(test)]
mod tests;
```

`desktop/src/panel/status.rs`:

```rust
//! The panel header's words: what state the proxy is in and what the app may do about it.

use crate::app::{ActionState, AppModel};
use crate::client::health::HealthState;
use crate::connect::discovery::Owner;
use crate::install::{InstallState, ReadOnlyReason};

pub fn headline(model: &AppModel) -> String {
    let Some(d) = &model.discovery else {
        return match &model.discovery_error {
            Some(_) => "Cannot inspect aio-proxy".into(),
            None => "Connecting…".into(),
        };
    };
    let version = d.instance.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default();
    match (model.health.state(), d.instance.reachable) {
        (HealthState::Down, _) | (_, false) if d.job.pid.is_none() => "Stopped".into(),
        (HealthState::Down, _) | (_, false) => "Not responding".into(),
        _ => format!("Running{version}"),
    }
}

pub fn endpoint(model: &AppModel) -> Option<String> {
    model.discovery.as_ref()?.instance.control_url.clone()
}

/// The one line of context under the headline, most important first.
pub fn notice(model: &AppModel) -> Option<String> {
    if let ActionState::Failed(error) = &model.action {
        return Some(error.clone());
    }
    match &model.install {
        Some(InstallState::ReadOnly(ReadOnlyReason::Location)) => {
            return Some("Move AIO Proxy to Applications to let it manage the proxy.".into());
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app, version })) => {
            return Some(format!(
                "A newer copy ({version}) is installed at {}. This copy is read-only.",
                app.display()
            ));
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app })) => {
            return Some(format!("Cannot read the version of {}. This copy is read-only.", app.display()));
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error))) => {
            return Some(format!("Cannot update the service link: {error}"));
        }
        _ => {}
    }
    if let Some(error) = &model.discovery_error {
        return Some(error.clone());
    }
    let d = model.discovery.as_ref()?;
    match d.unit.owner {
        Owner::External => Some("Managed by the aio-proxy CLI. Changes happen only when you click.".into()),
        Owner::Unknown => Some("The installed service is not recognised; the app will not change it.".into()),
        Owner::Desktop if d.job.disabled => Some("Stopped by you. Click Start to run it again.".into()),
        _ => match &model.action {
            ActionState::Done(note) => Some(note.clone()),
            ActionState::Running(action) => Some(format!("{action:?}…")),
            ActionState::Automatic(action) => Some(format!("Automatic {action:?}…")),
            _ => model.summary_error.clone(),
        },
    }
}

#[cfg(test)]
mod tests;
```

`desktop/src/panel/degraded.rs`:

```rust
//! The panel for an instance without a usable `desktop-summary` (404, or an unknown protocolVersion):
//! status, endpoint, Open Dashboard, Reload.

use gpui_kit::*;

use crate::summary::DegradedReason;

pub fn body(reason: &DegradedReason) -> impl IntoElement {
    let text = match reason {
        DegradedReason::Missing => {
            "This aio-proxy is older than the desktop app and has no summary. Update it to see usage."
        }
        DegradedReason::UnsupportedVersion(_) => {
            "This aio-proxy speaks a newer summary format. Update the desktop app to see usage."
        }
    };
    div().py_2().text_sm().child(text)
}
```

`desktop/src/panel/actions.rs`:

```rust
//! The action row. Buttons only appear when the ownership table offers them.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel};
use crate::connect::policy::{UserAction, offered_actions};

fn action_button(id: &'static str, label: &'static str, action: UserAction, busy: bool) -> Button {
    Button::new(id).small().label(label).disabled(busy).on_click(move |_, _, cx| app::run_user_action(cx, action))
}

pub fn row(model: &AppModel) -> impl IntoElement {
    let busy = model.action.is_busy();
    let offered = model.discovery.as_ref().map(|d| offered_actions(d, model.persistent())).unwrap_or_default();
    let mut row = h_flex().gap_1().flex_wrap();
    if offered.start {
        row = row.child(action_button("start", "Start", UserAction::Start, busy));
    }
    if offered.restart {
        row = row.child(action_button("restart", "Restart", UserAction::Restart, busy));
    }
    if offered.stop {
        row = row.child(action_button("stop", "Stop", UserAction::Stop, busy));
    }
    if offered.reload {
        row = row.child(action_button("reload", "Reload config", UserAction::Reload, busy));
    }
    row.child(Button::new("refresh").small().label("Refresh").on_click(|_, _, cx| app::manual_refresh(cx)))
        .child(Button::new("logs").small().label("Open logs").on_click(|_, _, cx| app::open_logs(cx)))
        .child(
            Button::new("dashboard")
                .small()
                .primary()
                .label("Open Dashboard")
                .on_click(|_, _, cx| app::open_dashboard(cx)),
        )
}
```

`desktop/src/panel/view.rs`:

```rust
//! The panel's root view. It holds no data: everything renders from the `AppModel` global.

use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{compact, usd};
use super::{actions, degraded, status};
use crate::app::{AppModel, SummaryState};
use crate::summary::SummaryV1;

pub struct PanelView {
    _activation: Subscription,
}

impl PanelView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Click-away closes the panel (passed by hand on 2026-09-30, spike check 2 item 1).
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if !window.is_window_active() {
                super::window::close(window, cx);
            }
        });
        Self { _activation: activation }
    }
}

fn card(label: &'static str, value: String, cx: &App) -> impl IntoElement {
    v_flex()
        .flex_1()
        .p_2()
        .rounded_md()
        .border_1()
        .border_color(cx.theme().border)
        .child(div().text_xs().text_color(cx.theme().muted_foreground).child(label))
        .child(div().text_lg().child(value))
}

fn cards(summary: &SummaryV1, cx: &App) -> impl IntoElement {
    let usage = &summary.usage24h;
    h_flex()
        .gap_2()
        .child(card("Requests 24h", compact(usage.requests), cx))
        .child(card("Failed", compact(usage.failed_requests), cx))
        .child(card("Tokens", compact(usage.input_tokens + usage.output_tokens), cx))
        .child(card("Cost", usd(usage.estimated_cost_nano_usd), cx))
}

fn body(model: &AppModel, cx: &App) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    let message = |text: String| div().py_2().text_sm().text_color(muted).child(text).into_any_element();
    match &model.summary {
        SummaryState::Ready(summary) => v_flex().flex_1().gap_2().child(cards(summary, cx)).into_any_element(),
        SummaryState::Degraded(reason) => degraded::body(reason).into_any_element(),
        SummaryState::AuthFailed => message("Authentication failed. The desktop token was rejected.".into()),
        SummaryState::Unavailable(error) => message(error.clone()),
        SummaryState::Waiting => message("Loading…".into()),
    }
}

impl Render for PanelView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let model = cx.global::<AppModel>();
        let muted = cx.theme().muted_foreground;
        let mut header = v_flex().gap_1().child(div().text_lg().child(status::headline(model)));
        if let Some(endpoint) = status::endpoint(model) {
            header = header.child(div().text_xs().text_color(muted).child(endpoint));
        }
        if let Some(notice) = status::notice(model) {
            header = header.child(div().text_xs().child(notice));
        }
        v_flex()
            .size_full()
            .p_3()
            .gap_2()
            .bg(cx.theme().background)
            .child(header)
            .child(body(model, cx))
            .child(actions::row(model))
    }
}
```

`desktop/src/panel/window.rs`:

```rust
//! The PopUp window lifecycle: hybrid (destroy the window and its Metal surface on close, keep the
//! model), animation off, anchored from a click.

use std::time::{Duration, Instant};

use gpui_kit::*;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow, NSWindowAnimationBehavior};
use objc2_foundation::{NSNumber, NSString};
use tray_icon::TrayIcon;

use super::placement::{Frame, panel_origin};
use super::view::PanelView;
use crate::log;
use crate::tray::Tray;

pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 560.0;
/// A click on the icon first deactivates the panel (closing it); that click must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PanelWindow {
    handle: Option<AnyWindowHandle>,
    /// Held only while the window exists; keeping it would keep the NSWindow alive.
    native: Option<Retained<NSWindow>>,
    closed_at: Option<Instant>,
}

impl Global for PanelWindow {}

pub fn toggle(cx: &mut App) {
    let (handle, closed_at) = {
        let state = cx.global::<PanelWindow>();
        (state.handle, state.closed_at)
    };
    if let Some(handle) = handle {
        let _ = handle.update(cx, |_, window, cx| close(window, cx));
        return;
    }
    if closed_at.is_some_and(|at| at.elapsed() < REOPEN_GUARD) {
        return;
    }
    // The status item's frame is zero until AppKit lays out the menu bar, so anchor only from a click.
    let Some((x, y, display)) = anchor(&cx.global::<Tray>().icon) else {
        log::info("panel: could not compute the anchor");
        return;
    };
    cx.activate(true);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: point(px(x as f32), px(y as f32)),
            size: size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32)),
        })),
        titlebar: None,
        focus: true,
        // Shown by hand below, after the animation is turned off.
        show: false,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        display_id: Some(DisplayId::new(u64::from(display))),
        ..Default::default()
    };
    match gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| PanelView::new(window, cx))) {
        Ok((handle, _view)) => {
            let native = handle.update(cx, |_, window, _| native_window(window)).ok().flatten();
            if let Some(native) = &native {
                // AppKit's utility-window animation otherwise runs on its own thread for every open and close.
                native.setAnimationBehavior(NSWindowAnimationBehavior::None);
                native.makeKeyAndOrderFront(None);
            }
            let state = cx.global_mut::<PanelWindow>();
            state.handle = Some(handle);
            state.native = native;
            crate::app::panel_opened(cx);
        }
        Err(error) => log::info(format!("panel: open_window failed: {error:#}")),
    }
}

/// Shared by the toggle and the deactivation observer.
pub fn close(window: &mut Window, cx: &mut App) {
    let state = cx.global_mut::<PanelWindow>();
    state.handle = None;
    state.native = None;
    state.closed_at = Some(Instant::now());
    window.remove_window();
    crate::app::panel_closed(cx);
}

/// Panel origin (display-local, top-down points) and the icon's display id.
fn anchor(tray: &TrayIcon) -> Option<(f64, f64, u32)> {
    let mtm = MainThreadMarker::new()?;
    let window = tray.ns_status_item()?.button(mtm)?.window()?;
    let screen = window.screen()?;
    let frame = |r: objc2_foundation::NSRect| Frame {
        x: r.origin.x,
        y: r.origin.y,
        width: r.size.width,
        height: r.size.height,
    };
    let display = screen
        .deviceDescription()
        .objectForKey(&NSString::from_str("NSScreenNumber"))
        .and_then(|n| n.downcast::<NSNumber>().ok())
        .map(|n| n.unsignedIntValue())?;
    let (x, y) = panel_origin(frame(window.frame()), frame(screen.frame()), PANEL_WIDTH);
    Some((x, y, display))
}

/// The NSWindow GPUI created, reached through the public raw-window-handle (an NSView).
fn native_window(window: &Window) -> Option<Retained<NSWindow>> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else {
        return None;
    };
    // SAFETY: GPUI's AppKit handle wraps its live GPUIView for as long as `window` is borrowed.
    let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
    view.window()
}
```

In `desktop/src/app.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
pub enum AppEvent {
    OpenDashboard,
```

   Replace with:

```rust
pub enum AppEvent {
    TogglePanel,
    OpenDashboard,
```


In `desktop/src/tray.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
//! The menu-bar icon: right click opens a native menu, and the icon shows one of three states.
//! Task 11 adds the left-click panel toggle.
```

   Replace with:

```rust
//! The menu-bar icon: left click toggles the panel, right click opens a native menu, and the icon
//! shows one of three states.
```

2. Find:

```rust
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
```

   Replace with:

```rust
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
```

3. Find:

```rust
        .map_err(|error| error.to_string())?;
    MenuEvent::set_event_handler(
```

   Replace with:

```rust
        .map_err(|error| error.to_string())?;
    let clicks = events.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let _ = clicks.unbounded_send(AppEvent::TogglePanel);
        }
    }));
    MenuEvent::set_event_handler(
```


In `desktop/src/main.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
use aio_proxy_desktop::install::{self, Paths};
```

   Replace with:

```rust
use aio_proxy_desktop::install::{self, Paths};
use aio_proxy_desktop::panel::{self, PanelWindow};
```

2. Find:

```rust
        cx.set_global(AppModel::new(paths, bundle));
```

   Replace with:

```rust
        cx.set_global(AppModel::new(paths, bundle));
        cx.set_global(PanelWindow::default());
```

3. Find:

```rust
    match event {
        AppEvent::OpenDashboard
```

   Replace with:

```rust
    match event {
        AppEvent::TogglePanel => panel::toggle(cx),
        AppEvent::OpenDashboard
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 94 passed`; clippy clean.
Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`, then launch the bundle from where it was built (a read-only location) with an isolated home:

```bash
H=$(mktemp -d); HOME=$H "desktop/target/bundle/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop" &
```

Expected: a left click opens the panel directly under the icon (no arrow, no Dock icon, not in Cmd+Tab); its header shows a state and "Move AIO Proxy to Applications to let it manage the proxy."; clicking the desktop closes it; clicking the icon again reopens it; clicking the icon while it is open closes it and it stays closed. Quit from the right-click menu, then `rm -rf "$H"`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/lib.rs desktop/src/app.rs desktop/src/tray.rs desktop/src/main.rs desktop/src/panel.rs desktop/src/panel
git commit -m "feat(desktop): add the anchored panel with a hybrid window lifecycle"
```

### Task 12: Panel content: 7-day trend, activity heatmap, Provider quota list

**Files:**
- Create: `desktop/src/panel/charts.rs`, `desktop/src/panel/providers.rs`
- Modify: `desktop/src/panel.rs`, `desktop/src/panel/format.rs`, `desktop/src/panel/view.rs`
- Test: `desktop/src/panel/format/tests.rs`, `desktop/src/panel/charts/tests.rs`, `desktop/src/panel/providers/tests.rs`

**Interfaces:**
- Consumes: `summary::{ActivityDay, TrendBucket, Provider, ProviderState, Quota, QuotaWindow, LocalizedText}` (Task 2), `panel::view` (Task 11).
- Produces (private to `panel`): `format::{percent(f64) -> String, days_from_civil(i64, u32, u32) -> i64, civil_from_days(i64) -> (i64, u32, u32), parse_date(&str) -> Option<i64>, parse_utc(&str) -> Option<i64>, until(now: i64, at: i64) -> String, month_day(unix: i64, utc_offset: i64) -> String, local_utc_offset(unix: i64) -> i64}`; `charts::{HEATMAP_DAYS (365), heatmap_levels(activity: &[ActivityDay], today: i64) -> Vec<u8>, TrendPoint { label: SharedString, requests: f64 }, trend_points(&[TrendBucket], utc_offset: i64) -> Vec<TrendPoint>, trend(&[TrendBucket], now: i64, cx: &App), heatmap(&[ActivityDay], now: i64, cx: &App)}`; `providers::{quota_text(&QuotaWindow, now: i64) -> String, quota_status(&Quota) -> Option<&'static str>, list(&[Provider], now: i64, cx: &App)}`.

The trend uses GPUI Kit's `BarChart` exactly as the spike did (`git show spike/desktop:spike/desktop-host/src/main.rs`, lines 298-304: `BarChart::new(data).band(..).value(..).fill(move |_, _, _, _| accent).id(..)`; signatures in `gpui-component-0.7.0/src/chart/bar_chart.rs:88,202,208,232`). Bars are labelled `M/D` of the bucket's local day, so labels stay unique band keys. The heatmap is 365 plain cells, oldest first, today last (the spike's grid, lines 307-309); levels 1–4 scale by the busiest day. Quota bars use `gpui_kit::component::progress::Progress` with a 0–100 value (`progress/progress.rs:56`). Time math is dependency-free (Howard Hinnant's civil-date algorithm) and the server writes UTC `toISOString()` values, so only `Z`/`+00:00` parse.

- [ ] **Step 1: Write the failing test**

Replace `desktop/src/panel/format/tests.rs`:

```rust
use super::*;

#[test]
fn compacts_counts() {
    assert_eq!(compact(999), "999");
    assert_eq!(compact(1_204), "1.2K");
    assert_eq!(compact(14_815_402), "14.8M");
    assert_eq!(compact(148_000_000), "148M");
    assert_eq!(compact(1_500_000), "1.5M");
    assert_eq!(compact(18_014_398_509_481_985), "18014T");
}

#[test]
fn formats_nano_usd() {
    assert_eq!(usd(20_521_353_840), "$20.52");
    assert_eq!(usd(0), "$0.00");
    assert_eq!(usd(1), "<$0.01");
}

#[test]
fn round_trips_calendar_days() {
    assert_eq!(days_from_civil(1970, 1, 1), 0);
    assert_eq!(parse_date("2026-09-29"), Some(days_from_civil(2026, 9, 29)));
    assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    assert_eq!(parse_date("2026-13-01"), None);
    assert_eq!(parse_date("yesterday"), None);
}

#[test]
fn parses_utc_timestamps_only() {
    assert_eq!(parse_utc("1970-01-02T00:00:01.000Z"), Some(86_401));
    assert_eq!(parse_utc("1970-01-01T00:00:00+00:00"), Some(0));
    assert_eq!(parse_utc("1970-01-01T08:00:00+08:00"), None);
}

#[test]
fn describes_reset_times() {
    assert_eq!(until(0, 30), "now");
    assert_eq!(until(0, 40 * 60), "in 40m");
    assert_eq!(until(0, 2 * 3_600 + 5 * 60), "in 2h 5m");
    assert_eq!(until(0, 3 * 86_400 + 3_600), "in 3d 1h");
    assert_eq!(until(100, 0), "now");
}

#[test]
fn labels_a_bucket_by_its_local_day() {
    // The golden fixture's bucket starts at local midnight in UTC+8.
    let start = parse_utc("2026-09-28T16:00:00.000Z").unwrap();
    assert_eq!(month_day(start, 8 * 3_600), "9/29");
    assert_eq!(month_day(start, 0), "9/28");
}
```

Replace `desktop/src/panel.rs` (declares the two new modules):

```rust
//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod actions;
mod charts;
mod degraded;
mod format;
mod placement;
mod providers;
mod status;
mod view;
mod window;

pub use window::{PanelWindow, toggle};
```

Create `desktop/src/panel/charts.rs` and `desktop/src/panel/providers.rs`, each with only:

```rust
#[cfg(test)]
mod tests;
```

`desktop/src/panel/charts/tests.rs`:

```rust
// Not `super::*`: that glob carries gpui's own `test` attribute, which shadows the built-in one.
use super::{HEATMAP_DAYS, heatmap_levels, trend_points};
use crate::panel::format::days_from_civil;
use crate::summary::{ActivityDay, TrendBucket};

fn day(date: &str, total_tokens: u128) -> ActivityDay {
    ActivityDay { date: date.into(), total_tokens }
}

#[test]
fn today_is_the_last_cell_and_the_busiest_day_is_level_four() {
    let today = days_from_civil(2026, 9, 29);
    let levels = heatmap_levels(&[day("2026-09-29", 100), day("2026-09-28", 10), day("2026-09-01", 0)], today);
    assert_eq!(levels.len(), HEATMAP_DAYS);
    assert_eq!(levels[HEATMAP_DAYS - 1], 4);
    assert_eq!(levels[HEATMAP_DAYS - 2], 1);
    assert_eq!(levels[HEATMAP_DAYS - 3], 0);
}

#[test]
fn days_outside_the_window_and_bad_dates_are_ignored() {
    let today = days_from_civil(2026, 9, 29);
    let levels = heatmap_levels(&[day("2025-09-29", 50), day("2026-09-30", 50), day("soon", 50)], today);
    assert!(levels.iter().all(|&l| l == 0));
}

#[test]
fn trend_points_are_labelled_by_local_day() {
    let bucket = TrendBucket {
        start: "2026-09-28T16:00:00.000Z".into(),
        requests: 257,
        total_tokens: 1,
        estimated_cost_nano_usd: 1,
    };
    let points = trend_points(&[bucket], 8 * 3_600);
    assert_eq!(points[0].label.as_ref(), "9/29");
    assert_eq!(points[0].requests, 257.0);
}
```

`desktop/src/panel/providers/tests.rs`:

```rust
// Not `super::*`: that glob carries gpui's own `test` attribute, which shadows the built-in one.
use super::{quota_status, quota_text};
use crate::panel::format::parse_utc;
use crate::summary::{LocalizedText, Quota, QuotaWindow};

fn window(remaining_ratio: Option<f64>, resets_at: Option<&str>) -> QuotaWindow {
    QuotaWindow {
        id: "primary".into(),
        label: LocalizedText::Plain("5 hours".into()),
        remaining_ratio,
        resets_at: resets_at.map(str::to_string),
        window_minutes: Some(300),
    }
}

#[test]
fn describes_a_quota_window() {
    let now = parse_utc("2026-09-29T08:00:00.000Z").unwrap();
    assert_eq!(
        quota_text(&window(Some(0.4), Some("2026-09-29T10:00:00.000Z")), now),
        "5 hours · 40% left · resets in 2h 0m"
    );
    assert_eq!(quota_text(&window(None, None), now), "5 hours · no data");
}

#[test]
fn loading_and_failed_quota_are_worded_differently() {
    assert_eq!(quota_status(&Quota::Loading), Some("Quota loading…"));
    assert_eq!(quota_status(&Quota::Failed), Some("Quota unavailable"));
    assert_eq!(quota_status(&Quota::Unsupported), None);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo test --lib panel`
Expected: FAIL to compile: `` cannot find function `heatmap_levels` ``, `` cannot find function `quota_text` ``, `` cannot find function `parse_utc` ``.

- [ ] **Step 3: Implement**

Replace `desktop/src/panel/format.rs`:

```rust
//! Pure display formatting: counts, money, reset times and local calendar days.

pub fn compact(n: u128) -> String {
    const UNITS: [(u128, &str); 4] = [(1_000_000_000_000, "T"), (1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (scale, unit) in UNITS {
        if n >= scale {
            let tenths = n * 10 / scale;
            return if tenths >= 1_000 {
                format!("{}{unit}", tenths / 10)
            } else {
                format!("{}.{}{unit}", tenths / 10, tenths % 10)
            };
        }
    }
    n.to_string()
}

/// Nano-USD to dollars, two decimals; a non-zero amount below a cent reads `<$0.01`.
pub fn usd(nano: u128) -> String {
    let cents = nano / 10_000_000;
    if cents == 0 && nano > 0 {
        return "<$0.01".into();
    }
    format!("${}.{:02}", cents / 100, cents % 100)
}

pub fn percent(ratio: f64) -> String {
    format!("{:.0}%", (ratio.clamp(0.0, 1.0) * 100.0).floor())
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of `days_from_civil`: (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `YYYY-MM-DD` to a day number.
pub fn parse_date(text: &str) -> Option<i64> {
    let mut parts = text.splitn(3, '-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok().filter(|m| (1..=12).contains(m))?;
    let day = parts.next()?.parse().ok().filter(|d| (1..=31).contains(d))?;
    Some(days_from_civil(year, month, day))
}

/// RFC 3339 in UTC (`…Z` or `…+00:00`, as the server's `toISOString()` writes) to Unix seconds.
pub fn parse_utc(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let time = time.strip_suffix('Z').or_else(|| time.strip_suffix("+00:00"))?;
    let time = time.split('.').next()?;
    let mut hms = time.splitn(3, ':').map(|part| part.parse::<i64>().ok());
    let (h, m, s) = (hms.next()??, hms.next()??, hms.next()??);
    Some(parse_date(date)? * 86_400 + h * 3_600 + m * 60 + s)
}

/// `resetsAt` relative to now: "in 2h 5m", "in 40m", "now".
pub fn until(now: i64, at: i64) -> String {
    let minutes = (at - now).max(0) / 60;
    match (minutes / 1_440, minutes / 60 % 24, minutes % 60) {
        (0, 0, 0) => "now".into(),
        (0, 0, m) => format!("in {m}m"),
        (0, h, m) => format!("in {h}h {m}m"),
        (d, h, _) => format!("in {d}d {h}h"),
    }
}

/// `M/D` of the local day containing `unix`, for trend bar labels.
pub fn month_day(unix: i64, utc_offset: i64) -> String {
    let (_, month, day) = civil_from_days((unix + utc_offset).div_euclid(86_400));
    format!("{month}/{day}")
}

/// The local UTC offset in seconds (glue for the pure functions above).
pub fn local_utc_offset(unix: i64) -> i64 {
    let mut tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
    let time = unix as libc::time_t;
    // SAFETY: localtime_r writes `tm` and returns null on failure.
    if unsafe { libc::localtime_r(&time, tm.as_mut_ptr()) }.is_null() {
        return 0;
    }
    unsafe { tm.assume_init() }.tm_gmtoff
}

#[cfg(test)]
mod tests;
```

`desktop/src/panel/charts.rs`:

```rust
//! The 7-day trend (GPUI Kit's bar chart) and the 365-cell activity heatmap (a plain grid).

use gpui_kit::component::chart::BarChart;
use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{local_utc_offset, month_day, parse_date, parse_utc};
use crate::summary::{ActivityDay, TrendBucket};

pub const HEATMAP_DAYS: usize = 365;

/// Levels 0..=4 for the last 365 local days, oldest first; the last cell is `today`.
pub fn heatmap_levels(activity: &[ActivityDay], today: i64) -> Vec<u8> {
    let mut tokens = vec![0_u128; HEATMAP_DAYS];
    for day in activity {
        let Some(date) = parse_date(&day.date) else { continue };
        let age = today - date;
        if (0..HEATMAP_DAYS as i64).contains(&age) {
            tokens[HEATMAP_DAYS - 1 - age as usize] = day.total_tokens;
        }
    }
    let max = tokens.iter().copied().max().unwrap_or(0);
    tokens.iter().map(|&t| if t == 0 || max == 0 { 0 } else { (1 + t * 3 / max).min(4) as u8 }).collect()
}

#[derive(Clone)]
pub struct TrendPoint {
    pub label: SharedString,
    pub requests: f64,
}

pub fn trend_points(buckets: &[TrendBucket], utc_offset: i64) -> Vec<TrendPoint> {
    buckets
        .iter()
        .filter_map(|b| {
            let start = parse_utc(&b.start)?;
            Some(TrendPoint { label: month_day(start, utc_offset).into(), requests: b.requests as f64 })
        })
        .collect()
}

pub fn trend(buckets: &[TrendBucket], now: i64, cx: &App) -> impl IntoElement {
    let accent = cx.theme().chart_1;
    div().h(px(96.)).child(
        BarChart::new(trend_points(buckets, local_utc_offset(now)))
            .band(|p: &TrendPoint| p.label.clone())
            .value(|p: &TrendPoint| p.requests)
            .fill(move |_, _, _, _| accent)
            .id("trend-7d"),
    )
}

pub fn heatmap(activity: &[ActivityDay], now: i64, cx: &App) -> impl IntoElement {
    let accent = cx.theme().chart_1;
    let muted = cx.theme().muted;
    let today = (now + local_utc_offset(now)).div_euclid(86_400);
    h_flex().flex_wrap().gap(px(1.)).children(heatmap_levels(activity, today).into_iter().map(move |level| {
        let color = if level == 0 { muted } else { accent.opacity(f32::from(level) / 4.0) };
        div().size(px(7.)).rounded(px(1.)).bg(color)
    }))
}

#[cfg(test)]
mod tests;
```

`desktop/src/panel/providers.rs`:

```rust
//! The Provider list: state, diagnostic and one progress bar per quota window.

use gpui_kit::component::progress::Progress;
use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{parse_utc, percent, until};
use crate::summary::{Provider, ProviderState, Quota, QuotaWindow};

pub fn quota_text(window: &QuotaWindow, now: i64) -> String {
    let mut text = window.label.text().to_string();
    match window.remaining_ratio {
        Some(ratio) => text.push_str(&format!(" · {} left", percent(ratio))),
        None => text.push_str(" · no data"),
    }
    if let Some(at) = window.resets_at.as_deref().and_then(parse_utc) {
        text.push_str(&format!(" · resets {}", until(now, at)));
    }
    text
}

pub fn quota_status(quota: &Quota) -> Option<&'static str> {
    match quota {
        Quota::Loading => Some("Quota loading…"),
        Quota::Failed => Some("Quota unavailable"),
        Quota::Ready { refresh_failed: true, .. } => Some("Quota refresh failed; showing the last reading"),
        Quota::Unknown => Some("Quota status not recognised"),
        Quota::None | Quota::Unsupported | Quota::Ready { .. } => None,
    }
}

fn state_color(state: ProviderState, cx: &App) -> Hsla {
    match state {
        ProviderState::Ok => cx.theme().success,
        ProviderState::Degraded => cx.theme().warning,
        ProviderState::Unavailable => cx.theme().danger,
        ProviderState::Disabled | ProviderState::Unknown => cx.theme().muted_foreground,
    }
}

fn row(provider: &Provider, now: i64, cx: &App) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let mut column = v_flex().py_1().gap_1().border_b_1().border_color(cx.theme().border).child(
        h_flex()
            .gap_2()
            .items_center()
            .child(div().size(px(8.)).rounded_full().bg(state_color(provider.state, cx)))
            .child(div().text_sm().child(provider.name.clone())),
    );
    if let Some(diagnostic) = &provider.diagnostic {
        column = column.child(div().text_xs().text_color(muted).child(diagnostic.summary.clone()));
    }
    if let Some(status) = quota_status(&provider.quota) {
        column = column.child(div().text_xs().text_color(muted).child(status));
    }
    if let Quota::Ready { windows, .. } = &provider.quota {
        for window in windows {
            let id: SharedString = format!("quota-{}-{}", provider.id, window.id).into();
            column = column
                .child(div().text_xs().text_color(muted).child(quota_text(window, now)))
                .child(Progress::new(id).value(window.remaining_ratio.unwrap_or(0.0) as f32 * 100.0));
        }
    }
    column
}

pub fn list(providers: &[Provider], now: i64, cx: &App) -> impl IntoElement {
    div().id("providers").flex_1().overflow_y_scroll().children(providers.iter().map(|p| row(p, now, cx)))
}

#[cfg(test)]
mod tests;
```

In `desktop/src/panel/view.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
use gpui_kit::component::*;
```

   Replace with:

```rust
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::*;
```

2. Find:

```rust
use super::{actions, degraded, status};
```

   Replace with:

```rust
use super::{actions, charts, degraded, providers, status};
```

3. Find:

```rust
fn body(model: &AppModel, cx: &App) -> AnyElement {
```

   Replace with:

```rust
fn body(model: &AppModel, now: i64, cx: &App) -> AnyElement {
```

4. Find:

```rust
        SummaryState::Ready(summary) => v_flex().flex_1().gap_2().child(cards(summary, cx)).into_any_element(),
```

   Replace with:

```rust
        SummaryState::Ready(summary) => v_flex()
            .flex_1()
            .gap_2()
            .child(cards(summary, cx))
            .child(charts::trend(&summary.trend7d, now, cx))
            .child(charts::heatmap(&summary.activity, now, cx))
            .child(providers::list(&summary.providers, now, cx))
            .into_any_element(),
```

5. Find:

```rust
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let model
```

   Replace with:

```rust
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let model
```

6. Find:

```rust
            .child(body(model, cx))
```

   Replace with:

```rust
            .child(body(model, now, cx))
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 103 passed`; clippy clean. The rendered panel with real data is checked in Task 15 (it needs a desktop-owned service with a token).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/panel.rs desktop/src/panel/format.rs desktop/src/panel/format/tests.rs desktop/src/panel/charts.rs desktop/src/panel/charts desktop/src/panel/providers.rs desktop/src/panel/providers desktop/src/panel/view.rs
git commit -m "feat(desktop): show the trend, activity heatmap and Provider quota"
```

### Task 13: "App starts at login" (SMAppService)

**Files:**
- Create: `desktop/src/login_item.rs`, `desktop/src/panel/footer.rs`
- Modify: `desktop/src/lib.rs`, `desktop/build.rs`, `desktop/src/app.rs`, `desktop/src/app/lifecycle.rs`, `desktop/src/app/refresh.rs`, `desktop/src/panel.rs`, `desktop/src/panel/view.rs`

**Interfaces:**
- Consumes: `app::{AppModel, ActionState, changed}` (Task 10), `panel::view` (Task 11).
- Produces: `login_item::{LoginItemStatus::{NotRegistered, Enabled, RequiresApproval, NotFound, Unavailable}, status() -> LoginItemStatus, set_enabled(enabled: bool) -> Result<(), String>, open_settings()}`; `AppModel.login_item: LoginItemStatus` (refreshed on every panel open); `app::set_login_item(cx: &mut App, enabled: bool)` (no-op unless the install is persistent); private `panel::footer::footer(model: &AppModel, cx: &App)`.

The spike never touched SMAppService. The API was checked against the SDK header `$(xcrun --show-sdk-path)/System/Library/Frameworks/ServiceManagement.framework/Headers/SMAppService.h`: `SMAppServiceStatus` values `NotRegistered, Enabled, RequiresApproval, NotFound` = 0…3 (lines 30-34), `+mainAppService` (91), `-registerAndReturnError:` (172), `-unregisterAndReturnError:` (201), `status` (248), `+openSystemSettingsLoginItems` (283), all macOS 13.0. `objc2-service-management` is not in the dependency graph, so the calls go through `AnyClass::get(c"SMAppService")` and `msg_send!` (the same pattern the spike used for Sparkle), with `build.rs` linking `ServiceManagement` so the class is loaded; `msg_send![obj, registerAndReturnError: _]` is objc2 0.6's `NSError**` convention returning `Result<(), Retained<NSError>>`. The switch reads the real status; "requires approval" shows a button to System Settings. "Proxy starts at login" needs nothing here: it is the launchd job's `RunAtLoad`.

- [ ] **Step 1: Write the failing test**

There is no pure logic to unit-test (the status mapping restates the SDK's constants); the red step is the footer's call into the functions this task adds. Create `desktop/src/panel/footer.rs`:

```rust
//! Launch-at-login switch. Task 14 adds the gentle update reminder.

use gpui_kit::component::button::*;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel};
use crate::login_item::{self, LoginItemStatus};

pub fn footer(model: &AppModel, cx: &App) -> impl IntoElement {
    let mut row = h_flex().gap_2().items_center().justify_between();
    if model.persistent() {
        let enabled = matches!(model.login_item, LoginItemStatus::Enabled | LoginItemStatus::RequiresApproval);
        let mut login = h_flex().gap_1().items_center().child(
            Switch::new("login-item")
                .checked(enabled)
                .label("Open at login")
                .on_click(|checked, _, cx| app::set_login_item(cx, *checked)),
        );
        if model.login_item == LoginItemStatus::RequiresApproval {
            login = login.child(
                Button::new("login-approve")
                    .xsmall()
                    .ghost()
                    .label("Needs approval in System Settings")
                    .on_click(|_, _, _| login_item::open_settings()),
            );
        }
        row = row.child(login);
    }
    row.text_color(cx.theme().foreground)
}
```

Replace `desktop/src/panel.rs`:

```rust
//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod actions;
mod charts;
mod degraded;
mod footer;
mod format;
mod placement;
mod providers;
mod status;
mod view;
mod window;

pub use window::{PanelWindow, toggle};
```

In `desktop/src/panel/view.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
use super::{actions, charts, degraded, providers, status};
```

   Replace with:

```rust
use super::{actions, charts, degraded, footer, providers, status};
```

2. Find:

```rust
            .child(actions::row(model))
```

   Replace with:

```rust
            .child(actions::row(model))
            .child(footer::footer(model, cx))
```


- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo build`
Expected: FAIL: `` unresolved import `crate::login_item` ``, `` cannot find function `set_login_item` in module `app` ``, `` no field `login_item` on type `&AppModel` ``.

- [ ] **Step 3: Implement**

`desktop/src/login_item.rs`:

```rust
//! "App starts at login": `SMAppService.mainAppService` (macOS 13+), reached by name through the
//! ObjC runtime. build.rs links ServiceManagement so the class is loaded.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::NSError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItemStatus {
    NotRegistered,
    Enabled,
    /// Registered, but the user must allow it in System Settings > General > Login Items.
    RequiresApproval,
    NotFound,
    Unavailable,
}

fn service() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"SMAppService")?;
    // SAFETY: `+[SMAppService mainAppService]` returns a non-null autoreleased object (SDK header).
    Some(unsafe { msg_send![class, mainAppService] })
}

pub fn status() -> LoginItemStatus {
    let Some(service) = service() else {
        return LoginItemStatus::Unavailable;
    };
    // SAFETY: `status` is a readonly NSInteger property (SMAppServiceStatus).
    let raw: isize = unsafe { msg_send![&*service, status] };
    match raw {
        0 => LoginItemStatus::NotRegistered,
        1 => LoginItemStatus::Enabled,
        2 => LoginItemStatus::RequiresApproval,
        3 => LoginItemStatus::NotFound,
        _ => LoginItemStatus::Unavailable,
    }
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let service = service().ok_or("ServiceManagement is unavailable")?;
    // SAFETY: both selectors are `- (BOOL)…AndReturnError:(NSError **)`; `_` makes msg_send! pass
    // the out-pointer and turn NO into Err.
    let result: Result<(), Retained<NSError>> = unsafe {
        if enabled {
            msg_send![&*service, registerAndReturnError: _]
        } else {
            msg_send![&*service, unregisterAndReturnError: _]
        }
    };
    result.map_err(|error| error.localizedDescription().to_string())
}

pub fn open_settings() {
    if let Some(class) = AnyClass::get(c"SMAppService") {
        // SAFETY: `+[SMAppService openSystemSettingsLoginItems]` takes no arguments.
        let _: () = unsafe { msg_send![class, openSystemSettingsLoginItems] };
    }
}
```

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod client;
pub mod connect;
pub mod install;
pub mod log;
pub mod login_item;
pub mod panel;
pub mod process;
pub mod summary;
pub mod token;
pub mod tray;
pub mod version;
```

Replace `desktop/build.rs`:

```rust
// The app's version is the product package's: CFBundleShortVersionString, `--version` and the
// no-downgrade rule all read this one value, so it cannot drift from the bundled sidecar.
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let package = manifest.join("../npm/aio-proxy/package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let text = fs::read_to_string(&package).expect("read npm/aio-proxy/package.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse npm/aio-proxy/package.json");
    let version = json["version"].as_str().expect("npm/aio-proxy/package.json has a string version");
    println!("cargo:rustc-env=AIO_PROXY_VERSION={version}");

    // SMAppService is looked up by name at runtime; linking loads the framework.
    println!("cargo:rustc-link-lib=framework=ServiceManagement");

    // Sparkle links only for a bundle build (desktop/scripts/bundle.ts sets SPARKLE_DIR). `cargo test`
    // and `cargo run` then need no framework; the updater finds no class and stays off.
    println!("cargo:rerun-if-env-changed=SPARKLE_DIR");
    if let Ok(dir) = env::var("SPARKLE_DIR") {
        println!("cargo:rustc-link-search=framework={dir}");
        println!("cargo:rustc-link-lib=framework=Sparkle");
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path/../Frameworks");
    }
}
```

In `desktop/src/app.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
pub use lifecycle::{open_dashboard, open_logs, rediscover, run_user_action, start};
```

   Replace with:

```rust
pub use lifecycle::{open_dashboard, open_logs, rediscover, run_user_action, set_login_item, start};
```

2. Find:

```rust
use crate::install::{InstallState, Paths};
```

   Replace with:

```rust
use crate::install::{InstallState, Paths};
use crate::login_item::LoginItemStatus;
```

3. Find:

```rust
    pub action: ActionState,
    attempts
```

   Replace with:

```rust
    pub action: ActionState,
    pub login_item: LoginItemStatus,
    attempts
```

4. Find:

```rust
            action: ActionState::Idle,
            attempts
```

   Replace with:

```rust
            action: ActionState::Idle,
            login_item: LoginItemStatus::Unavailable,
            attempts
```


In `desktop/src/app/lifecycle.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
    cx.reveal_path(&home.join("logs"));
}
```

   Replace with:

```rust
    cx.reveal_path(&home.join("logs"));
}

/// "App starts at login" is a persistent operation, so it follows the install-location policy.
pub fn set_login_item(cx: &mut App, enabled: bool) {
    let model = cx.global_mut::<AppModel>();
    if !model.persistent() {
        return;
    }
    if let Err(error) = crate::login_item::set_enabled(enabled) {
        model.action = ActionState::Failed(format!("Launch at login: {error}"));
    }
    model.login_item = crate::login_item::status();
    changed(cx);
}
```


In `desktop/src/app/refresh.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
    let order = cx.global_mut::<AppModel>().scheduler.open(Instant::now());
    dispatch(cx, order);
    super::check_health(cx);
```

   Replace with:

```rust
    let model = cx.global_mut::<AppModel>();
    model.login_item = crate::login_item::status();
    let order = model.scheduler.open(Instant::now());
    dispatch(cx, order);
    super::check_health(cx);
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 103 passed`; clippy clean.
Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy && otool -L "desktop/target/bundle/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop" | grep -E "ServiceManagement|Sparkle"`
Expected: both frameworks listed. The switch itself is exercised in Task 15 (it only appears for a copy in an Applications folder).

- [ ] **Step 5: Commit**

```bash
git add desktop/build.rs desktop/src/lib.rs desktop/src/login_item.rs desktop/src/app.rs desktop/src/app/lifecycle.rs desktop/src/app/refresh.rs desktop/src/panel.rs desktop/src/panel/footer.rs desktop/src/panel/view.rs
git commit -m "feat(desktop): add the open-at-login switch backed by SMAppService"
```

### Task 14: Sparkle updater with gentle reminders

**Files:**
- Create: `desktop/src/updater.rs`
- Modify: `desktop/src/lib.rs`, `desktop/src/app.rs`, `desktop/src/tray.rs`, `desktop/src/main.rs`, `desktop/src/panel/footer.rs`

**Interfaces:**
- Consumes: `app::{AppEvent, AppModel, changed}` (Task 10), the bundle's `Info.plist` keys (Task 9).
- Produces: `updater::{UserDriverDelegate (ObjC class "AIOProxyUserDriverDelegate"), start(events: UnboundedSender<AppEvent>), check_now()}`; `AppEvent::{CheckForUpdates, UpdateAvailable(String), UpdateAttended}`; `AppModel.update_pending: Option<String>` (counts toward the tray's Attention state); tray menu "Check for Updates…"; panel footer "Update to <version>…".

Controller creation is the spike's (`git show spike/desktop:spike/desktop-host/src/main.rs`, lines 496-518: `AnyClass::get(c"SPUStandardUpdaterController")`, `msg_send![msg_send![cls, alloc], initWithStartingUpdater: true, updaterDelegate: none, userDriverDelegate: …]`, `checkForUpdates:`); it now passes a user-driver delegate and keeps both objects alive for the app's lifetime (Sparkle holds delegates weakly). The delegate is new: selectors from Sparkle 2.10.0's `Sparkle.framework/Versions/B/Headers/SPUStandardUserDriverDelegate.h` (`supportsGentleScheduledUpdateReminders` line 102, `standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:` 134, `standardUserDriverWillHandleShowingUpdate:forUpdate:state:` 161, `standardUserDriverDidReceiveUserAttentionForUpdate:` 175, `standardUserDriverWillFinishUpdateSession` 189) and `SUAppcastItem.displayVersionString` (`SUAppcastItem.h:63`); the class syntax is `objc2-0.6.4/src/macros/define_class.rs:292-358` with `MainThreadMarker::alloc` (`src/main_thread_marker.rs:269`). The class does not formally adopt the protocol (it is not in any objc2 binding); Sparkle probes these optional methods by selector. A scheduled update Sparkle would not show in immediate focus becomes a pending-update indicator (icon Attention state + footer button); the button calls `checkForUpdates:`, which brings Sparkle's own alert, with its "Install and Relaunch", into focus. After the relaunch the version-triggered restart in the automatic table moves a desktop-owned proxy onto the new binary; nothing here restarts anything.

The updater starts only when `Info.plist` carries both `SUFeedURL` and `SUPublicEDKey` (Task 9 writes them only with `SPARKLE_PUBLIC_ED_KEY`) and Sparkle is loaded, so `cargo run` and keyless dev bundles run without an updater instead of showing Sparkle's "updater failed to start" alert.

- [ ] **Step 1: Write the failing test**

As in Task 13 the red step is a call site. Apply the `main.rs` edits first:

In `desktop/src/main.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
use aio_proxy_desktop::app::{self, AppEvent, AppModel};
```

   Replace with:

```rust
use aio_proxy_desktop::app::{self, AppEvent, AppModel, changed};
```

2. Find:

```rust
use aio_proxy_desktop::{log, tray};
```

   Replace with:

```rust
use aio_proxy_desktop::{log, tray, updater};
```

3. Find:

```rust
        observe_wake(events);
```

   Replace with:

```rust
        updater::start(events.clone());
        observe_wake(events);
```

4. Find:

```rust
        AppEvent::OpenDashboard => app::open_dashboard(cx),
```

   Replace with:

```rust
        AppEvent::OpenDashboard => app::open_dashboard(cx),
        AppEvent::CheckForUpdates => updater::check_now(),
```

5. Find:

```rust
        AppEvent::Wake => app::check_health(cx),
```

   Replace with:

```rust
        AppEvent::Wake => app::check_health(cx),
        AppEvent::UpdateAvailable(version) => {
            cx.global_mut::<AppModel>().update_pending = Some(version);
            changed(cx);
        }
        AppEvent::UpdateAttended => {
            cx.global_mut::<AppModel>().update_pending = None;
            changed(cx);
        }
```


- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && cargo build`
Expected: FAIL: `` unresolved import `aio_proxy_desktop::updater` ``, `` no variant named `CheckForUpdates` ``, `` no field `update_pending` ``.

- [ ] **Step 3: Implement**

`desktop/src/updater.rs`:

```rust
//! Sparkle 2.10.0 on the main thread: `SPUStandardUpdaterController` plus a
//! `SPUStandardUserDriverDelegate` with gentle reminders, because a background (`LSUIElement`) app
//! gets none from Sparkle. Updates only ever install through Sparkle's "Install and Relaunch"
//! (`SUAllowsAutomaticUpdates` is false); the relaunched app restarts its proxy through the
//! automatic-action table.

use std::cell::RefCell;

use futures::channel::mpsc::UnboundedSender;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{NSBundle, NSString};

use crate::app::AppEvent;
use crate::log;

pub struct Ivars {
    events: UnboundedSender<AppEvent>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop impl.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AIOProxyUserDriverDelegate"]
    #[ivars = Ivars]
    pub struct UserDriverDelegate;

    impl UserDriverDelegate {
        #[unsafe(method(supportsGentleScheduledUpdateReminders))]
        fn supports_gentle_reminders(&self) -> bool {
            true
        }

        /// Let Sparkle show a scheduled update itself only when it would be in immediate focus;
        /// otherwise the panel and icon carry the reminder.
        #[unsafe(method(standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:))]
        fn should_handle_scheduled(&self, _update: &AnyObject, immediate_focus: bool) -> bool {
            immediate_focus
        }

        #[unsafe(method(standardUserDriverWillHandleShowingUpdate:forUpdate:state:))]
        fn will_handle_showing(&self, handle_showing: bool, update: &AnyObject, _state: &AnyObject) {
            if handle_showing {
                return;
            }
            // SAFETY: `SUAppcastItem.displayVersionString` is a non-null NSString property.
            let version: Retained<NSString> = unsafe { msg_send![update, displayVersionString] };
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAvailable(version.to_string()));
        }

        #[unsafe(method(standardUserDriverDidReceiveUserAttentionForUpdate:))]
        fn did_receive_attention(&self, _update: &AnyObject) {
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAttended);
        }

        #[unsafe(method(standardUserDriverWillFinishUpdateSession))]
        fn will_finish_session(&self) {
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAttended);
        }
    }

    unsafe impl NSObjectProtocol for UserDriverDelegate {}
);

thread_local! {
    /// Sparkle holds its delegate weakly; both live for the life of the app.
    static UPDATER: RefCell<Option<(Retained<AnyObject>, Retained<UserDriverDelegate>)>> = const { RefCell::new(None) };
}

/// Both keys are written by the bundle step only when a feed and key are configured.
fn configured() -> bool {
    let bundle = NSBundle::mainBundle();
    ["SUFeedURL", "SUPublicEDKey"].iter().all(|key| {
        bundle
            .objectForInfoDictionaryKey(&NSString::from_str(key))
            .and_then(|value| value.downcast::<NSString>().ok())
            .is_some_and(|value| !value.to_string().is_empty())
    })
}

pub fn start(events: UnboundedSender<AppEvent>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    if !configured() {
        log::info("updater: disabled (Info.plist has no SUFeedURL/SUPublicEDKey)");
        return;
    }
    let Some(class) = AnyClass::get(c"SPUStandardUpdaterController") else {
        log::info("updater: disabled (Sparkle.framework is not loaded)");
        return;
    };
    let delegate = mtm.alloc::<UserDriverDelegate>().set_ivars(Ivars { events });
    // SAFETY: NSObject's designated initializer.
    let delegate: Retained<UserDriverDelegate> = unsafe { msg_send![super(delegate), init] };
    let none: Option<&AnyObject> = None;
    // SAFETY: `-initWithStartingUpdater:updaterDelegate:userDriverDelegate:` (SPUStandardUpdaterController.h).
    let controller: Retained<AnyObject> = unsafe {
        msg_send![msg_send![class, alloc], initWithStartingUpdater: true, updaterDelegate: none, userDriverDelegate: &*delegate]
    };
    log::info("updater: started");
    UPDATER.with(|slot| *slot.borrow_mut() = Some((controller, delegate)));
}

/// "Check for Updates…" and the panel's update button: brings Sparkle's own alert into focus.
pub fn check_now() {
    UPDATER.with(|slot| {
        if let Some((controller, _)) = &*slot.borrow() {
            let none: Option<&AnyObject> = None;
            // SAFETY: `-[SPUStandardUpdaterController checkForUpdates:]` takes an optional sender.
            let _: () = unsafe { msg_send![&**controller, checkForUpdates: none] };
        }
    });
}
```

`desktop/src/lib.rs`:

```rust
//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod client;
pub mod connect;
pub mod install;
pub mod log;
pub mod login_item;
pub mod panel;
pub mod process;
pub mod summary;
pub mod token;
pub mod tray;
pub mod updater;
pub mod version;
```

In `desktop/src/app.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
    OpenDashboard,
    Quit,
    Wake,
}
```

   Replace with:

```rust
    OpenDashboard,
    CheckForUpdates,
    Quit,
    Wake,
    UpdateAvailable(String),
    UpdateAttended,
}
```

2. Find:

```rust
    pub action: ActionState,
    pub login_item
```

   Replace with:

```rust
    pub action: ActionState,
    pub update_pending: Option<String>,
    pub login_item
```

3. Find:

```rust
            action: ActionState::Idle,
            login_item
```

   Replace with:

```rust
            action: ActionState::Idle,
            update_pending: None,
            login_item
```

4. Find:

```rust
        alerts
            || matches!(self.action
```

   Replace with:

```rust
        alerts
            || self.update_pending.is_some()
            || matches!(self.action
```


In `desktop/src/tray.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
const OPEN_DASHBOARD: &str = "open-dashboard";
```

   Replace with:

```rust
const OPEN_DASHBOARD: &str = "open-dashboard";
const CHECK_UPDATES: &str = "check-updates";
```

2. Find:

```rust
        &MenuItem::with_id(OPEN_DASHBOARD, "Open Dashboard", true, None),
```

   Replace with:

```rust
        &MenuItem::with_id(OPEN_DASHBOARD, "Open Dashboard", true, None),
        &MenuItem::with_id(CHECK_UPDATES, "Check for Updates…", true, None),
```

3. Find:

```rust
            OPEN_DASHBOARD => AppEvent::OpenDashboard,
```

   Replace with:

```rust
            OPEN_DASHBOARD => AppEvent::OpenDashboard,
            CHECK_UPDATES => AppEvent::CheckForUpdates,
```


In `desktop/src/panel/footer.rs`, make these replacements (each "find" text occurs exactly once in the file):

1. Find:

```rust
//! Launch-at-login switch. Task 14 adds the gentle update reminder.
```

   Replace with:

```rust
//! Launch-at-login switch and the gentle update reminder.
```

2. Find:

```rust
        row = row.child(login);
    }
```

   Replace with:

```rust
        row = row.child(login);
    }
    if let Some(version) = &model.update_pending {
        row = row.child(
            Button::new("update")
                .small()
                .primary()
                .label(format!("Update to {version}…"))
                .on_click(|_, _, _| crate::updater::check_now()),
        );
    }
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: `test result: ok. 103 passed`; clippy clean.
Run (a throwaway key only for this check; Sparkle writes the `com.aio-proxy.desktop` defaults domain, which the last command removes):

```bash
SPARKLE_PUBLIC_ED_KEY=6tfdkTDFm68kxdxZ4oBJZ625LnOFeVLbWB6UcIsQDW4= SPARKLE_FEED_URL=http://127.0.0.1:1/appcast.xml \
  bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy
H=$(mktemp -d); (HOME=$H "desktop/target/bundle/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop" > "$H/out" 2>&1 & echo $! > "$H/pid")
sleep 6; kill "$(cat "$H/pid")"; cat "$H/out"; rm -rf "$H"; defaults delete com.aio-proxy.desktop 2>/dev/null
```

Expected: the output contains `updater: started` and no crash; without `SPARKLE_PUBLIC_ED_KEY` the same run logs `updater: disabled (Info.plist has no SUFeedURL/SUPublicEDKey)`. The update flow itself is Task 15, item 13.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/updater.rs desktop/src/lib.rs desktop/src/app.rs desktop/src/tray.rs desktop/src/main.rs desktop/src/panel/footer.rs
git commit -m "feat(desktop): add the Sparkle updater with gentle update reminders"
```


### Task 15: Release note, full verification and manual acceptance

**Files:**
- Create: `.changeset/desktop-app.md`

**Interfaces:**
- Consumes: the finished app (Tasks 1–14) and `bun run desktop:bundle --unsigned`.
- Produces: the user-facing release note; a completed manual acceptance record (paste it into the PR description, not into a file).

The Phase 1 note (`.changeset/desktop-server-cli.md`) stays as it is: it describes the CLI and server changes, which are independent of the app. This note describes the app only. The app reaches users through the DMG that Phase 3's release job publishes; do not merge this branch to `main` before that pipeline exists, or the note would announce an app no Release carries.

- [ ] **Step 1: Write the release note**

Create `.changeset/desktop-app.md`:

```markdown
---
'aio-proxy': minor
---

New macOS menu-bar app for Apple Silicon (macOS 13 or later). It runs aio-proxy as a login service without a separate Bun or CLI install, and its panel shows proxy status, the last 24 hours of usage, Provider health and quota, a 7-day trend and an activity heatmap, with start, stop, restart and reload. A service installed with the CLI is only changed when you click.
```

- [ ] **Step 2: Check the note is picked up**

Run: `bun changeset status --verbose`
Expected: `aio-proxy` listed with a `minor` bump, and the fixed group's other packages bumped with it.

- [ ] **Step 3: Run the full verification**

Run: `cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: clean; `test result: ok. 103 passed`.
Run: `bun run preflight`
Expected: passes (it runs `lint:types`, which needs a built tree: run `bun run build` first if it reports unresolved workspace types).
Run: `bun run desktop:bundle --unsigned`
Expected: the full bundle path from Task 9, ending in the `.app` path.
Run: `find desktop/src desktop/scripts -name '*.rs' -o -name '*.ts' | grep -v -e '/tests.rs$' -e '.test.ts$' | xargs wc -l | sort -n | tail -3`
Expected: no handwritten non-test file at or above 500 lines.

- [ ] **Step 4: Manual acceptance**

Setup, once. Use a separate macOS user account for items 5–15 (they install, stop and restart the real `com.aio-proxy.agent` job and use `~/.aio-proxy`); items 1–4 and 16 can run anywhere.

```bash
bun run desktop:bundle --unsigned
mkdir -p ~/Applications && ditto "desktop/target/bundle/AIO Proxy.app" ~/Applications/"AIO Proxy.app"
open ~/Applications/"AIO Proxy.app"
tail -f ~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log   # the app's own log, in another terminal
```

Record pass/fail and the log excerpt for each item:

1. **Toggle via icon.** Left click opens the panel directly under the icon, centred, below the menu bar, with no arrow; clicking the icon again closes it and it stays closed; right click shows Open Dashboard, Check for Updates…, Quit AIO Proxy.
2. **Click outside hides.** Click the desktop, then another app's window: the panel closes each time.
3. **Not in Dock or Cmd+Tab**, including during launch.
4. **Second display with a different scale factor** and **full-screen app in another Space**: the panel anchors under the icon on that display with crisp text, and appears over the full-screen app.
5. **Fresh install (no plist).** With no `~/Library/LaunchAgents/com.aio-proxy.agent.plist`, first launch installs and starts the service: `launchctl print gui/$(id -u)/com.aio-proxy.agent` shows a pid; `plutil -p ~/Library/LaunchAgents/com.aio-proxy.agent.plist` shows `ProgramArguments[3]` = `~/Library/Application Support/aio-proxy-desktop/bin/aio-proxy` and the `AIO_PROXY_DESKTOP_EXEC` / `AIO_PROXY_UPGRADE_METHOD=desktop` markers; `readlink` of the symlink points into `~/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy`; the panel shows `Running <version>`, cards, trend, heatmap and Providers.
6. **Desktop user actions and completion.** Stop: after the button, `launchctl print` shows no pid and the panel says Stopped. Start: runs again. Restart: the old sidecar pid (`pgrep -f "aio-proxy run"`) is gone and `/health` answers before the panel refreshes. Reload with a broken `~/.aio-proxy/config.jsonc`: the header shows `Reload rejected at <stage>: …`; fix it and Reload succeeds.
7. **A user-stopped desktop service stays stopped across app relaunch.** Stop, Quit, reopen: still Stopped (`job.disabled`), with a Start button and "Stopped by you".
8. **Quit leaves the proxy running.** Quit from the menu; `curl -s http://127.0.0.1:9317/health` still answers.
9. **Recovery rows.** `kill -TERM <sidecar pid>` (a SIGTERM launchd did not send): the next rediscovery (open the panel) starts it once; do it again in the same app session: it stays down and shows Start (one attempt per launch).
10. **External service is never changed without a click and never rewritten.** `aio-proxy service uninstall`, then install the CLI's own service (`aio-proxy service install && aio-proxy service start` from a CLI install). Relaunch the app: the header says "Managed by the aio-proxy CLI…", nothing restarts. Note `shasum ~/Library/LaunchAgents/com.aio-proxy.agent.plist`; click Restart: the proxy restarts (new pid) and the checksum is unchanged (kickstart -k, not `service restart`).
11. **Unknown owner.** Hand-edit the plist wrapper string (`ProgramArguments[2]`): the app offers no service buttons and says it will not change it.
12. **Opening an older app copy does not downgrade.** With the current copy in `~/Applications`, build a copy whose `npm/aio-proxy/package.json` version is lower (edit locally, do not commit), put it in `/Applications`, quit the current app and open the older one: its header names the newer copy's path and version, `readlink` is unchanged, and no service command runs.
13. **Sparkle update restarts a desktop-owned proxy onto the new version.** Make a throwaway key and a local feed:

    ```bash
    export KEY=/tmp/aio-sparkle-dev.key
    PUB=$(bun -e 'import { generateKeyPairSync } from "node:crypto"; const { privateKey, publicKey } = generateKeyPairSync("ed25519"); await Bun.write(process.env.KEY, privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64")); console.log(publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));')
    SPARKLE_PUBLIC_ED_KEY=$PUB SPARKLE_FEED_URL=http://127.0.0.1:8123/appcast.xml bun run desktop:bundle --unsigned   # v1
    ditto "desktop/target/bundle/AIO Proxy.app" ~/Applications/"AIO Proxy.app"
    # bump npm/aio-proxy/package.json locally (do not commit), then build v2 with the same two variables
    mkdir -p /tmp/aio-feed && ditto -c -k --keepParent "desktop/target/bundle/AIO Proxy.app" /tmp/aio-feed/AIO-Proxy-v2.zip
    desktop/vendor/sparkle-2.10.0/bin/generate_appcast --ed-key-file "$KEY" --download-url-prefix http://127.0.0.1:8123/ /tmp/aio-feed
    python3 -m http.server 8123 --directory /tmp/aio-feed
    ```

    Open v1, choose Check for Updates…, click Install and Relaunch: the app relaunches as v2 and its log shows `automatic action: RestartForVersion`, then `/health` reports v2. `SUAutomaticallyUpdate` never appears in `defaults read com.aio-proxy.desktop`. Delete `$KEY` and revert `package.json` afterwards. (Ad-hoc builds log a code-signature mismatch in Sparkle's log and still install on the EdDSA signature; the Developer ID run of this item is Phase 3's.)
14. **Gentle reminder.** With v1 running in the background and the feed from item 13 up, run `defaults write com.aio-proxy.desktop SUEnableAutomaticChecks -bool true` and `defaults write com.aio-proxy.desktop SULastCheckTime -date "2000-01-01 00:00:00 +0000"`, then relaunch: if Sparkle does not show its alert in immediate focus, the icon switches to the attention state and the panel footer shows `Update to <version>…`, which opens Sparkle's alert. Record which path Sparkle took.
15. **Open at login.** The footer switch reflects `SMAppService` status; turning it on either enables it or shows "Needs approval in System Settings", whose button opens Login Items; the state survives a logout/login. The switch is absent for a copy outside an Applications folder.
16. **Sleep/wake with the panel open and closed**: no crash; after wake the log shows a health check and reopening still anchors correctly.
17. **401 handling.** Replace `~/.aio-proxy/desktop-token` with another valid-looking value without restarting the proxy: the panel rediscovers once, then shows "Authentication failed"; the proxy is not restarted.
18. **Degraded panel.** Point the app at an instance without `desktop-summary` (for example an external service running a 0.35.x CLI): the panel shows status, endpoint, the "older than the desktop app" text, Open Dashboard and Reload config.
19. **App deleted leaves launchd quiet; restoring recovers.** With the desktop service running: quit the app, move `~/Applications/AIO Proxy.app` to the Trash (do not empty it), `kill -TERM` the sidecar, watch `launchctl print gui/$(id -u)/com.aio-proxy.agent` and `log show --last 10m --predicate 'process == "launchd"' | grep aio-proxy` for 10 minutes: no respawn loop. Put the app back and open it: the loaded job is started again (`automatic action: StartNoProcess`).
20. **Footprint and wakeups (closed panel).** Open and close the panel once, wait a minute, then `footprint -p "$(pgrep -x aio-proxy-desktop)" | grep "Footprint:"` reports ≤ 40 MB, and `sudo powermetrics --samplers tasks --show-process-wakeups -i 10000 -n 3 | grep -A2 aio-proxy-desktop` shows ≤ 1 interrupt wakeup/s. Also record the hybrid-with-animation-None checks the spike never measured: 100 open/close cycles grow footprint by ≤ 10 MB, and a QuickTime 60 fps recording of ~10 opens shows no blank/white frame and click → full content ≤ 100 ms. If hybrid fails and destroy passes, switch per Task 11's fallback note.

- [ ] **Step 5: Commit**

```bash
git add .changeset/desktop-app.md
git commit -m "docs(changeset): announce the macOS menu-bar app"
```

---

## Appendix: Spec coverage

| Spec requirement (app-owned) | Where |
| --- | --- |
| Platform: `arm64` only | Task 1 (`--target aarch64-apple-darwin` in CI job and bundle), Task 9 (`lipo -archs` checks) |
| Minimum macOS 13.0 → `MACOSX_DEPLOYMENT_TARGET`, `LSMinimumSystemVersion`, every Mach-O `minos` ≤ 13.0 | Task 1 (`.cargo/config.toml`), Task 9 (`renderInfoPlist`, `machOProblems`) |
| Install location policy; "Move to Applications"; read-only otherwise | Task 6 (`location_allows_persistence`, `volume_is_read_only`, `prepare`), Task 10 (`prepare_install`), Task 11 (`notice`) |
| Stack: GPUI Kit `=0.7.0`, `tray-icon`, `WindowKind::PopUp`, `LSUIElement` + Accessory, `SMAppService`, Sparkle 2.10.0 + SHA-256, std `TcpStream` client, bundled Bun sidecar, mise | Tasks 1, 4, 9, 10, 11, 13, 14 |
| Bundled `Contents/MacOS/aio-proxy` beside `aio-proxy-desktop`; plist points at the symlink | Task 9 (layout), Task 6 (`Paths.symlink`, `sidecar_of`), Task 8 (`AIO_PROXY_DESKTOP_EXEC`) |
| Single instance via `flock` on `instance.lock`; a second copy exits | Task 6 (`acquire_instance_lock`), Task 10 (`main`) |
| No downgrade: `<target> --version`, re-point only when missing or not newer, otherwise read-only with a notice naming the copy | Task 6 (`plan_symlink`, `probe_version`), Task 11 (`notice`) |
| Re-point = temp symlink + `rename`, only after the location check | Task 6 (`repoint`, `prepare`) |
| Discovery consumption: separate unit/job/instance facts; `owner` null only as "no plist"; `job.disabled` fails closed; `matchesJob` null = no match; `protocolVersion` checked | Task 3 |
| Environment contract `AIO_PROXY_DESKTOP_EXEC` for discovery and every service command | Task 8 (`SystemHost::cli`) |
| Automatic-action table, every row; requirements (owner desktop, matchesJob or unreachable, valid location); disabled → nothing; never downgrade | Task 7 (`automatic_action`) |
| One attempt per launch; failure shown, no retry loop | Task 7 (`AutoAttempts`), Task 10 (`maybe_automatic`) |
| Version-triggered restart waits 30 s for the old pid gone and `/health` = `bundledVersion` | Task 8 (`run_auto`, `restart_complete`) |
| Re-run discovery before every mutation; abort on owner/matchesJob/disabled change | Task 7 (`unchanged`), Task 8 (`fresh`) |
| User actions per ownership table (kickstart -k for external restart; `service restart` only for desktop) | Task 7 (`user_mutations`, `offered_actions`), Task 8, Task 11 (`actions::row`) |
| Completion conditions: Restart, Stop, Reload (409 `error`/`stage`); then refetch | Task 7, Task 8, Task 10 (`after_action`) |
| "App starts at login" via `SMAppService`, real status incl. requires approval + System Settings link | Task 13 |
| Health check: 2 s, two failures = down, every 60 s + panel open + wake; icon + rediscovery only | Task 5 (`HealthTracker`, `parse_health`), Task 10 (`app/health.rs`, `panel_opened`, wake observer in `main.rs`) |
| Local token: redacting `Debug`; never logged; stdout never logged | Task 3 (`Token`, `parse_discovery` errors), Task 8 (discovery errors carry stderr only), Task 10 (`log`) |
| 401: rediscover once, then "authentication failed", never restart | Task 10 (`app/refresh.rs::finish`), Task 11 (view) |
| Refresh policy table and rules (one in flight, 5 s deadline, dirty, 15 s floor, tags, cancel on close) | Task 5 (`Scheduler`), Task 4 (deadline), Task 10 (`app/refresh.rs`) |
| Local HTTP transport rules (no proxy, no redirects, 1 s connect, 5 s total, loopback literal only, chunked, size cap, token never default) | Task 4 |
| Desktop app structure: `main.rs`, `tray.rs`, `panel/`, `install.rs`, `connect`, `client`, `summary.rs`, `login_item.rs`, `updater.rs` | Tasks 1–14 (see File Structure) |
| Tray: left click toggles with the icon rect, right click native menu, three icon states | Task 10, Task 11 |
| Panel: placement below the menu bar, centred, clamped to the icon's screen; anchor only from a click | Task 11 (`placement`, `anchor`) |
| Panel views: stat cards, Provider quota list, 7-day trend, heatmap (plain grid), action row; no arrow | Task 11, Task 12 |
| Hybrid lifecycle; `NSWindowAnimationBehaviorNone` right after creation; fallback to destroy | Task 11 (`window.rs`) |
| "Open logs" reveals `$AIO_PROXY_HOME/logs`; the app's own log in `~/Library/Logs/aio-proxy-desktop/` | Task 10 (`open_logs`, `log.rs`) |
| Degraded panel for 404 or unsupported `protocolVersion`: status, endpoint, Open Dashboard, Reload | Task 2 (`classify`), Task 11 (`degraded.rs`, header, action row) |
| Updater: Sparkle controller on the main thread; gentle reminders; "Install and Relaunch" only (`SUAllowsAutomaticUpdates=false`, no `SUAutomaticallyUpdate`); post-update restart through the version rule | Task 9 (`Info.plist`), Task 14, Task 7 (`RestartForVersion`) |
| Bundle command steps 1–8 for `--unsigned` (tools, build, build-binary + notices, cargo with 13.0, assembly incl. `Info.plist` keys, arch/minos/`--version` checks, runtime smoke, ad-hoc signature) | Task 9 |
| Version = `npm/aio-proxy/package.json` for `CFBundleShortVersionString` and `CFBundleVersion` | Task 1 (`build.rs`), Task 9 (`bundle.ts`) |
| Runtime smoke (temp home, free port, `PATH=/usr/bin:/bin`, `/health` version, dashboard HTML + one asset, `desktop-summary` 200 with the temp token, SIGTERM, no launchd job) | Task 9 (`smoke.ts`) |
| Entitlements: sidecar `allow-jit` only, justified; ad-hoc host `disable-library-validation` only for ad-hoc builds, also on the `.app` step | Task 9 |
| CI Rust job (`cargo fmt --check`, `clippy --all-targets -D warnings`, `cargo test`) on `desktop/**` | Task 1 |
| Changeset targets `aio-proxy` | Task 15 |
| Rust tests from the spec's Testing list (placement, summary parsing, automatic table, refresh scheduler, transport, install policy + symlink + second instance, token `Debug`) | Tasks 11, 2, 7, 5, 4, 6, 3 |
| Manual acceptance list | Task 15, Step 4 |

Out of scope here (Phase 3 by decision): Developer ID signing, notarization, the DMG, `generate_appcast` in CI, `sparkle:minimumSystemVersion`, the feed tag, the release `desktop` job and the Bundle smoke CI job. Step 1's `notarytool`/`stapler`/Sparkle-tool checks join `bundle.ts` with signing.

Deviations from the spec's wording, all in the safe direction or additive: every automatic row is limited to one attempt per launch (the spec names two rows); the "no plist" install also requires that nothing answers the control address; the tray menu adds "Check for Updates…"; service commands carry the plist's `AIO_PROXY_HOME`; the CI Rust job also runs when `npm/aio-proxy/package.json` or the shared golden fixture changes, because the crate reads both.
