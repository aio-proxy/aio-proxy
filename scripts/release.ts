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

import { buildHomebrewChecksums } from './homebrew-checksums';

const DRY_RUN = process.argv.includes('--dry-run');

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// --- discover every workspace package -----------------------------------------
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
const unsorted = allPackages.filter(({ json }) => json.private !== true);
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
const version = [...versions][0]!;

console.log(
  `Publishing ${publishable.length} package(s) at v${version}${DRY_RUN ? '  [dry-run]' : ''}:\n${publishable
    .map((p) => `  ${p.json.name}${platformProvided.has(p.json.name) ? '  (platform binary; npm only)' : ''}`)
    .join('\n')}\n`,
);

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
  // `bun update` + splice leaves bun.lock byte-identical to the pristine lock, so
  // there's nothing to restore; the manifests were never rewritten by this script.
  console.log(`\n[dry-run] Would publish ${tarballs.size} tarball(s) with --provenance. Stopping.`);
  process.exit(0);
}

// --- publish; skip versions already on the registry so a rerun resumes cleanly-
const outputPath = process.env['CHANGESETS_OUTPUT'];
// changesets/action reads this file UNCONDITIONALLY after the publish script exits
// and treats a missing file as a hard error. Create it up front so a cycle that
// emits no git-tag event (see the single-tag block below) still leaves the action
// a valid empty NDJSON (0 events = no releases) instead of an ENOENT.
if (outputPath) await Bun.write(outputPath, '');

for (const { json } of publishable) {
  const name = json.name;
  const tgz = tarballs.get(name)!;
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.exitCode === 0 && existing.text().trim() === version) {
    console.log(`\nSkipping ${name}@${version}: already published`);
    continue;
  }
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public`;
}

console.log(`\nReleased v${version}`);

// --- hand the Homebrew tap the checksums of the tarballs we just published -----
// See scripts/homebrew-checksums for why the tap cannot just re-download them.
const checksumPath = process.env['HOMEBREW_CHECKSUMS_PATH'];
if (checksumPath) {
  const payload = await buildHomebrewChecksums({
    tarballs,
    platformProvided,
    version,
    readBytes: (path) => Bun.file(path).bytes(),
    registryIntegrity: async (name, ver) =>
      (await $`npm view ${`${name}@${ver}`} dist.integrity`.nothrow().quiet()).text().trim(),
  });
  await Bun.write(checksumPath, JSON.stringify(payload));
  console.log(`\nWrote ${Object.keys(payload.checksums).length} Homebrew checksum(s) to ${checksumPath}`);
}

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
// what the Homebrew notify step reads (`gh release view` -> tagName -> strip `v`).
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
