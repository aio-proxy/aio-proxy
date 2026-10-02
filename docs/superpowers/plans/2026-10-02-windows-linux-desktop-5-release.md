# Windows and Linux Desktop — Phase 5: Packaging, CI and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce AppImages and a per-user NSIS installer in CI for every stable release, publish them with their `.minisig` files to the version's Release, and maintain `latest.json` on `desktop-feed`, without touching the macOS release path.

**Architecture:** `cargo-packager` builds the artifacts from `[package.metadata.packager]` in `desktop/Cargo.toml`, driven by `desktop/scripts/package.ts`. Two Bun scripts publish: `publish-assets.ts` (per version, resumable, never signs bytes it did not build) and `publish-latest.ts` (the serialized feed write, which always picks the highest complete version). `desktop-release.yml` gains a `verify` job, unprivileged build jobs, and two privileged publish jobs.

**Tech Stack:** `cargo-packager` (pinned, `cargo install --locked`), AppImage via linuxdeploy, NSIS; Bun scripts with `bun test`; GitHub Actions (`ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-2025` — confirm the oldest still-available Ubuntu LTS labels when implementing); `gh`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 4), section 6; phase 0 findings (NSIS hooks, upgrade-vs-uninstall condition). Requires phases 1–4.

## Global Constraints

