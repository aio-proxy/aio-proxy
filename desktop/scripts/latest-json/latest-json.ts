import { TARGETS, trustedComment, type UpdateTarget, updaterSignature } from '../minisign';
import { assetName } from '../package/index';

export { TARGETS, type UpdateTarget };

export const REPO = 'aio-proxy/aio-proxy';

/** Where a target's build for `version` is downloaded from: the feed points at exactly this URL. */
export const assetUrl = (version: string, target: UpdateTarget): string =>
  `https://github.com/${REPO}/releases/download/v${version}/${assetName(target, version)}`;

/** Whether `signature` is the base64 of a four-line .minisig text carrying the trusted comment this entry needs. */
function signsEntry(signature: string, version: string, target: UpdateTarget): boolean {
  try {
    const text = Buffer.from(signature, 'base64').toString();
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
    return (
      lines.length === 4 &&
      lines[0]!.startsWith('untrusted comment: ') &&
      lines[1] !== '' &&
      lines[2] === `trusted comment: ${trustedComment(version, target, assetName(target, version))}` &&
      lines[3] !== ''
    );
  } catch {
    // trustedComment refuses a version that is not plain semver: no entry of such a feed is usable.
    return false;
  }
}

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
 * The published feed's version, and whether every target has the entry publish-latest would write for it (the
 * Release asset's URL, a signature carrying its trusted comment, the right format); `undefined` when the text is not
 * a feed. An incomplete feed may be rewritten at its own version.
 */
export function parseLatestJson(text: string): { version: string; complete: boolean } | undefined {
  try {
    const json = JSON.parse(text) as { version?: unknown; platforms?: Record<string, unknown> } | null;
    const version = json?.version;
    if (typeof version !== 'string') return undefined;
    const complete = TARGETS.every((target) => {
      const entry = json?.platforms?.[target] as { url?: unknown; signature?: unknown; format?: unknown } | undefined;
      return (
        entry?.url === assetUrl(version, target) &&
        typeof entry.signature === 'string' &&
        signsEntry(entry.signature, version, target) &&
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
