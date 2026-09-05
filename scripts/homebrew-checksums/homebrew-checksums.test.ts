import { describe, expect, test } from 'bun:test';

import { buildHomebrewChecksums } from './homebrew-checksums';

const PLATFORM = '@aio-proxy/cli-darwin-arm64';
const OTHER_PLATFORM = '@aio-proxy/cli-linux-x64';
const VERSION = '9.8.7';

const bytesFor = (name: string) => new TextEncoder().encode(`tarball-of-${name}`);
const integrityFor = (name: string) =>
  `sha512-${new Bun.CryptoHasher('sha512').update(bytesFor(name)).digest('base64')}`;
const sha256For = (name: string) => new Bun.CryptoHasher('sha256').update(bytesFor(name)).digest('hex');

const build = (overrides: Partial<Parameters<typeof buildHomebrewChecksums>[0]> = {}) =>
  buildHomebrewChecksums({
    tarballs: new Map([
      [PLATFORM, `/tmp/${PLATFORM}.tgz`],
      [OTHER_PLATFORM, `/tmp/${OTHER_PLATFORM}.tgz`],
    ]),
    platformProvided: new Set([PLATFORM, OTHER_PLATFORM]),
    version: VERSION,
    readBytes: (path) => Promise.resolve(bytesFor(path.replace('/tmp/', '').replace('.tgz', ''))),
    registryIntegrity: (name) => Promise.resolve(integrityFor(name)),
    ...overrides,
  });

describe('buildHomebrewChecksums', () => {
  test('emits an unscoped-name sha256 for every platform tarball', async () => {
    const payload = await build();

    // The tap's formula keys off the unscoped package name.
    expect(payload).toEqual({
      version: VERSION,
      checksums: {
        'cli-darwin-arm64': sha256For(PLATFORM),
        'cli-linux-x64': sha256For(OTHER_PLATFORM),
      },
    });
  });

  test('ignores packages the tap does not pin', async () => {
    const payload = await build({
      tarballs: new Map([
        [PLATFORM, `/tmp/${PLATFORM}.tgz`],
        ['aio-proxy', '/tmp/launcher.tgz'],
        ['@aio-proxy/plugin-sdk', '/tmp/sdk.tgz'],
      ]),
      platformProvided: new Set([PLATFORM]),
    });

    expect(Object.keys(payload.checksums)).toEqual(['cli-darwin-arm64']);
  });

  // A resumed release skips publish for versions already on the registry, so the
  // tarball on disk is not automatically the one npm serves. Shipping a checksum
  // for the wrong bytes would make `brew install` fail for every user.
  test('refuses to ship a checksum when the registry advertises different bytes', async () => {
    const promise = build({
      registryIntegrity: (name) =>
        Promise.resolve(name === OTHER_PLATFORM ? integrityFor('something-else') : integrityFor(name)),
    });

    await expect(promise).rejects.toThrow(/cli-linux-x64@9\.8\.7: local tarball integrity .* does not match/);
  });

  test('refuses to ship a checksum when the registry advertises no integrity at all', async () => {
    const promise = build({ registryIntegrity: () => Promise.resolve('') });

    await expect(promise).rejects.toThrow(/does not match the registry's \(none\)/);
  });

  // An empty payload would dispatch a release the tap cannot build a formula for.
  test('fails when no platform tarball was packed', async () => {
    const promise = build({ platformProvided: new Set<string>() });

    await expect(promise).rejects.toThrow(/nothing to pin/);
  });
});
