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
  optionalDependencies?: Record<string, string>;
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
// Written before packing (even in dry-run) so bun pm pack resolves
// optionalDependencies/workspace: to the real release version, and so private
// packages like packages/cli (whose version is compiled into the CLI binary and
// the config schema URL) ship the right version. Original bytes are snapshotted
// so a dry-run (or failure) restores them exactly, preserving any pre-existing
// unstaged edits rather than reverting to the git index.
const originals = new Map<string, string>();
for (const { path } of allPackages) {
  const text = await Bun.file(path).text();
  originals.set(path, text);
  const json = JSON.parse(text) as PackageJson;
  json.version = version;
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}
const restoreManifests = () => Promise.all([...originals].map(([path, text]) => Bun.write(path, text)));

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

// Fail loudly if any tarball still carries an unresolved protocol.
for (const tgz of tarballs) {
  const files = await new Bun.Archive(await Bun.file(tgz).bytes()).files();
  const pkgJson = await files.get('package/package.json')?.text();
  if (!pkgJson) throw new Error(`${tgz} has no package/package.json`);
  if (/catalog:|workspace:/.test(pkgJson)) {
    throw new Error(`${tgz} still contains catalog:/workspace: — pack did not resolve protocols`);
  }
}

if (DRY_RUN) {
  // Restore the exact pre-run manifest bytes so dry-run leaves no diff.
  await restoreManifests();
  console.log(`\n[dry-run] Would publish ${tarballs.length} tarball(s) with --provenance. Stopping.`);
  process.exit(0);
}

// --- persist the release first, so a mid-publish failure is resumable ---
// Prepend the new section after the "# Changelog" H1 (kept at the top).
const changelogFile = Bun.file('CHANGELOG.md');
const H1 = '# Changelog';
const prior = (await changelogFile.exists()) ? await changelogFile.text() : `${H1}\n`;
const body = prior.startsWith(H1) ? prior.slice(H1.length).replace(/^\n+/, '') : prior;
await Bun.write(changelogFile, `${H1}\n\n${changelog}\n${body}`);

// Idempotent so a re-run after a mid-publish failure resumes instead of erroring:
// commit only if the bump isn't already committed, tag only if absent.
await $`git add -A`;
const staged = await $`git diff --cached --quiet`.nothrow();
if (staged.exitCode !== 0) await $`git commit -m ${`chore: release v${version}`}`;
const tagged = await $`git rev-parse -q --verify ${`refs/tags/v${version}`}`.nothrow().quiet();
if (tagged.exitCode !== 0) await $`git tag -a v${version} -m ${`v${version}`}`;
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
