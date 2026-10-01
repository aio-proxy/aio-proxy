# Desktop Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the macOS app from CI. The pipeline signs with Developer ID, notarizes and staples the `.app` and `.dmg`, uploads the DMG to the version's GitHub Release and replaces the Sparkle feed on the `desktop-feed` prerelease. A pull-request Bundle smoke job keeps the unsigned bundle building.

**Architecture:** `bun run desktop:bundle` stays the only build entry point. It gains `--release`, which continues past the runtime smoke into Developer ID signing, notarization and the DMG. A new `bun run desktop:publish --version X.Y.Z` is the release `desktop` job's single step. It does four things in order:
1. Reuses or builds the DMG, and verifies it.
2. Uploads the DMG.
3. Runs Sparkle's `generate_appcast`.
4. Refuses to replace `appcast.xml` unless the new feed passes pure, unit-tested checks, including an Ed25519 verification of the DMG bytes against the app's own `SUPublicEDKey`.

The job runs in a reusable workflow that `release.yml` calls after a publish. The same workflow can be dispatched by tag to resume a failed desktop publish.

**Tech Stack:** Bun scripts (TypeScript, `bun:test`, Bun shell `$`, WebCrypto Ed25519), `codesign`, `xcrun notarytool`/`stapler`, `hdiutil`, `spctl`, `syspolicy_check`, `vmmap`, Sparkle 2.10.0 `generate_appcast`, GitHub Actions (`macos-15` arm64), `gh`.

**Spec:** `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (rev 4), sections "Build, sign, release" and "Testing → Release". Background: `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md` (human checklist items 6-11), and the Phase 2 plan `docs/superpowers/plans/2026-09-30-desktop-app.md` (Task 9 built `desktop/scripts/bundle.ts --unsigned`).

**Branch:** create `claude/desktop-phase3-release` from `claude/aio-proxy-desktop-client-27770c` (which holds Phases 1 and 2).

## Measured facts this plan relies on (2026-09-30, this machine)

These came from `desktop/vendor/sparkle-2.10.0/bin/generate_appcast` run against re-signed copies of the unsigned bundle, and the bundled sidecar run under a temp home.

- **generate_appcast signs silently or not at all.** When the private key does not match the app's `SUPublicEDKey`, or the app has no `SUPublicEDKey`, it prints only a warning, **exits 0**, and writes an enclosure **without** `sparkle:edSignature`. Only the published feed's own checks can catch this.
- **generate_appcast checks the archive.** It refuses an archive whose app fails code-signing checks ("The app failed Apple Code Signing checks"), and skips it.
- **Prior feed items survive.** With the previous `appcast.xml` beside only the new `.dmg`, `generate_appcast --versions <new> --maximum-versions 3` keeps the earlier item's URL, length and signature unchanged. It writes `<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>` and `<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>` itself, taken from the bundle.
- **The private key can come from stdin.** `--ed-key-file -` reads it from stdin, so the key never has to touch disk or argv. The key format is the base64 32-byte Ed25519 seed; `sign_update --ed-key-file` accepts the same file.
- **Bun can verify Sparkle signatures.** A Sparkle `sparkle:edSignature` verifies with Bun's WebCrypto: `crypto.subtle.verify('Ed25519', rawPublicKey, signature, dmgBytes)` returns true, and returns false after flipping one byte.
- **vmmap reads the hardened sidecar.** `vmmap <pid>` on the ad-hoc hardened bundled sidecar succeeds without sudo, and lists `JS JIT Generated Code` rows at the start of the line.

## Global Constraints

- Architecture `arm64` only; minimum macOS **13.0** (`MINIMUM_MACOS` in `desktop/scripts/macho`); every appcast item for a new version must carry `sparkle:minimumSystemVersion` 13.0.
- Signing is inside-out with Developer ID, hardened runtime and `--timestamp` (`codesign -f -s "$ID" -o runtime --timestamp`), in this order:
  1. `Installer.xpc`
  2. `Downloader.xpc`, with `--preserve-metadata=entitlements`
  3. `Autoupdate`
  4. `Updater.app`
  5. `Sparkle.framework`
  6. `Contents/MacOS/aio-proxy`, with `--entitlements desktop/entitlements/aio-proxy.plist`
  7. `Contents/MacOS/aio-proxy-desktop`
  8. the `.app`

  `--deep` is never used for signing.
- Entitlements under Developer ID:
  - The sidecar's committed file holds only `com.apple.security.cs.allow-jit`.
  - The host gets **no** entitlements. The release script never adds any.
  - The ad-hoc build gives the host `desktop/entitlements/adhoc-host.plist`, on the host step and on the `.app` step.
- JIT is verified by the `JS JIT Generated Code` region in `vmmap` while the signed sidecar serves, never by "it starts". Without `allow-jit`, Bun silently runs interpreted.
- Notarization order (spec "Signing and notarization"):
  1. `codesign --verify --deep --strict --verbose=2` on the `.app`.
  2. Zip it with `ditto -c -k --keepParent`, then `notarytool submit --wait`, then `stapler staple` the `.app`.
  3. `syspolicy_check distribution` and `spctl --assess --type execute` on the `.app`.
  4. Build the `.dmg` from the stapled `.app`, `codesign` it (with `--timestamp`), `notarytool submit --wait`, then `stapler staple`.
  5. `spctl --assess --type open --context context:primary-signature` on the `.dmg`.
  6. `stapler validate` on both.
- The DMG is named `aio-proxy-<version>-arm64.dmg`, and it lives on Release `v<version>`: `https://github.com/aio-proxy/aio-proxy/releases/download/v<version>/aio-proxy-<version>-arm64.dmg`.
- The feed is `SUFeedURL` = `https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml` (`DEFAULT_FEED_URL`). It is a prerelease tag `desktop-feed` that never becomes latest and holds only `appcast.xml`.
- Publish sequence. The feed upload is the single commit point:
  1. Upload the `.dmg`, or reuse it.
  2. Check that the versioned URL answers 200.
  3. Download the current `appcast.xml`.
  4. Run `generate_appcast` with `--download-url-prefix https://github.com/aio-proxy/aio-proxy/releases/download/v<version>/` and `--maximum-versions 3`, stated explicitly.
  5. Run `gh release upload desktop-feed appcast.xml --clobber`.
- Idempotence: if the DMG already exists on the tag's Release, download and re-verify it, never rebuild. Never upload different bytes under the same name; the `.dmg` upload never uses `--clobber`.
- The EdDSA private key is the update root of trust. It exists only as the CI secret `SPARKLE_ED_PRIVATE_KEY`, reaches `generate_appcast` only through stdin (`--ed-key-file -`), and is never used through `--account`. Neither it nor `GH_TOKEN` reaches the build (cargo build scripts, bun lifecycle scripts).
- A separate `desktop` job, `needs: release`, runs on a pinned arm64 macOS runner label (`macos-15`, the label the CI Rust job already uses). It has a `workflow_dispatch` entry taking a release tag. Canary releases skip it.
- New secrets:
  - `DEVELOPER_ID_P12_BASE64`
  - `DEVELOPER_ID_P12_PASSWORD`
  - `APPLE_API_KEY_P8`
  - `APPLE_API_KEY_ID`
  - `APPLE_API_ISSUER_ID`
  - `SPARKLE_ED_PRIVATE_KEY`

  New repository variables: `DEVELOPER_ID_IDENTITY` and `SPARKLE_PUBLIC_ED_KEY`. The public key and the identity name are not secret.
- `SUAllowsAutomaticUpdates` stays `false` and `SUAutomaticallyUpdate` is never written (already enforced by `desktop/scripts/info-plist`).
- The CI Bundle smoke job runs `bun run desktop:bundle --unsigned` for changes under these paths: `desktop/**`, `packages/cli/scripts/**`, `.github/workflows/**`, `bun.lock`, `.bun-version`.
- Repo rules (CLAUDE.md):
  - Colocated tests: `foo/index.ts` (exports only), `foo/foo.ts`, `foo/foo.test.ts`.
  - Handwritten non-test files stay under 500 lines; at 400, evaluate a split.
  - Bun APIs are preferred.
  - `desktop/scripts` is not a workspace package, and its tests run via the root `test:unit` (`bun test ./scripts ./desktop/scripts`) on Linux CI. Its unit tests must therefore not call macOS tools.
  - The tsconfig has `noPropertyAccessFromIndexSignature`, so env access is `process.env['X']`, and the target is ES2022, so do not use `findLast`.
- Environment rules for implementers:
  - Never touch the real aio-proxy service on 127.0.0.1:9317, `~/.aio-proxy`, the launchd job `com.aio-proxy.agent`, `~/Library/LaunchAgents`, `/Applications` or `~/Applications`.
  - Never run `desktop:publish` or `desktop:bundle --release` against real credentials. There are none on this machine; those runs are HUMAN-PENDING.
  - Never create, edit or delete GitHub Releases or tags.
  - Never push.
  - Never format or commit the locally excluded `spike/` directory.
  - Run Rust with plain `cargo` from `desktop/`.

## Review Focus

1. **Key mismatch.** If the EdDSA private key does not match the app's `SUPublicEDKey`, generate_appcast exits 0 and writes an unsigned enclosure (measured). The publish must refuse to replace the feed, naming the likely cause. Task 4 (`feedProblems` without a signature) and Task 5 (signature verified against the mounted app's key) cover this.
2. **Re-run for an already uploaded version.** When the `.dmg` is already on the Release, the job reuses and re-verifies those bytes; it never rebuilds or re-uploads. When the feed already lists the version, the job re-verifies that item instead of regenerating it. Task 4 (`feedAction` already-published) and Task 5 cover this.
3. **Transient `gh` failure while reading `desktop-feed`** (5xx, auth). The job must stop. It must not treat the failure as "no feed yet" and start a fresh feed that drops every published version. Task 4 (`feedState`) covers this.
4. **Notarization rejected.** If `notarytool` reports `Invalid` (or prints no JSON), the release stops and prints the notary log; nothing is stapled or published. Task 2 (`parseSubmission`) covers this.
5. **Resuming an older tag after a newer version is in the feed.** The older version is not added, prior items are never reordered or dropped, and pruning to three versions only removes the oldest. Task 4 (`feedAction` superseded, `feedProblems` prune) covers this.

