#!/usr/bin/env bun
// Guard: the Changesets `fixed` group must list EVERY workspace package.
//
// We keep all packages on one lockstep version (private ones too — their version
// is compiled into the CLI binary and each plugin's *_PLUGIN_VERSION). Changesets
// enforces that via a `fixed` group in .changeset/config.json.
//
// Ideally that group would be the glob `@aio-proxy/*` + `aio-proxy`, but the
// pinned Changesets v3 prerelease (@changesets/config@4.0.0-next.8) validates a
// `fixed` glob without expanding it (only `ignore` is globbed), so a glob entry
// makes `changeset version` throw. We therefore enumerate the names — and this
// guard fails loudly if the enumeration drifts from the actual workspace, so a
// newly added package can never silently fall out of lockstep and ship a
// mismatched version. Remove this guard (and switch `fixed` back to a glob) once
// the upstream config expands `fixed` globs again.

const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const manifests = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))].filter(
  (p) => !p.includes('/node_modules/') && !p.includes('/dist/'),
);
const workspaceNames = (await Promise.all(manifests.map(async (p) => (await Bun.file(p).json()).name as string)))
  .filter((n): n is string => typeof n === 'string')
  .sort();

const config = (await Bun.file('.changeset/config.json').json()) as { fixed?: string[][] };
const fixedNames = [...new Set((config.fixed ?? []).flat())].sort();

const missing = workspaceNames.filter((n) => !fixedNames.includes(n));
const extra = fixedNames.filter((n) => !workspaceNames.includes(n));

if (missing.length > 0 || extra.length > 0) {
  console.error('.changeset/config.json `fixed` group is out of sync with the workspace.');
  if (missing.length > 0) console.error(`  Missing (add to fixed): ${missing.join(', ')}`);
  if (extra.length > 0) console.error(`  Extra (remove from fixed): ${extra.join(', ')}`);
  console.error('\nExpected fixed[0]:');
  console.error(JSON.stringify(workspaceNames, null, 2));
  process.exit(1);
}

console.log(`OK: fixed group covers all ${workspaceNames.length} workspace packages.`);
