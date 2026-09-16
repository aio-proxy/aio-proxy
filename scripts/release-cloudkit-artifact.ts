// The CloudKit backend is the one package whose payload is not produced by `bun run build`: the
// native bundle is built, signed and notarized by the macOS release job before scripts/release.ts
// runs, and the JS build then wipes the dist tree it lands in. This module restores that exact
// archive into the publishable package and verifies it — digest, version, team and notarization —
// so a release fails closed rather than shipping a backend that cannot connect.

import { createHash } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';

import { $ } from 'bun';

type CloudKitRuntimeManifest = {
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
  readonly signing?: {
    readonly teamId?: string;
    readonly bundleIdentifier?: string;
    readonly signatureStatus?: string;
    readonly notarizationStatus?: string;
  };
};

type CloudKitSignedManifest = {
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

export async function prepareCloudKitArtifact(packageRoot: string, releaseVersion: string): Promise<void> {
  const signedArchive = process.env['APPLE_CLOUDKIT_SIGNED_ARCHIVE'];
  if (signedArchive === undefined || signedArchive.trim() === '') {
    throw new Error('APPLE_CLOUDKIT_SIGNED_ARCHIVE is required for a CloudKit release');
  }
  const teamId = process.env['APPLE_TEAM_ID'];
  if (teamId === undefined || teamId.trim() === '') throw new Error('APPLE_TEAM_ID is required for a CloudKit release');
  const signedArchivePath = resolve(signedArchive);
  if (!(await Bun.file(signedArchivePath).exists())) {
    throw new Error('APPLE_CLOUDKIT_SIGNED_ARCHIVE does not point to an existing signed artifact');
  }
  const signedManifest = process.env['APPLE_CLOUDKIT_SIGNED_MANIFEST'];
  if (signedManifest === undefined || signedManifest.trim() === '') {
    throw new Error('APPLE_CLOUDKIT_SIGNED_MANIFEST is required for a CloudKit release');
  }
  const signedManifestPath = resolve(signedManifest);
  if (!(await Bun.file(signedManifestPath).exists())) {
    throw new Error('APPLE_CLOUDKIT_SIGNED_MANIFEST does not point to an existing artifact manifest');
  }
  const archiveDigest = createHash('sha256')
    .update(await Bun.file(signedArchivePath).bytes())
    .digest('hex');
  const signedJson: unknown = await Bun.file(signedManifestPath).json();
  const signedValue =
    signedJson !== null && typeof signedJson === 'object' && !Array.isArray(signedJson)
      ? (signedJson as Partial<CloudKitSignedManifest>)
      : undefined;
  if (
    signedValue === undefined ||
    signedValue.artifactVersion !== releaseVersion ||
    signedValue.signatureStatus !== 'verified' ||
    signedValue.notarizationStatus !== 'accepted' ||
    signedValue.archiveSha256 !== archiveDigest ||
    typeof signedValue.archiveRelativePath !== 'string' ||
    basename(signedValue.archiveRelativePath) !== basename(signedArchivePath) ||
    signedValue.signing?.teamId !== teamId ||
    signedValue.signing?.bundleIdentifier !== 'dev.aioproxy' ||
    signedValue.signing?.signatureStatus !== 'verified' ||
    signedValue.signing?.notarizationStatus !== 'accepted'
  ) {
    throw new Error('APPLE_CLOUDKIT_SIGNED_MANIFEST is not a verified, notarized artifact for this release');
  }
  process.env['APPLE_CLOUDKIT_NATIVE_VERSION'] ??= releaseVersion;
  process.env['APPLE_CLOUDKIT_SIGNED_MANIFEST'] = signedManifestPath;
  await $`bun run --filter @aio-proxy/plugin-cloudkit pack-native`;

  const manifestPath = join(packageRoot, 'dist', 'native', 'manifest.json');
  if (!(await Bun.file(manifestPath).exists())) throw new Error('CloudKit native manifest is missing after packaging');
  const manifest = (await Bun.file(manifestPath).json()) as Partial<CloudKitRuntimeManifest>;
  if (
    manifest.format !== 1 ||
    manifest.pluginVersion !== releaseVersion ||
    manifest.nativeVersion !== releaseVersion ||
    manifest.bundleId !== 'dev.aioproxy' ||
    manifest.minimumMacOS !== '14.0' ||
    manifest.teamId !== teamId ||
    typeof manifest.archive !== 'string' ||
    !manifest.archive.endsWith('.app.zip') ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
    manifest.signatureStatus !== 'verified' ||
    manifest.notarizationStatus !== 'accepted' ||
    manifest.signing?.teamId !== teamId ||
    manifest.signing?.bundleIdentifier !== 'dev.aioproxy' ||
    manifest.signing?.signatureStatus !== 'verified' ||
    manifest.signing?.notarizationStatus !== 'accepted'
  ) {
    throw new Error('CloudKit native manifest does not match the lockstep signed release');
  }
  const archivePath = resolve(packageRoot, manifest.archive);
  const archiveRelative = relative(resolve(packageRoot), archivePath);
  if (archiveRelative.startsWith('..') || resolve(packageRoot, archiveRelative) !== archivePath) {
    throw new Error('CloudKit native archive path escapes the package');
  }
  if (basename(archivePath) !== basename(signedArchivePath) || !(await Bun.file(archivePath).exists())) {
    throw new Error('CloudKit native archive is missing from the package payload');
  }
  const digest = createHash('sha256')
    .update(await Bun.file(archivePath).bytes())
    .digest('hex');
  if (digest !== manifest.sha256) throw new Error('CloudKit native archive digest does not match its manifest');
}

export async function shouldPrepareCloudKitArtifact(releaseVersion: string): Promise<boolean> {
  const override = process.env['APPLE_CLOUDKIT_RELEASE_REQUIRED'];
  if (override === 'true') return true;
  if (override === 'false') return false;
  // Same exact-version probe as the publish loop and the workflow gate: the dist-tag
  // does not follow a prerelease, so it cannot answer whether this version is published.
  const published = await $`npm view ${`@aio-proxy/plugin-cloudkit@${releaseVersion}`} version`.nothrow().quiet();
  return published.exitCode !== 0 || published.text().trim() !== releaseVersion;
}
