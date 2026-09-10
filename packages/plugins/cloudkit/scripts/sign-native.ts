import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CLOUDKIT_BUNDLE_ID,
  assertNoSymlinkEscape,
  directoryDigest,
  executablePathForApp,
  sha256File,
  validateEffectiveEntitlements,
  validateManifest,
  validateProfileMetadata,
  type ArtifactManifest,
} from './artifact';

const packageRoot = resolve(import.meta.dir, '..');
const nativeDist = join(packageRoot, 'dist', 'native');
const requiredInputs = [
  'APPLE_TEAM_ID',
  'APPLE_SIGN_IDENTITY',
  'APPLE_PROFILE_PATH',
  'APPLE_CLOUDKIT_CONTAINER_ID',
  'APPLE_NOTARY_PROFILE',
] as const;

type PlistValue = string | readonly PlistValue[] | { readonly [key: string]: PlistValue };
type CommandResult = { readonly stdout: string; readonly stderr: string };

async function run(command: string, args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} failed; inspect the local signing tool diagnostics`);
  }
  return { stdout, stderr };
}

function requiredValue(name: (typeof requiredInputs)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`Missing native signing input: ${name}`);
  return value;
}

function stringValue(value: PlistValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function objectValue(value: PlistValue | undefined): { readonly [key: string]: PlistValue } {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly [key: string]: PlistValue })
    : {};
}

async function decodePlist(path: string, tempRoot: string): Promise<{ readonly [key: string]: PlistValue }> {
  const jsonPath = join(tempRoot, `${Math.random().toString(16).slice(2)}.json`);
  await run('plutil', ['-convert', 'json', '-o', jsonPath, '--', path]);
  return objectValue(JSON.parse(await readFile(jsonPath, 'utf8')) as PlistValue);
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function entitlementsXml(input: {
  readonly applicationIdentifier: string;
  readonly teamId: string;
  readonly containerId: string;
  readonly environment: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>${escapeXml(input.applicationIdentifier)}</string>
<key>com.apple.developer.team-identifier</key><string>${escapeXml(input.teamId)}</string>
<key>com.apple.developer.icloud-container-identifiers</key><array><string>${escapeXml(input.containerId)}</string></array>
<key>com.apple.developer.icloud-container-environment</key><string>${escapeXml(input.environment)}</string>
<key>com.apple.developer.icloud-services</key><array><string>CloudKit</string></array>
</dict></plist>
`;
}

async function validateProfile(
  profilePath: string,
  teamId: string,
  containerId: string,
  tempRoot: string,
): Promise<{ readonly environment: string }> {
  const decodedPath = join(tempRoot, 'profile.plist');
  await run('security', ['cms', '-D', '-i', profilePath, '-o', decodedPath]);
  const profile = await decodePlist(decodedPath, tempRoot);
  return validateProfileMetadata(profile, { teamId, containerId, bundleId: CLOUDKIT_BUNDLE_ID });
}

async function validateDeveloperIdIdentity(identity: string, teamId: string): Promise<void> {
  const identities = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const match = identities.stdout
    .split(/\r?\n/u)
    .find((line) => line.includes(identity) && line.includes('Developer ID Application:'));
  if (match === undefined || !match.includes(`(${teamId})`)) {
    throw new Error('APPLE_SIGN_IDENTITY is not a Developer ID Application identity for APPLE_TEAM_ID');
  }
}

