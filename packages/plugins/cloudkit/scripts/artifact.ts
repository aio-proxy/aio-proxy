import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const CLOUDKIT_BUNDLE_ID = 'dev.aioproxy';
export const CLOUDKIT_SIGNING_STEPS = [
  'nested-code',
  'bundle',
  'verify',
  'archive',
  'notarize',
  'staple',
  'archive-final',
] as const;
export type CloudKitSigningStep = (typeof CLOUDKIT_SIGNING_STEPS)[number];

export type ArtifactManifest = {
  readonly artifactVersion: string;
  readonly bundleIdentifier: string;
  readonly appRelativePath: string;
  readonly executableRelativePath: string;
  readonly architectures: readonly string[];
  readonly executableSha256: string;
  readonly appSha256?: string;
  readonly archiveRelativePath?: string;
  readonly archiveSha256?: string;
  readonly signatureStatus?: string;
  readonly notarizationStatus?: string;
  readonly signing?: {
    readonly teamId: string;
    readonly bundleIdentifier: string;
    readonly containerId: string;
    readonly environment: string;
    readonly signatureStatus: string;
    readonly notarizationStatus: string;
  };
};

export type SigningProfileInput = {
  readonly teamId: string;
  readonly containerId: string;
  readonly bundleId: string;
};

export type ProfileMetadata = {
  readonly TeamIdentifier?: unknown;
  readonly Entitlements?: unknown;
  readonly Platform?: unknown;
  readonly ProvisionsAllDevices?: unknown;
  readonly ProvisionedDevices?: unknown;
  readonly ExpirationDate?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asStrings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function validateProfileMetadata(
  profile: ProfileMetadata,
  input: SigningProfileInput,
): { readonly environment: string } {
  const entitlements = asRecord(profile.Entitlements);
  const team = asString(profile.TeamIdentifier) ?? asStrings(profile.TeamIdentifier)[0];
  const entitlementTeam = asString(entitlements['com.apple.developer.team-identifier']);
  const applicationIdentifier = asString(entitlements['application-identifier']);
  if (team !== undefined && team !== input.teamId)
    throw new Error('Signing profile team does not match CLOUDKIT_TEAM_ID');
  if (entitlementTeam !== input.teamId || applicationIdentifier !== `${input.teamId}.${input.bundleId}`) {
    throw new Error('Signing profile application identity does not match the native bundle');
  }
  if (!asStrings(entitlements['com.apple.developer.icloud-container-identifiers']).includes(input.containerId)) {
    throw new Error('Signing profile does not permit CLOUDKIT_CONTAINER_ID');
  }
  if (!asStrings(entitlements['com.apple.developer.icloud-services']).includes('CloudKit')) {
    throw new Error('Signing profile does not permit CloudKit');
  }
  const environment = asString(entitlements['com.apple.developer.icloud-container-environment']);
  if (environment !== 'Development' && environment !== 'Production') {
    throw new Error('Signing profile has no supported CloudKit environment');
  }
  if (!asStrings(profile.Platform).some((platform) => platform === 'OSX' || platform === 'macOS')) {
    throw new Error('Signing profile is not a macOS profile');
  }
  if (profile.ProvisionsAllDevices !== true || profile.ProvisionedDevices !== undefined) {
    throw new Error('Signing profile is not a Developer ID distribution profile');
  }
  const expiration = profile.ExpirationDate;
  if (typeof expiration !== 'string' || Number.isNaN(Date.parse(expiration)) || Date.parse(expiration) <= Date.now()) {
    throw new Error('Signing profile is expired or has no expiration date');
  }
  if (entitlements['get-task-allow'] === true) throw new Error('Signing profile allows development debugging');
  return { environment };
}

export function validateEffectiveEntitlements(
  entitlements: Record<string, unknown>,
  input: SigningProfileInput & { readonly environment: string },
): void {
  if (entitlements['application-identifier'] !== `${input.teamId}.${input.bundleId}`) {
    throw new Error('Effective entitlements have the wrong application identifier');
  }
  if (entitlements['com.apple.developer.team-identifier'] !== input.teamId) {
    throw new Error('Effective entitlements have the wrong team identifier');
  }
  if (!asStrings(entitlements['com.apple.developer.icloud-container-identifiers']).includes(input.containerId)) {
    throw new Error('Effective entitlements have the wrong iCloud container');
  }
  if (entitlements['com.apple.developer.icloud-container-environment'] !== input.environment) {
    throw new Error('Effective entitlements have the wrong iCloud environment');
  }
  if (!asStrings(entitlements['com.apple.developer.icloud-services']).includes('CloudKit')) {
    throw new Error('Effective entitlements do not include CloudKit');
  }
}

export function validateManifest(manifest: ArtifactManifest): void {
  if (manifest.bundleIdentifier !== CLOUDKIT_BUNDLE_ID) throw new Error('Native manifest bundle identifier is invalid');
  if (
    manifest.architectures.length !== 2 ||
    !manifest.architectures.includes('arm64') ||
    !manifest.architectures.includes('x86_64')
  ) {
    throw new Error('Native manifest is not universal');
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.executableSha256))
    throw new Error('Native manifest executable digest is invalid');
  if (manifest.appSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(manifest.appSha256)) {
    throw new Error('Native manifest app digest is invalid');
  }
  if (manifest.archiveSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(manifest.archiveSha256)) {
    throw new Error('Native manifest archive digest is invalid');
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function directoryDigest(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const directory = join(root, relativePath);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`Native artifact contains unsupported entry: ${child}`);
    }
  };
  await visit('');
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  await stat(root);
  return hash.digest('hex');
}
