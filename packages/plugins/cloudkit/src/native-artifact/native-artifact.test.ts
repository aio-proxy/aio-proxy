import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureNativeArtifact, type NativeManifest } from './native-artifact';

test('rejects a changed archive before launching anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-integrity-'));
  const archivePath = join(root, 'artifact.zip');
  await writeFile(archivePath, 'original');
  const manifest: NativeManifest = {
    format: 1,
    pluginVersion: '1.0.0',
    nativeVersion: '1.0.0',
    bundleId: 'dev.aioproxy',
    teamId: 'TEAM',
    minimumMacOS: '14.0',
    archive: 'artifact.zip',
    sha256: createHash('sha256').update('different').digest('hex'),
  };
  await writeFile(archivePath, 'tampered');
  await expect(
    ensureNativeArtifact({
      packageRoot: root,
      cacheRoot: join(root, 'cache'),
      manifest,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'invalid-data' });
});

test('rejects an archive path that escapes the package root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-path-'));
  const manifest = {
    format: 1,
    pluginVersion: '1.0.0',
    nativeVersion: '1.0.0',
    bundleId: 'dev.aioproxy',
    teamId: 'TEAM',
    minimumMacOS: '14.0',
    archive: '../artifact.zip',
    sha256: '0'.repeat(64),
  } as const;
  await expect(
    ensureNativeArtifact({
      packageRoot: root,
      cacheRoot: join(root, 'cache'),
      manifest,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'invalid-data' });
});
