import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');

export function nativeArchivePath(outputName: string): string {
  return `dist/native/${outputName}`;
}

type SignedManifest = {
  readonly artifactVersion: string;
  readonly archiveRelativePath: string;
  readonly archiveSha256: string;
  readonly signatureStatus: string;
  readonly notarizationStatus: string;
  readonly signing?: {
    readonly teamId?: string;
    readonly bundleIdentifier?: string;
    readonly signatureStatus?: string;
    readonly notarizationStatus?: string;
  };
};

export type RuntimeManifest = {
  readonly format: 1;
  readonly pluginVersion: string;
  readonly nativeVersion: string;
  readonly bundleId: 'dev.aioproxy';
  readonly teamId: string;
  readonly minimumMacOS: '14.0';
  readonly archive: string;
  readonly sha256: string;
  readonly signatureStatus: 'verified' | 'unsigned';
  readonly notarizationStatus: 'accepted' | 'unverified';
  readonly signing?: SignedManifest['signing'];
};

export function validateRuntimeManifestForProduction(manifest: RuntimeManifest, teamId: string): void {
  if (
    manifest.signatureStatus !== 'verified' ||
    manifest.notarizationStatus !== 'accepted' ||
    manifest.signing?.teamId !== teamId ||
    manifest.signing?.bundleIdentifier !== 'dev.aioproxy' ||
    manifest.signing?.signatureStatus !== 'verified' ||
    manifest.signing?.notarizationStatus !== 'accepted'
  ) {
    throw new Error('CloudKit runtime manifest is not verified and notarized for production');
  }
}

function validateSignedManifest(
  value: unknown,
  archiveName: string,
  digest: string,
  version: string,
  teamId: string,
): SignedManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CLOUDKIT_SIGNED_MANIFEST is not a JSON object');
  }
  const manifest = value as Partial<SignedManifest>;
  if (
    manifest.artifactVersion !== version ||
    manifest.signatureStatus !== 'verified' ||
    manifest.notarizationStatus !== 'accepted' ||
    manifest.archiveSha256 !== digest ||
    typeof manifest.archiveRelativePath !== 'string' ||
    basename(manifest.archiveRelativePath) !== archiveName ||
    manifest.signing?.teamId !== teamId ||
    manifest.signing?.bundleIdentifier !== 'dev.aioproxy' ||
    manifest.signing?.signatureStatus !== 'verified' ||
    manifest.signing?.notarizationStatus !== 'accepted'
  ) {
    throw new Error('CLOUDKIT_SIGNED_MANIFEST is not a verified, notarized artifact manifest');
  }
  return manifest as SignedManifest;
}

export async function packNative(): Promise<RuntimeManifest> {
  const archive = process.env.CLOUDKIT_SIGNED_ARCHIVE;
  if (archive === undefined || archive.trim() === '') {
    throw new Error('CLOUDKIT_SIGNED_ARCHIVE is required; refusing to package an unsigned native artifact');
  }
  const teamId = process.env.CLOUDKIT_TEAM_ID;
  if (teamId === undefined || teamId.trim() === '') throw new Error('CLOUDKIT_TEAM_ID is required');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') throw new Error('CloudKit package version is missing');
  const outputRoot = join(packageRoot, 'dist', 'native');
  await mkdir(outputRoot, { recursive: true });
  const outputName = basename(archive);
  const output = join(outputRoot, outputName);
  const bytes = await Bun.file(archive).bytes();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signedManifestPath = process.env.CLOUDKIT_SIGNED_MANIFEST;
  const signed =
    signedManifestPath === undefined || signedManifestPath.trim() === ''
      ? undefined
      : validateSignedManifest(
          JSON.parse(await readFile(signedManifestPath, 'utf8')) as unknown,
          outputName,
          digest,
          packageJson.version,
          teamId,
        );
  await copyFile(archive, output);
  const manifest: RuntimeManifest = {
    format: 1 as const,
    pluginVersion: packageJson.version,
    nativeVersion: process.env.CLOUDKIT_NATIVE_VERSION ?? packageJson.version,
    bundleId: 'dev.aioproxy' as const,
    teamId,
    minimumMacOS: '14.0' as const,
    archive: nativeArchivePath(outputName),
    sha256: digest,
    signatureStatus: signed === undefined ? 'unsigned' : 'verified',
    notarizationStatus: signed === undefined ? 'unverified' : 'accepted',
    ...(signed?.signing === undefined ? {} : { signing: signed.signing }),
  };
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) await packNative();
