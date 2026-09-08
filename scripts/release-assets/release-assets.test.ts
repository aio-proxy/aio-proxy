import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uploadReleaseAssets } from './release-assets';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'release-assets-'));
  directories.push(directory);
  await Bun.write(join(directory, 'cli-darwin-arm64-9.8.7.tgz'), 'original tarball');
  return directory;
}

test('resumes a partial upload without replacing existing bytes and publishes checksums last', async () => {
  const directory = await fixture();
  const uploads: string[] = [];
  await uploadReleaseAssets({
    directory,
    version: '9.8.7',
    packages: ['cli-darwin-arm64'],
    list: async () => ['cli-darwin-arm64-9.8.7.tgz'],
    read: async () => new TextEncoder().encode('original tarball'),
    upload: async (name) => {
      uploads.push(name);
    },
  });
  expect(uploads).toEqual(['SHA256SUMS']);
  expect(await Bun.file(join(directory, 'SHA256SUMS')).text()).toBe(
    `${new Bun.CryptoHasher('sha256').update('original tarball').digest('hex')}  cli-darwin-arm64-9.8.7.tgz\n`,
  );
});

test('refuses conflicting existing assets before publishing a checksum manifest', async () => {
  const uploads: string[] = [];
  await expect(
    uploadReleaseAssets({
      directory: await fixture(),
      version: '9.8.7',
      packages: ['cli-darwin-arm64'],
      list: async () => ['cli-darwin-arm64-9.8.7.tgz'],
      read: async () => new TextEncoder().encode('different build'),
      upload: async (name) => {
        uploads.push(name);
      },
    }),
  ).rejects.toThrow('different bytes');
  expect(uploads).toEqual([]);
});

test('does not publish checksums when a tarball upload fails', async () => {
  const uploads: string[] = [];
  await expect(
    uploadReleaseAssets({
      directory: await fixture(),
      version: '9.8.7',
      packages: ['cli-darwin-arm64'],
      list: async () => [],
      read: async () => new Uint8Array(),
      upload: async (name) => {
        uploads.push(name);
        throw new Error('upload failed');
      },
    }),
  ).rejects.toThrow('upload failed');
  expect(uploads).toEqual(['cli-darwin-arm64-9.8.7.tgz']);
});
