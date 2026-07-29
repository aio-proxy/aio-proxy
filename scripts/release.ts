#!/usr/bin/env bun
// Publish flow for the workspace's public npm packages.
//
// Why this is hand-rolled rather than nx/changesets/semantic-release:
//   - `bun publish` cannot do npm OIDC trusted publishing (oven-sh/bun#22423),
//     so the actual publish must go through `npm publish`.
//   - `npm publish` does not understand `catalog:` (and would ship the literal
//     string), so the tarball must be produced by `bun pm pack`, which resolves
//     `catalog:`, `workspace:*`, and optionalDependencies to real versions.
//   Splitting pack (bun) from publish (npm) is the only combination that keeps
//   protocol rewriting AND OIDC + provenance. nx picks one or the other.
//
// Two products publish at one lockstep version:
//   - the library packages under packages/** (non-private), and
//   - the CLI: the `aio-proxy` launcher + its per-platform binary packages
//     under npm/* (bun build --compile fills each npm/cli-*/bin before packing).
// Discovery is automatic; adding a non-private package needs no change here.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';
import { ConventionalChangelog } from 'conventional-changelog';
import { Bumper } from 'conventional-recommended-bump';
import * as semver from 'semver';

const DRY_RUN = process.argv.includes('--dry-run');
const bumpArg = process.argv.find((a) => a.startsWith('--bump='))?.slice('--bump='.length);

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// --- discover every workspace package; bump them all to one lockstep version ---
// All packages are versioned (private ones too — e.g. packages/cli's version is
// compiled into the CLI binary), but only non-private packages are published.
const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const globbed = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))];
const allPackages = (
  await Promise.all(
    globbed
      .filter((p) => !p.includes('/node_modules/') && !p.includes('/dist/'))
      .map(async (path) => ({ path, json: (await Bun.file(path).json()) as PackageJson })),
  )
).filter(({ json }) => typeof json.name === 'string');

const publishable = allPackages
  .filter(({ json }) => json.private !== true)
  // Publish per-platform binary packages before the launcher that lists them in
  // optionalDependencies, so the launcher's resolved versions already exist.
  .sort((a, b) => Number(!!a.json.optionalDependencies) - Number(!!b.json.optionalDependencies));

if (publishable.length === 0) {
  throw new Error('No publishable packages found');
}
console.log(
  `Bumping ${allPackages.length} packages; publishing:\n${publishable.map((p) => `  ${p.json.name}`).join('\n')}\n`,
);

// --- resolve the bump level from conventional commits since the last v* tag ---
async function detectBump(): Promise<'major' | 'minor' | 'patch'> {
  const rec = await new Bumper().loadPreset('conventionalcommits').bump();
  if ('releaseType' in rec && (rec.releaseType === 'major' || rec.releaseType === 'minor')) {
    return rec.releaseType;
  }
  return 'patch';
}

const level = (bumpArg as 'major' | 'minor' | 'patch') ?? (await detectBump());
if (!['major', 'minor', 'patch'].includes(level)) {
  throw new Error(`Invalid --bump=${bumpArg}; expected major|minor|patch`);
}

// --- generate a changelog section for the new version (same preset as bump) ---
async function changelogSection(nextVer: string): Promise<string> {
  const generator = new ConventionalChangelog(process.cwd())
    .loadPreset('conventionalcommits')
    .options({ releaseCount: 1 })
    .context({ version: nextVer });
  let out = '';
  for await (const chunk of generator.write()) out += chunk;
  return out;
}

// Highest current version via semver ordering (localeCompare mis-sorts 1.9 vs 1.10).
const versions = allPackages.map((p) => p.json.version);
const invalid = versions.find((v) => !semver.valid(v));
if (invalid) throw new Error(`Unparseable version: ${invalid}`);
const highest = semver.rsort([...versions])[0]!;

// Resume, don't re-bump: if HEAD already carries a release tag (a prior run pushed
// the bump commit + tag but a later publish failed), reuse that version so the
// registry-skip loop targets the partially-published release instead of vX+1.
const headTag = (await $`git tag --points-at HEAD`.nothrow().quiet().text())
  .split('\n')
  .map((t) => t.trim())
  .find((t) => /^v\d+\.\d+\.\d+$/.test(t));
const version = headTag && !DRY_RUN ? headTag.slice(1) : semver.inc(highest, level)!;

console.log(
  `Bump: ${level}  (${highest} -> ${version})${headTag && !DRY_RUN ? '  [resuming tagged release]' : ''}${DRY_RUN ? '  [dry-run]' : ''}\n`,
);

// --- generate the changelog section for this release ---
const changelog = await changelogSection(version);
console.log(changelog);