---

### Task 1: Shared signing steps and the post-sign JIT smoke

**Files:**
- Create: `desktop/scripts/signing/index.ts`, `desktop/scripts/signing/signing.ts`, `desktop/scripts/signing/signing.test.ts`
- Create: `desktop/scripts/smoke/smoke.test.ts`
- Modify: `desktop/scripts/smoke/smoke.ts`, `desktop/scripts/smoke/index.ts`, `desktop/scripts/bundle.ts` (step 8 only)

**Interfaces:**
- Consumes: `runtimeSmoke(app: string, version: string): Promise<void>` (Phase 2, `desktop/scripts/smoke`).
- Produces:
  - `type Signer = { readonly kind: 'adhoc' } | { readonly kind: 'developer-id'; readonly identity: string }`
  - `type SignStep = { readonly path: string; readonly args: readonly string[] }`
  - `signSteps(app: string, signer: Signer, entitlementsDir: string): SignStep[]`
  - `signApp(app: string, signer: Signer, entitlementsDir: string): Promise<void>`
  - `hasJitRegion(vmmapOutput: string): boolean`
  - `runtimeSmoke(app: string, version: string, options?: { readonly jit?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `desktop/scripts/signing/signing.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { signSteps } from './signing';

const app = '/b/AIO Proxy.app';
const entitlements = '/e';
const relative = (path: string): string => path.slice(app.length) || '.';
const developerId = { kind: 'developer-id', identity: 'Developer ID Application: Team (TEAMID)' } as const;

describe('signSteps', () => {
  test('signs inside-out in Sparkle 2.10.0 order, one path per step, never --deep', () => {
    const steps = signSteps(app, developerId, entitlements);
    expect(steps.map((step) => relative(step.path))).toEqual([
      '/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app',
      '/Contents/Frameworks/Sparkle.framework',
      '/Contents/MacOS/aio-proxy',
      '/Contents/MacOS/aio-proxy-desktop',
      '.',
    ]);
    for (const step of steps) {
      expect(step.args).not.toContain('--deep');
      expect(step.args.at(-1)).toBe(step.path);
    }
    expect(steps[1]?.args).toContain('--preserve-metadata=entitlements');
  });

  test('Developer ID: every step is timestamped and only the sidecar carries entitlements', () => {
    const steps = signSteps(app, developerId, entitlements);
    for (const step of steps) {
      expect(step.args).toEqual(expect.arrayContaining(['-s', developerId.identity, '-o', 'runtime', '--timestamp']));
    }
    const entitled = steps.filter((step) => step.args.includes('--entitlements'));
    expect(entitled.map((step) => relative(step.path))).toEqual(['/Contents/MacOS/aio-proxy']);
    expect(entitled[0]?.args).toContain('/e/aio-proxy.plist');
  });

  test('ad-hoc: no timestamp, and the host gets disable-library-validation on its own step and the .app step', () => {
    const steps = signSteps(app, { kind: 'adhoc' }, entitlements);
    for (const step of steps) expect(step.args).not.toContain('--timestamp');
    const hostEntitled = steps.filter((step) => step.args.includes('/e/adhoc-host.plist'));
    expect(hostEntitled.map((step) => relative(step.path))).toEqual(['/Contents/MacOS/aio-proxy-desktop', '.']);
  });
});
```

Create `desktop/scripts/smoke/smoke.test.ts` (sample rows captured from the bundled sidecar with `vmmap <pid>`):

```ts
import { expect, test } from 'bun:test';

import { hasJitRegion } from './smoke';

const jitRows = `
MALLOC_SMALL                 150000000-150800000    [ 8192K   212K   212K     0K] rw-/rwx SM=PRV
JS JIT Generated Code       121e04000-121e08000    [   16K     0K     0K     0K] ---/rwx SM=NUL
JS JIT Generated Code       121e08000-141e08000    [512.0M  2016K  2016K     0K] rwx/rwx SM=PRV
`;

test('finds the JIT region vmmap lists while JavaScriptCore can JIT', () => {
  expect(hasJitRegion(jitRows)).toBe(true);
});

