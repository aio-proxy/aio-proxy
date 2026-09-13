import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

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

async function inspectPackedNative(archiveName: string): Promise<{
  readonly packageJson: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly archive: Uint8Array;
}> {
  const destination = await mkdtemp(join(tmpdir(), 'aio-cloudkit-tarball-'));
  try {
    await $`bun pm pack --destination ${destination}`.cwd(join(import.meta.dir, '..'));
    const [tarball] = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: destination, absolute: true }));
    if (tarball === undefined) throw new Error('CloudKit test pack produced no tarball');
    const files = await new Bun.Archive(await Bun.file(tarball).bytes()).files();
    const packageFile = files.get('package/package.json');
    const manifestFile = files.get('package/dist/native/manifest.json');
    const archiveFile = files.get(`package/dist/native/${archiveName}`);
    if (packageFile === undefined || manifestFile === undefined || archiveFile === undefined)
      throw new Error('CloudKit tarball omitted native package files');
    return {
      packageJson: (await packageFile.json()) as Record<string, unknown>,
      manifest: (await manifestFile.json()) as Record<string, unknown>,
      archive: await archiveFile.bytes(),
    };
  } finally {
    await rm(destination, { recursive: true, force: true });
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
        APPLE_CLOUDKIT_SIGNED_ARCHIVE: archive,
        APPLE_CLOUDKIT_SIGNED_MANIFEST: signedManifest,
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_CLOUDKIT_NATIVE_VERSION: version,
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
    const packed = await inspectPackedNative(archive.split('/').at(-1)!);
    expect(packed.packageJson.peerDependencies).toEqual({ '@aio-proxy/plugin-sdk': version });
    expect(packed.manifest).toMatchObject({
      archive: `dist/native/AIOProxyCloudKit-${version}.app.zip`,
      sha256: digest,
      signatureStatus: 'verified',
      notarizationStatus: 'accepted',
      signing: { teamId: 'TEAM123', bundleIdentifier: 'dev.aioproxy' },
    });
    expect(createHash('sha256').update(packed.archive).digest('hex')).toBe(digest);
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
        APPLE_CLOUDKIT_SIGNED_ARCHIVE: archive,
        APPLE_CLOUDKIT_SIGNED_MANIFEST: undefined,
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_CLOUDKIT_NATIVE_VERSION: version,
      },
      () => packNative(),
    );
    expect(manifest).toMatchObject({ signatureStatus: 'unsigned', notarizationStatus: 'unverified' });
    const packed = await inspectPackedNative(archive.split('/').at(-1)!);
    expect(packed.manifest).toMatchObject({
      signatureStatus: 'unsigned',
      notarizationStatus: 'unverified',
      archive: `dist/native/AIOProxyCloudKit-${version}.app.zip`,
    });
    expect(createHash('sha256').update(packed.archive).digest('hex')).toBe(manifest.sha256);
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
          APPLE_CLOUDKIT_SIGNED_ARCHIVE: archive,
          APPLE_CLOUDKIT_SIGNED_MANIFEST: signedManifest,
          APPLE_TEAM_ID: 'TEAM123',
          APPLE_CLOUDKIT_NATIVE_VERSION: version,
        },
        () => packNative(),
      ),
    ).rejects.toThrow('verified, notarized');
  } finally {
    await rm(join(import.meta.dir, '..', 'dist', 'native'), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
