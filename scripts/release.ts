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

// --- discover publishable packages (non-private, in the two product roots) ---
const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const globbed = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))];
const publishable = (
  await Promise.all(
    globbed
      .filter((p) => !p.includes('/node_modules/') && !p.includes('/dist/'))
      .map(async (path) => ({ path, json: (await Bun.file(path).json()) as PackageJson })),
  )
)
  .filter(({ json }) => json.private !== true && typeof json.name === 'string')
  // Publish per-platform binary packages before the launcher that lists them in
  // optionalDependencies, so the launcher's resolved versions already exist.
  .sort((a, b) => Number(!!a.json.optionalDependencies) - Number(!!b.json.optionalDependencies));

if (publishable.length === 0) {
  throw new Error('No publishable packages found');
}
console.log(`Publishable packages:\n${publishable.map((p) => `  ${p.json.name}`).join('\n')}\n`);

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
const versions = publishable.map((p) => p.json.version);
const invalid = versions.find((v) => !semver.valid(v));
if (invalid) throw new Error(`Unparseable version: ${invalid}`);
const highest = semver.rsort([...versions])[0]!;
const version = semver.inc(highest, level)!;

console.log(`Bump: ${level}  (${highest} -> ${version})${DRY_RUN ? '  [dry-run]' : ''}\n`);

// --- generate the changelog section for this release ---
const changelog = await changelogSection(version);
console.log(changelog);

// --- write the new version to every publishable package.json ---
// Done before packing so the launcher's optionalDependencies resolve to it.
for (const { path, json } of publishable) {
  json.version = version;
  if (!DRY_RUN) await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}

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
  console.log(`\n[dry-run] Would publish ${tarballs.length} tarball(s) with --provenance. Stopping.`);
  process.exit(0);
}

for (const tgz of tarballs) {
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public`;
}

// --- prepend the section to CHANGELOG.md, commit the bump, tag, push ---
const changelogFile = Bun.file('CHANGELOG.md');
const prior = (await changelogFile.exists()) ? await changelogFile.text() : '# Changelog\n';
await Bun.write(changelogFile, `${changelog}\n${prior}`);

await $`git add -A`;
await $`git commit -m ${`chore: release v${version}`}`;
await $`git tag v${version}`;
await $`git push origin HEAD --tags`;

// GitHub Release with the same notes (gh is available on GitHub-hosted runners).
const notesFile = join(outDir, 'RELEASE_NOTES.md');
await Bun.write(notesFile, changelog);
await $`gh release create v${version} --title ${`v${version}`} --notes-file ${notesFile}`.nothrow();
console.log(`\nReleased v${version}`);
