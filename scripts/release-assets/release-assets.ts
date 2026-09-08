import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

import { buildHomebrewChecksums } from '../homebrew-checksums';

const REPOSITORY = 'aio-proxy/aio-proxy';

/** Existing attachments are immutable here: a rebuilt tarball must never silently replace a released one. */
export async function uploadReleaseAssets({
  directory,
  version,
  packages,
  list = async () => {
    const result = await $`gh release view ${`v${version}`} --repo ${REPOSITORY} --json assets`.quiet();
    return (JSON.parse(result.text()) as { assets: { name: string }[] }).assets.map((asset) => asset.name);
  },
  upload = async (name) => {
    await $`gh release upload ${`v${version}`} ${join(directory, name)} --repo ${REPOSITORY}`;
  },
  read = async (name) => {
    const temporary = await mkdtemp(join(tmpdir(), 'release-asset-'));
    try {
      await $`gh release download ${`v${version}`} --repo ${REPOSITORY} --pattern ${name} --dir ${temporary}`.quiet();
      return await Bun.file(join(temporary, name)).bytes();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
}: {
  directory: string;
  version: string;
  packages: readonly string[];
  list?: () => Promise<string[]>;
  upload?: (name: string) => Promise<void>;
  read?: (name: string) => Promise<Uint8Array>;
}): Promise<void> {
  const payload = await buildHomebrewChecksums({ directory, version, packages });
  const filenames = packages.map((pkg) => `${pkg}-${version}.tgz`);
  await Bun.write(
    join(directory, 'SHA256SUMS'),
    packages.map((pkg, i) => `${payload.checksums[pkg]}  ${filenames[i]}\n`).join(''),
  );
  const existing = new Set(await list());
  // Validate all existing files before uploading anything, including a prior manifest.
  for (const name of [...filenames, 'SHA256SUMS']) {
    if (!existing.has(name)) continue;
    const local = new Bun.CryptoHasher('sha256').update(await Bun.file(join(directory, name)).bytes()).digest('hex');
    const remote = new Bun.CryptoHasher('sha256').update(await read(name)).digest('hex');
    if (local !== remote)
      throw new Error(
        `Release asset ${name} already exists with different bytes; reuse the original workflow artifact`,
      );
  }
  // Manifest last: its presence means every platform upload has completed.
  for (const name of [...filenames, 'SHA256SUMS']) {
    if (!existing.has(name)) await upload(name);
  }
}
