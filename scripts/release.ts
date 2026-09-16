#!/usr/bin/env bun
// Publish flow for the workspace's public npm packages.
//
// Versioning + changelog + the standing "Version PR" are owned by Changesets
// (see .changeset/config.json + .github/workflows/release.yml). This script is
// ONLY the publish step: it packs and publishes whatever version the merged
// Version PR already wrote into each package.json. It does NOT decide versions,
// write changelogs, or commit. changesets/action (publish-script mode) never
// creates git tags — it only PUSHES a tag we create locally and then builds the
// GitHub Release from the NDJSON git-tag event we emit — so this script tags the
// release commit itself (see the tag block near the end).
//
// Why this is still hand-rolled rather than `changeset publish`:
//   - `bun publish` cannot do npm OIDC trusted publishing (oven-sh/bun#22423),
//     so the actual publish must go through `npm publish`.
//   - `npm publish` does not understand `catalog:` (and would ship the literal
//     string), so the tarball must be produced by `bun pm pack`, which resolves
//     `catalog:`, `workspace:*`, and optionalDependencies to real versions.
//     `changeset publish` / `changeset pack` pack via npm/pnpm/yarn and hit the
//     same `catalog:` limitation, so they can't replace this either.
//   Splitting pack (bun) from publish (npm) is the only combination that keeps
//   protocol rewriting AND OIDC + provenance.
//
// Two run modes:
//   - default (push to main, driven by changesets/action): publish the version the
//     merged Version PR wrote, to the `latest` dist-tag, and tag + Release it.
//   - `--canary` (workflow_dispatch on any branch): rewrite every manifest to
//     `X.Y.(Z+1)-canary.<run_number>.g<sha7>`, where `X.Y.Z` is npm's published
//     `latest`, and publish to the `canary` dist-tag.
//     No changelog, no commit, no git tag, no GitHub Release, no Docker/Homebrew.
//
// Two public products publish at one lockstep version:
//   - the CLI: the `aio-proxy` launcher + its per-platform binary packages under
//     npm/* (bun build --compile fills each npm/cli-*/bin before packing), and
//   - the plugin SDK: @aio-proxy/plugin-sdk.
// Every package (private ones too — their version is compiled into the CLI
// binary and each plugin's *_PLUGIN_VERSION) shares the version, via the `fixed`
// group in .changeset/config.json. That group must enumerate every package by
// name: changesets.dev documents `fixed` as supporting picomatch patterns, but
// the implementation only globs `ignore` — a glob in `fixed` silently no-ops
// (verified on @changesets/cli 3.0.0-next.11), leaving packages unbumped. So a
// newly added package must be added to `fixed` by hand; the lockstep assertion
// below is what catches it if nobody did.
// Discovery is automatic; adding a non-private package needs no change here.

import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

import { canaryVersion } from './canary-version';
import { prepareCloudKitArtifact, shouldPrepareCloudKitArtifact } from './release-cloudkit-artifact';
import { cloudKitReleaseGatePassed } from './release-cloudkit-gate';

const DRY_RUN = process.argv.includes('--dry-run');
// canary：对任意分支手动派发时，把全部包改成一个 prerelease 版本并发到 npm 的
// `canary` dist-tag。不写 changelog、不打 tag、不建 Release——见
// docs/superpowers/specs/2026-09-15-canary-release-design.md。
const CANARY = process.argv.includes('--canary');

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const globbed = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))];
const allPackages = (
  await Promise.all(
    globbed
      .filter((p) => !p.includes('/node_modules/') && !p.includes('/dist/'))
      .map(async (path) => ({ path, json: (await Bun.file(path).json()) as PackageJson })),
  )
).filter(({ json }) => typeof json.name === 'string');

// Platform-binary packages are the ones another workspace package pulls in via
// optionalDependencies (the launcher's @aio-proxy/cli-*). They are published to
// npm but are an implementation detail of the launcher, so they get no git
// tag / GitHub Release of their own — only the note-bearing product packages do.
const platformProvided = new Set(allPackages.flatMap(({ json }) => Object.keys(json.optionalDependencies ?? {})));

