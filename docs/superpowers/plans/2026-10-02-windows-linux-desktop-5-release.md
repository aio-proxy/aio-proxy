# Windows and Linux Desktop — Phase 5: Packaging, CI and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce signed-for-update AppImages and a per-user NSIS installer in CI for every stable release, publish them with their `.minisig` files to the version's Release, and maintain `latest.json` on `desktop-feed`, without touching the macOS release path.

**Architecture:** `cargo-packager` builds the artifacts from `[package.metadata.packager]` in `desktop/Cargo.toml`, driven by `desktop/scripts/package.ts`. Two Bun scripts publish: `publish-assets.ts` (per version, resumable) and `publish-latest.ts` (the serialized feed write). `desktop-release.yml` gains unprivileged build jobs and two privileged publish jobs; a composite action shares the tag checks with the macOS job.

**Tech Stack:** `cargo-packager` (AppImage via linuxdeploy, NSIS), Bun scripts with `bun test`, GitHub Actions (`ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-2025` — confirm the oldest still-available Ubuntu LTS labels when implementing), `gh`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 3), section 6; phase 0 findings (NSIS hooks, upgrade-vs-uninstall condition). Requires phases 1–4.

## Global Constraints

- Assets on `v<version>`: `aio-proxy-<v>-x86_64.AppImage`, `aio-proxy-<v>-aarch64.AppImage`, `aio-proxy-<v>-x64-setup.exe`, each with `<asset>.minisig`.
- Upload order per platform: asset, then `.minisig`.
- `publish-assets` plan: neither present → sign built asset, upload both; asset only → download the published asset, sign those bytes, upload `.minisig`; both → verify pair (signature + trusted comment), mismatch fails.
- `feed` never creates `desktop-feed`; applies `feedAction` (same → re-verify, stop; older → stop; newer → write).
- Concurrency: macOS job `desktop-feed`; Linux/Windows `feed` job `desktop-feed-latest`, `cancel-in-progress: false`; `publish-assets` has no group.
- Permissions per job: build jobs `contents: read`, `persist-credentials: false`, no environment, no secrets; `publish-assets` and `feed` `contents: write` in environment `desktop-release`.
- Windows Authenticode: `windows.sign_command` set only when `WINDOWS_SIGN_COMMAND` is set; no signing step in the workflow.
- `package.ts` refuses to build release artifacts when `AIO_PROXY_DESKTOP_FEED_URL` or `AIO_PROXY_DESKTOP_UPDATE_KEY` is set.
- Changeset: one note, `minor`, packages `aio-proxy`, `@aio-proxy/cli`, `@aio-proxy/core`; one paragraph, at most 5 lines.

## Review Focus

- A re-dispatch after `publish-assets` uploaded the AppImage but crashed before its `.minisig` — owned by Task 3.
- A re-dispatch of an older tag after a newer version is in `latest.json` — owned by Task 2/4.
- One platform's build failing: no asset of that version should appear in `latest.json`, the other platforms' assets may already be on the Release — owned by Task 4.
- An interactive NSIS upgrade (newer installer run by hand) must keep the service, stop state, shims and Run value — owned by Task 1.
- The AppImage started on a distribution older than the build runner's glibc — owned by Task 1 (runner choice + smoke on the oldest supported target).

---

### Task 1: `cargo-packager` configuration and `package.ts`

**Files:**
- Modify: `desktop/Cargo.toml` (`[package.metadata.packager]`: `product-name = "AIO Proxy"`, `identifier = "com.aio-proxy.desktop"`, `formats` per OS, `resources` = the sidecar, icons from `packages/brand`, `[package.metadata.packager.nsis]` `install-mode = "currentUser"` and the hook/template per phase 0, `[package.metadata.packager.appimage]` bundled libs)
- Create: `desktop/scripts/package.ts`, `desktop/scripts/package/` (`package.ts` logic + `package.test.ts` for the pure parts), `desktop/packaging/nsis-hooks.nsh` (or the custom template phase 0 chose), `desktop/packaging/aio-proxy-desktop.desktop`
- Modify: `package.json` (`"desktop:package": "bun desktop/scripts/package.ts"`)

