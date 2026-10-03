import { TARGETS, type UpdateTarget, updaterSignature } from '../minisign';

export { TARGETS, type UpdateTarget };

/** Builds the feed the cargo-packager updater reads (`notes` and `pub_date` are optional there, so omitted). */
export function buildLatestJson(
  version: string,
  entries: ReadonlyMap<UpdateTarget, { url: string; minisig: string }>,
): string {
  const platforms: Record<string, { url: string; signature: string; format: 'appimage' | 'nsis' }> = {};
  for (const target of TARGETS) {
    const entry = entries.get(target);
    if (!entry) throw new Error(`latest.json is missing the ${target} build`);
    platforms[target] = {
      url: entry.url,
      signature: updaterSignature(entry.minisig),
      format: target.startsWith('windows-') ? 'nsis' : 'appimage',
    };
  }
  return `${JSON.stringify({ version, platforms }, null, 2)}\n`;
}

/** The published feed's version, or `undefined` when the text is not a feed. */
export function parseLatestJson(text: string): { version: string } | undefined {
  try {
    const json: unknown = JSON.parse(text);
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === 'string') return { version };
  } catch {
    // malformed feed: treat as absent
  }
  return undefined;
}

/** Highest complete stable version strictly above `current`, else `undefined`. */
export function pickFeedVersion(
  current: string | undefined,
  releases: readonly { version: string; complete: boolean }[],
): string | undefined {
  let best = current;
  let picked: string | undefined;
  for (const { version, complete } of releases) {
    if (!complete || version.includes('-')) continue;
    if (best === undefined || Bun.semver.order(version, best) > 0) {
      best = version;
      picked = version;
    }
  }
  return picked;
}

/**
 * Stable `vX.Y.Z` tags above `current`, highest first: the only Releases that can move the feed, in the
 * order to check them, so checking stops at the first complete one instead of downloading every build.
 */
export function feedCandidates(current: string | undefined, tags: readonly string[]): string[] {
  return tags
    .flatMap((tag) => /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1] ?? [])
    .filter((version) => current === undefined || Bun.semver.order(version, current) > 0)
    .sort((a, b) => Bun.semver.order(b, a));
}