// Publish dependencies before dependents. npm silently skips an optionalDependency
// that isn't on the registry yet (launcher -> @aio-proxy/cli-*), and a dependent
// published before its workspace dependency (plugin-sdk -> @aio-proxy/types) is
// uninstallable if the later publish fails mid-release.
// CloudKit is the one package whose publishability is not a property of the repository: the backend
// is only releasable once its live gates have been recorded (scripts/release-cloudkit-gate/). It is
// withheld from the set rather than failing the run, because a blocked native gate is no reason to
// hold the rest of the release — and the workflow skips signing on the same answer, so a withheld
// backend costs the run neither Apple secrets nor a notarization.
// A canary withholds it unconditionally: the signing step reads the version out of the manifest
// before this script rewrites it, so its signed artifact is stamped with the stable version and
// `prepareCloudKitArtifact` would reject it — and packing the backend without that bundle publishes a
// preview whose sync cannot connect.
const cloudKitReleasable = !CANARY && (await cloudKitReleaseGatePassed());
if (!cloudKitReleasable) {
  console.log(
    CANARY
      ? 'Withholding @aio-proxy/plugin-cloudkit: a canary carries no signed native bundle.'
      : 'Withholding @aio-proxy/plugin-cloudkit: docs/testing/evidence/cloudkit-sync.json is not a passed gate.',
  );
}
const unsorted = allPackages.filter(
  ({ json }) => json.private !== true && (cloudKitReleasable || json.name !== '@aio-proxy/plugin-cloudkit'),
);
const names = new Set(unsorted.map((p) => p.json.name));
const emitted = new Set<string>();
const publishable: typeof unsorted = [];
while (publishable.length < unsorted.length) {
  const ready = unsorted.filter(
    (p) =>
      !emitted.has(p.json.name) &&
      [...Object.keys(p.json.dependencies ?? {}), ...Object.keys(p.json.optionalDependencies ?? {})].every(
        (dep) => !names.has(dep) || emitted.has(dep),
      ),
  );
  if (ready.length === 0) throw new Error('Cyclic workspace dependencies among publishable packages');
  for (const p of ready) emitted.add(p.json.name);
  publishable.push(...ready);
}

if (publishable.length === 0) {
  throw new Error('No publishable packages found');
}

// --- the release version is whatever the merged Version PR wrote --------------
// `fixed` keeps every package on one version; assert that here so a drifted
// checkout fails loudly instead of publishing a split release.
const versions = new Set(allPackages.map((p) => p.json.version));
if (versions.size !== 1) {
  throw new Error(`Workspace versions are not in lockstep: ${[...versions].sort().join(', ')}`);
}
let version = [...versions][0]!;

