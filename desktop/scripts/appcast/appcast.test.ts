import { describe, expect, test } from 'bun:test';

import {
  type AppcastItem,
  feedAction,
  feedProblems,
  feedState,
  ownsLatestDownload,
  parseAppcast,
  publicKeyFromPrivate,
  verifyEdSignature,
} from './appcast';

const prefix = 'https://github.com/aio-proxy/aio-proxy/releases/download';
const item = (version: string, extra: Partial<AppcastItem> = {}): AppcastItem => ({
  version,
  url: `${prefix}/v${version}/aio-proxy-${version}-arm64.dmg`,
  length: 42_290_000,
  edSignature: `sig-${version}`,
  minimumSystemVersion: '13.0',
  ...extra,
});

const generated = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>AIO Proxy</title>
        <item>
            <title>0.37.0</title>
            <sparkle:version>0.37.0</sparkle:version>
            <sparkle:shortVersionString>0.37.0</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${prefix}/v0.37.0/aio-proxy-0.37.0-arm64.dmg" length="42290185" type="application/octet-stream" sparkle:edSignature="q6S4/0pU9ViJ=="/>
        </item>
        <item>
            <title>0.36.0</title>
            <sparkle:version>0.36.0</sparkle:version>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <enclosure url="${prefix}/v0.36.0/aio-proxy-0.36.0-arm64.dmg" length="42290114" type="application/octet-stream"/>
        </item>
    </channel>
</rss>`;

describe('parseAppcast', () => {
  test('reads version, enclosure, signature and minimum OS from generate_appcast output', () => {
    expect(parseAppcast(generated)).toEqual([
      {
        version: '0.37.0',
        url: `${prefix}/v0.37.0/aio-proxy-0.37.0-arm64.dmg`,
        length: 42_290_185,
        edSignature: 'q6S4/0pU9ViJ==',
        minimumSystemVersion: '13.0',
      },
      {
        version: '0.36.0',
        url: `${prefix}/v0.36.0/aio-proxy-0.36.0-arm64.dmg`,
        length: 42_290_114,
        minimumSystemVersion: '13.0',
      },
    ]);
  });

  test('an item without an enclosure fails the parse instead of vanishing', () => {
    expect(() => parseAppcast('<item><sparkle:version>1.0.0</sparkle:version></item>')).toThrow('enclosure');
  });
});

describe('feedState', () => {
  test('only a definite "release not found" means there is no feed yet', () => {
    expect(feedState(1, '', 'release not found\n')).toBe('missing-release');
  });

  test('any other gh failure stops the job instead of starting a fresh feed', () => {
    expect(() => feedState(1, '', 'HTTP 502: Bad Gateway')).toThrow('502');
  });

  test('a release without appcast.xml is empty; with it, present', () => {
    expect(feedState(0, '{"assets":[]}', '')).toBe('empty');
    expect(feedState(0, '{"assets":[{"name":"appcast.xml"}]}', '')).toBe('present');
  });
});

describe('feedAction', () => {
  const previous = [item('0.37.0'), item('0.36.0')];

  test('a version newer than everything in the feed is published', () => {
    expect(feedAction(previous, '0.38.0')).toEqual({ kind: 'publish' });
  });

  test('a version already in the feed is re-verified, not regenerated', () => {
    expect(feedAction(previous, '0.36.0')).toEqual({ kind: 'already-published', item: item('0.36.0') });
  });

  test('resuming an older tag after a newer release does not add it', () => {
    expect(feedAction(previous, '0.36.5')).toEqual({ kind: 'superseded', newest: '0.37.0' });
  });
});

describe('ownsLatestDownload', () => {
  const previous = [item('0.37.0'), item('0.36.0')];

  test('a new newest version and a resumed newest version replace the download', () => {
    expect(ownsLatestDownload(previous, '0.38.0')).toBe(true);
    expect(ownsLatestDownload(previous, '0.37.0')).toBe(true);
  });

  test('resuming an older tag never downgrades the download', () => {
    expect(ownsLatestDownload(previous, '0.36.0')).toBe(false);
    expect(ownsLatestDownload(previous, '0.36.5')).toBe(false);
  });
});

describe('feedProblems', () => {
  const previous = [item('0.37.0'), item('0.36.0'), item('0.35.0')];
  const expected = { version: '0.38.0', url: item('0.38.0').url, length: 42_290_000 };

  test('accepts the new item plus the two newest prior items, unchanged', () => {
    const next = [item('0.38.0'), item('0.37.0'), item('0.36.0')];
    expect(feedProblems({ ...expected, previous, next })).toEqual([]);
  });

  test('an unsigned enclosure (private key does not match SUPublicEDKey) is refused', () => {
    const { edSignature: _, ...unsigned } = item('0.38.0');
    const problems = feedProblems({ ...expected, previous, next: [unsigned, item('0.37.0'), item('0.36.0')] });
    expect(problems.join('\n')).toContain('sparkle:edSignature');
  });

  test('a dropped or rewritten prior item is refused', () => {
    const rewritten = item('0.37.0', { url: 'https://example.test/other.dmg' });
    expect(feedProblems({ ...expected, previous, next: [item('0.38.0'), rewritten, item('0.36.0')] })).not.toEqual([]);
    expect(feedProblems({ ...expected, previous, next: [item('0.38.0'), item('0.37.0')] })).not.toEqual([]);
  });

  test('a wrong download URL, length or minimum OS on the new item is refused', () => {
    const next = [item('0.38.0', { url: 'https://example.test/x.dmg', length: 1, minimumSystemVersion: '14.0' })];
    const problems = feedProblems({ ...expected, previous: [], next });
    expect(problems).toHaveLength(3);
  });
});

describe('verifyEdSignature', () => {
  test('verifies Sparkle EdDSA signatures over the archive bytes against the base64 public key', async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
    const bytes = new TextEncoder().encode('dmg bytes');
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)).toString('base64');
    expect(await verifyEdSignature(bytes, signature, publicKey)).toBe(true);
    const tampered = bytes.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(await verifyEdSignature(tampered, signature, publicKey)).toBe(false);
  });
});

describe('publicKeyFromPrivate', () => {
  test('derives the SUPublicEDKey from a Sparkle private key file, in the 32 and 64 byte forms', async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicRaw = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey));
    const seed = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).subarray(-32);
    const publicKey = publicRaw.toString('base64');
    expect(await publicKeyFromPrivate(seed.toString('base64'))).toBe(publicKey);
    expect(await publicKeyFromPrivate(Buffer.concat([seed, publicRaw]).toString('base64'))).toBe(publicKey);
  });

  test('anything that is not a 32 or 64 byte key is refused', async () => {
    await expect(publicKeyFromPrivate(Buffer.alloc(10).toString('base64'))).rejects.toThrow('not a base64 Ed25519 key');
  });
});
