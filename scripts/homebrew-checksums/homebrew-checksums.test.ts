import { expect, test } from 'bun:test';

import { buildHomebrewChecksums } from './homebrew-checksums';

const packages = ['cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64'];
const version = '9.8.7';
const checksums = Object.fromEntries(
  packages.map((pkg) => [pkg, new Bun.CryptoHasher('sha256').update(pkg).digest('hex')]),
);
const manifest = packages.map((pkg) => `${checksums[pkg]}  ${pkg}-${version}.tgz\n`).join('');

test('uses the published manifest checksums for all four Formula URLs', () => {
  expect(buildHomebrewChecksums({ packages, version, manifest })).toEqual({
    version,
    checksums,
  });
});

test('rejects missing, corrupt, duplicate, or wrong-version checksums', () => {
  for (const invalid of [
    '',
    manifest.replace(checksums[packages[0]!]!, 'invalid'),
    manifest + manifest,
    manifest.replaceAll(version, '9.8.6'),
  ]) {
    expect(() => buildHomebrewChecksums({ packages, version, manifest: invalid })).toThrow();
  }
});

test('rejects an empty platform set', () => {
  expect(() => buildHomebrewChecksums({ packages: [], version, manifest })).toThrow('nothing to pin');
});
