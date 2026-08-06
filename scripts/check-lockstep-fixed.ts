#!/usr/bin/env bun
// Guard: Changesets' view of which packages are versioned must match ours.
//
// 1. The `fixed` group must list EVERY versioned workspace package. We keep them
//    all on one lockstep version (private ones too — it is compiled into the CLI
//    binary and each plugin's *_PLUGIN_VERSION), which Changesets enforces via
//    `fixed` in .changeset/config.json.
//
//    Ideally that group would be the glob `@aio-proxy/*` + `aio-proxy`, but
//    @changesets/config only globs `ignore`: `fixed` patterns are stored raw and
//    matchFixedConstraint looks them up literally, so a glob entry throws in
//    `changeset version`. Worse, the unmatched-pattern check is a WARNING, so
//    `changeset status` stays green and the failure only lands in release CI.
//    (Verified against 4.0.0-next.8 and 4.0.0-next.9.) We therefore enumerate,
//    and this guard fails loudly when the enumeration drifts — so a new package
//    can never silently fall out of lockstep and ship a mismatched version.
//    Remove this half (and switch `fixed` to a glob) once upstream expands them.
//
// 2. The website must stay UNVERSIONED. It deploys to GitHub Pages, not npm, and
//    nothing imports it. When it had a `version`, its `workspace:*` dep on
//    @aio-proxy/ui made every release rewrite website/package.json +
//    website/CHANGELOG.md, which retriggered deploy-website.yml's `website/**`
//    path filter and redeployed an unchanged site. Changesets skips a package
//    when `!packageJson.version` (see @changesets/should-skip-package), so
//    deleting the field is what keeps it out — and re-adding one would silently
//    restore the redeploy loop. This guard is the only thing that would notice.

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

// The website is intentionally unversioned; see (2) above.
const websiteManifest = 'website/package.json';
const website = (await Bun.file(websiteManifest).json()) as { version?: string };
if (website.version !== undefined) {
  console.error(
    `${websiteManifest} has a "version" field (${website.version}).\n` +
      'The website must stay unversioned, otherwise every release rewrites it and\n' +
      'redeploys an unchanged site to GitHub Pages. Delete the field.',
  );
  process.exit(1);
}

console.log(`OK: fixed group covers all ${workspaceNames.length} workspace packages; website is unversioned.`);
