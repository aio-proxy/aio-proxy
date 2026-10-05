# Windows and Linux Desktop — Phase 4: Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app updates on Linux and Windows through `cargo-packager-updater`, signed with the existing Sparkle Ed25519 key in minisign form, with the signed trusted comment binding version, target and asset.

**Architecture:** A Bun signer (`desktop/scripts/minisign/`) turns `SPARKLE_ED_PRIVATE_KEY` into minisign `.minisig` text; the Rust `platform::updater` for Linux and Windows wraps `cargo-packager-updater`, checks the verified trusted comment before `install`, and drives the existing `AppEvent::UpdateAvailable` / `UpdateAttended` events plus a new `UpToDate`. macOS keeps Sparkle.

**Tech Stack:** Bun + WebCrypto Ed25519 + `node:crypto` `blake2b512`; Rust `cargo-packager-updater` 0.2.3, `minisign-verify` (its dependency) for trusted-comment parsing, `base64`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 4), section 5. Requires phases 2–3.

## Global Constraints

- Feed URL: `https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/latest.json`; compile-time overrides `option_env!("AIO_PROXY_DESKTOP_FEED_URL")` and `option_env!("AIO_PROXY_DESKTOP_UPDATE_KEY")` for rehearsals only; phase 5's packaging script accepts them only with `--rehearsal`, which names its outputs `*-rehearsal.*`, and the publish scripts reject anything not signed by the release key.
- Targets: `linux-x86_64`, `linux-aarch64` (format `appimage`), `windows-x86_64` (format `nsis`).
- Public key string given to the updater = `base64("untrusted comment: aio-proxy-desktop update key\n" + base64("Ed" ‖ KEY_ID ‖ pk32) + "\n")`.
- `signature` field = `base64(` four-line `.minisig` text `)`; signature algorithm `ED` (prehashed: Ed25519 over BLAKE2b-512 of the file).
- `KEY_ID`: 8 fixed bytes, defined once in `desktop/scripts/minisign/minisign.ts` and `desktop/src/platform/update_key.rs` (little-endian of `0x6169_6f70_7278_7964`, "aioprxyd").
- Trusted comment: `aio-proxy-desktop <version> <target> <asset name>`.
- Checks at launch and every 6 h; no silent install; Windows install mode `Passive`.
- Linux in-place install only when the directory of `$APPIMAGE` is writable; otherwise "Install" opens the Release page for that version.

## Review Focus

- A feed whose `version` is newer but whose signature's trusted comment names an older version (replayed package) — owned by Task 3.
- A feed with no entry for the running target (e.g. `linux-aarch64` missing) — must be "no update", not an error dialog — owned by Task 3.
- The network down at launch: no user-visible error, retried at the next 6 h tick or on "Check for Updates…" — owned by Task 3.
- An AppImage in a read-only location (`/opt`) — owned by Task 3 (download-page fallback).
- A private key in Sparkle's 64-byte (seed ‖ public) form instead of the 32-byte seed — owned by Task 1.

---

### Task 1: Bun minisign signer