test('an interpreted-only process (no allow-jit) or empty output has no JIT region', () => {
  expect(hasJitRegion('MALLOC_SMALL   150000000-150800000 [ 8192K ] rw-/rwx SM=PRV\n')).toBe(false);
  expect(hasJitRegion('')).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test desktop/scripts/signing desktop/scripts/smoke`
Expected: FAIL. `./signing` cannot be resolved, and `hasJitRegion` is not exported.

- [ ] **Step 3: Implement**

Create `desktop/scripts/signing/signing.ts`:

```ts
import { join } from 'node:path';

import { $ } from 'bun';

export type Signer = { readonly kind: 'adhoc' } | { readonly kind: 'developer-id'; readonly identity: string };

export type SignStep = { readonly path: string; readonly args: readonly string[] };

/**
 * Inside-out codesign steps in Sparkle 2.10.0's documented order; `--deep` is never used. Only the
 * sidecar gets the committed allow-jit entitlements. An ad-hoc signature has no Team ID, so
 * hardened-runtime library validation would reject Sparkle: only an ad-hoc host gets
 * disable-library-validation, on its own step and on the .app step (which re-signs the main executable).
 */
export function signSteps(app: string, signer: Signer, entitlementsDir: string): SignStep[] {
  const framework = join(app, 'Contents/Frameworks/Sparkle.framework');
  const base =
    signer.kind === 'adhoc'
      ? ['-f', '-s', '-', '-o', 'runtime']
      : ['-f', '-s', signer.identity, '-o', 'runtime', '--timestamp'];
  const host = signer.kind === 'adhoc' ? ['--entitlements', join(entitlementsDir, 'adhoc-host.plist')] : [];
  const step = (path: string, ...extra: string[]): SignStep => ({ path, args: [...base, ...extra, path] });
  return [
    step(join(framework, 'Versions/B/XPCServices/Installer.xpc')),
    step(join(framework, 'Versions/B/XPCServices/Downloader.xpc'), '--preserve-metadata=entitlements'),
    step(join(framework, 'Versions/B/Autoupdate')),
    step(join(framework, 'Versions/B/Updater.app')),
    step(framework),
    step(join(app, 'Contents/MacOS/aio-proxy'), '--entitlements', join(entitlementsDir, 'aio-proxy.plist')),
    step(join(app, 'Contents/MacOS/aio-proxy-desktop'), ...host),
    step(app, ...host),
  ];
}

/** codesign output stays visible: a failed step's stderr is the only diagnosis CI gets. */
export async function signApp(app: string, signer: Signer, entitlementsDir: string): Promise<void> {
  for (const { args } of signSteps(app, signer, entitlementsDir)) await $`codesign ${args}`;
}
```

Create `desktop/scripts/signing/index.ts`:

```ts
export { signApp, signSteps, type SignStep, type Signer } from './signing';
```

In `desktop/scripts/smoke/smoke.ts`, make these changes:

1. Add `import { $ } from 'bun';` after the `node:path` import, separated by one blank line, matching `bundle.ts`.
2. Add these declarations above `runtimeSmoke`:

```ts
/** vmmap lists this region only while JavaScriptCore can JIT; without allow-jit Bun silently runs interpreted. */
export const hasJitRegion = (vmmapOutput: string): boolean => /^JS JIT Generated Code\b/imu.test(vmmapOutput);

async function vmmap(pid: number): Promise<string> {
  const direct = await $`vmmap ${pid}`.nothrow().quiet();
  if (direct.exitCode === 0) return direct.text();
  // A Developer ID hardened process may refuse task_for_pid; CI runners have passwordless sudo, and a
  // developer can cache credentials with `sudo -v` first.
  const elevated = await $`sudo -n vmmap ${pid}`.nothrow().quiet();
  if (elevated.exitCode === 0) return elevated.text();
  throw new Error(
    `vmmap ${pid} failed (${direct.stderr.toString().trim()}); sudo -n vmmap: ${elevated.stderr.toString().trim()}`,
  );
}
```

3. Change the signature and doc comment of `runtimeSmoke`:

```ts
/**
 * Runs the bundled sidecar with a throwaway home on a free port and no user tools on PATH, checks
 * what the app depends on, then SIGTERMs it. It never installs a launchd job. With `jit`, the
 * serving sidecar must also show the JIT region (run it against a signed sidecar).
 */
export async function runtimeSmoke(app: string, version: string, options: { readonly jit?: boolean } = {}): Promise<void> {
```

4. After the `desktop-summary` `expectStatus(...)` call, inside the `try`, add:

```ts
    if (options.jit === true && !hasJitRegion(await vmmap(proxy.pid))) {
      throw new Error('the signed sidecar has no "JS JIT Generated Code" region: is allow-jit missing?');
    }
```

Change `desktop/scripts/smoke/index.ts` to:

```ts
export { hasJitRegion, runtimeSmoke } from './smoke';
```

In `desktop/scripts/bundle.ts`:
1. Add `import { signApp } from './signing';` in import order, after `./macho`.
2. Replace everything from `step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');` to the end of the file with:

```ts
step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');
await signApp(app, { kind: 'adhoc' }, join(desktop, 'entitlements'));
await $`codesign --verify --deep --strict --verbose=2 ${app}`;
await hostRuns('after signing');
// The hardened sidecar must still serve, and still JIT.
await runtimeSmoke(app, version, { jit: true });

console.error(`\n${app}`);
```

- [ ] **Step 4: Run the tests and the unsigned bundle**

Run: `bun test desktop/scripts`
Expected: PASS (including the existing `info-plist` and `macho` tests).
Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`. If that sidecar is missing, run `bun run desktop:bundle --unsigned` instead.
Expected: exit 0. The log shows two runtime smokes, one before signing and one after. It ends with the `.app` path. The smoke never touches port 9317 or `~/.aio-proxy`.
Run: `bun run check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/signing desktop/scripts/smoke desktop/scripts/bundle.ts
git commit -m "feat(desktop): share the signing order and check JIT after signing"
```

---

### Task 2: Release environment and notarization helpers

**Files:**
- Create: `desktop/scripts/release-env/index.ts`, `desktop/scripts/release-env/release-env.ts`, `desktop/scripts/release-env/release-env.test.ts`
- Create: `desktop/scripts/notary/index.ts`, `desktop/scripts/notary/notary.ts`, `desktop/scripts/notary/notary.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_FEED_URL` from `desktop/scripts/info-plist`.
- Produces:
  - `type ReleaseEnv = { readonly identity: string; readonly publicEdKey: string; readonly feedUrl: string; readonly notaryAuth: readonly string[] }`
  - `releaseEnv(env: Readonly<Record<string, string | undefined>>): ReleaseEnv`
  - `notaryAuth(env: Readonly<Record<string, string | undefined>>): string[]`
  - `type NotarySubmission = { readonly id: string; readonly status: string }`
  - `parseSubmission(stdout: string): NotarySubmission`
  - `notarize(file: string, auth: readonly string[]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `desktop/scripts/release-env/release-env.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { DEFAULT_FEED_URL } from '../info-plist';
import { notaryAuth, releaseEnv } from './release-env';

const publicEdKey = '6tfdkTDFm68kxdxZ4oBJZ625LnOFeVLbWB6UcIsQDW4=';
const ci = {
  DEVELOPER_ID_IDENTITY: 'Developer ID Application: Team (TEAMID)',
  SPARKLE_PUBLIC_ED_KEY: publicEdKey,
  APPLE_API_KEY_PATH: '/tmp/notary.p8',
  APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER_ID: 'ISSUER',
};

describe('releaseEnv', () => {
  test('a complete CI environment signs with the identity, ships the product feed and notarizes with the API key', () => {
    expect(releaseEnv(ci)).toEqual({
      identity: ci.DEVELOPER_ID_IDENTITY,
      publicEdKey,
      feedUrl: DEFAULT_FEED_URL,
      notaryAuth: ['--key', '/tmp/notary.p8', '--key-id', 'KEYID', '--issuer', 'ISSUER'],
    });
  });

  test('a feed override is carried for local update rehearsals (desktop:publish refuses such a build)', () => {
    expect(releaseEnv({ ...ci, SPARKLE_FEED_URL: 'http://127.0.0.1:8123/appcast.xml' }).feedUrl).toBe(
      'http://127.0.0.1:8123/appcast.xml',
    );
  });

  test('refuses to start without a Developer ID identity, or with the ad-hoc identity', () => {
    expect(() => releaseEnv({ ...ci, DEVELOPER_ID_IDENTITY: undefined })).toThrow('DEVELOPER_ID_IDENTITY');
    expect(() => releaseEnv({ ...ci, DEVELOPER_ID_IDENTITY: '-' })).toThrow('--unsigned');
  });

  test('refuses a missing public key, or anything that is not a base64 32-byte key (e.g. a pasted private key)', () => {
    expect(() => releaseEnv({ ...ci, SPARKLE_PUBLIC_ED_KEY: '' })).toThrow('SPARKLE_PUBLIC_ED_KEY');
    expect(() => releaseEnv({ ...ci, SPARKLE_PUBLIC_ED_KEY: `${publicEdKey.slice(0, -1)}${publicEdKey}` })).toThrow(
      'SPARKLE_PUBLIC_ED_KEY',
    );
  });
});

describe('notaryAuth', () => {
  test('a developer Mac uses a stored keychain profile', () => {
    expect(notaryAuth({ NOTARY_PROFILE: 'aio-proxy-notary' })).toEqual(['--keychain-profile', 'aio-proxy-notary']);
  });

  test('a partial API key is an error, not a silent fall back to the profile', () => {
    expect(() => notaryAuth({ APPLE_API_KEY_ID: 'KEYID', NOTARY_PROFILE: 'aio-proxy-notary' })).toThrow('together');
  });

  test('no credentials at all is an error naming both options', () => {
    expect(() => notaryAuth({})).toThrow('NOTARY_PROFILE');
  });
});
```

Create `desktop/scripts/notary/notary.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { parseSubmission } from './notary';

test('reads the final JSON object notarytool prints, after any progress lines', () => {
  const stdout = 'Conducting pre-submission checks...\n{"id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","message":"Processing complete","status":"Accepted"}\n';
  expect(parseSubmission(stdout)).toEqual({ id: '2efe2717-52ef-43a5-96dc-0797e4ca1041', status: 'Accepted' });
});

test('an Invalid submission is reported as such, so the caller can fetch its log', () => {
  expect(parseSubmission('{"id":"abc","message":"Processing complete","status":"Invalid"}').status).toBe('Invalid');
});

test('output without a JSON result, or a result without a status, is an error', () => {
  expect(() => parseSubmission('Error: HTTP status code: 401. Unable to authenticate.')).toThrow('no JSON result');
  expect(() => parseSubmission('{"id":"abc","message":"Processing complete"}')).toThrow('status');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test desktop/scripts/release-env desktop/scripts/notary`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `desktop/scripts/release-env/release-env.ts`:

```ts
import { DEFAULT_FEED_URL } from '../info-plist';

type Env = Readonly<Record<string, string | undefined>>;

export type ReleaseEnv = {
  readonly identity: string;
  readonly publicEdKey: string;
  readonly feedUrl: string;
  readonly notaryAuth: readonly string[];
};

const present = (value: string | undefined): value is string => value !== undefined && value !== '';

// Base64 of a 32-byte Ed25519 public key: 43 characters and one pad.
const ED25519_PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/u;

/** Notary credentials: an App Store Connect API key in CI, or a stored keychain profile on a developer Mac. */
export function notaryAuth(env: Env): string[] {
  const key = env['APPLE_API_KEY_PATH'];
  const keyId = env['APPLE_API_KEY_ID'];
  const issuer = env['APPLE_API_ISSUER_ID'];
  if (present(key) && present(keyId) && present(issuer)) return ['--key', key, '--key-id', keyId, '--issuer', issuer];
  if (present(key) || present(keyId) || present(issuer)) {
    throw new Error('APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID must be set together');
  }
  const profile = env['NOTARY_PROFILE'];
  if (present(profile)) return ['--keychain-profile', profile];
  throw new Error('notarization needs APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID, or NOTARY_PROFILE');
}

/** Everything `desktop:bundle --release` needs, checked before the long build starts. */
export function releaseEnv(env: Env): ReleaseEnv {
  const identity = env['DEVELOPER_ID_IDENTITY'];
  if (!present(identity)) {
    throw new Error('DEVELOPER_ID_IDENTITY is required, e.g. "Developer ID Application: <Team> (<TEAMID>)"');
  }
  if (identity === '-') throw new Error('--release never signs ad-hoc; use --unsigned');
  const publicEdKey = env['SPARKLE_PUBLIC_ED_KEY'];
  if (!present(publicEdKey) || !ED25519_PUBLIC_KEY.test(publicEdKey)) {
    throw new Error('SPARKLE_PUBLIC_ED_KEY must be the base64 32-byte EdDSA public key');
  }
  const feedOverride = env['SPARKLE_FEED_URL'];
  return {
    identity,
    publicEdKey,
    feedUrl: present(feedOverride) ? feedOverride : DEFAULT_FEED_URL,
    notaryAuth: notaryAuth(env),
  };
}
```

Create `desktop/scripts/release-env/index.ts`:

```ts
export { notaryAuth, releaseEnv, type ReleaseEnv } from './release-env';
```

Create `desktop/scripts/notary/notary.ts`:

```ts
import { $ } from 'bun';

export type NotarySubmission = { readonly id: string; readonly status: string };

/**
 * `notarytool submit --wait --output-format json` ends with one JSON object. Its exit code alone is
 * not trusted: only an "Accepted" status passes.
 */
export function parseSubmission(stdout: string): NotarySubmission {
  const line = stdout
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.startsWith('{'))
    .at(-1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line ?? '');
  } catch {
    throw new Error(`notarytool printed no JSON result: ${stdout.trim().slice(0, 300)}`);
  }
  const { id, status } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof id !== 'string' || typeof status !== 'string') {
    throw new Error(`notarytool result has no id or status: ${line}`);
  }
  return { id, status };
}

export async function notarize(file: string, auth: readonly string[]): Promise<void> {
  const submit = await $`xcrun notarytool submit ${file} ${auth} --wait --output-format json`.nothrow().quiet();
  let submission: NotarySubmission;
  try {
    submission = parseSubmission(submit.stdout.toString());
  } catch (error) {
    throw new Error(
      `notarytool submit ${file} failed (exit ${submit.exitCode}): ${submit.stderr.toString().trim()}`,
      { cause: error },
    );
  }
  console.error(`notarytool: ${file} ${submission.status} (${submission.id})`);
  if (submission.status !== 'Accepted') {
    const log = await $`xcrun notarytool log ${submission.id} ${auth}`.nothrow().text();
    throw new Error(`notarization of ${file} ended "${submission.status}" (${submission.id}):\n${log}`);
  }
}
```

Create `desktop/scripts/notary/index.ts`:

```ts
export { notarize, parseSubmission, type NotarySubmission } from './notary';
```

- [ ] **Step 4: Run the tests**

Run: `bun test desktop/scripts`
Expected: PASS.
Run: `bun run check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/release-env desktop/scripts/notary
git commit -m "feat(desktop): check release credentials up front and trust only an Accepted notarization"
```

---

### Task 3: `desktop:bundle --release` and the DMG

**Files:**
- Create: `desktop/scripts/dmg/index.ts`, `desktop/scripts/dmg/dmg.ts`
- Modify: `desktop/scripts/bundle.ts`

**Interfaces:**
- Consumes:
  - `signApp` and `runtimeSmoke(..., { jit })` (Task 1).
  - `releaseEnv` and `notarize` (Task 2).
  - `renderInfoPlist` and `DEFAULT_FEED_URL` (Phase 2).
- Produces:
  - `APP_NAME = 'AIO Proxy.app'`
  - `dmgName(version: string): string`, which returns `aio-proxy-<version>-arm64.dmg`
  - `buildDmg(app: string, dmg: string): Promise<void>`
  - `type MountedApp = { readonly version: string; readonly feedUrl: string; readonly publicEdKey: string }`
  - `verifyDmg(dmg: string): Promise<MountedApp>`
  - `bun run desktop:bundle --release`, which writes `desktop/target/bundle/aio-proxy-<version>-arm64.dmg`

`buildDmg` and `verifyDmg` only orchestrate macOS tools, so they get no unit test. The human release rehearsal in Task 7 exercises them, and Task 5 runs `verifyDmg` on every publish.

- [ ] **Step 1: Create the DMG module**

Create `desktop/scripts/dmg/dmg.ts`:

```ts
import { mkdtempSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

export const APP_NAME = 'AIO Proxy.app';

export const dmgName = (version: string): string => `aio-proxy-${version}-arm64.dmg`;

/** A drag-to-install image: the stapled app beside a link to /Applications. */
export async function buildDmg(app: string, dmg: string): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), 'aio-proxy-dmg-'));
  try {
    await $`ditto ${app} ${join(stage, APP_NAME)}`;
    symlinkSync('/Applications', join(stage, 'Applications'));
    rmSync(dmg, { force: true });
    await $`hdiutil create -volname ${'AIO Proxy'} -srcfolder ${stage} -format UDZO ${dmg}`;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export type MountedApp = { readonly version: string; readonly feedUrl: string; readonly publicEdKey: string };

/**
 * The Gatekeeper checks a downloaded copy meets: the signed, notarized .dmg, then the app inside it,
 * mounted read-only. Returns the app's version and update keys for the feed checks.
 */
export async function verifyDmg(dmg: string): Promise<MountedApp> {
  await $`spctl --assess --type open --context context:primary-signature --verbose=4 ${dmg}`;
  await $`xcrun stapler validate ${dmg}`;
  const mount = mkdtempSync(join(tmpdir(), 'aio-proxy-dmg-mount-'));
  await $`hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${mount} ${dmg}`.quiet();
  try {
    const app = join(mount, APP_NAME);
    await $`codesign --verify --deep --strict --verbose=2 ${app}`;
    await $`spctl --assess --type execute --verbose=4 ${app}`;
    await $`xcrun stapler validate ${app}`;
    const plist = join(app, 'Contents/Info.plist');
    const read = async (key: string): Promise<string> => (await $`plutil -extract ${key} raw -o - ${plist}`.text()).trim();
    return {
      version: await read('CFBundleShortVersionString'),
      feedUrl: await read('SUFeedURL'),
      publicEdKey: await read('SUPublicEDKey'),
    };
  } finally {
    await $`hdiutil detach ${mount}`.nothrow().quiet();
    // Only the empty mount point: never recurse into a volume that failed to detach.
    try {
      rmdirSync(mount);
    } catch {}
  }
}
```

Create `desktop/scripts/dmg/index.ts`:

```ts
export { APP_NAME, buildDmg, dmgName, verifyDmg, type MountedApp } from './dmg';
```

- [ ] **Step 2: Add `--release` to `bundle.ts`**

Replace `desktop/scripts/bundle.ts` from the top of the file down to and including the `step('1. verify tools');` block (the `for` loop over tools) with:

```ts
// The only entry point that assembles the macOS app (spec "Bundle command").
//
//   --unsigned           CI smoke: stops after an ad-hoc hardened signature
//   --release            Developer ID signature, then a notarized, stapled .app and .dmg
//   --sidecar <path>     reuse an already-built `aio-proxy` (with THIRD_PARTY_NOTICES beside it)
//                        instead of `bun run build` + build-binary.ts
// Env (--unsigned): SPARKLE_PUBLIC_ED_KEY enables the updater; SPARKLE_FEED_URL overrides the feed.
// Env (--release): DEVELOPER_ID_IDENTITY, SPARKLE_PUBLIC_ED_KEY, and APPLE_API_KEY_PATH +
// APPLE_API_KEY_ID + APPLE_API_ISSUER_ID or NOTARY_PROFILE; SPARKLE_FEED_URL only for local update
// rehearsals (desktop:publish refuses such a build).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { APP_NAME, buildDmg, dmgName } from './dmg';
import { DEFAULT_FEED_URL, renderInfoPlist } from './info-plist';
import { MINIMUM_MACOS, machOProblems } from './macho';
import { notarize } from './notary';
import { releaseEnv } from './release-env';
import { signApp } from './signing';
import { runtimeSmoke } from './smoke';
import { fetchSparkle } from './sparkle';

const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');
const app = join(out, APP_NAME);
const entitlements = join(desktop, 'entitlements');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    unsigned: { type: 'boolean', default: false },
    release: { type: 'boolean', default: false },
    sidecar: { type: 'string' },
  },
});
if (values.unsigned === values.release) {
  console.error('Pass exactly one of --unsigned or --release.');
  process.exit(2);
}
// A missing release credential fails here, not after a ten-minute build.
const release = values.release ? releaseEnv(process.env) : undefined;
if (release !== undefined && release.feedUrl !== DEFAULT_FEED_URL) {
  console.error(`WARNING: feed override ${release.feedUrl}; desktop:publish will refuse this build.`);
}

const step = (name: string): void => console.error(`\n==> ${name}`);

step('1. verify tools');
const tools = ['cargo', 'codesign', 'vtool', 'lipo', 'ditto', 'tar', 'plutil'];
if (release !== undefined) tools.push('hdiutil', 'spctl', 'syspolicy_check', 'xcrun');
for (const tool of tools) {
  if (Bun.which(tool) === null) throw new Error(`missing tool: ${tool}`);
}
if (release !== undefined) {
  for (const tool of ['notarytool', 'stapler']) {
    if ((await $`xcrun --find ${tool}`.nothrow().quiet()).exitCode !== 0) throw new Error(`missing tool: xcrun ${tool}`);
  }
}
```

Keep the existing `const sparkle = await fetchSparkle(...)` and `const version = ...` lines that follow, and keep steps 2-7.

In step 5, replace the `const publicEdKey = ...` statement and the `Bun.write(join(app, 'Contents/Info.plist'), ...)` call with:

```ts
const devPublicEdKey = process.env['SPARKLE_PUBLIC_ED_KEY'];
const sparkleKeys =
  release !== undefined
    ? { feedUrl: release.feedUrl, publicEdKey: release.publicEdKey }
    : devPublicEdKey === undefined || devPublicEdKey === ''
      ? undefined
      : { feedUrl: process.env['SPARKLE_FEED_URL'] ?? DEFAULT_FEED_URL, publicEdKey: devPublicEdKey };
await Bun.write(
  join(app, 'Contents/Info.plist'),
  renderInfoPlist({ version, ...(sparkleKeys === undefined ? {} : { sparkle: sparkleKeys }) }),
);
```

Replace step 8 (the block Task 1 wrote, from `step('8. ad-hoc hardened signature ...` to the end of the file) with:

```ts
const verifySigned = async (): Promise<void> => {
  await $`codesign --verify --deep --strict --verbose=2 ${app}`;
  await hostRuns('after signing');
  // The hardened sidecar must still serve, and still JIT.
  await runtimeSmoke(app, version, { jit: true });
};

if (release === undefined) {
  step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');
  await signApp(app, { kind: 'adhoc' }, entitlements);
  await verifySigned();
  console.error(`\n${app}`);
} else {
  step('8. Developer ID signature (inside-out, Sparkle 2.10.0 order)');
  await signApp(app, { kind: 'developer-id', identity: release.identity }, entitlements);
  await verifySigned();

  step('9. notarize and staple the .app');
  const zip = join(out, 'notarize.zip');
  await $`ditto -c -k --keepParent ${app} ${zip}`;
  await notarize(zip, release.notaryAuth);
  rmSync(zip);
  await $`xcrun stapler staple ${app}`;
  await $`syspolicy_check distribution ${app}`;
  await $`spctl --assess --type execute --verbose=4 ${app}`;

  step('10. build, sign, notarize and staple the .dmg');
  const dmg = join(out, dmgName(version));
  await buildDmg(app, dmg);
  await $`codesign -s ${release.identity} --timestamp ${dmg}`;
  await notarize(dmg, release.notaryAuth);
  await $`xcrun stapler staple ${dmg}`;
  await $`spctl --assess --type open --context context:primary-signature --verbose=4 ${dmg}`;
  await $`xcrun stapler validate ${app}`;
  await $`xcrun stapler validate ${dmg}`;
  console.error(`\n${dmg}`);
}
```

- [ ] **Step 3: Verify the modes that can run on this machine**

Run: `bun desktop/scripts/bundle.ts`
Expected: exit 2 with `Pass exactly one of --unsigned or --release.`
Run: `env -u DEVELOPER_ID_IDENTITY bun desktop/scripts/bundle.ts --release`
Expected: fails at once, before `==> 1. verify tools`, with the `DEVELOPER_ID_IDENTITY is required` message.
Run: `bun run desktop:bundle --unsigned --sidecar desktop/target/bundle/sidecar/aio-proxy`
Expected: exit 0, with both smokes, and it ends with the `.app` path.
Run: `bun test desktop/scripts && bun run check`
Expected: PASS and clean. `bundle.ts` stays well under 400 lines (`wc -l desktop/scripts/bundle.ts`).

A real `--release` run is HUMAN-PENDING (Task 7): no Developer ID identity or notary credentials exist on this machine.

- [ ] **Step 4: Commit**

```bash
git add desktop/scripts/dmg desktop/scripts/bundle.ts
git commit -m "feat(desktop): add the Developer ID release bundle with a notarized DMG"
```

---

### Task 4: Appcast checks

**Files:**
- Create: `desktop/scripts/appcast/index.ts`, `desktop/scripts/appcast/appcast.ts`, `desktop/scripts/appcast/appcast.test.ts`

**Interfaces:**
- Consumes: `MINIMUM_MACOS` from `desktop/scripts/macho`.
- Produces:
  - `MAXIMUM_VERSIONS = 3`
  - `type AppcastItem = { readonly version: string; readonly url: string; readonly length: number; readonly edSignature?: string; readonly minimumSystemVersion?: string }`
  - `parseAppcast(xml: string): AppcastItem[]`
  - `type FeedState = 'missing-release' | 'empty' | 'present'`
  - `feedState(exitCode: number, stdout: string, stderr: string): FeedState`
  - `type FeedAction = { readonly kind: 'publish' } | { readonly kind: 'already-published'; readonly item: AppcastItem } | { readonly kind: 'superseded'; readonly newest: string }`
  - `feedAction(previous: readonly AppcastItem[], version: string): FeedAction`
  - `type ExpectedItem = { readonly version: string; readonly url: string; readonly length: number }`
  - `itemProblems(item: AppcastItem, expected: ExpectedItem): string[]`
  - `feedProblems(check: ExpectedItem & { readonly previous: readonly AppcastItem[]; readonly next: readonly AppcastItem[] }): string[]`
  - `verifyEdSignature(bytes: Uint8Array, signature: string, publicKey: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `desktop/scripts/appcast/appcast.test.ts`. The fixture is the shape generate_appcast 2.10.0 wrote in the measurement:

```ts
import { describe, expect, test } from 'bun:test';

import {
  type AppcastItem,
  feedAction,
  feedProblems,
  feedState,
  parseAppcast,
  verifyEdSignature,
} from './appcast';

const prefix = 'https://github.com/aio-proxy/aio-proxy/releases/download';
const item = (version: string, extra: Partial<AppcastItem> = {}): AppcastItem => ({
  version,
  url: `${prefix}/v${version}/aio-proxy-${version}-arm64.dmg`,
  length: 42_290_000,
  edSignature: `sig-${version}`,
  minimumSystemVersion: '13.0',
  ...extra,
});

const generated = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>AIO Proxy</title>
        <item>
            <title>0.37.0</title>
            <sparkle:version>0.37.0</sparkle:version>
            <sparkle:shortVersionString>0.37.0</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${prefix}/v0.37.0/aio-proxy-0.37.0-arm64.dmg" length="42290185" type="application/octet-stream" sparkle:edSignature="q6S4/0pU9ViJ=="/>
        </item>
        <item>
            <title>0.36.0</title>
            <sparkle:version>0.36.0</sparkle:version>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <enclosure url="${prefix}/v0.36.0/aio-proxy-0.36.0-arm64.dmg" length="42290114" type="application/octet-stream"/>
        </item>
    </channel>
</rss>`;

describe('parseAppcast', () => {
  test('reads version, enclosure, signature and minimum OS from generate_appcast output', () => {
    expect(parseAppcast(generated)).toEqual([
      {
        version: '0.37.0',
        url: `${prefix}/v0.37.0/aio-proxy-0.37.0-arm64.dmg`,
        length: 42_290_185,
        edSignature: 'q6S4/0pU9ViJ==',
        minimumSystemVersion: '13.0',
      },
      { version: '0.36.0', url: `${prefix}/v0.36.0/aio-proxy-0.36.0-arm64.dmg`, length: 42_290_114, minimumSystemVersion: '13.0' },
    ]);
  });

  test('an item without an enclosure fails the parse instead of vanishing', () => {
    expect(() => parseAppcast('<item><sparkle:version>1.0.0</sparkle:version></item>')).toThrow('enclosure');
  });
});

describe('feedState', () => {
  test('only a definite "release not found" means there is no feed yet', () => {
    expect(feedState(1, '', 'release not found\n')).toBe('missing-release');
  });

  test('any other gh failure stops the job instead of starting a fresh feed', () => {
    expect(() => feedState(1, '', 'HTTP 502: Bad Gateway')).toThrow('502');
  });

  test('a release without appcast.xml is empty; with it, present', () => {
    expect(feedState(0, '{"assets":[]}', '')).toBe('empty');
    expect(feedState(0, '{"assets":[{"name":"appcast.xml"}]}', '')).toBe('present');
  });
});

describe('feedAction', () => {
  const previous = [item('0.37.0'), item('0.36.0')];

  test('a version newer than everything in the feed is published', () => {
    expect(feedAction(previous, '0.38.0')).toEqual({ kind: 'publish' });
  });

  test('a version already in the feed is re-verified, not regenerated', () => {
    expect(feedAction(previous, '0.36.0')).toEqual({ kind: 'already-published', item: previous[1] });
  });

  test('resuming an older tag after a newer release does not add it', () => {
    expect(feedAction(previous, '0.36.5')).toEqual({ kind: 'superseded', newest: '0.37.0' });
  });
});

describe('feedProblems', () => {
  const previous = [item('0.37.0'), item('0.36.0'), item('0.35.0')];
  const expected = { version: '0.38.0', url: item('0.38.0').url, length: 42_290_000 };

  test('accepts the new item plus the two newest prior items, unchanged', () => {
    const next = [item('0.38.0'), item('0.37.0'), item('0.36.0')];
    expect(feedProblems({ ...expected, previous, next })).toEqual([]);
  });

  test('an unsigned enclosure (private key does not match SUPublicEDKey) is refused', () => {
    const { edSignature: _, ...unsigned } = item('0.38.0');
    const problems = feedProblems({ ...expected, previous, next: [unsigned, item('0.37.0'), item('0.36.0')] });
    expect(problems.join('\n')).toContain('sparkle:edSignature');
  });

  test('a dropped or rewritten prior item is refused', () => {
    const rewritten = item('0.37.0', { url: 'https://example.test/other.dmg' });
    expect(feedProblems({ ...expected, previous, next: [item('0.38.0'), rewritten, item('0.36.0')] })).not.toEqual([]);
    expect(feedProblems({ ...expected, previous, next: [item('0.38.0'), item('0.37.0')] })).not.toEqual([]);
  });

  test('a wrong download URL, length or minimum OS on the new item is refused', () => {
    const next = [item('0.38.0', { url: 'https://example.test/x.dmg', length: 1, minimumSystemVersion: '14.0' })];
    const problems = feedProblems({ ...expected, previous: [], next });
    expect(problems).toHaveLength(3);
  });
});

describe('verifyEdSignature', () => {
  test('verifies Sparkle EdDSA signatures over the archive bytes against the base64 public key', async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
    const bytes = new TextEncoder().encode('dmg bytes');
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)).toString('base64');
    expect(await verifyEdSignature(bytes, signature, publicKey)).toBe(true);
    const tampered = bytes.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(await verifyEdSignature(tampered, signature, publicKey)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test desktop/scripts/appcast`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `desktop/scripts/appcast/appcast.ts`:

```ts
import { MINIMUM_MACOS } from '../macho';

/** generate_appcast keeps this many versions; passed explicitly instead of relying on its default. */
export const MAXIMUM_VERSIONS = 3;

export type AppcastItem = {
  readonly version: string;
  readonly url: string;
  readonly length: number;
  readonly edSignature?: string;
  readonly minimumSystemVersion?: string;
};

const element = (body: string, name: string): string | undefined =>
  new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(body)?.[1]?.trim();

/** Items of an appcast written by generate_appcast. An item it cannot read fails the parse. */
export function parseAppcast(xml: string): AppcastItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map(([, body = '']) => {
    const version = element(body, 'sparkle:version');
    const enclosure = /<enclosure\b([^>]*)>/u.exec(body)?.[1];
    if (version === undefined || enclosure === undefined) {
      throw new Error(`appcast item without sparkle:version or enclosure: ${body.trim().slice(0, 200)}`);
    }
    const attributes = new Map([...enclosure.matchAll(/([\w:]+)="([^"]*)"/gu)].map(([, key = '', value = '']) => [key, value]));
    const url = attributes.get('url');
    const length = Number(attributes.get('length'));
    if (url === undefined || !Number.isSafeInteger(length)) throw new Error(`appcast item ${version} has no url or length`);
    const edSignature = attributes.get('sparkle:edSignature');
    const minimumSystemVersion = element(body, 'sparkle:minimumSystemVersion');
    return {
      version,
      url,
      length,
      ...(edSignature === undefined ? {} : { edSignature }),
      ...(minimumSystemVersion === undefined ? {} : { minimumSystemVersion }),
    };
  });
}

export type FeedState = 'missing-release' | 'empty' | 'present';

/**
 * State of the `desktop-feed` Release from `gh release view desktop-feed --json assets`. Only a
 * definite "release not found" may start a new feed: treating any other failure as "no feed" would
 * publish a fresh appcast that drops every earlier version.
 */
export function feedState(exitCode: number, stdout: string, stderr: string): FeedState {
  if (exitCode !== 0) {
    if (/release not found/iu.test(stderr)) return 'missing-release';
    throw new Error(`gh release view desktop-feed failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  const { assets } = JSON.parse(stdout) as { assets?: unknown };
  if (!Array.isArray(assets)) throw new Error(`unexpected gh output: ${stdout.slice(0, 200)}`);
  return assets.some((asset: { name?: unknown }) => asset.name === 'appcast.xml') ? 'present' : 'empty';
}

export type FeedAction =
  | { readonly kind: 'publish' }
  | { readonly kind: 'already-published'; readonly item: AppcastItem }
  | { readonly kind: 'superseded'; readonly newest: string };

const newestFirst = (a: AppcastItem, b: AppcastItem): number => Bun.semver.order(b.version, a.version);

/**
 * A version already in the feed is re-verified, never regenerated. A version older than the feed's
 * newest is not added: every install that could take it already sees the newer one.
 */
export function feedAction(previous: readonly AppcastItem[], version: string): FeedAction {
  const same = previous.find((item) => item.version === version);
  if (same !== undefined) return { kind: 'already-published', item: same };
  const newest = [...previous].sort(newestFirst)[0];
  return newest !== undefined && Bun.semver.order(newest.version, version) > 0
    ? { kind: 'superseded', newest: newest.version }
    : { kind: 'publish' };
}

export type ExpectedItem = { readonly version: string; readonly url: string; readonly length: number };

export function itemProblems(item: AppcastItem, { version, url, length }: ExpectedItem): string[] {
  const problems: string[] = [];
  if (item.url !== url) problems.push(`${version}: enclosure url ${item.url}, expected ${url}`);
  if (item.length !== length) problems.push(`${version}: enclosure length ${item.length}, expected ${length}`);
  if (item.edSignature === undefined) {
    problems.push(
      `${version}: no sparkle:edSignature (generate_appcast writes none when the private key does not match SUPublicEDKey)`,
    );
  }
  if (item.minimumSystemVersion !== MINIMUM_MACOS) {
    problems.push(`${version}: sparkle:minimumSystemVersion ${item.minimumSystemVersion ?? 'missing'}, expected ${MINIMUM_MACOS}`);
  }
  return problems;
}

/** Problems with a regenerated feed; empty when it may replace the published appcast.xml. */
export function feedProblems({
  previous,
  next,
  ...expected
}: ExpectedItem & { readonly previous: readonly AppcastItem[]; readonly next: readonly AppcastItem[] }): string[] {
  const added = next.filter((item) => item.version === expected.version);
  const [item] = added;
  if (added.length !== 1 || item === undefined) return [`expected one ${expected.version} item, found ${added.length}`];
  const problems = itemProblems(item, expected);
  // Everything else is the newest prior items, carried over byte for byte.
  const kept = next.filter((other) => other.version !== expected.version).sort(newestFirst);
  const carried = [...previous].sort(newestFirst).slice(0, MAXIMUM_VERSIONS - 1);
  if (JSON.stringify(kept) !== JSON.stringify(carried)) {
    const versions = (items: readonly AppcastItem[]): string => items.map((other) => other.version).join(', ') || 'none';
    problems.push(`prior items changed: feed keeps ${versions(kept)}, expected ${versions(carried)} unchanged`);
  }
  return problems;
}

/** Sparkle's EdDSA signature is Ed25519 over the archive bytes, checked against the app's SUPublicEDKey. */
export async function verifyEdSignature(bytes: Uint8Array, signature: string, publicKey: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'base64'), bytes);
}
```

Create `desktop/scripts/appcast/index.ts`:

```ts
export {
  MAXIMUM_VERSIONS,
  feedAction,
  feedProblems,
  feedState,
  itemProblems,
  parseAppcast,
  verifyEdSignature,
  type AppcastItem,
  type ExpectedItem,
  type FeedAction,
  type FeedState,
} from './appcast';
```

- [ ] **Step 4: Run the tests**

Run: `bun test desktop/scripts`
Expected: PASS.
Run: `bun run check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/appcast
git commit -m "feat(desktop): check a regenerated Sparkle feed before it replaces the published one"
```

---

### Task 5: `desktop:publish`

**Files:**
- Create: `desktop/scripts/publish.ts`
- Modify: `package.json` (root `scripts`)

**Interfaces:**
- Consumes:
  - Task 4: `feedState`, `feedAction`, `feedProblems`, `itemProblems`, `parseAppcast`, `verifyEdSignature`, `MAXIMUM_VERSIONS`.
  - Task 3: `dmgName`, `verifyDmg`.
  - Phase 2: `DEFAULT_FEED_URL`, `fetchSparkle`.
- Produces: `bun run desktop:publish --version X.Y.Z`. The release `desktop` job runs it as its only build step (Task 6).

The orchestration shells out to `gh`, `hdiutil` and generate_appcast. Its decisions are the Task 4 functions, which are already unit-tested. The flow itself is exercised by the human release rehearsal (Task 7).

- [ ] **Step 1: Create `desktop/scripts/publish.ts`**

```ts
// Publishes one released version of the macOS app; the release `desktop` job's only build step
// (spec "Release job and feed"): reuse or build the .dmg, verify it, upload it, then replace the
// Sparkle feed on the `desktop-feed` prerelease. The feed upload is the single commit point.
//
//   bun run desktop:publish --version X.Y.Z      (from a checkout of tag vX.Y.Z)
// Env: GH_TOKEN; SPARKLE_ED_PRIVATE_KEY (only ever written to generate_appcast's stdin); plus the
// `desktop:bundle --release` env when the .dmg is not on the Release yet.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import {
  MAXIMUM_VERSIONS,
  feedAction,
  feedProblems,
  feedState,
  itemProblems,
  parseAppcast,
  verifyEdSignature,
} from './appcast';
import { dmgName, verifyDmg } from './dmg';
import { DEFAULT_FEED_URL } from './info-plist';
import { fetchSparkle } from './sparkle';

