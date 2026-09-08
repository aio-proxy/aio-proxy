import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const nativeDist = join(packageRoot, 'dist', 'native');
const requiredInputs = [
  'CLOUDKIT_TEAM_ID',
  'CLOUDKIT_SIGN_IDENTITY',
  'CLOUDKIT_PROFILE_PATH',
  'CLOUDKIT_CONTAINER_ID',
  'CLOUDKIT_NOTARY_PROFILE',
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

function stringArray(value: PlistValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectValue(value: PlistValue | undefined): { readonly [key: string]: PlistValue } {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const entitlements = objectValue(profile.Entitlements);
  const profileTeam = stringValue(profile.TeamIdentifier) ?? stringArray(profile.TeamIdentifier)[0];
  const entitlementTeam = stringValue(entitlements['com.apple.developer.team-identifier']);
  const applicationIdentifier = stringValue(entitlements['application-identifier']);
  const expectedApplicationIdentifier = `${teamId}.dev.aioproxy`;
  if (profileTeam !== undefined && profileTeam !== teamId)
    throw new Error('Signing profile team does not match CLOUDKIT_TEAM_ID');
  if (entitlementTeam !== teamId || applicationIdentifier !== expectedApplicationIdentifier) {
    throw new Error('Signing profile application identity does not match dev.aioproxy');
  }
  if (!stringArray(entitlements['com.apple.developer.icloud-container-identifiers']).includes(containerId)) {
    throw new Error('Signing profile does not permit CLOUDKIT_CONTAINER_ID');
  }
  if (!stringArray(entitlements['com.apple.developer.icloud-services']).includes('CloudKit')) {
    throw new Error('Signing profile does not permit CloudKit');
  }
  const environment = stringValue(entitlements['com.apple.developer.icloud-container-environment']);
  if (environment !== 'Development' && environment !== 'Production') {
    throw new Error('Signing profile has no supported CloudKit environment');
  }
  return { environment };
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('CloudKit signing requires macOS');
  for (const tool of ['codesign', 'plutil', 'security', 'xcrun', 'ditto', 'spctl']) {
    if (Bun.which(tool) === null) throw new Error(`Required signing tool is missing: ${tool}`);
  }
  const teamId = requiredValue('CLOUDKIT_TEAM_ID');
  const signingIdentity = requiredValue('CLOUDKIT_SIGN_IDENTITY');
  const profilePath = requiredValue('CLOUDKIT_PROFILE_PATH');
  const containerId = requiredValue('CLOUDKIT_CONTAINER_ID');
  const notaryProfile = requiredValue('CLOUDKIT_NOTARY_PROFILE');
  if (!containerId.startsWith('iCloud.')) throw new Error('CLOUDKIT_CONTAINER_ID must start with iCloud.');

  const manifestPath = join(nativeDist, 'manifest.json');
  if (!(await Bun.file(manifestPath).exists()))
    throw new Error('Native build manifest is missing; run build-native.ts first');
  const manifest = (await Bun.file(manifestPath).json()) as {
    readonly artifactVersion?: unknown;
    readonly appRelativePath?: unknown;
    readonly bundleIdentifier?: unknown;
  };
  if (
    manifest.artifactVersion === undefined ||
    typeof manifest.appRelativePath !== 'string' ||
    manifest.bundleIdentifier !== 'dev.aioproxy'
  ) {
    throw new Error('Native build manifest is invalid');
  }
  const appPath = resolve(packageRoot, manifest.appRelativePath);
  const executablePath = join(appPath, 'Contents', 'MacOS', 'AIOProxyCloudKit');
  const infoPath = join(appPath, 'Contents', 'Info.plist');
  if (!(await Bun.file(executablePath).exists()) || !(await Bun.file(infoPath).exists())) {
    throw new Error('Native app bundle is incomplete');
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'aio-cloudkit-sign-'));
  try {
    const { environment } = await validateProfile(profilePath, teamId, containerId, tempRoot);
    const info = await decodePlist(infoPath, tempRoot);
    if (stringValue(info.CFBundleIdentifier) !== 'dev.aioproxy')
      throw new Error('Native bundle identifier is not dev.aioproxy');
    const entitlementsPath = join(tempRoot, 'cloudkit.entitlements');
    await writeFile(
      entitlementsPath,
      entitlementsXml({
        applicationIdentifier: `${teamId}.dev.aioproxy`,
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
    await run('codesign', ['--display', '--entitlements', ':-', appPath]);

    const archivePath = join(nativeDist, `AIOProxyCloudKit-${String(manifest.artifactVersion)}.app.zip`);
    await run('ditto', ['-c', '-k', '--keepParent', appPath, archivePath]);
    const notary = await run('xcrun', [
      'notarytool',
      'submit',
      archivePath,
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
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);

    const signedManifest = {
      ...manifest,
      signing: {
        teamId,
        bundleIdentifier: 'dev.aioproxy',
        containerId,
        environment,
        signatureStatus: 'verified',
        notarizationStatus: 'accepted',
      },
      archiveRelativePath: archivePath.slice(packageRoot.length + 1),
    };
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