**Files:**
- Create: `desktop/scripts/minisign/index.ts`, `minisign/minisign.ts`, `minisign/minisign.test.ts`, `desktop/src/platform/update_key/fixture/` (`payload.bin`, `payload.bin.minisig`, `pubkey.txt` — written by the test's `--update-fixture` mode)

**Interfaces:**
- Consumes: `publicKeyFromPrivate(privateKey)` and `PKCS8_ED25519_PREFIX` logic in `desktop/scripts/appcast/appcast.ts` (move the prefix + seed parsing into `minisign.ts` and import it back into `appcast.ts`).
- Produces: `KEY_ID: Uint8Array`; `minisignPublicKey(publicKeyBase64: string): string` (two-line text); `signMinisign(file: Uint8Array, privateKey: string, trustedComment: string): Promise<string>` (four-line text); `updaterPubkey(publicKeyBase64: string): string` and `updaterSignature(minisig: string): string` (the outer base64).

- [ ] **Step 1: Write the failing tests**

```ts
test('minisign text verifies with WebCrypto for both Sparkle key forms', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pub = await publicKeyFromPrivate(Buffer.from(seed).toString('base64'));
  const file = new TextEncoder().encode('payload');
  for (const priv of [seed, Buffer.concat([seed, Buffer.from(pub, 'base64')])]) {
    const text = await signMinisign(file, Buffer.from(priv).toString('base64'), 'aio-proxy-desktop 0.40.0 linux-x86_64 a.AppImage');
    const [untrusted, sigLine, trusted, globalLine] = text.trimEnd().split('\n');
    expect(untrusted.startsWith('untrusted comment: ')).toBe(true);
    const sig = Buffer.from(sigLine, 'base64');
    expect(sig.subarray(0, 2).toString()).toBe('ED');
    expect(sig.subarray(2, 10)).toEqual(Buffer.from(KEY_ID));
    const key = await crypto.subtle.importKey('raw', Buffer.from(pub, 'base64'), 'Ed25519', false, ['verify']);
    const digest = createHash('blake2b512').update(file).digest();
    expect(await crypto.subtle.verify('Ed25519', key, sig.subarray(10), digest)).toBe(true);
    const comment = trusted.slice('trusted comment: '.length);
    expect(await crypto.subtle.verify('Ed25519', key, Buffer.from(globalLine, 'base64'),
      Buffer.concat([sig.subarray(10), Buffer.from(comment)]))).toBe(true);
  }
});

test('signing is deterministic, so a resumed publish re-derives the same signature', async () => {
  const k = Buffer.alloc(32, 7).toString('base64');
  const f = new Uint8Array([1, 2, 3]);
  expect(await signMinisign(f, k, 'c')).toBe(await signMinisign(f, k, 'c'));
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/minisign` — Expected: FAIL.
- [ ] **Step 3: Implement**; the untrusted comment line is `untrusted comment: signature from aio-proxy-desktop key`.
- [ ] **Step 4: Run** — Expected: PASS. Then generate the fixture with a throwaway key (`bun desktop/scripts/minisign/minisign.test.ts --update-fixture`) — the fixture key is a test key, never the release key.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/minisign desktop/scripts/appcast desktop/src/platform/update_key/fixture
git commit -m "feat(desktop): sign updates in minisign form with the Sparkle key"
```

### Task 2: Rust update key and trusted-comment check

**Files:**
- Create: `desktop/src/platform/update_key.rs`, `platform/update_key/tests.rs`
- Modify: `desktop/Cargo.toml` (`[target.'cfg(any(target_os = "linux", windows))'.dependencies]` `cargo-packager-updater = "0.2.3"`, `minisign-verify` (same version the updater uses), `base64`)

**Interfaces:**
- Produces: `PUBLIC_KEY_B64: &str` (the release public key, raw 32-byte base64, same value as the `SPARKLE_PUBLIC_ED_KEY` repository variable); `updater_pubkey(raw_b64: &str) -> String`; `struct Offer<'a> { version: &'a str, target: &'a str, asset: &'a str }`; `check_trusted(signature_field: &str, offer: &Offer) -> Result<(), String>` (outer base64 → `.minisig` text → `minisign_verify::Signature::decode` → `trusted_comment()` must equal `aio-proxy-desktop {version} {target} {asset}`).

- [ ] **Step 1: Write the failing tests** using the Task 1 fixture

```rust
#[test]
fn the_bun_signature_passes_the_updater_verification_entry_point() {
    // Serve fixture/payload.bin and a latest.json (version 9.9.9, target of this test, url to the
    // payload, signature = base64(fixture minisig)) from a std::net::TcpListener thread; build the
    // updater with updater_pubkey(fixture pubkey) and the local endpoint; check() → Some(update);
    // update.download() → Ok(bytes) == payload.
}