**Interfaces:**
- Produces: `bun run desktop:package --target <linux-x86_64|linux-aarch64|windows-x86_64> --version <v>` → `desktop/target/package/<asset name>`; pure `assetName(target: string, version: string): string`; `packagerConfigOverrides(env): { signCommand?: string }`; `refuseRehearsalEnv(env): void` (throws when either override variable is set).

- [ ] **Step 1: Write the failing tests**

```ts
test('asset names follow the release contract', () => {
  expect(assetName('linux-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x86_64.AppImage');
  expect(assetName('linux-aarch64', '0.40.0')).toBe('aio-proxy-0.40.0-aarch64.AppImage');
  expect(assetName('windows-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x64-setup.exe');
});

test('a rehearsal build can never become a release artifact', () => {
  expect(() => refuseRehearsalEnv({ AIO_PROXY_DESKTOP_FEED_URL: 'http://127.0.0.1/latest.json' })).toThrow();
  expect(() => refuseRehearsalEnv({ AIO_PROXY_DESKTOP_UPDATE_KEY: 'x' })).toThrow();
  expect(() => refuseRehearsalEnv({})).not.toThrow();
});

test('the Windows sign command is passed only when configured', () => {
  expect(packagerConfigOverrides({})).toEqual({});
  expect(packagerConfigOverrides({ WINDOWS_SIGN_COMMAND: 'signtool sign %1' })).toEqual({ signCommand: 'signtool sign %1' });
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/package` — Expected: FAIL.
- [ ] **Step 3: Implement.** `package.ts`: `refuseRehearsalEnv`; build the sidecar with `bun packages/cli/scripts/build-binary.ts <linux-x64|linux-arm64|win32-x64> <outfile>`; `cargo build --release --locked`; `cargo packager --release --formats <appimage|nsis>`; rename the output to `assetName`. NSIS hooks: pre-install closes `aio-proxy-desktop.exe`; uninstall runs section 4's cleanup only under the user-uninstall condition from phase 0.
- [ ] **Step 4: Run** the tests — Expected: PASS. Then on Linux `bun run desktop:package --target linux-x86_64 --version 0.0.0-dev` and run the AppImage on the oldest supported distribution (Ubuntu 22.04 VM) — Expected: tray + panel work; on Windows `--target windows-x86_64` → install per-user without a UAC prompt, run, uninstall; then install the old build and run the new installer by hand — service, stop state, `aiop` and Run value survive.
- [ ] **Step 5: Commit**

```bash
git add desktop/Cargo.toml desktop/scripts/package.ts desktop/scripts/package desktop/packaging package.json
git commit -m "build(desktop): package AppImages and a per-user NSIS installer"
```

### Task 2: `latest.json` builder

**Files:**
- Create: `desktop/scripts/latest-json/index.ts`, `latest-json/latest-json.ts`, `latest-json/latest-json.test.ts`