async function validateEffectiveSigning(
  appPath: string,
  teamId: string,
  containerId: string,
  environment: string,
  tempRoot: string,
): Promise<void> {
  const display = await run('codesign', ['--display', '--entitlements', ':-', appPath]);
  const entitlementsXml = display.stdout.includes('<plist') ? display.stdout : display.stderr;
  if (!entitlementsXml.includes('<plist')) throw new Error('Signed bundle did not expose effective entitlements');
  const entitlementsPath = join(tempRoot, 'effective-entitlements.plist');
  await writeFile(entitlementsPath, entitlementsXml);
  const entitlements = objectValue(await decodePlist(entitlementsPath, tempRoot));
  validateEffectiveEntitlements(entitlements, {
    teamId,
    containerId,
    bundleId: CLOUDKIT_BUNDLE_ID,
    environment,
  });
  const details = await run('codesign', ['--display', '--verbose=4', appPath]);
  if (!details.stderr.includes(`TeamIdentifier=${teamId}`) && !details.stdout.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error('Signed bundle team identifier does not match APPLE_TEAM_ID');
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('CloudKit signing requires macOS');
  for (const tool of ['codesign', 'plutil', 'security', 'xcrun', 'ditto', 'spctl']) {
    if (Bun.which(tool) === null) throw new Error(`Required signing tool is missing: ${tool}`);
  }
  const teamId = requiredValue('APPLE_TEAM_ID');
  const signingIdentity = requiredValue('APPLE_SIGN_IDENTITY');
  const profilePath = requiredValue('APPLE_PROFILE_PATH');
  const containerId = requiredValue('APPLE_CLOUDKIT_CONTAINER_ID');
  const notaryProfile = requiredValue('APPLE_NOTARY_PROFILE');
  if (!containerId.startsWith('iCloud.')) throw new Error('APPLE_CLOUDKIT_CONTAINER_ID must start with iCloud.');
  await validateDeveloperIdIdentity(signingIdentity, teamId);

  const manifestPath = join(nativeDist, 'manifest.json');
  if (!(await Bun.file(manifestPath).exists()))
    throw new Error('Native build manifest is missing; run build-native.ts first');
  const manifest = (await Bun.file(manifestPath).json()) as ArtifactManifest;
  if (
    typeof manifest.artifactVersion !== 'string' ||
    typeof manifest.appRelativePath !== 'string' ||
    manifest.bundleIdentifier !== CLOUDKIT_BUNDLE_ID
  ) {
    throw new Error('Native build manifest is invalid');
  }
  validateManifest(manifest);
  const appPath = resolve(packageRoot, manifest.appRelativePath);
  const executablePath = executablePathForApp(manifest, appPath);
  await assertNoSymlinkEscape(packageRoot, appPath, 'app');
  await assertNoSymlinkEscape(appPath, executablePath, 'executable');
  const infoPath = join(appPath, 'Contents', 'Info.plist');
  if (!(await Bun.file(executablePath).exists()) || !(await Bun.file(infoPath).exists())) {
    throw new Error('Native app bundle is incomplete');
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'aio-cloudkit-sign-'));
  try {
    const { environment } = await validateProfile(profilePath, teamId, containerId, tempRoot);
    const info = await decodePlist(infoPath, tempRoot);
    if (stringValue(info.CFBundleIdentifier) !== CLOUDKIT_BUNDLE_ID)
      throw new Error('Native bundle identifier is not dev.aioproxy');
    const entitlementsPath = join(tempRoot, 'cloudkit.entitlements');
    await writeFile(
      entitlementsPath,
      entitlementsXml({
        applicationIdentifier: `${teamId}.${CLOUDKIT_BUNDLE_ID}`,
        teamId,
        containerId,
        environment,
      }),
    );
    await writeFile(join(appPath, 'Contents', 'embedded.provisionprofile'), await readFile(profilePath));
    await run('codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      '--sign',
      signingIdentity,
      executablePath,
    ]);
    await run('codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      '--sign',
      signingIdentity,
      appPath,
    ]);
    await run('codesign', ['--verify', '--strict', '--verbose=2', appPath]);
    await validateEffectiveSigning(appPath, teamId, containerId, environment, tempRoot);

    const submissionArchivePath = join(
      nativeDist,
      `AIOProxyCloudKit-${String(manifest.artifactVersion)}.submission.zip`,
    );
    await run('ditto', ['-c', '-k', '--keepParent', appPath, submissionArchivePath]);
    const notary = await run('xcrun', [
      'notarytool',
      'submit',
      submissionArchivePath,
      '--keychain-profile',
      notaryProfile,
      '--wait',
      '--output-format',
      'json',
    ]);
    let status: unknown;
    try {
      status = (JSON.parse(notary.stdout) as { readonly status?: unknown }).status;
    } catch {
      status = undefined;
    }
    if (status !== 'Accepted') throw new Error('CloudKit notarization did not reach Accepted');
    await run('xcrun', ['stapler', 'staple', appPath]);
    await run('xcrun', ['stapler', 'validate', appPath]);
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    const archivePath = join(nativeDist, `AIOProxyCloudKit-${String(manifest.artifactVersion)}.app.zip`);
    await run('ditto', ['-c', '-k', '--keepParent', appPath, archivePath]);

    const signedManifest = {
      ...manifest,
      executableSha256: await sha256File(executablePath),
      appSha256: await directoryDigest(appPath),
      archiveRelativePath: archivePath.slice(packageRoot.length + 1),
      archiveSha256: await sha256File(archivePath),
      signatureStatus: 'verified',
      notarizationStatus: 'accepted',
      signing: {
        teamId,
        bundleIdentifier: CLOUDKIT_BUNDLE_ID,
        containerId,
        environment,
        signatureStatus: 'verified',
        notarizationStatus: 'accepted',
      },
    } satisfies ArtifactManifest;
    validateManifest(signedManifest);
    await writeFile(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CloudKit signing failed');
    process.exitCode = 1;
  });
}