// canary 版本必须在 `bun update` 之前写进 manifest：只有这样 bun.lock 的
// `workspaces` 块才会刷新成 canary 版本，`bun pm pack` 才能把 launcher 的
// `workspace:*` optionalDeps 和 plugin-sdk 的 `catalog:` 解析成 canary 版本。
// 私有包也要改——版本被编译进 CLI 二进制与各插件的 *_PLUGIN_VERSION，且上面的
// 锁步断言要求全仓库一致。
const pristineManifests = new Map<string, string>();
if (CANARY) {
  // base 取 npm 上 `latest` 的版本，而不是本地 manifest：手动派发允许任意分支，
  // 而本地版本可能与已发布的稳定线不一致。落后的分支（本地 0.23.0、latest 已是
  // 0.23.1）会算出排在用户已装版本之下的 canary，`upgrade --version` 变成空操作；
  // Version PR 分支（本地 0.24.0）会算出 0.24.1-canary，把待发布的 0.24.0 挡在下面。
  const latest = (await $`npm view aio-proxy version`.quiet()).text().trim();
  version = canaryVersion({
    base: latest,
    runNumber: process.env['GITHUB_RUN_NUMBER'] ?? '',
    sha: process.env['GITHUB_SHA'] ?? '',
  });

  // 重跑一个陈旧的 canary run 会用同样的 run_number/sha 算出同样的旧版本：已发布的包
  // 被下面 publish 循环的 `continue` 跳过，缺失的包却会带 `--tag canary` 补发，把这几个
  // 包的 canary tag 拉回旧版本——同一锁步版本的包散落在两个 canary 上。并发已由
  // workflow 的 concurrency 组挡住，剩下的就是这种先后顺序的重跑，这里直接拒绝。
  //
  // 必须逐包查：publish 顺序是依赖先于依赖者，launcher `aio-proxy` 排在最后，只看它
  // 会漏掉「两次 run 各发出前几个包就失败」的情形——那时 launcher 的 tag 还是旧的，
  // 而前面几个包已经被新 run 推到了新版本。
  const canaryTags = await Promise.all(
    publishable.map(async ({ json }) => {
      // 查 `dist-tags.canary` 而不是 `<pkg>@canary`：包在 registry 上但没有 canary
      // tag 时前者退出码为 0、输出为空，后者报 E404，与「包本身没发布过」混在一起。
      const view = await $`npm view ${json.name} dist-tags.canary`.nothrow().quiet();
      // 唯一可接受的失败是包尚未发布（新增包的首个 canary），npm 报 E404。超时 /
      // 5xx / 认证失败同样会给出空输出，与「没有 canary tag」无从区分，正好在这道
      // 守卫最该拦住的时刻放行——所以非 E404 的失败一律 fail closed。
      if (view.exitCode !== 0 && !view.stderr.toString().includes('E404')) {
        throw new Error(`Could not read the canary dist-tag for ${json.name}: ${view.stderr.toString().trim()}`);
      }
      return { name: json.name, current: view.text().trim() };
    }),
  );
  const ahead = canaryTags.filter(({ current }) => current && Bun.semver.order(current, version) > 0);
  if (ahead.length > 0) {
    throw new Error(
      `The canary dist-tag is already ahead of ${version} on ${ahead.map((t) => `${t.name}@${t.current}`).join(', ')}; ` +
        `refusing to move it backwards. Dispatch a new canary run instead of rerunning this one.`,
    );
  }
  // 定点文本替换而非 JSON.stringify 重写整个文件：保留原格式不产生漂移。
  // 正则锚定顶层字段的两空格缩进（全部 manifest 均为该格式，嵌套字段缩进更深
  // 不会误命中）。未命中即抛，避免静默发出一个未改版本的包。
  for (const { path } of allPackages) {
    const raw = await Bun.file(path).text();
    const rewritten = raw.replace(/^ {2}"version": "[^"]+"/m, `  "version": "${version}"`);
    if (rewritten === raw) throw new Error(`Could not rewrite the version field in ${path}`);
    pristineManifests.set(path, raw);
    await Bun.write(path, rewritten);
  }
}

console.log(
  `Publishing ${publishable.length} package(s) at v${version}${DRY_RUN ? '  [dry-run]' : ''}:\n${publishable
    .map((p) => `  ${p.json.name}${platformProvided.has(p.json.name) ? '  (platform binary)' : ''}`)
    .join('\n')}\n`,
);

const cloudKitPackage = publishable.find(({ json }) => json.name === '@aio-proxy/plugin-cloudkit');

