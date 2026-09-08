import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHomebrewChecksums } from './homebrew-checksums';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'homebrew-checksums-'));
  directories.push(directory);
  return directory;
}

test('hashes the original local tarballs without consulting npm', async () => {
  const directory = await fixture();
  const packages = ['cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64'];
  for (const pkg of packages) await Bun.write(join(directory, `${pkg}-9.8.7.tgz`), `packed-${pkg}`);
  const result = await buildHomebrewChecksums({ directory, packages, version: '9.8.7' });
  expect(result).toEqual({
    version: '9.8.7',
    source: 'github-release',
    checksums: Object.fromEntries(
      packages.map((pkg) => [pkg, new Bun.CryptoHasher('sha256').update(`packed-${pkg}`).digest('hex')]),
    ),
  });
});

test('rejects incomplete artifacts instead of notifying with partial checksums', async () => {
  const directory = await fixture();
  await Bun.write(join(directory, 'cli-darwin-arm64-9.8.6.tgz'), 'old version');
  await expect(
    buildHomebrewChecksums({ directory, packages: ['cli-darwin-arm64'], version: '9.8.7' }),
  ).rejects.toThrow();
});

test('rejects an empty platform set', async () => {
  await expect(buildHomebrewChecksums({ directory: await fixture(), packages: [], version: '9.8.7' })).rejects.toThrow(
    'nothing to pin',
  );
});
