#!/usr/bin/env bun
// Publish flow for the workspace's public npm packages.
//
// Versioning + changelog + the standing "Version PR" are owned by Changesets
// (see .changeset/config.json + .github/workflows/release.yml). This script is
// ONLY the publish step: it packs and publishes whatever version the merged
// Version PR already wrote into each package.json. It does NOT decide versions,
// write changelogs, commit, or tag — changesets/action creates the git tag(s) +
// GitHub Release(s) from the NDJSON events we emit below.
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
// binary and each plugin's *_PLUGIN_VERSION) shares the version; Changesets'
// `fixed` group guarantees that and scripts/check-lockstep-fixed.ts guards it.
// Discovery is automatic; adding a non-private package needs no change here.

import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

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

const publishable = allPackages
  .filter(({ json }) => json.private !== true)
  // Publish per-platform binary packages before the launcher that lists them in
  // optionalDependencies: npm silently skips an optional dep that isn't on the
  // registry yet (and won't self-heal on later installs), so the platform
  // packages must already exist at this version when the launcher is published.
  .sort((a, b) => Number(!!a.json.optionalDependencies) - Number(!!b.json.optionalDependencies));

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
// changesets/action injects CHANGESETS_OUTPUT and, after this script exits, reads
// one NDJSON git-tag event per line, then pushes that git tag + creates a GitHub
// Release (body = the tagged package's CHANGELOG.md entry) for each event.
//
// We emit an event only for a note-bearing PRODUCT package (not the platform
// binaries) that actually has a changelog entry this cycle, so every GitHub
// Release has real notes and the platform binaries add no empty-release noise.
// A package a prior run already published is still re-emitted, so a resumed
// release recreates any tag/Release the earlier run didn't finish.
const outputPath = process.env['CHANGESETS_OUTPUT'];
const emitTag = async (name: string, dir: string) => {
  if (!outputPath) return;
  if (platformProvided.has(name)) return; // platform binaries: npm only, no Release
  if (!(await hasChangelogEntry(dir, version))) return; // no notes this cycle -> no Release
  const event = { type: 'git-tag', tag: `${name}@${version}`, packageName: name };
  appendFileSync(outputPath, `${JSON.stringify(event)}\n`);
};

for (const { path, json } of publishable) {
  const name = json.name;
  const dir = path.replace(/\/package\.json$/, '');
  const tgz = tarballs.get(name)!;
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.exitCode === 0 && existing.text().trim() === version) {
    console.log(`\nSkipping ${name}@${version}: already published`);
    await emitTag(name, dir);
    continue;
  }
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public`;
  await emitTag(name, dir);
}

console.log(`\nReleased v${version}`);

// Return true when CHANGELOG.md has a non-empty entry for `version`. Mirrors the
// depth-2 heading slice that changesets/action uses to build the Release body, so
// we only tag a product when the Release it produces would actually have content.
async function hasChangelogEntry(dir: string, ver: string): Promise<boolean> {
  let text: string;
  try {
    text = await Bun.file(join(dir, 'CHANGELOG.md')).text();
  } catch {
    return false; // no CHANGELOG (e.g. platform binaries) -> nothing to release
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `## ${ver}`);
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break; // next version section (depth-2) ends this entry
    if (lines[i]!.trim() !== '') return true; // any non-blank content = real notes
  }
  return false;
}