- Assets on `v<version>`: `aio-proxy-<v>-x86_64.AppImage`, `aio-proxy-<v>-aarch64.AppImage`, `aio-proxy-<v>-x64-setup.exe`, each with `<asset>.minisig`.
- Upload order per platform: `.minisig`, then asset.
- `publish-assets` states: neither → sign this run's asset, upload `.minisig` then asset; `.minisig` only → upload this run's asset only if it verifies against that `.minisig` and trusted comment, else fail naming the orphan to delete; both → verify, mismatch fails; asset only → fail.
- `feed`: never creates `desktop-feed`; target version = highest stable Release among the newest 20 whose three assets and `.minisig` files are present and verify; same → stop; lower → stop; higher → write.
- Concurrency: macOS job `desktop-feed`; `feed` job `desktop-feed-latest`, `cancel-in-progress: false`; `publish-assets` none.
- Permissions per job: `verify` and build jobs `contents: read`; build jobs check out `verify.outputs.sha` with `persist-credentials: false`, no environment, no secrets; `publish-assets` and `feed` `contents: write` in environment `desktop-release`.
- Clean runners: `bun install --frozen-lockfile`, then `bun run build` before `build-binary.ts`.
- Packager version = the release version (Cargo's `0.0.0` must never reach installer metadata).
- AppImage sidecar at `$APPDIR/usr/bin/aio-proxy` (packager `external_binaries`, not `resources`).
- Windows Authenticode: `windows.sign_command` only when `WINDOWS_SIGN_COMMAND` is set.
- Rehearsal: `--rehearsal` allows `AIO_PROXY_DESKTOP_FEED_URL` / `AIO_PROXY_DESKTOP_UPDATE_KEY` and names outputs `*-rehearsal.*`; without it, either variable fails the build.
- Changeset: rewrite the existing note in place; `minor`; packages `aio-proxy`, `@aio-proxy/cli`, `@aio-proxy/core`; one paragraph, at most 5 lines.

## Review Focus

- A re-dispatch after `publish-assets` uploaded a `.minisig` but crashed before the asset — owned by Task 3.
- A slower older build queuing its `feed` run after a newer version's run — owned by Task 2 (`pickFeedVersion`).
- One platform's build failing: that version must not enter `latest.json` — owned by Task 2.
- An interactive NSIS upgrade (newer installer run by hand) must keep the service, stop state, shims and Run value — owned by Task 1.
- The AppImage started on a distribution older than the build runner's glibc — owned by Task 1 (runner choice + run on the oldest supported target).

---

### Task 1: `cargo-packager` configuration and `package.ts`

**Files:**
- Modify: `desktop/Cargo.toml` (`[package.metadata.packager]`: `product-name = "AIO Proxy"`, `identifier = "com.aio-proxy.desktop"`, `external-binaries` = the sidecar, icons from `packages/brand`, `[package.metadata.packager.nsis]` `install-mode = "currentUser"` and the hook/template phase 0 chose, AppImage bundled libs)
- Create: `desktop/scripts/package.ts` (entry), `desktop/scripts/package/{index.ts,package.ts,package.test.ts}`, `desktop/packaging/nsis-hooks.nsh` (or phase 0's template), `desktop/packaging/aio-proxy-desktop.desktop`
- Modify: `package.json` (`"desktop:package": "bun desktop/scripts/package.ts"`)

**Interfaces:**
- Produces: `bun run desktop:package --target <linux-x86_64|linux-aarch64|windows-x86_64> --version <v> [--rehearsal]` → `desktop/target/package/<asset name>`; pure `assetName(target: string, version: string, rehearsal = false): string`; `packagerConfig(version: string, env): { version: string; signCommand?: string }` (written to a generated config passed with `cargo packager --config`); `checkRehearsalEnv(env, rehearsal: boolean): void`.

- [ ] **Step 1: Write the failing tests**

```ts
test('asset names follow the release contract', () => {
  expect(assetName('linux-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x86_64.AppImage');
  expect(assetName('linux-aarch64', '0.40.0')).toBe('aio-proxy-0.40.0-aarch64.AppImage');
  expect(assetName('windows-x86_64', '0.40.0')).toBe('aio-proxy-0.40.0-x64-setup.exe');
  expect(assetName('windows-x86_64', '0.40.0', true)).toBe('aio-proxy-0.40.0-x64-setup-rehearsal.exe');
});

test('override variables are allowed only in a rehearsal', () => {
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_FEED_URL: 'http://127.0.0.1/latest.json' }, false)).toThrow();
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_UPDATE_KEY: 'x' }, false)).toThrow();
  expect(() => checkRehearsalEnv({ AIO_PROXY_DESKTOP_FEED_URL: 'http://127.0.0.1/latest.json' }, true)).not.toThrow();
});

test('the packager config carries the release version and the sign command only when configured', () => {
  expect(packagerConfig('0.40.0', {})).toEqual({ version: '0.40.0' });
  expect(packagerConfig('0.40.0', { WINDOWS_SIGN_COMMAND: 'signtool sign %1' })).toEqual({ version: '0.40.0', signCommand: 'signtool sign %1' });
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/package` — Expected: FAIL.
- [ ] **Step 3: Implement.** `package.ts`: `checkRehearsalEnv`; `bun run build`; build the sidecar with `bun packages/cli/scripts/build-binary.ts <linux-x64|linux-arm64|win32-x64> <outfile>`; `cargo build --release --locked`; `cargo packager --release --formats <appimage|nsis> --config <generated>`; rename the output to `assetName`. NSIS hooks: pre-install closes `aio-proxy-desktop.exe`; uninstall runs spec section 4's cleanup only under phase 0's user-uninstall condition.
- [ ] **Step 4: Run** the tests — Expected: PASS. Then verify artifacts:
  - Linux: `bun run desktop:package --target linux-x86_64 --version 0.0.1`; `./aio-proxy-0.0.1-x86_64.AppImage --appimage-extract` → `squashfs-root/usr/bin/aio-proxy --version` prints `0.0.1`-matching CLI version; run the AppImage on an Ubuntu 22.04 VM — tray + panel work.
  - Windows: `--target windows-x86_64 --version 0.0.1` → installer properties show 0.0.1; per-user install without UAC; app `--version` prints 0.0.1. Install 0.0.1, then run a 0.0.2 installer by hand — service, stop state, `aiop` and Run value survive; uninstall removes them.
- [ ] **Step 5: Commit**

```bash
git add desktop/Cargo.toml desktop/scripts/package.ts desktop/scripts/package desktop/packaging package.json
git commit -m "build(desktop): package AppImages and a per-user NSIS installer"
```

### Task 2: `latest.json` builder and feed version choice

**Files:**
- Create: `desktop/scripts/latest-json/{index.ts,latest-json.ts,latest-json.test.ts}`

**Interfaces:**
- Consumes: phase 4 `updaterSignature(minisig)`; `Bun.semver.order`.
- Produces: `TARGETS = ['linux-x86_64', 'linux-aarch64', 'windows-x86_64'] as const`; `buildLatestJson(version: string, entries: ReadonlyMap<Target, { url: string; minisig: string }>): string` (throws naming a missing target; `format` `appimage`/`nsis`); `parseLatestJson(text: string): { version: string } | undefined`; `pickFeedVersion(current: string | undefined, releases: readonly { version: string; complete: boolean }[]): string | undefined` (highest complete stable version above `current`, else `undefined`).

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

test('the feed takes the highest complete version, whatever run executes last', () => {
  const releases = [
    { version: '0.42.0', complete: false },
    { version: '0.41.0', complete: true },
    { version: '0.40.0', complete: true },
  ];
  expect(pickFeedVersion('0.40.0', releases)).toBe('0.41.0');
  expect(pickFeedVersion('0.41.0', releases)).toBeUndefined();
  expect(pickFeedVersion('0.43.0', releases)).toBeUndefined();
  expect(pickFeedVersion(undefined, releases)).toBe('0.41.0');
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/latest-json` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/latest-json
git commit -m "feat(desktop): build the Linux and Windows update feed"
```

### Task 3: `publish-assets.ts`

**Files:**
- Create: `desktop/scripts/publish-assets.ts` (entry), `desktop/scripts/publish-assets/{index.ts,publish-assets.ts,publish-assets.test.ts}`
- Modify: `package.json` (`"desktop:publish-assets": "bun desktop/scripts/publish-assets.ts"`)

**Interfaces:**
- Consumes: Task 1 `assetName`; phase 4 `signMinisign`; `publicKeyFromPrivate`.
- Produces: `type AssetStep = 'sign-and-upload' | 'upload-verified-asset' | 'verify'`; `assetStep(present: { asset: boolean; minisig: boolean }): AssetStep` (asset without `.minisig` → throws); `verifyPair(bytes, minisig, publicKey, expectedComment): Promise<boolean>`; CLI `bun run desktop:publish-assets --version <v> --dir <artifacts dir>` (env `GH_TOKEN`, `SPARKLE_ED_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY`).

- [ ] **Step 1: Write the failing tests**

```ts
test('each partial state has exactly one resume step, and none signs published bytes', () => {
  expect(assetStep({ asset: false, minisig: false })).toBe('sign-and-upload');
  expect(assetStep({ asset: false, minisig: true })).toBe('upload-verified-asset');
  expect(assetStep({ asset: true, minisig: true })).toBe('verify');
  expect(() => assetStep({ asset: true, minisig: false })).toThrow();
});

test('a rebuilt asset does not verify against the orphan signature of an earlier build', async () => {
  const minisig = await signMinisign(firstBuild, key, comment);
  expect(await verifyPair(firstBuild, minisig, pub, comment)).toBe(true);
  expect(await verifyPair(rebuild, minisig, pub, comment)).toBe(false);
});

test('a pair whose trusted comment names another version fails verification', async () => {
  const minisig = await signMinisign(bytes, key, 'aio-proxy-desktop 0.39.0 linux-x86_64 a.AppImage');
  expect(await verifyPair(bytes, minisig, pub, 'aio-proxy-desktop 0.40.0 linux-x86_64 a.AppImage')).toBe(false);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Check the key pair (`publicKeyFromPrivate(private) === SPARKLE_PUBLIC_ED_KEY`) before anything irreversible, as `publish.ts` does; refuse `*-rehearsal.*` inputs; list assets with `gh release view v<v> --json assets`; per target apply `assetStep`; uploads with `gh release upload v<v> <file>` (no `--clobber`); on `upload-verified-asset` failure print the `gh release delete-asset` command for the orphan.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/publish-assets.ts desktop/scripts/publish-assets package.json
git commit -m "feat(desktop): publish Linux and Windows assets resumably"
```

### Task 4: `publish-latest.ts` and the release workflow

**Files:**
- Create: `desktop/scripts/publish-latest.ts`
- Modify: `.github/workflows/desktop-release.yml` (drop workflow-level `permissions`; macOS job: `permissions: contents: write`, steps unchanged; add `verify`, `build-linux` matrix, `build-windows`, `publish-assets`, `feed`), `package.json` (`"desktop:publish-latest": "bun desktop/scripts/publish-latest.ts"`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `bun run desktop:publish-latest`: fails when `desktop-feed` is missing; reads `latest.json` (absent on an existing Release = no current version); lists the newest 20 stable Releases with `gh release list --exclude-drafts --exclude-pre-releases --limit 20`; marks each complete when its three assets and `.minisig` files exist and verify; `pickFeedVersion`; writes and uploads `latest.json` with `--clobber` only when a version is picked.

- [ ] **Step 1:** Write `publish-latest.ts` (decisions covered by Task 2's tests; this file sequences `gh` calls).
- [ ] **Step 2:** Write the workflow. `verify`: the macOS job's two inline check steps, outputs `version` and `sha`. Build jobs: `needs: verify`; checkout `${{ needs.verify.outputs.sha }}` with `persist-credentials: false`; setup Bun, `bun install --frozen-lockfile --prefer-offline`; pinned Rust toolchain; `cargo install cargo-packager --version <pinned> --locked`; Linux apt deps from phase 2 Task 6 plus `libfuse2`; `bun run desktop:package --target … --version …`; `actions/upload-artifact`. `publish-assets`: `needs` all builds, `actions/download-artifact`, `bun run desktop:publish-assets`. `feed`: `needs: publish-assets`, `bun run desktop:publish-latest`. Pin every third-party action to a commit SHA, as the macOS job does.
- [ ] **Step 3: Verify** with `actionlint .github/workflows/desktop-release.yml` — Expected: no findings. Then dispatch on a fork (throwaway tags, a test `desktop-feed`) — Expected: all jobs green, `.minisig` files and assets on the Release, `latest.json` on `desktop-feed`; re-dispatch the same tag — `publish-assets` verifies and uploads nothing, `feed` stops at "same version"; dispatch an older tag — `feed` stops without a write.
- [ ] **Step 4: Commit**

```bash
git add desktop/scripts/publish-latest.ts .github/workflows/desktop-release.yml package.json
git commit -m "ci(desktop): release Linux and Windows builds with an update feed"
```

### Task 5: Native service smoke in CI

**Files:**
- Modify: `desktop/scripts/smoke/smoke.ts` (extract `httpChecks(base: string, token: string)` from `runtimeSmoke`; add `serviceSmoke(exec: string, deps)`), `desktop/scripts/smoke/smoke.test.ts`, `desktop/scripts/smoke/index.ts`
- Create: `desktop/scripts/smoke/cli.ts` (`bun desktop/scripts/smoke/cli.ts --service <exec>`)
- Modify: `.github/workflows/ci.yml` (job `service-smoke` on `ubuntu-24.04` with a `systemd --user` session via `loginctl enable-linger` and on `windows-2025`; steps: install, `bun run build`, build the sidecar, run the CLI)

**Interfaces:**
- Consumes: `runtimeSmoke`'s HTTP checks; `readDesktopToken(home)` from `@aio-proxy/core` (resolves the Windows path too); phase 1 CLI.
- Produces: `serviceSmoke` runs `service install`, `service start`, waits up to 30 s for `__desktop-connect` to report reachable, `httpChecks`, `service stop`, `__desktop-connect` (`disabled: true`, not reachable), `service start` + wait, `service restart` + wait, `service uninstall`, then asserts no `aio-proxy` process remains and `__desktop-connect` reports `disabled: true` (uninstall marker).

- [ ] **Step 1: Write the failing test** for the sequencing with a fake runner:

```ts
test('service smoke checks that a stop and an uninstall stay put', async () => {
  const seen = await runServiceSmokeWithFakes();
  expect(seen.commands.slice(0, 2)).toEqual([['service', 'install'], ['service', 'start']]);
  expect(seen.connects.map((c) => [c.job.disabled, c.instance.reachable]))
    .toEqual([[false, true], [true, false], [false, true], [false, true], [true, false]]);
});
```

- [ ] **Step 2: Run** `bun test desktop/scripts/smoke` — Expected: FAIL.
- [ ] **Step 3: Implement** and add the CI job; `runtimeSmoke` keeps its signature and calls `httpChecks`.
- [ ] **Step 4: Run** locally on Linux and via CI on both runners — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/smoke .github/workflows/ci.yml
git commit -m "ci(desktop): smoke-test the managed service on Linux and Windows"
```

### Task 6: Update rehearsal

- [ ] **Step 1:** Build two rehearsal versions per platform: `AIO_PROXY_DESKTOP_FEED_URL=http://127.0.0.1:8765/latest.json AIO_PROXY_DESKTOP_UPDATE_KEY=<throwaway public key> bun run desktop:package --target <t> --version 0.0.1 --rehearsal`, then `0.0.2`. Sign 0.0.2 with the throwaway key (phase 4 `signMinisign`), serve it and a `latest.json` built by Task 2 from `127.0.0.1:8765`.
- [ ] **Step 2:** On Linux and Windows with 0.0.1 installed, check: feed at 0.0.1 → "up to date"; feed at 0.0.2 → attention dot, Install → relaunch on 0.0.2, proxy restarted on the new stable copy; `version` field 0.0.3 with 0.0.2's signature → refused, no install; corrupted signature → refused; AppImage in a read-only directory → Install opens the release page.
- [ ] **Step 3:** Record the results in the PR description. Nothing to commit.

### Task 7: Docs and release note

**Files:**
- Modify: `desktop/RELEASING.md` (title "Releasing the desktop app"; Linux/Windows jobs, resume rules incl. deleting an orphan `.minisig`, the minisign wrapping of the Sparkle key, `WINDOWS_SIGN_COMMAND` wiring for Artifact Signing or `signtool`, the Linux "uninstall the service before deleting the AppImage" note), `README.md` and `README.zh-Hans.md` (download section lists the AppImages and the Windows installer; SmartScreen note for the unsigned installer)
- Modify: `.changeset/windows-cli-service.md` → rewrite in place (do not add a second note)

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Rewrite the changeset body (packages unchanged, `minor`): the desktop app is now available for Linux (AppImage, x86_64 and arm64) and Windows (x64 installer) with in-app updates; the CLI ships for Windows with `aio-proxy service` backed by a per-user scheduled task; a stopped or uninstalled service now stays stopped on Linux and Windows.
- [ ] **Step 3: Run** `bun run preflight` — Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add desktop/RELEASING.md README.md README.zh-Hans.md .changeset
git commit -m "docs(desktop): document Linux and Windows releases"
```
