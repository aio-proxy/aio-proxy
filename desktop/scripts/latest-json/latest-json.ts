import { KEY_ID, TARGETS, trustedComment, type UpdateTarget, updaterSignature } from '../minisign';
import { assetName } from '../package/index';

export { TARGETS, type UpdateTarget };

export const REPO = 'aio-proxy/aio-proxy';

/** Where a target's build for `version` is downloaded from: the feed points at exactly this URL. */
export const assetUrl = (version: string, target: UpdateTarget): string =>
  `https://github.com/${REPO}/releases/download/v${version}/${assetName(target, version)}`;

/** Strict base64 (a truncated or padded-wrong value fails), decoded; `undefined` when it is not. */
function strictBase64(text: string | undefined): Buffer | undefined {
  if (text === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : undefined;
}

/** The four .minisig lines of an entry's `signature`, or `undefined` when it is not one. */
function minisigLines(signature: string): string[] | undefined {
  const raw = strictBase64(signature);
  if (raw === undefined) return undefined;
  const text = raw.toString();
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  return lines.length === 4 ? lines : undefined;
}

/**
 * Whether `signature` has the shape the updater accepts for this entry: a four-line .minisig whose signature line is
 * `ED` + our key id + 64 bytes, whose global signature is 64 bytes, and whose trusted comment names this entry.
 * The signatures themselves are checked against the key by `feedSignaturesVerify`.
 */
function signsEntry(signature: string, version: string, target: UpdateTarget): boolean {
  try {
    const lines = minisigLines(signature);
    const sig = strictBase64(lines?.[1]);
    return (
      lines !== undefined &&
      lines[0]!.startsWith('untrusted comment: ') &&
      sig?.length === 74 &&
      sig.subarray(0, 2).toString() === 'ED' &&
      sig.subarray(2, 10).equals(Buffer.from(KEY_ID)) &&
      lines[2] === `trusted comment: ${trustedComment(version, target, assetName(target, version))}` &&
      strictBase64(lines[3])?.length === 64
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

/**
 * Whether every entry's global signature (over its signature bytes and trusted comment) verifies against
 * `publicKeyB64`: a well-formed entry signed by another key is no more usable than a malformed one. Needs no asset.
 */
export async function feedSignaturesVerify(text: string, publicKeyB64: string): Promise<boolean> {
  try {
    const json = JSON.parse(text) as { platforms?: Record<string, { signature?: unknown }> };
    const key = await crypto.subtle.importKey('raw', Buffer.from(publicKeyB64, 'base64'), 'Ed25519', false, ['verify']);
    for (const target of TARGETS) {
      const signature = json.platforms?.[target]?.signature;
      const lines = typeof signature === 'string' ? minisigLines(signature) : undefined;
      const sig = strictBase64(lines?.[1]);
      const global = strictBase64(lines?.[3]);
      if (lines === undefined || sig === undefined || global === undefined) return false;
      const comment = Buffer.from(lines[2]!.slice('trusted comment: '.length));
      if (
        !(await crypto.subtle.verify(
          'Ed25519',
          key,
          new Uint8Array(global),
          new Uint8Array(Buffer.concat([sig.subarray(10), comment])),
        ))
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