// --- refresh bun.lock's workspace versions so `bun pm pack` resolves siblings -
// A plain `bun install` reports "no changes" and leaves the lock's workspace
// versions stale, so the launcher's `workspace:*` optionalDependencies and
// plugin-sdk's `catalog:` deps would pack against the old version. Only `bun
// update` re-resolves them — but it also bumps any external devDependency with a
// newer in-range release, which would silently ship a release built against an
// untested dependency set.
//
// bun.lock is a segmented JSON-ish document: the `workspaces` block (top) holds
// sibling versions; `catalog` and `packages` (from the `patchedDependencies`
// marker onward) hold external resolutions. Splice the two locks — keep the
// updated `workspaces` block, restore everything from the marker onward from the
// pre-run lock — so workspace versions refresh with zero external drift. The
// root manifest is restored too, so the result stays frozen-install clean.
const pristineLock = await Bun.file('bun.lock').text();
const rootOriginal = await Bun.file('package.json').text();
try {
  await $`bun update`;
  await Bun.write('package.json', rootOriginal);
  const LOCK_TAIL_MARKER = '\n  "patchedDependencies":';
  const updatedLock = await Bun.file('bun.lock').text();
  const headEnd = updatedLock.indexOf(LOCK_TAIL_MARKER);
  const tailStart = pristineLock.indexOf(LOCK_TAIL_MARKER);
  if (headEnd < 0 || tailStart < 0) {
    throw new Error(`bun.lock layout changed: "patchedDependencies" marker not found; update the lock-splice logic.`);
  }
  await Bun.write('bun.lock', updatedLock.slice(0, headEnd) + pristineLock.slice(tailStart));

  // --- build: library (rslib) + CLI binaries (bun build --compile, all targets) -
  if (!DRY_RUN) {
    await $`bun run build`;
    await $`bun run --filter @aio-proxy/cli build:binary`;
  }

  // The macOS workflow builds and notarizes the native bundle before invoking this
  // script. The JS build cleans package dist directories, so restore the signed
  // archive into CloudKit's publishable dist tree immediately before packing it.
  // This keeps native signing out of ordinary Bun/Linux builds while making a
  // release fail closed when the lockstep artifact is absent or stale.
  if (cloudKitPackage !== undefined && (await shouldPrepareCloudKitArtifact(version))) {
    await prepareCloudKitArtifact(cloudKitPackage.path.replace(/\/package\.json$/u, ''), version);
  }

  // --- pack (bun, rewrites catalog:/workspace:/optionalDeps) in publish order ---
  const outDir = mkdtempSync(join(tmpdir(), 'release-'));
  const tarballs = new Map<string, string>();
  for (const { path, json } of publishable) {
    const dir = path.replace(/\/package\.json$/, '');
    const dest = join(outDir, json.name.replace(/[@/]/g, '-'));
    console.log(`\nPacking ${json.name}@${version}`);
    await $`bun pm pack --destination ${dest}`.cwd(dir);
    const [tgz] = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: dest, absolute: true }));
    if (!tgz) throw new Error(`pack produced no tarball for ${json.name}`);
    tarballs.set(json.name, tgz);
  }

  // Fail loudly if any tarball carries an unresolved protocol or a sibling
  // workspace dependency pinned to anything other than this release version.
  const workspaceNames = new Set(allPackages.map((p) => p.json.name));
  const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
  for (const tgz of tarballs.values()) {
    const files = await new Bun.Archive(await Bun.file(tgz).bytes()).files();
    const raw = await files.get('package/package.json')?.text();
    if (!raw) throw new Error(`${tgz} has no package/package.json`);
    if (/catalog:|workspace:/.test(raw)) {
      throw new Error(`${tgz} still contains catalog:/workspace: — pack did not resolve protocols`);
    }
    const packed = JSON.parse(raw) as PackageJson;
    if (packed.name === '@aio-proxy/plugin-cloudkit') {
      if (packed.dependencies?.['@aio-proxy/plugin-sdk'] !== undefined) {
        throw new Error('@aio-proxy/plugin-cloudkit must not carry @aio-proxy/plugin-sdk as a runtime dependency');
      }
      if (packed.peerDependencies?.['@aio-proxy/plugin-sdk'] !== version) {
        throw new Error(
          `@aio-proxy/plugin-cloudkit: peerDependencies.@aio-proxy/plugin-sdk must be "${version}" in the packed artifact`,
        );
      }
    }
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(packed[field] ?? {})) {
        if (workspaceNames.has(dep) && range !== version) {
          throw new Error(
            `${packed.name}: ${field}.${dep} is "${range}", expected "${version}" (stale workspace resolution)`,
          );
        }
      }
    }
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] Would publish ${tarballs.size} tarball(s) with --provenance. Stopping.`);
  } else {
    // Stage the same pack output for upload after Changesets creates the GitHub Release.
    // Only local I/O here: npm availability must never delay tagging or Release creation.
    const assetDirectory = process.env['RELEASE_ASSETS_DIR'];
    if (assetDirectory) {
      const checksums: string[] = [];
      for (const name of Object.keys(
        allPackages.find(({ json }) => json.name === 'aio-proxy')!.json.optionalDependencies ?? {},
      )) {
        const tarball = tarballs.get(name);
        if (!tarball) throw new Error(`Missing platform tarball: ${name}`);
        const filename = `${name.replace('@aio-proxy/', '')}-${version}.tgz`;
        const bytes = await Bun.file(tarball).bytes();
        await Bun.write(join(assetDirectory, filename), bytes);
        checksums.push(`${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${filename}\n`);
      }
      await Bun.write(join(assetDirectory, 'SHA256SUMS'), checksums.join(''));
    }

    // --- publish; skip versions already on the registry so a rerun resumes cleanly-
    const outputPath = process.env['CHANGESETS_OUTPUT'];
    // changesets/action reads this file UNCONDITIONALLY after the publish script exits
    // and treats a missing file as a hard error. Create it up front so a cycle that
    // emits no git-tag event (see the single-tag block below) still leaves the action
    // a valid empty NDJSON (0 events = no releases) instead of an ENOENT.
    if (outputPath) await Bun.write(outputPath, '');

    // `--tag canary` 是唯一阻止 canary 覆盖 `latest` 的东西，所以双向断言模式与
    // 版本形态一致：canary 必须是 prerelease，正式发布必须不是。这条断言真正拦住的
    // 是「传了 --canary 但版本改写被跳过」——那会把一个正常版本推上 latest。
    if (CANARY !== version.includes('-canary.')) {
      throw new Error(`--canary=${CANARY} does not match version ${version}; refusing to publish`);
    }
    const distTag = CANARY ? ['--tag', 'canary'] : [];

    for (const { json } of publishable) {
      const name = json.name;
      const tgz = tarballs.get(name)!;
      const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
      if (existing.exitCode === 0 && existing.text().trim() === version) {
        console.log(`\nSkipping ${name}@${version}: already published`);
        continue;
      }
      console.log(`\nPublishing ${tgz}`);
      await $`npm publish ${tgz} --provenance --access public ${distTag}`;
    }

    console.log(`\nReleased v${version}`);

    // --- one lockstep tag + GitHub Release for the whole release --------------------
    // Every package shares one version (`fixed`), so this repo cuts a single
    // `v<version>` tag (matching the historical v0.1.0 / v0.0.1), NOT changesets'
    // monorepo default of one `<pkg>@<version>` tag per published package. In
    // publish-script mode changesets/action never creates tags — it only pushes a tag
    // we create here and then builds a GitHub Release whose body is the emitted
    // package's CHANGELOG entry. So create `v<version>` locally and emit ONE event.
    //
    // The Release body must come from a product package that has notes this cycle:
    // prefer the CLI launcher `aio-proxy`, else the SDK (an SDK-only cycle leaves
    // `aio-proxy` without an entry, and the action throws on a missing entry). If
    // neither has an entry — which the changeset convention in AGENTS.md prevents —
    // emit nothing so the action makes no contentless Release. The tag name is also
    // what the GitHub asset upload and Homebrew notification job read.
    if (outputPath) {
      let releaseOf: string | undefined;
      for (const name of ['aio-proxy', '@aio-proxy/plugin-sdk']) {
        const dir = publishable.find((p) => p.json.name === name)?.path.replace(/\/package\.json$/, '');
        if (dir && (await hasChangelogEntry(dir, version))) {
          releaseOf = name;
          break;
        }
      }
      if (releaseOf) {
        const tag = `v${version}`;
        // Idempotent for reruns/resumes: create the local tag only if absent, but
        // always emit so a resumed release still pushes the tag + creates the Release.
        const tagged = (await $`git tag -l ${tag}`.nothrow().quiet()).text().trim() === tag;
        if (!tagged) await $`git tag ${tag}`;
        appendFileSync(outputPath, `${JSON.stringify({ type: 'git-tag', tag, packageName: releaseOf })}\n`);
      }
    }
  }
} finally {
  if (DRY_RUN) {
    // `--canary` rewrote every manifest before `bun update` carried those versions into
    // bun.lock's `workspaces` block, so both go back (without it the splice already leaves
    // the lock byte-identical and the map is empty, so this is a no-op).
    for (const [path, raw] of pristineManifests) await Bun.write(path, raw);
    await Bun.write('bun.lock', pristineLock);
    await Bun.write('package.json', rootOriginal);
  }
}

// Return true when CHANGELOG.md has a non-empty entry for `version`. Mirrors the
// depth-2 heading slice that changesets/action uses to build the Release body, so
// we only tag a product when the Release it produces would actually have content.
async function hasChangelogEntry(dir: string, ver: string): Promise<boolean> {
  const file = Bun.file(join(dir, 'CHANGELOG.md'));
  if (!(await file.exists())) return false; // no CHANGELOG (e.g. platform binaries)

  const lines = (await file.text()).split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `## ${ver}`);
  if (start < 0) return false;

  // The entry runs from its heading to the next depth-2 heading (or EOF).
  const after = lines.slice(start + 1);
  const nextSection = after.findIndex((line) => /^##\s/.test(line));
  const entry = nextSection < 0 ? after : after.slice(0, nextSection);
  return entry.some((line) => line.trim() !== ''); // any non-blank line = real notes
}
