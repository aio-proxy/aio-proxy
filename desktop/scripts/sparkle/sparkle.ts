import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { $ } from 'bun';

export const SPARKLE_VERSION = '2.10.0';
export const SPARKLE_SHA256 = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';
const ARCHIVE = `Sparkle-${SPARKLE_VERSION}.tar.xz`;
const URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/${ARCHIVE}`;

const sha256 = async (path: string): Promise<string> =>
  new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');

/**
 * Downloads (once) and verifies the pinned Sparkle archive, then extracts it with `tar -xJf` so the
 * framework's symlinks survive. Returns the directory holding `Sparkle.framework` and `bin/`.
 */
export async function fetchSparkle(vendorDir: string): Promise<string> {
  mkdirSync(vendorDir, { recursive: true });
  const archive = join(vendorDir, ARCHIVE);
  if (!existsSync(archive)) {
    const response = await fetch(URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`download ${URL}: HTTP ${response.status}`);
    await Bun.write(archive, response);
  }
  const actual = await sha256(archive);
  if (actual !== SPARKLE_SHA256) {
    throw new Error(`${archive}: SHA-256 ${actual}, expected ${SPARKLE_SHA256}. Delete it and retry.`);
  }
  const dir = join(vendorDir, `sparkle-${SPARKLE_VERSION}`);
  if (!existsSync(join(dir, 'Sparkle.framework'))) {
    mkdirSync(dir, { recursive: true });
    await $`tar -xJf ${archive} -C ${dir}`;
  }
  return dir;
}