**Interfaces:**
- Consumes: `feedAction` and `Bun.semver.order` usage from `desktop/scripts/appcast/appcast.ts` (generalize `feedAction` to take `readonly { version: string }[]`).
- Produces: `TARGETS = ['linux-x86_64', 'linux-aarch64', 'windows-x86_64'] as const`; `buildLatestJson(version: string, entries: ReadonlyMap<Target, { url: string; minisig: string }>, notes?: string): string` (throws when any target is missing; `signature` = `updaterSignature(minisig)`; `format` `appimage`/`nsis`); `parseLatestJson(text: string): { version: string } | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
test('latest.json lists every target in the updater format', () => {
  const json = JSON.parse(buildLatestJson('0.40.0', allThree));
  expect(json.version).toBe('0.40.0');
  expect(Object.keys(json.platforms).sort()).toEqual([...TARGETS].sort());
  expect(json.platforms['windows-x86_64'].format).toBe('nsis');
  expect(Buffer.from(json.platforms['linux-x86_64'].signature, 'base64').toString()).toStartWith('untrusted comment: ');
});

test('a missing platform refuses to build the feed', () => {
  expect(() => buildLatestJson('0.40.0', withoutWindows)).toThrow(/windows-x86_64/);
});

test('an older version never replaces a newer feed', () => {
  expect(feedAction([{ version: '0.41.0' }], '0.40.0').kind).toBe('superseded');
  expect(feedAction([{ version: '0.40.0' }], '0.40.0').kind).toBe('already-published');
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/latest-json desktop/scripts/appcast` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS (existing appcast tests unchanged).
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/latest-json desktop/scripts/appcast
git commit -m "feat(desktop): build the Linux and Windows update feed"
```

### Task 3: `publish-assets.ts`

**Files:**
- Create: `desktop/scripts/publish-assets.ts`, `desktop/scripts/publish-assets/` (`plan.ts`, `plan.test.ts`)
- Modify: `package.json` (`"desktop:publish-assets": "bun desktop/scripts/publish-assets.ts"`)

**Interfaces:**
- Consumes: Task 1 `assetName`; phase 4 `signMinisign`, `minisignPublicKey`; `publicKeyFromPrivate`.
- Produces: `type AssetStep = 'sign-and-upload' | 'sign-published' | 'verify'`; `assetStep(present: { asset: boolean; minisig: boolean }): AssetStep` (minisig without asset → throws: a manual deletion, not resumable); `verifyPair(bytes, minisig, publicKey, expectedComment): Promise<boolean>`; CLI `bun run desktop:publish-assets --version <v> --dir <artifacts dir>` (env `GH_TOKEN`, `SPARKLE_ED_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY`).

- [ ] **Step 1: Write the failing tests**

```ts
test('each partial state has exactly one resume step', () => {
  expect(assetStep({ asset: false, minisig: false })).toBe('sign-and-upload');
  expect(assetStep({ asset: true, minisig: false })).toBe('sign-published');
  expect(assetStep({ asset: true, minisig: true })).toBe('verify');
  expect(() => assetStep({ asset: false, minisig: true })).toThrow();
});

