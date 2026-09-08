import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureNativeArtifact, type NativeManifest } from './native-artifact';
import { withArtifactFixture } from './test-support';

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

test('installs a verified staged bundle and preserves it when extraction is interrupted', async () => {
  await withArtifactFixture(async (fixture) => {
    const hooks = {
      verifyBundle: async () => undefined,
      extractArchive: async (archivePath: string, stagingRoot: string) => {
        await Bun.$`unzip -q ${archivePath} -d ${stagingRoot}`;
      },
    };
    const installed = await ensureNativeArtifact({
      ...fixture,
      signal: new AbortController().signal,
      hooks,
    });
    expect(await Bun.file(installed.executable).exists()).toBe(true);
    const interrupted = new AbortController();
    interrupted.abort();
    await expect(ensureNativeArtifact({ ...fixture, signal: interrupted.signal, hooks })).rejects.toThrow();
    expect(await Bun.file(installed.executable).exists()).toBe(true);
  });
});

test('keeps the previous version when activation fails', async () => {
  await withArtifactFixture(async (fixture) => {
    const previousExecutable = join(
      fixture.cacheRoot,
      '1.0.0',
      'AIOProxyCloudKit.app',
      'Contents',
      'MacOS',
      'AIOProxyCloudKit',
    );
    await mkdir(join(fixture.cacheRoot, '1.0.0', 'AIOProxyCloudKit.app', 'Contents', 'MacOS'), { recursive: true });
    await writeFile(previousExecutable, 'previous');
    const controller = new AbortController();
    await expect(
      ensureNativeArtifact({
        ...fixture,
        manifest: { ...fixture.manifest, nativeVersion: '2.0.0' },
        signal: controller.signal,
        hooks: {
          verifyBundle: async () => undefined,
          extractArchive: async () => {
            throw new Error('interrupted extraction');
          },
        },
      }),
    ).rejects.toThrow('interrupted extraction');
    expect(await Bun.file(previousExecutable).text()).toBe('previous');
  });
});

test('rejects symlink escape and verifier identity failures before activation', async () => {
  await withArtifactFixture(async (fixture) => {
    const linkedArchive = join(fixture.packageRoot, 'native', 'linked.zip');
    await symlink(fixture.archivePath, linkedArchive);
    await expect(
      ensureNativeArtifact({
        ...fixture,
        manifest: { ...fixture.manifest, archive: 'native/linked.zip' },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });
    await expect(
      ensureNativeArtifact({
        ...fixture,
        signal: new AbortController().signal,
        hooks: {
          verifyBundle: async () => {
            throw new Error('wrong team or bundle');
          },
        },
      }),
    ).rejects.toThrow('wrong team or bundle');
    expect(
      await Bun.file(
        join(fixture.cacheRoot, '1.0.0', 'AIOProxyCloudKit.app', 'Contents', 'MacOS', 'AIOProxyCloudKit'),
      ).exists(),
    ).toBe(false);
  });
});

test('rejects installation on unsupported operating systems', async () => {
  if (process.platform === 'darwin') return;
  await withArtifactFixture(async (fixture) => {
    await expect(ensureNativeArtifact({ ...fixture, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