const REPO = 'aio-proxy/aio-proxy';
const FEED_TAG = 'desktop-feed';
const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { version: { type: 'string' } } });
const version = values.version ?? '';
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error('--version X.Y.Z is required (stable versions only; canaries never ship the app)');
  process.exit(2);
}
const checkout = ((await Bun.file(join(root, 'npm/aio-proxy/package.json')).json()) as { version: string }).version;
if (checkout !== version) throw new Error(`this checkout is ${checkout}, not ${version}: check out tag v${version}`);

// The update root of trust and the write token never reach the build (cargo build scripts, bun
// lifecycle scripts); the key only ever goes to generate_appcast's stdin.
const edKey = process.env['SPARKLE_ED_PRIVATE_KEY'] ?? '';
if (edKey === '') throw new Error('SPARKLE_ED_PRIVATE_KEY is required');
const buildEnv: Record<string, string | undefined> = { ...process.env };
for (const secret of ['SPARKLE_ED_PRIVATE_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) delete buildEnv[secret];

const tag = `v${version}`;
const name = dmgName(version);
const dmg = join(out, name);
const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const step = (text: string): void => console.error(`\n==> ${text}`);

step(`1. reuse or build ${name}`);
const release = await $`gh release view ${tag} --repo ${REPO} --json assets`.quiet();
const assets = (JSON.parse(release.stdout.toString()) as { assets: { name: string }[] }).assets;
const reused = assets.some((asset) => asset.name === name);
if (reused) {
  // A published version is never rebuilt: users may already have these exact bytes.
  await $`gh release download ${tag} --repo ${REPO} --pattern ${name} --dir ${out} --clobber`;
} else {
  await $`bun run desktop:bundle --release`.cwd(root).env(buildEnv);
}

step('2. verify the .dmg');
const mounted = await verifyDmg(dmg);
if (mounted.version !== version) throw new Error(`${name} holds version ${mounted.version}`);
if (mounted.feedUrl !== DEFAULT_FEED_URL) throw new Error(`${name} points at feed ${mounted.feedUrl}, not the product feed`);
const bytes = new Uint8Array(await Bun.file(dmg).arrayBuffer());
const signatureProblems = async (signature: string | undefined): Promise<string[]> =>
  signature === undefined || (await verifyEdSignature(bytes, signature, mounted.publicEdKey))
    ? [] // a missing signature is reported by itemProblems
    : [`${version}: sparkle:edSignature does not verify against the app's SUPublicEDKey`];

step('3. upload and check the versioned URL');
// No --clobber: a released attachment is never replaced.
if (!reused) await $`gh release upload ${tag} ${dmg} --repo ${REPO}`;
await waitForDownload(url, bytes.length);

step('4. feed');
const feedDir = mkdtempSync(join(tmpdir(), 'aio-proxy-feed-'));
try {
  const view = await $`gh release view ${FEED_TAG} --repo ${REPO} --json assets`.nothrow().quiet();
  const state = feedState(view.exitCode, view.stdout.toString(), view.stderr.toString());
  if (state === 'missing-release') {
    await $`gh release create ${FEED_TAG} --repo ${REPO} --prerelease --latest=false --title ${'Desktop update feed'} --notes ${'Holds only appcast.xml, the macOS app update feed. Not a product release.'}`;
  }
  if (state === 'present') await $`gh release download ${FEED_TAG} --repo ${REPO} --pattern appcast.xml --dir ${feedDir}`;
  const previous = state === 'present' ? parseAppcast(await Bun.file(join(feedDir, 'appcast.xml')).text()) : [];
  const expected = { version, url, length: bytes.length };
  const action = feedAction(previous, version);
  if (action.kind === 'superseded') {
    console.error(`the feed already offers ${action.newest}; ${version} is not added`);
  } else if (action.kind === 'already-published') {
    const problems = [...itemProblems(action.item, expected), ...(await signatureProblems(action.item.edSignature))];
    if (problems.length > 0) throw new Error(`the feed's ${version} item does not match ${name}:\n${problems.join('\n')}`);
    console.error(`the feed already offers ${version} for these bytes`);
  } else {
    copyFileSync(dmg, join(feedDir, name));
    const sparkle = await fetchSparkle(join(desktop, 'vendor'));
    const generate = Bun.spawn(
      [
        join(sparkle, 'bin/generate_appcast'),
        '--ed-key-file',
        '-',
        '--download-url-prefix',
        `https://github.com/${REPO}/releases/download/${tag}/`,
        '--maximum-versions',
        String(MAXIMUM_VERSIONS),
        '--versions',
        version,
        feedDir,
      ],
      { stdin: new Blob([edKey]), stdout: 'inherit', stderr: 'inherit', env: buildEnv },
    );
    if ((await generate.exited) !== 0) throw new Error('generate_appcast failed');
    const next = parseAppcast(await Bun.file(join(feedDir, 'appcast.xml')).text());
    const added = next.find((item) => item.version === version);
    const problems = [...feedProblems({ ...expected, previous, next }), ...(await signatureProblems(added?.edSignature))];
    if (problems.length > 0) throw new Error(`refusing to replace the feed:\n${problems.join('\n')}`);
    await $`gh release upload ${FEED_TAG} ${join(feedDir, 'appcast.xml')} --repo ${REPO} --clobber`;
    console.error(`the feed now offers ${version}`);
  }
} finally {
  rmSync(feedDir, { recursive: true, force: true });
}

// A fresh Release asset can take a moment to be served; the feed must never point at a 404. A
// different length under the same name means different bytes and stops the job.
async function waitForDownload(target: string, length: number): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(target, { method: 'HEAD', redirect: 'follow' }).catch(() => undefined);
    if (response?.status === 200) {
      const served = response.headers.get('content-length');
      if (served !== String(length)) throw new Error(`${target} serves ${served} bytes, local ${name} has ${length}`);
      return;
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`${target} did not answer 200`);
}
```

- [ ] **Step 2: Add the root script**

In the root `package.json` `scripts`, add this line after `"desktop:bundle": "bun desktop/scripts/bundle.ts",`:

```json
    "desktop:publish": "bun desktop/scripts/publish.ts",
```

- [ ] **Step 3: Verify what can run here**

These checks run only the argument and checkout guards. They exit before any `gh` call.
Run: `bun run desktop:publish`
Expected: exit 2 with `--version X.Y.Z is required`.
Run: `bun run desktop:publish --version 0.0.1`
Expected: fails with `this checkout is <current version>, not 0.0.1`, before any `gh` call.
Run: `bun test desktop/scripts && bun run check && bun run lint:types`
Expected: clean. If `lint:types` needs a built tree, run `bun run build` first.

Never run `desktop:publish` with a matching version here: it would read and write the real repository's Releases. A real run is HUMAN-PENDING (Task 7).

- [ ] **Step 4: Commit**

```bash
git add desktop/scripts/publish.ts package.json
git commit -m "feat(desktop): publish the DMG and replace the Sparkle feed only after it verifies"
```

---

### Task 6: Workflows: the release `desktop` job and the Bundle smoke

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Modify: `.github/workflows/release.yml` (append a job), `.github/workflows/ci.yml` (`desktop-changes` and a new `bundle-smoke` job)

**Interfaces:**
- Consumes: `bun run desktop:publish --version X.Y.Z` (Task 5); `bun run desktop:bundle --unsigned` (Task 1); release outputs `published` and `published-packages` (existing `release` job).
- Produces: the reusable workflow `desktop-release.yml`, which takes the input `version` on `workflow_call` or `tag` on `workflow_dispatch`, and the CI job `bundle-smoke`.

- [ ] **Step 1: Create `.github/workflows/desktop-release.yml`**

```yaml
name: Desktop release

# Builds, signs, notarizes and publishes the macOS app for one released version, then replaces the
# Sparkle feed on the desktop-feed prerelease (docs/superpowers/specs/2026-09-29-desktop-client-design.md,
# "Release job and feed"). release.yml calls it after a publish. Dispatch it by hand with the tag to
# resume a failed desktop publish for the same immutable version; it never re-runs the npm publish.
on:
  workflow_call:
    inputs:
      version:
        type: string
        required: true
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag to (re)publish, e.g. v0.36.0
        type: string
        required: true

permissions:
  contents: write # upload the .dmg and replace appcast.xml on desktop-feed

jobs:
  desktop:
    runs-on: macos-15
    timeout-minutes: 90
    # Every run replaces the same appcast.xml.
    concurrency:
      group: desktop-feed
      cancel-in-progress: false
    steps:
      - name: Resolve the version
        id: version
        env:
          TAG: ${{ inputs.tag }}
          INPUT_VERSION: ${{ inputs.version }}
        run: |
          VERSION="${INPUT_VERSION:-${TAG#v}}"
          if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "not a stable X.Y.Z release: '$VERSION'" >&2
            exit 1
          fi
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      - uses: actions/checkout@v7
        with:
          ref: v${{ steps.version.outputs.version }}
          persist-credentials: false

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - run: bun install --frozen-lockfile --prefer-offline

      - name: Install the pinned Rust toolchain
        working-directory: desktop
        run: |
          channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
          rustup toolchain install "$channel" --profile minimal --target aarch64-apple-darwin

      - name: Import the Developer ID certificate
        env:
          DEVELOPER_ID_P12_BASE64: ${{ secrets.DEVELOPER_ID_P12_BASE64 }}
          DEVELOPER_ID_P12_PASSWORD: ${{ secrets.DEVELOPER_ID_P12_PASSWORD }}
        run: |
          keychain="$RUNNER_TEMP/signing.keychain-db"
          keychain_password=$(openssl rand -hex 24)
          security create-keychain -p "$keychain_password" "$keychain"
          security set-keychain-settings -lut 21600 "$keychain"
          security unlock-keychain -p "$keychain_password" "$keychain"
          printf '%s' "$DEVELOPER_ID_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/developer-id.p12"
          security import "$RUNNER_TEMP/developer-id.p12" -k "$keychain" -P "$DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
          rm -f "$RUNNER_TEMP/developer-id.p12"
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
          security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

      - name: Write the notary API key
        env:
          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
        run: |
          umask 077
          printf '%s' "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/notary.p8"

      - name: Build, verify and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEVELOPER_ID_IDENTITY: ${{ vars.DEVELOPER_ID_IDENTITY }}
          APPLE_API_KEY_PATH: ${{ runner.temp }}/notary.p8
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER_ID: ${{ secrets.APPLE_API_ISSUER_ID }}
          SPARKLE_PUBLIC_ED_KEY: ${{ vars.SPARKLE_PUBLIC_ED_KEY }}
          SPARKLE_ED_PRIVATE_KEY: ${{ secrets.SPARKLE_ED_PRIVATE_KEY }}
        run: bun run desktop:publish --version "${{ steps.version.outputs.version }}"

      - name: Remove signing material
        if: always()
        run: |
          security delete-keychain "$RUNNER_TEMP/signing.keychain-db" 2>/dev/null || true
          rm -f "$RUNNER_TEMP/notary.p8" "$RUNNER_TEMP/developer-id.p12"
```

- [ ] **Step 2: Call it from `release.yml`**

Append this job at the end of `.github/workflows/release.yml` (after `homebrew`), at the same indentation as the other jobs:

```yaml

  # The macOS app for the version just published. It never gates npm, Docker or Homebrew, and a
  # failure is resumed by dispatching desktop-release.yml with the tag. Canary dispatches never set
  # `published`, so they skip it.
  desktop:
    needs: release
    if: ${{ !cancelled() && needs.release.outputs.published == 'true' }}
    permissions:
      contents: write
    uses: ./.github/workflows/desktop-release.yml
    with:
      version: ${{ fromJSON(needs.release.outputs['published-packages'])[0].version }}
    secrets: inherit
```

- [ ] **Step 3: Add the Bundle smoke to `ci.yml`**

In `.github/workflows/ci.yml`, replace the whole `desktop-changes` job with:

```yaml
  desktop-changes:
    if: github.event_name == 'push' || !github.event.pull_request.draft
    runs-on: ubuntu-latest
    outputs:
      rust: ${{ steps.diff.outputs.rust }}
      bundle: ${{ steps.diff.outputs.bundle }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: diff
        env:
          BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
        run: |
          changed() {
            if [ -z "$BASE" ] || ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
              echo true
            elif git diff --quiet "$BASE...HEAD" -- "$@"; then
              echo false
            else
              echo true
            fi
          }
          echo "rust=$(changed desktop npm/aio-proxy/package.json packages/types/src/desktop-summary/fixtures .github/workflows/ci.yml)" >> "$GITHUB_OUTPUT"
          # Server and dashboard changes are left out to spare macOS minutes; the release desktop job
          # always runs the full runtime smoke before signing (spec "CI").
          echo "bundle=$(changed desktop packages/cli/scripts .github/workflows bun.lock .bun-version)" >> "$GITHUB_OUTPUT"
```

Then append this job after the `rust` job:

```yaml

  bundle-smoke:
    needs: desktop-changes
    if: needs.desktop-changes.outputs.bundle == 'true'
    runs-on: macos-15
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - uses: actions/cache@v6
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: |
            ${{ runner.os }}-bun-

      - run: bun install --frozen-lockfile --prefer-offline

      - name: Install the pinned Rust toolchain
        working-directory: desktop
        run: |
          channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
          rustup toolchain install "$channel" --profile minimal --target aarch64-apple-darwin

      - uses: actions/cache@v6
        with:
          path: |
            ~/.cargo/registry/index
            ~/.cargo/registry/cache
            ~/.cargo/git/db
            desktop/target
          key: ${{ runner.os }}-desktop-bundle-${{ hashFiles('desktop/rust-toolchain.toml', 'desktop/Cargo.lock') }}
          restore-keys: |
            ${{ runner.os }}-desktop-bundle-

      # Build, Mach-O checks, runtime smoke, ad-hoc hardened signature, then the signed smoke with
      # the JIT check.
      - run: bun run desktop:bundle --unsigned
```

- [ ] **Step 4: Verify the YAML parses and the call is wired**

Run:

```bash
for f in .github/workflows/desktop-release.yml .github/workflows/release.yml .github/workflows/ci.yml; do
  bun -e "Bun.YAML.parse(await Bun.file('$f').text()); console.log('ok $f')"
done
```

Expected: `ok` for all three files.
Run: `bun -e "const w = Bun.YAML.parse(await Bun.file('.github/workflows/release.yml').text()); console.log(w.jobs.desktop.uses, w.jobs.desktop.needs)"`
Expected: `./.github/workflows/desktop-release.yml release`.
Run: `bun run format:check`
Expected: clean. oxfmt does not format YAML, but the command must still pass.

The workflows themselves run only on GitHub. Their first real run is HUMAN-PENDING (Task 7).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/desktop-release.yml .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "ci(desktop): publish the app after a release and smoke the unsigned bundle on PRs"
```

---

### Task 7: Release documentation, spec corrections and full verification

**Files:**
- Create: `desktop/RELEASING.md`
- Modify: `docs/superpowers/specs/2026-09-29-desktop-client-design.md` ("Release job and feed", "Testing → Release"), `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md` (human checklist setup line)

**Interfaces:**
- Consumes: everything above.
- Produces: the maintainer runbook, and a HUMAN-PENDING release-rehearsal checklist to paste into the PR description.

No changeset is needed. This is release tooling with no user-visible behaviour of its own, and the pending `.changeset/desktop-app.md` already announces the app that these jobs ship.

- [ ] **Step 1: Write `desktop/RELEASING.md`**

````markdown
# Releasing the macOS app

The app ships from CI. After Changesets publishes a release, `release.yml` calls
`desktop-release.yml`. That workflow builds, signs, notarizes and uploads
`aio-proxy-<version>-arm64.dmg` to the `v<version>` Release, then replaces the Sparkle feed
`appcast.xml` on the `desktop-feed` prerelease. Canary releases never ship the app.

## One-time setup

1. **Developer ID certificate.** In an Apple Developer Program team, create a "Developer ID
   Application" certificate and export it with its private key as a `.p12`.
   - Secret `DEVELOPER_ID_P12_BASE64`: the output of `base64 -i developer-id.p12`.
   - Secret `DEVELOPER_ID_P12_PASSWORD`: the export password.
   - Variable `DEVELOPER_ID_IDENTITY`: the certificate name, e.g. `Developer ID Application: <Team> (<TEAMID>)`.
2. **Notarization.** In App Store Connect → Users and Access → Integrations, create an API key
   with the Developer role.
   - Secret `APPLE_API_KEY_P8`: the downloaded `.p8` file's contents.
   - Secret `APPLE_API_KEY_ID`: the key ID.
   - Secret `APPLE_API_ISSUER_ID`: the issuer ID.
3. **Sparkle update key.** This key is the update root of trust: whoever holds the private key
   can ship an update to every install. Losing it means existing installs can never be updated
   again. Keep one offline backup, and never change it once a version has shipped.
   ```bash
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop
   desktop/vendor/sparkle-2.10.0/bin/generate_keys --account aio-proxy-desktop -x sparkle-private.key
   ```
   (`bun run desktop:bundle --unsigned` downloads `desktop/vendor` first.)
   - Variable `SPARKLE_PUBLIC_ED_KEY`: the printed public key.
   - Secret `SPARKLE_ED_PRIVATE_KEY`: the contents of `sparkle-private.key`. Delete the file afterwards.

   CI passes the key to `generate_appcast` only on stdin. Do not use `--account` in automation:
   it blocks on a Keychain prompt.

## Local rehearsal (no publishing)

Store the notary credentials once, with
`xcrun notarytool store-credentials aio-proxy-notary --apple-id <id> --team-id <TEAMID>`, then run:

```bash
sudo -v   # vmmap may need sudo to read a Developer ID hardened sidecar
DEVELOPER_ID_IDENTITY="Developer ID Application: <Team> (<TEAMID>)" \
NOTARY_PROFILE=aio-proxy-notary \
SPARKLE_PUBLIC_ED_KEY=<public key> \
bun run desktop:bundle --release
```

It ends with `desktop/target/bundle/aio-proxy-<version>-arm64.dmg`. Set `SPARKLE_FEED_URL` only
to rehearse an update against a local feed; `desktop:publish` refuses such a build.

## Resuming a failed desktop publish

Run `gh workflow run desktop-release.yml -f tag=v<version>`. If the DMG is already on the
Release, the job reuses and re-verifies it: a published version is never rebuilt or replaced.
If the feed already offers the version, the job re-verifies that item. If the feed already
offers something newer, the older version is not added.

The job refuses to replace the feed when the new item has no valid EdDSA signature. The usual
cause is a `SPARKLE_ED_PRIVATE_KEY` that does not match `SPARKLE_PUBLIC_ED_KEY`, because
`generate_appcast` itself only warns in that case.
````

- [ ] **Step 2: Correct the spec**

In `docs/superpowers/specs/2026-09-29-desktop-client-design.md`, "Release job and feed", make three edits.

First, replace publish-sequence item 4 with:

```markdown
  4. Run the pinned `generate_appcast` with that file beside the new `.dmg`, `--download-url-prefix` set to the versioned Release URL, `--maximum-versions 3` stated explicitly, and `--versions <version>` so only this version is added. It reads prior items from the existing XML; old `.dmg` files are not needed locally (measured). Before the upload, `desktop:publish` checks the regenerated feed: exactly one new item with the versioned URL, the DMG's length, `sparkle:minimumSystemVersion` 13.0, and a `sparkle:edSignature` that verifies (Ed25519) against the app's `SUPublicEDKey`; the prior items are the newest ones, unchanged. `generate_appcast` exits 0 and writes an unsigned enclosure when the key does not match, so this check is the only guard. A version the feed already lists is re-verified, not regenerated; one older than the feed's newest is not added.
```

Second, in the EdDSA bullet, replace `It exists only as a CI secret, is written to a temp file for `generate_appcast --ed-key-file` and deleted afterwards, and is never used through `--account`` with:

```markdown
It exists only as a CI secret, reaches `generate_appcast` only on stdin (`--ed-key-file -`), never reaches the build's environment, and is never used through `--account`
```

Third, after the "Canary releases skip the desktop job." bullet, add:

```markdown
- The job is `.github/workflows/desktop-release.yml`, called by `release.yml` and dispatchable with a tag. `bun run desktop:publish --version X.Y.Z` is its build step; `desktop/RELEASING.md` is the maintainer runbook.
```

In "Build, sign, release → Bundle command", step 8, replace `` `--unsigned` stops here with an ad-hoc signature. Release continues to signing. `` with:

```markdown
`--unsigned` stops here with an ad-hoc signature; `--release` continues to Developer ID signing and notarization. Both re-run the runtime smoke on the signed bundle and require the `JS JIT Generated Code` region in `vmmap` (falling back to `sudo -n vmmap`). The `.dmg` holds the app and a link to `/Applications`.
```

- [ ] **Step 3: Point the spike checklist at the product pipeline**

In `docs/superpowers/specs/2026-09-29-desktop-spike-findings.md`, add this paragraph directly after the "Setup for all items:" paragraph of "Human checklist (priority order)":

```markdown
Items 6, 9 and 11 can now also run on the product pipeline instead of the spike scripts. Use `bun run desktop:bundle --release` (see `desktop/RELEASING.md`): it signs with Developer ID, checks the JIT region, notarizes and staples the `.app` and `.dmg`. Item 10 can use that `.dmg`.
```

- [ ] **Step 4: Full verification**

Run: `bun run preflight`
Expected: passes. If `lint:types` reports unresolved workspace types, run `bun run build` first.
Run: `(cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --locked)`
Expected: clean, with 130 tests passing. Rust is unchanged by this plan.
Run: `bun run desktop:bundle --unsigned`
Expected: exit 0, with both smokes including the JIT check. It ends with the `.app` path.
Run: `find desktop/scripts -name '*.ts' ! -name '*.test.ts' | xargs wc -l | sort -n | tail -3`
Expected: no file at or above 400 lines.

- [ ] **Step 5: HUMAN-PENDING release rehearsal**

Do not perform these steps. Copy the list below into the task report so it can be pasted into the PR description.

- [ ] R1. Set the secrets and variables from `desktop/RELEASING.md`. Local `--release` run: `codesign --verify` passes. The host has no entitlements (`codesign -d --entitlements - "<app>/Contents/MacOS/aio-proxy-desktop"` prints nothing). The signed smoke finds the JIT region. Both notarizations are `Accepted`. `syspolicy_check`, both `spctl` checks and both `stapler validate` checks pass. These are findings items 6, 7 and 9.
- [ ] R2. Clean-Mac browser install of that `.dmg`. The DMG shows the app and an Applications link. Quarantine is set, only the standard prompt appears, and `spctl -a -vv` says `source=Notarized Developer ID`. This is findings item 10.
- [ ] R3. Developer ID Sparkle update through the UI. Build v1 and v2 with `--release` and `SPARKLE_FEED_URL=http://127.0.0.1:8123/appcast.xml`, then run `generate_appcast` with a throwaway key file. There must be no "Code signature of the new version doesn't match" line, and the proxy must restart onto v2. This is findings item 11 and Phase 2 checklist item 13.
- [ ] R4. First CI release. After the merge gates clear, the `desktop` job of the first real release uploads the DMG. It creates `desktop-feed` as a prerelease that is not latest, and `curl -sL https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml` shows one signed item.
- [ ] R5. Resume. `gh workflow run desktop-release.yml -f tag=v<that version>` reuses the DMG ("reuse" path, no upload) and reports `the feed already offers <version> for these bytes`.
- [ ] R6. Bundle smoke. A PR touching `desktop/` runs `bundle-smoke` green on `macos-15`, and `vmmap` works there, with or without the `sudo -n` fallback.

- [ ] **Step 6: Commit**

```bash
git add desktop/RELEASING.md docs/superpowers/specs/2026-09-29-desktop-client-design.md docs/superpowers/specs/2026-09-29-desktop-spike-findings.md
git commit -m "docs(desktop): add the release runbook and record the feed checks in the spec"
```

---

## Self-review notes

- **Spec coverage:** every spec requirement maps to a task.

  | Spec requirement | Task |
  | --- | --- |
  | Bundle steps 1 and 8 (tools, `--release`) | Task 3 |
  | Signing order and entitlements | Task 1 |
  | JIT via vmmap, with the `sudo` fallback | Task 1 |
  | Notarization order and Gatekeeper checks | Tasks 2 and 3 |
  | DMG | Task 3 |
  | EdDSA signing and verification | Tasks 4 and 5 |
  | Release job, dispatch by tag, idempotence, feed commit point, `--maximum-versions 3` | Tasks 5 and 6 |
  | Canary skip | Task 6 (the `published` gate) |
  | Secrets | Tasks 6 and 7 |
  | CI Bundle smoke paths | Task 6 |
  | "Testing → Release" rows: arm64/minos (existing), JIT, `codesign --verify --strict`, `syspolicy_check`/`spctl`, `stapler validate`, Sparkle signature, versioned URL 200 before the feed | Tasks 1, 3 and 5 |

- **Deviations from the spec text, each recorded in the spec by Task 7:**
  - The EdDSA key goes on stdin rather than in a temp file.
  - `--versions <version>` is passed, and the feed actions "already-published" and "superseded" are added.
  - The DMG gets an `/Applications` link.
  - A feed-override build is refused at publish time rather than at build time, so local update rehearsals remain possible.
- **Out of scope:**
  - Delta updates. generate_appcast makes none, because old archives are not present.
  - Release notes in the appcast.
  - Intel builds.
  - Rust changes.
  - The Phase 2 deferred minors other than the post-sign smoke, which Task 1 fixes.
