import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nativeArchivePath, packNative, validateRuntimeManifestForProduction } from '../scripts/pack-native';

async function withCloudKitEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the package exposes the lazy CloudKit descriptor entry point', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(packageJson.name).toBe('@aio-proxy/plugin-cloudkit');
  expect(packageJson.private).toBeUndefined();
  expect(packageJson.exports['.'].default).toBe('./dist/index.js');
  expect(nativeArchivePath('CloudKit.app.zip')).toBe('dist/native/CloudKit.app.zip');
  expect(packageJson.dependencies?.['@aio-proxy/plugin-sdk']).toBeUndefined();
  expect(packageJson.peerDependencies?.['@aio-proxy/plugin-sdk']).toBe('workspace:*');
  expect(packageJson.devDependencies?.['@aio-proxy/plugin-sdk']).toBe('workspace:*');
});

test('packs verified signing and notarization metadata into the runtime manifest', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const version = packageJson.version as string;
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-pack-'));
  const archive = join(root, `AIOProxyCloudKit-${version}.app.zip`);
  const bytes = new TextEncoder().encode('signed-native-archive');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signedManifest = join(root, 'signed-manifest.json');
  await writeFile(archive, bytes);
  await writeFile(
    signedManifest,
    JSON.stringify({
      artifactVersion: version,
      archiveRelativePath: `dist/native/${archive.split('/').at(-1)}`,
      archiveSha256: digest,
      signatureStatus: 'verified',
      notarizationStatus: 'accepted',
      signing: {
        teamId: 'TEAM123',
        bundleIdentifier: 'dev.aioproxy',
        signatureStatus: 'verified',
        notarizationStatus: 'accepted',
      },
    }),
  );
  try {
    const manifest = await withCloudKitEnvironment(
      {
        CLOUDKIT_SIGNED_ARCHIVE: archive,
        CLOUDKIT_SIGNED_MANIFEST: signedManifest,
        CLOUDKIT_TEAM_ID: 'TEAM123',
        CLOUDKIT_NATIVE_VERSION: version,
      },
      () => packNative(),
    );
    expect(manifest).toMatchObject({
      pluginVersion: version,
      nativeVersion: version,
      signatureStatus: 'verified',
      notarizationStatus: 'accepted',
      signing: { teamId: 'TEAM123', bundleIdentifier: 'dev.aioproxy' },
    });
    expect(
      createHash('sha256')
        .update(await readFile(join(import.meta.dir, '..', 'dist/native', archive.split('/').at(-1)!)))
        .digest('hex'),
    ).toBe(digest);
    validateRuntimeManifestForProduction(manifest, 'TEAM123');
  } finally {
    await rm(join(import.meta.dir, '..', 'dist', 'native'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('marks unsigned development artifacts as non-production', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const version = packageJson.version as string;
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-pack-'));
  const archive = join(root, `AIOProxyCloudKit-${version}.app.zip`);
  await writeFile(archive, 'unsigned-development-archive');
  try {
    const manifest = await withCloudKitEnvironment(
      {
        CLOUDKIT_SIGNED_ARCHIVE: archive,
        CLOUDKIT_SIGNED_MANIFEST: undefined,
        CLOUDKIT_TEAM_ID: 'TEAM123',
        CLOUDKIT_NATIVE_VERSION: version,
      },
      () => packNative(),
    );
    expect(manifest).toMatchObject({ signatureStatus: 'unsigned', notarizationStatus: 'unverified' });
    expect(() => validateRuntimeManifestForProduction(manifest, 'TEAM123')).toThrow('production');
  } finally {
    await rm(join(import.meta.dir, '..', 'dist', 'native'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a signed manifest without accepted notarization', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const version = packageJson.version as string;
  const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-pack-'));
  const archive = join(root, `AIOProxyCloudKit-${version}.app.zip`);
  const bytes = new TextEncoder().encode('signed-native-archive');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signedManifest = join(root, 'signed-manifest.json');
  await writeFile(archive, bytes);
  await writeFile(
    signedManifest,
    JSON.stringify({
      artifactVersion: version,
      archiveRelativePath: `dist/native/${archive.split('/').at(-1)}`,
      archiveSha256: digest,
      signatureStatus: 'verified',
      notarizationStatus: 'unverified',
      signing: { teamId: 'TEAM123', bundleIdentifier: 'dev.aioproxy' },
    }),
  );
  try {
    await expect(
      withCloudKitEnvironment(
        {
          CLOUDKIT_SIGNED_ARCHIVE: archive,
          CLOUDKIT_SIGNED_MANIFEST: signedManifest,
          CLOUDKIT_TEAM_ID: 'TEAM123',
          CLOUDKIT_NATIVE_VERSION: version,
        },
        () => packNative(),
      ),
    ).rejects.toThrow('verified, notarized');
  } finally {
    await rm(join(import.meta.dir, '..', 'dist', 'native'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
