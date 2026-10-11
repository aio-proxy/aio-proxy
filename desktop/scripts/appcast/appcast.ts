import { MINIMUM_MACOS } from '../macho';

export { publicKeyFromPrivate } from '../minisign';

/** generate_appcast keeps this many versions; passed explicitly instead of relying on its default. */
export const MAXIMUM_VERSIONS = 3;

export type AppcastItem = {
  readonly version: string;
  readonly url: string;
  readonly length: number;
  readonly edSignature?: string;
  readonly minimumSystemVersion?: string;
};

const element = (body: string, name: string): string | undefined =>
  new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(body)?.[1]?.trim();

/** Items of an appcast written by generate_appcast. An item it cannot read fails the parse. */
export function parseAppcast(xml: string): AppcastItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map(([, body = '']) => {
    const version = element(body, 'sparkle:version');
    const enclosure = /<enclosure\b([^>]*)>/u.exec(body)?.[1];
    if (version === undefined || enclosure === undefined) {
      throw new Error(`appcast item without sparkle:version or enclosure: ${body.trim().slice(0, 200)}`);
    }
    const attributes = new Map(
      [...enclosure.matchAll(/([\w:]+)="([^"]*)"/gu)].map(([, key = '', value = '']) => [key, value]),
    );
    const url = attributes.get('url');
    const length = Number(attributes.get('length'));
    if (url === undefined || !Number.isSafeInteger(length))
      throw new Error(`appcast item ${version} has no url or length`);
    const edSignature = attributes.get('sparkle:edSignature');
    const minimumSystemVersion = element(body, 'sparkle:minimumSystemVersion');
    return {
      version,
      url,
      length,
      ...(edSignature === undefined ? {} : { edSignature }),
      ...(minimumSystemVersion === undefined ? {} : { minimumSystemVersion }),
    };
  });
}

export type FeedState = 'missing-release' | 'empty' | 'present';

/**
 * State of the `desktop-feed` Release from `gh release view desktop-feed --json assets`. Only a
 * definite "release not found" may start a new feed: treating any other failure as "no feed" would
 * publish a fresh appcast that drops every earlier version.
 */
export function feedState(exitCode: number, stdout: string, stderr: string): FeedState {
  if (exitCode !== 0) {
    if (/release not found/iu.test(stderr)) return 'missing-release';
    throw new Error(`gh release view desktop-feed failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  const { assets } = JSON.parse(stdout) as { assets?: unknown };
  if (!Array.isArray(assets)) throw new Error(`unexpected gh output: ${stdout.slice(0, 200)}`);
  return assets.some((asset: { name?: unknown }) => asset.name === 'appcast.xml') ? 'present' : 'empty';
}

export type FeedAction =
  | { readonly kind: 'publish' }
  | { readonly kind: 'already-published'; readonly item: AppcastItem }
  | { readonly kind: 'superseded'; readonly newest: string };

const newestFirst = (a: AppcastItem, b: AppcastItem): number => Bun.semver.order(b.version, a.version);

/**
 * A version already in the feed is re-verified, never regenerated. A version older than the feed's
 * newest is not added: every install that could take it already sees the newer one.
 */
export function feedAction(previous: readonly AppcastItem[], version: string): FeedAction {
  const same = previous.find((item) => item.version === version);
  if (same !== undefined) return { kind: 'already-published', item: same };
  const newest = [...previous].sort(newestFirst)[0];
  return newest !== undefined && Bun.semver.order(newest.version, version) > 0
    ? { kind: 'superseded', newest: newest.version }
    : { kind: 'publish' };
}

/** Whether `version` may hold the unversioned website download: nothing in the feed is newer. */
export const ownsLatestDownload = (previous: readonly AppcastItem[], version: string): boolean =>
  previous.every((item) => Bun.semver.order(item.version, version) <= 0);

export type ExpectedItem = { readonly version: string; readonly url: string; readonly length: number };

export function itemProblems(item: AppcastItem, { version, url, length }: ExpectedItem): string[] {
  const problems: string[] = [];
  if (item.url !== url) problems.push(`${version}: enclosure url ${item.url}, expected ${url}`);
  if (item.length !== length) problems.push(`${version}: enclosure length ${item.length}, expected ${length}`);
  if (item.edSignature === undefined) {
    problems.push(
      `${version}: no sparkle:edSignature (generate_appcast writes none when the private key does not match SUPublicEDKey)`,
    );
  }
  if (item.minimumSystemVersion !== MINIMUM_MACOS) {
    problems.push(
      `${version}: sparkle:minimumSystemVersion ${item.minimumSystemVersion ?? 'missing'}, expected ${MINIMUM_MACOS}`,
    );
  }
  return problems;
}

/** Problems with a regenerated feed; empty when it may replace the published appcast.xml. */
export function feedProblems({
  previous,
  next,
  ...expected
}: ExpectedItem & { readonly previous: readonly AppcastItem[]; readonly next: readonly AppcastItem[] }): string[] {
  const added = next.filter((item) => item.version === expected.version);
  const [item] = added;
  if (added.length !== 1 || item === undefined) return [`expected one ${expected.version} item, found ${added.length}`];
  const problems = itemProblems(item, expected);
  // Everything else is the newest prior items, carried over with unchanged version, URL, length, signature and minimum OS.
  const kept = next.filter((other) => other.version !== expected.version).sort(newestFirst);
  const carried = [...previous].sort(newestFirst).slice(0, MAXIMUM_VERSIONS - 1);
  if (JSON.stringify(kept) !== JSON.stringify(carried)) {
    const versions = (items: readonly AppcastItem[]): string =>
      items.map((other) => other.version).join(', ') || 'none';
    problems.push(`prior items changed: feed keeps ${versions(kept)}, expected ${versions(carried)} unchanged`);
  }
  return problems;
}

/** Sparkle's EdDSA signature is Ed25519 over the archive bytes, checked against the app's SUPublicEDKey. */
export async function verifyEdSignature(
  bytes: Uint8Array<ArrayBuffer>,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'base64'), bytes);
}
