import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  readonly appSha256: string;
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
  if (!/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.artifactVersion)) {
    throw new Error('Native manifest artifact version is unsafe');
  }
  if (manifest.bundleIdentifier !== CLOUDKIT_BUNDLE_ID) throw new Error('Native manifest bundle identifier is invalid');
  if (
    !Array.isArray(manifest.architectures) ||
    manifest.architectures.length !== 2 ||
    !manifest.architectures.includes('arm64') ||
    !manifest.architectures.includes('x86_64')
  ) {
    throw new Error('Native manifest is not universal');
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.executableSha256))
    throw new Error('Native manifest executable digest is invalid');
  if (!/^[a-f0-9]{64}$/u.test(manifest.appSha256)) {
    throw new Error('Native manifest app digest is invalid');
  }
  if (manifest.archiveSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(manifest.archiveSha256)) {
    throw new Error('Native manifest archive digest is invalid');
  }
  validateRelativePath(manifest.appRelativePath, 'app');
  validateRelativePath(manifest.executableRelativePath, 'executable');
  const executableFromApp = relative(resolve(manifest.appRelativePath), resolve(manifest.executableRelativePath));
  if (
    executableFromApp === '' ||
    executableFromApp === '.' ||
    executableFromApp.startsWith('..') ||
    isAbsolute(executableFromApp)
  ) {
    throw new Error('Native manifest executable is outside the app bundle');
  }
  if (manifest.archiveRelativePath !== undefined) validateRelativePath(manifest.archiveRelativePath, 'archive');
  const signing = manifest.signing;
  const final = manifest.signatureStatus === 'verified' || signing !== undefined;
  if (final) {
    if (manifest.archiveRelativePath === undefined || manifest.archiveSha256 === undefined || signing === undefined) {
      throw new Error('Signed native manifest is missing final artifact binding');
    }
    if (
      manifest.signatureStatus !== 'verified' ||
      manifest.notarizationStatus !== 'accepted' ||
      signing.signatureStatus !== 'verified' ||
      signing.notarizationStatus !== 'accepted' ||
      signing.bundleIdentifier !== CLOUDKIT_BUNDLE_ID
    ) {
      throw new Error('Signed native manifest has invalid signing status');
    }
  }
}

export function validateRelativePath(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]/u).some((part) => part === '..')
  ) {
    throw new Error(`Native manifest ${label} path is unsafe`);
  }
}

export function assertPathInside(root: string, target: string, label: string): void {
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, resolve(target));
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Native ${label} path escapes its root`);
  }
}

export async function assertNoSymlinkEscape(root: string, target: string, label: string): Promise<void> {
  assertPathInside(root, target, label);
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rootEntry = await lstat(rootPath);
  if (rootEntry.isSymbolicLink()) throw new Error(`Native ${label} path contains a symlink`);
  let current = rootPath;
  const relativePath = relative(rootPath, targetPath);
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Native ${label} path contains a symlink`);
  }
}

export function executablePathForApp(manifest: ArtifactManifest, appRoot: string): string {
  const executableFromApp = relative(resolve(manifest.appRelativePath), resolve(manifest.executableRelativePath));
  return join(appRoot, executableFromApp);
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
