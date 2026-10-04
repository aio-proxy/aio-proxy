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

/**
 * The published feed's version, and whether every target has a usable entry (url, signature, the right format);
 * `undefined` when the text is not a feed. An incomplete feed may be rewritten at its own version.
 */
export function parseLatestJson(text: string): { version: string; complete: boolean } | undefined {
  try {
    const json = JSON.parse(text) as { version?: unknown; platforms?: Record<string, unknown> } | null;
    const version = json?.version;
    if (typeof version !== 'string') return undefined;
    const complete = TARGETS.every((target) => {
      const entry = json?.platforms?.[target] as { url?: unknown; signature?: unknown; format?: unknown } | undefined;
      return (
        typeof entry?.url === 'string' &&
        entry.url !== '' &&
        typeof entry.signature === 'string' &&
        entry.signature !== '' &&
        entry.format === (target.startsWith('windows-') ? 'nsis' : 'appimage')
      );
    });
    return { version, complete };
  } catch {
    return undefined;
  }
}

/** Highest complete stable version strictly above `current`, else `undefined`. */
export function pickFeedVersion(
  current: string | undefined,
  releases: readonly { version: string; complete: boolean }[],
  // An incomplete current feed may be rewritten at its own version, never below it.
  sameVersionAllowed = false,
): string | undefined {
  let best = current;
  let picked: string | undefined;
  const floor = sameVersionAllowed ? 0 : 1;
  for (const { version, complete } of releases) {
    if (!complete || version.includes('-')) continue;
    if (best === undefined || Bun.semver.order(version, best) >= (picked === undefined ? floor : 1)) {
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
export function feedCandidates(
  current: string | undefined,
  tags: readonly string[],
  sameVersionAllowed = false,
): string[] {
  return tags
    .flatMap((tag) => /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1] ?? [])
    .filter((version) => current === undefined || Bun.semver.order(version, current) >= (sameVersionAllowed ? 0 : 1))
    .sort((a, b) => Bun.semver.order(b, a));
}
