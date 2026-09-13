import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NativeManifest } from './native-artifact';

export async function withArtifactFixture(
  action: (fixture: {
    packageRoot: string;
    cacheRoot: string;
    archivePath: string;
    manifest: NativeManifest;
    launched: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-artifact-'));
  const packageRoot = join(root, 'package');
  const cacheRoot = join(root, 'cache');
  const app = join(packageRoot, 'native', 'AIOProxyCloudKit.app', 'Contents', 'MacOS');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'AIOProxyCloudKit'), '#!/bin/sh\n');
  const archivePath = join(packageRoot, 'native', 'artifact.zip');
  await Bun.$`cd ${join(packageRoot, 'native')} && zip -q -r ${archivePath} AIOProxyCloudKit.app`;
  const archive = await Bun.file(archivePath).bytes();
  const manifest: NativeManifest = {
    format: 1,
    pluginVersion: '1.0.0',
    nativeVersion: '1.0.0',
    bundleId: 'dev.aioproxy',
    teamId: 'TESTTEAM',
    minimumMacOS: '14.0',
    archive: 'native/artifact.zip',
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
  try {
    await action({ packageRoot, cacheRoot, archivePath, manifest, launched: () => false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
