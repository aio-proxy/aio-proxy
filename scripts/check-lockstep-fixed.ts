#!/usr/bin/env bun
// Guard: Changesets' view of which packages are versioned must match ours.
//
// 1. The `fixed` group must list every versioned workspace package, so they all
//    share one version (private ones too — it is compiled into the CLI binary and
//    each plugin's *_PLUGIN_VERSION).
//
//    `fixed` cannot be the glob `@aio-proxy/*`: @changesets/config only globs
//    `ignore`, while `fixed` patterns are stored raw and matchFixedConstraint
//    looks them up literally (verified on 4.0.0-next.8 and .9). So the names are
//    enumerated, and a new package is easy to forget. scripts/release.ts does
//    ultimately refuse to publish a split release, but only after the Version PR
//    has merged; this fails on the PR that adds the package instead.
//
//    Only missing names are checked — a name in `fixed` that matches no package
//    already hard-fails inside `changeset status`, and a rename shows up as
//    missing anyway. Delete this half once upstream expands `fixed` globs.
//
// 2. The website must stay UNVERSIONED. It deploys to GitHub Pages, not npm, and
//    nothing imports it. When it had a `version`, its `workspace:*` dep on
//    @aio-proxy/ui made every release rewrite website/package.json +
//    website/CHANGELOG.md, which retriggered deploy-website.yml's `website/**`
//    path filter and redeployed an unchanged site. Changesets skips a package
//    when `!packageJson.version` (see @changesets/should-skip-package), so
//    deleting the field is what keeps it out. Nothing else would notice it
//    coming back.

const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const manifests = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))].filter(
  (p) => !p.includes('/node_modules/') && !p.includes('/dist/'),
);
// Generated manifests (e.g. paraglide output) have no `name`; they are not packages.
const names = (await Promise.all(manifests.map(async (p) => (await Bun.file(p).json()).name as unknown))).filter(
  (n): n is string => typeof n === 'string',
);

const config = (await Bun.file('.changeset/config.json').json()) as { fixed?: string[][] };
const fixed = new Set((config.fixed ?? []).flat());
const missing = names.filter((n) => !fixed.has(n)).sort();

if (missing.length > 0) {
  console.error(`Add to \`fixed\` in .changeset/config.json, or they ship a mismatched version: ${missing.join(', ')}`);
  process.exit(1);
}

const website = (await Bun.file('website/package.json').json()) as { version?: string };
if (website.version !== undefined) {
  console.error(
    `website/package.json has a "version" (${website.version}); it must stay unversioned,\n` +
      'otherwise every release rewrites it and redeploys an unchanged site. Delete the field.',
  );
  process.exit(1);
}

console.log(`OK: \`fixed\` covers all ${names.length} versioned packages; website is unversioned.`);