#[test]
fn a_trusted_comment_naming_another_version_or_target_is_refused() {
    let sig = base64_of(include_str!("fixture/payload.bin.minisig"));
    let ok = Offer { version: "9.9.9", target: "linux-x86_64", asset: "payload.bin" };
    assert!(check_trusted(&sig, &ok).is_ok());
    assert!(check_trusted(&sig, &Offer { version: "10.0.0", ..ok }).is_err());
    assert!(check_trusted(&sig, &Offer { target: "windows-x86_64", ..ok }).is_err());
}
```

  (The fixture's trusted comment is `aio-proxy-desktop 9.9.9 linux-x86_64 payload.bin`; Task 1's fixture mode writes it.)

- [ ] **Step 2: Run** `cd desktop && cargo test --locked platform::update_key` on Linux — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS on Linux and Windows CI.
- [ ] **Step 5: Commit**

```bash
git add desktop
git commit -m "feat(desktop): verify update signatures and their signed version"
```

### Task 3: Linux and Windows `platform::updater`

**Files:**
- Create: `desktop/src/platform/updater_packager.rs` (shared by Linux and Windows), `platform/updater_packager/tests.rs`
- Modify: `platform/linux/mod.rs`, `platform/windows/mod.rs` (re-export as `updater`), `desktop/src/app.rs` (`AppEvent::UpToDate`), `main.rs` (`handle`: `UpToDate` → `model.action = ActionState::Done("AIO Proxy is up to date.".into())`), `panel` update button (calls `platform::updater::install_now()` off macOS; macOS keeps `check_now`)

**Interfaces:**
- Consumes: Task 2 `updater_pubkey`, `check_trusted`; `AppEvent::{UpdateAvailable, UpdateAttended}`.
- Produces: `start(events)`; `check_now()` (manual check: emits `UpdateAvailable(v)` or `UpToDate`); `install_now(events: UnboundedSender<AppEvent>)` (runs on a background thread); new `AppEvent::RelaunchInto(PathBuf)` (Linux) and `AppEvent::OpenUrl(String)`; pure `decide_check(current: &str, offered: Option<(&str, &str)>, interactive: bool) -> CheckOutcome { Available(String), UpToDate, Silent }` (offered = version, target; a missing target entry is `None`); `install_action(appimage: Option<&Path>, dir_writable: impl Fn(&Path) -> bool, version: &str) -> InstallAction { InPlace, OpenUrl(String) }`; `asset_name(url: &str) -> &str` (last path segment).
- Exit contract: on Windows `cargo-packager-updater`'s `install` launches the installer and calls `process::exit(0)` itself, so nothing after it runs; on Linux `install_now` sends `RelaunchInto($APPIMAGE)` and the main thread replaces the process with `std::os::unix::process::CommandExt::exec` (the instance-lock file descriptor is close-on-exec, so the new image takes the lock without a race).

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn background_checks_stay_silent_unless_newer_and_manual_checks_report_up_to_date() {
    assert_eq!(decide_check("0.40.0", Some(("0.41.0", "linux-x86_64")), false), CheckOutcome::Available("0.41.0".into()));
    assert_eq!(decide_check("0.40.0", Some(("0.40.0", "linux-x86_64")), false), CheckOutcome::Silent);
    assert_eq!(decide_check("0.40.0", Some(("0.40.0", "linux-x86_64")), true), CheckOutcome::UpToDate);
    assert_eq!(decide_check("0.40.0", None, true), CheckOutcome::UpToDate);
    assert_eq!(decide_check("0.40.0", Some(("0.39.0", "linux-x86_64")), true), CheckOutcome::UpToDate);
}

#[test]
fn an_appimage_that_cannot_be_replaced_opens_that_version_release_page() {
    let a = Path::new("/opt/AIO Proxy.AppImage");
    assert_eq!(install_action(Some(a), |_| false, "0.41.0"),
        InstallAction::OpenUrl("https://github.com/aio-proxy/aio-proxy/releases/tag/v0.41.0".into()));
    assert_eq!(install_action(Some(a), |d| d == Path::new("/opt"), "0.41.0"), InstallAction::InPlace);
    assert!(matches!(install_action(None, |_| true, "0.41.0"), InstallAction::OpenUrl(_)));
}
```

  Plus one `app` test: handling `AppEvent::UpToDate` sets the action line and clears nothing else.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `start`: a background thread checks at launch and every 6 h (`std::thread::sleep`), network errors only logged. `install_now`: `install_action` first (`OpenUrl` → send `AppEvent::OpenUrl`); else `download()` → `check_trusted` with `Offer { version, target, asset_name(download_url) }` (mismatch → log + `ActionState::Failed`) → Windows: `install(bytes)` (Passive; the library exits the process); Linux: `install(bytes)` then send `RelaunchInto($APPIMAGE)`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): check for and install updates on Linux and Windows"
```


The end-to-end rehearsal against a local feed runs in phase 5 Task 6, once packaging exists.
