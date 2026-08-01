#!/usr/bin/env bun
// Guard: changesets may only target the PUBLIC PRODUCT packages.
//
// All packages share one lockstep version via Changesets' `fixed` group, so a
// changeset written against a private package (`@aio-proxy/core`, `server`,
// `cli`, the plugins) or a platform-binary package (`@aio-proxy/cli-*`) would
// bump the whole workspace all the same — but its release note would land in
// that package's CHANGELOG.md, which nobody publishes a GitHub Release for.
//
// Contributors therefore write changesets against the products users actually
// install — `aio-proxy` (the CLI/proxy) or `@aio-proxy/plugin-sdk` — and put the
// affected area in the summary text (e.g. "core: fix provider fallback"). This
// guard fails a PR whose changeset targets anything else, so release notes can't
// silently go missing.

const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: process.cwd(), absolute: true }));
const manifests = [...(await scan('packages/**/package.json')), ...(await scan('npm/*/package.json'))].filter(
  (p) => !p.includes('/node_modules/') && !p.includes('/dist/'),
);
const pkgs = await Promise.all(
  manifests.map(
    async (p) =>
      (await Bun.file(p).json()) as { name?: string; private?: boolean; optionalDependencies?: Record<string, string> },
  ),
);

// Platform binaries are whatever another package pulls in via optionalDependencies.
const platformProvided = new Set(pkgs.flatMap((j) => Object.keys(j.optionalDependencies ?? {})));
const allowedTargets = new Set(
  pkgs
    .filter((j) => typeof j.name === 'string' && j.private !== true && !platformProvided.has(j.name!))
    .map((j) => j.name!),
);

const changesetFiles = (await scan('.changeset/*.md')).filter((p) => !/\/README\.md$/i.test(p));

const violations: string[] = [];
for (const file of changesetFiles) {
  for (const pkg of parseChangesetPackages(await Bun.file(file).text())) {
    if (!allowedTargets.has(pkg)) {
      violations.push(`  ${file.split('/.changeset/')[1] ?? file}: targets "${pkg}"`);
    }
  }
}

if (violations.length > 0) {
  console.error('Changesets may only target public product packages: ' + [...allowedTargets].sort().join(', ') + '.');
  console.error('Put the affected area in the summary instead (e.g. "core: ...").\n');
  console.error('Offending changesets:');
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`OK: ${changesetFiles.length} changeset(s) target only allowed packages.`);

// Read the package names from a changeset's YAML frontmatter block. Each release
// line looks like `"@scope/pkg": patch` or `pkg: minor` between the leading `---`
// fences; we only need the names, so we don't pull in a YAML dependency.
export function parseChangesetPackages(source: string): string[] {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const names: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') break;
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^:'"\s][^:]*?))\s*:\s*\S+\s*$/.exec(lines[i]!);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name) names.push(name.trim());
  }
  return names;
}
