import { expect, test } from 'bun:test';

import { trustedComment, type UpdateTarget } from '../minisign';
import { assetName } from '../package/index';
import { assetUrl, buildLatestJson, feedCandidates, parseLatestJson, pickFeedVersion, TARGETS } from './latest-json';

const minisig = (version: string, target: UpdateTarget) =>
  `untrusted comment: signature\nabc\ntrusted comment: ${trustedComment(version, target, assetName(target, version))}\ndef\n`;
const feed = (version: string) =>
  new Map(TARGETS.map((t) => [t, { url: assetUrl(version, t), minisig: minisig(version, t) }]));
const allThree = feed('0.40.0');

test('latest.json lists every target in the updater format', () => {
  const json = JSON.parse(buildLatestJson('0.40.0', allThree));
  expect(json.version).toBe('0.40.0');
  expect(Object.keys(json.platforms).sort()).toEqual([...TARGETS].sort());
  expect(json.platforms['windows-x86_64'].format).toBe('nsis');
  expect(json.platforms['linux-aarch64'].format).toBe('appimage');
  expect(Buffer.from(json.platforms['linux-x86_64'].signature, 'base64').toString()).toStartWith('untrusted comment: ');
});

test('a missing platform refuses to build the feed', () => {
  const withoutWindows = new Map(allThree);
  withoutWindows.delete('windows-x86_64');
  expect(() => buildLatestJson('0.40.0', withoutWindows)).toThrow(/windows-x86_64/);
});

test('malformed feed text parses to undefined', () => {
  expect(parseLatestJson('{nope')).toBeUndefined();
  expect(parseLatestJson('[]')).toBeUndefined();
  expect(parseLatestJson(buildLatestJson('0.40.0', allThree))).toEqual({ version: '0.40.0', complete: true });
});

test('the feed takes the highest complete version, whatever run executes last', () => {
  const releases = [
    { version: '0.42.0', complete: false },
    { version: '0.41.0', complete: true },
    { version: '0.40.0', complete: true },
    { version: '0.44.0-rc.1', complete: true },
  ];
  expect(pickFeedVersion('0.40.0', releases)).toBe('0.41.0');
  expect(pickFeedVersion('0.41.0', releases)).toBeUndefined();
  expect(pickFeedVersion('0.43.0', releases)).toBeUndefined();
  expect(pickFeedVersion(undefined, releases)).toBe('0.41.0');
});

test('candidates are the stable tags above the feed, highest first', () => {
  const tags = ['v0.39.0', 'v0.41.0', 'desktop-feed', 'v0.42.0-beta.1', 'v0.40.0', 'v0.40.1'];
  expect(feedCandidates('0.40.0', tags)).toEqual(['0.41.0', '0.40.1']);
  expect(feedCandidates(undefined, tags)).toEqual(['0.41.0', '0.40.1', '0.40.0', '0.39.0']);
  expect(feedCandidates('0.41.0', tags)).toEqual([]);
});

test('a current feed missing a target is incomplete, and may be rewritten at its own version but not below', () => {
  const full = buildLatestJson('0.40.0', allThree);
  expect(parseLatestJson(full)).toEqual({ version: '0.40.0', complete: true });
  const broken = JSON.stringify({
    version: '0.40.0',
    platforms: { 'linux-x86_64': JSON.parse(full).platforms['linux-x86_64'] },
  });
  expect(parseLatestJson(broken)).toEqual({ version: '0.40.0', complete: false });
  const releases = [
    { version: '0.40.0', complete: true },
    { version: '0.39.0', complete: true },
  ];
  expect(pickFeedVersion('0.40.0', releases)).toBeUndefined();
  expect(pickFeedVersion('0.40.0', releases, true)).toBe('0.40.0');
  expect(pickFeedVersion('0.41.0', releases, true)).toBeUndefined();
  expect(feedCandidates('0.40.0', ['v0.40.0', 'v0.39.0'], true)).toEqual(['0.40.0']);
});

test('a current feed entry that publish-latest would not write is incomplete', () => {
  const full = JSON.parse(buildLatestJson('0.40.0', allThree));
  const withEntry = (patch: Record<string, unknown>) =>
    JSON.stringify({
      ...full,
      platforms: { ...full.platforms, 'windows-x86_64': { ...full.platforms['windows-x86_64'], ...patch } },
    });
  const signature: string = full.platforms['windows-x86_64'].signature;
  const otherVersion = buildLatestJson('0.40.0', feed('0.39.0'));
  for (const text of [
    withEntry({ url: 'https://example.com/aio-proxy-0.40.0-x64-setup.exe' }),
    withEntry({ url: assetUrl('0.39.0', 'windows-x86_64') }),
    withEntry({ signature: signature.slice(0, signature.length / 2) }),
    withEntry({ signature: Buffer.from('untrusted comment: x\nabc\n').toString('base64') }),
    withEntry({ signature: JSON.parse(otherVersion).platforms['windows-x86_64'].signature }),
  ]) {
    expect(parseLatestJson(text)).toEqual({ version: '0.40.0', complete: false });
  }
  expect(parseLatestJson(otherVersion)).toEqual({ version: '0.40.0', complete: false });
});
