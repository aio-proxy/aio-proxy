import { expect, test } from 'bun:test';

import { buildLatestJson, feedCandidates, parseLatestJson, pickFeedVersion, TARGETS } from './latest-json';

const minisig = 'untrusted comment: signature\nabc\ntrusted comment: t\ndef\n';
const entry = (t: string) => ({ url: `https://example.com/${t}`, minisig });
const allThree = new Map(TARGETS.map((t) => [t, entry(t)]));

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
  expect(parseLatestJson(buildLatestJson('0.40.0', allThree))).toEqual({ version: '0.40.0' });
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