test('a pair whose trusted comment names another version fails verification', async () => {
  const minisig = await signMinisign(bytes, key, 'aio-proxy-desktop 0.39.0 linux-x86_64 a.AppImage');
  expect(await verifyPair(bytes, minisig, pub, 'aio-proxy-desktop 0.40.0 linux-x86_64 a.AppImage')).toBe(false);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Check the key pair (`publicKeyFromPrivate(private) === SPARKLE_PUBLIC_ED_KEY`) before anything irreversible, as `publish.ts` does; list Release assets with `gh release view v<v> --json assets`; per target apply `assetStep`; uploads with `gh release upload v<v> <file>` (no `--clobber`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/publish-assets.ts desktop/scripts/publish-assets package.json
git commit -m "feat(desktop): publish Linux and Windows assets resumably"
```

### Task 4: `publish-latest.ts` and the release workflow

**Files:**
- Create: `desktop/scripts/publish-latest.ts`, `.github/actions/verify-release-tag/action.yml` (the "Resolve the version" and "Verify the tag is a published release on main" steps from `desktop-release.yml`, outputs `version`, `sha`)
- Modify: `.github/workflows/desktop-release.yml` (drop workflow-level `permissions`; macOS job: `permissions: contents: write`, uses the composite action, steps otherwise unchanged; add `build-linux` matrix, `build-windows`, `publish-assets`, `feed`), `package.json` (`"desktop:publish-latest": "bun desktop/scripts/publish-latest.ts"`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `bun run desktop:publish-latest --version <v>`: fails when `desktop-feed` is missing; reads `latest.json` (absent asset on an existing Release = no previous version); applies `feedAction`; downloads the three `.minisig` files from `v<v>`, verifies each against its asset's trusted comment, writes `latest.json`, uploads with `--clobber`.

- [ ] **Step 1:** Write `publish-latest.ts` (logic covered by Task 2's tests; this file only sequences `gh` calls).
- [ ] **Step 2:** Write the workflow. Build jobs: checkout the verified `sha` with `persist-credentials: false`; setup Bun and the pinned Rust toolchain (Linux: apt deps from phase 2 Task 6 plus `libfuse2` for linuxdeploy); `bun run desktop:package --target … --version …`; `actions/upload-artifact`. `publish-assets`: `needs` all builds, `actions/download-artifact`, `bun run desktop:publish-assets`. `feed`: `needs: publish-assets`, `bun run desktop:publish-latest`. Pin every third-party action to a commit SHA, as the macOS job does.
- [ ] **Step 3: Verify** with `actionlint .github/workflows/desktop-release.yml` — Expected: no findings. Then dispatch on a fork (or with a throwaway tag on a test repository) — Expected: all jobs green, assets + `.minisig` on the Release, `latest.json` on `desktop-feed`; re-dispatch the same tag — Expected: `publish-assets` verifies and uploads nothing, `feed` reports already-published.
- [ ] **Step 4: Commit**

```bash
git add desktop/scripts/publish-latest.ts .github package.json
git commit -m "ci(desktop): release Linux and Windows builds with an update feed"
```

### Task 5: Native service smoke in CI

**Files:**
- Modify: `desktop/scripts/smoke/smoke.ts` (+ `smoke.test.ts`): add `serviceSmoke(exec: string, deps)`
- Modify: `.github/workflows/ci.yml` (job `service-smoke` on `ubuntu-24.04` (with a `systemd --user` session via `loginctl enable-linger`) and `windows-2025`, building the sidecar and running `bun desktop/scripts/smoke --service <exec>`)

**Interfaces:**
- Consumes: `runtimeSmoke` (existing `/health`, Dashboard, authenticated summary checks); phase 1 CLI.
- Produces: `serviceSmoke` runs, in order: `service install`, `__desktop-connect` (owner `external`, reachable), `runtimeSmoke`, `service stop`, `__desktop-connect` (`disabled: true`, not reachable), `service start`, `service restart`, `service uninstall`, then asserts no `aio-proxy` process remains and `__desktop-connect` reports `disabled: true` (uninstall marker).

- [ ] **Step 1: Write the failing test** for the sequencing with a fake runner:

```ts
test('service smoke checks that a stop and an uninstall stay put', async () => {
  const seen = await runServiceSmokeWithFakes();
  expect(seen.connects.map((c) => [c.job.disabled, c.instance.reachable])).toEqual([[false, true], [true, false], [true, false]]);
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/smoke` — Expected: FAIL.
- [ ] **Step 3: Implement** and add the CI job.
- [ ] **Step 4: Run** locally on Linux and via CI on both runners — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/smoke .github/workflows/ci.yml
git commit -m "ci(desktop): smoke-test the managed service on Linux and Windows"
```

### Task 6: Docs and release note

**Files:**
- Modify: `desktop/RELEASING.md` (title "Releasing the desktop app"; Linux/Windows jobs, resume rules, the minisign wrapping of the Sparkle key, `WINDOWS_SIGN_COMMAND` wiring for Artifact Signing or `signtool`, the Linux "uninstall the service before deleting the AppImage" note), `README.md` and `README.zh-Hans.md` (download section lists the AppImages and the Windows installer; SmartScreen note for the unsigned installer)
- Modify: `.changeset/windows-cli-service.md` → rewrite in place (do not add a second note)

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Rewrite the changeset body (packages unchanged, `minor`): the desktop app is now available for Linux (AppImage, x86_64 and arm64) and Windows (x64 installer) with in-app updates; the CLI ships for Windows with `aio-proxy service` backed by a per-user scheduled task; a stopped or uninstalled service now stays stopped on Linux and Windows.
- [ ] **Step 3: Run** `bun run preflight` — Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add desktop/RELEASING.md README.md README.zh-Hans.md .changeset
git commit -m "docs(desktop): document Linux and Windows releases"
```