// --- write the new version to every workspace package (published and private) ---
// Written before packing (even in dry-run) so private packages like packages/cli
// (whose version is compiled into the CLI binary and the config schema URL) ship
// the right version. Original bytes (incl. bun.lock, which `bun update` rewrites)
// are snapshotted so a dry-run (or failure) restores them exactly, preserving any
// pre-existing unstaged edits.
const workspaceNames = new Set(allPackages.map((p) => p.json.name));
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const originals = new Map<string, string>();
originals.set('bun.lock', await Bun.file('bun.lock').text());
// Snapshot the root manifest too: every `bun update` variant (incl. --workspaces
// / --filter) re-resolves its devDependency ranges, which is release noise.
const rootOriginal = await Bun.file('package.json').text();
for (const { path } of allPackages) {
  const text = await Bun.file(path).text();
  originals.set(path, text);
  const json = JSON.parse(text) as PackageJson;
  json.version = version;
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}
const restoreManifests = () => Promise.all([...originals].map(([path, text]) => Bun.write(path, text)));

// Refresh bun.lock's recorded workspace versions so `bun pm pack` resolves
// workspace: siblings (e.g. the aio-proxy launcher's optionalDependencies) to the
// bumped version. A plain `bun install` reports "no changes" and leaves them at
// the pre-bump version; `bun update` (without --latest) re-resolves within the
// existing package.json ranges, so catalog pins are not drifted.
await $`bun update`;
// Discard bun update's incidental rewrite of the root manifest's devDependency
// ranges; the lockfile stays self-consistent (frozen install still passes) since
// only the workspace sibling versions materially changed.
await Bun.write('package.json', rootOriginal);

// --- build: library (rslib) + CLI binaries (bun build --compile, all targets) ---
if (!DRY_RUN) {
  await $`bun run build`;
  await $`bun run --filter @aio-proxy/cli build:binary`;
}

// --- pack (bun, rewrites catalog:/workspace:/optionalDeps) in publish order ---
const outDir = mkdtempSync(join(tmpdir(), 'release-'));
const tarballs: string[] = [];
for (const { path, json } of publishable) {
  const dir = path.replace(/\/package\.json$/, '');
  const dest = join(outDir, json.name.replace(/[@/]/g, '-'));
  console.log(`\nPacking ${json.name}@${version}`);
  await $`bun pm pack --destination ${dest}`.cwd(dir);
  const [tgz] = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: dest, absolute: true }));
  if (!tgz) throw new Error(`pack produced no tarball for ${json.name}`);
  tarballs.push(tgz);
}

// Fail loudly if any tarball carries an unresolved protocol or a sibling
// workspace dependency pinned to anything other than this release version.
for (const tgz of tarballs) {
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
  // Restore the exact pre-run manifest bytes so dry-run leaves no diff.
  await restoreManifests();
  console.log(`\n[dry-run] Would publish ${tarballs.length} tarball(s) with --provenance. Stopping.`);
  process.exit(0);
}

// --- persist the release first, so a mid-publish failure is resumable ---
// On a resume (HEAD already carries this tag) the changelog and release commit
// already exist — don't rewrite them (that would move HEAD off the tag and break
// a further retry's resume detection). Just re-push and fall through to publish.
if (!headTag) {
  // Prepend the new section after the "# Changelog" H1 (kept at the top).
  const changelogFile = Bun.file('CHANGELOG.md');
  const H1 = '# Changelog';
  const prior = (await changelogFile.exists()) ? await changelogFile.text() : `${H1}\n`;
  const body = prior.startsWith(H1) ? prior.slice(H1.length).replace(/^\n+/, '') : prior;
  await Bun.write(changelogFile, `${H1}\n\n${changelog}\n${body}`);

  await $`git add -A`;
  await $`git commit -m ${`chore: release v${version}`}`;
  await $`git tag -a v${version} -m ${`v${version}`}`;
}
// Push to the concrete branch this workflow ran on (not the literal ref "HEAD"),
// and push the tag explicitly (a lightweight tag would be skipped by --follow-tags).
const branch = process.env['GITHUB_REF_NAME'] ?? (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
await $`git push origin ${`HEAD:${branch}`} ${`refs/tags/v${version}`}`;

// --- publish; skip versions already on the registry so a rerun resumes cleanly ---
for (const { json } of publishable) {
  const name = json.name;
  const dest = join(outDir, name.replace(/[@/]/g, '-'));
  const [tgz] = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: dest, absolute: true }));
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.exitCode === 0 && existing.text().trim() === version) {
    console.log(`\nSkipping ${name}@${version}: already published`);
    continue;
  }
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public`;
}

// --- GitHub Release with the same notes; failure must fail the job ---
const notesFile = join(outDir, 'RELEASE_NOTES.md');
await Bun.write(notesFile, changelog);
await $`gh release create v${version} --title ${`v${version}`} --notes-file ${notesFile}`;
console.log(`\nReleased v${version}`);
