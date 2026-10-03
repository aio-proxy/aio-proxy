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
