import { cp, lstat, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  CLOUDKIT_BUNDLE_ID,
  assertNoSymlinkEscape,
  assertPathInside,
  directoryDigest,
  executablePathForApp,
  sha256File,
  spawnText,
  validateEffectiveEntitlements,
  validateManifest,
  validateProfileMetadata,
  type ArtifactManifest,
  type CommandResult,
} from './artifact';

const packageRoot = resolve(import.meta.dir, '..');
const nativeDist = join(packageRoot, 'dist', 'native');
const failureCodes = new Set([
  'offline',
  'quota',
  'identity-changed',
  'cancelled',
  'unauthorized',
  'unsupported',
  'outcome-unknown',
  'invalid-data',
]);

type ProbeSuccess = {
  readonly ok: true;
  readonly account: 'available';
  readonly identityId: string;
  readonly bundleId: string;
};
type ProbeFailure = { readonly ok: false; readonly error: { readonly code: string } };
export type ProbeResult = ProbeSuccess | ProbeFailure;

async function run(command: string, args: readonly string[]): Promise<CommandResult> {
  const result = await spawnText(command, args);
  if (result.exitCode !== 0) throw new Error(`${command} failed; inspect local artifact diagnostics`);
  return result;
}

export function parseProbeResult(output: string): ProbeResult {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error('Native probe did not return JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native probe did not return a structured result');
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (
      record.account !== 'available' ||
      typeof record.identityId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(record.identityId) ||
      record.bundleId !== CLOUDKIT_BUNDLE_ID
    ) {
      throw new Error('Native probe success response is invalid');
    }
    return {
      ok: true,
      account: 'available',
      identityId: record.identityId,
      bundleId: CLOUDKIT_BUNDLE_ID,
    };
  }
  if (record.ok === false && record.error !== null && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.code === 'string' && failureCodes.has(error.code)) {
      return { ok: false, error: { code: error.code } };
    }
  }
  throw new Error('Native probe returned an invalid structured probe error');
}

// A wedged native binary must not be able to exhaust this process's memory, so cap each pipe.
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Native probe output exceeded its bound');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function runProbe(
  executable: string,
  containerId: string,
): Promise<{ readonly result: ProbeResult; readonly exitCode: number }> {
  const child = Bun.spawn([executable, '--probe'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(`${JSON.stringify({ containerId, expectedBundleId: CLOUDKIT_BUNDLE_ID })}\n`);
  child.stdin.end();
  const [stdout] = await Promise.all([readBounded(child.stdout, 1024 * 1024), readBounded(child.stderr, 1024 * 1024)]);
  const exitCode = await child.exited;
  if (exitCode !== 0 || stdout.trim() === '') {
    return { result: { ok: false, error: { code: 'unsupported' } }, exitCode };
  }
  return { result: parseProbeResult(stdout), exitCode };
}

async function decodePlist(path: string, tempRoot: string): Promise<Record<string, unknown>> {
  const jsonPath = join(tempRoot, `${crypto.randomUUID()}.json`);
  await run('plutil', ['-convert', 'json', '-o', jsonPath, '--', path]);
  const value = (await Bun.file(jsonPath).json()) as unknown;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function verifyBundle(appPath: string, manifest: ArtifactManifest, signed: boolean): Promise<void> {
  validateManifest(manifest);
  await assertNoSymlinkEscape(dirname(appPath), appPath, 'installed app');
  const infoPath = join(appPath, 'Contents', 'Info.plist');
  if (!(await Bun.file(infoPath).exists())) throw new Error('Installed native bundle is missing Info.plist');
  const decoded = await spawnText('plutil', ['-convert', 'json', '-o', '-', '--', infoPath]);
  if (decoded.exitCode !== 0) throw new Error('Installed native bundle Info.plist cannot be decoded');
  const info = JSON.parse(decoded.stdout) as {
    readonly CFBundleIdentifier?: unknown;
    readonly LSMinimumSystemVersion?: unknown;
  };
  if (info.CFBundleIdentifier !== CLOUDKIT_BUNDLE_ID) throw new Error('Installed native bundle identifier is invalid');
  const minimumSystem = Number.parseFloat(String(info.LSMinimumSystemVersion ?? '0'));
  if (!Number.isFinite(minimumSystem) || minimumSystem < 14)
    throw new Error('Installed bundle has an invalid macOS deployment floor');
  const executable = executablePathForApp(manifest, appPath);
  await assertNoSymlinkEscape(appPath, executable, 'installed executable');
  if ((await sha256File(executable)) !== manifest.executableSha256)
    throw new Error('Installed executable digest does not match manifest');
  if ((await directoryDigest(appPath)) !== manifest.appSha256) {
    throw new Error('Installed app digest does not match manifest');
  }
  const architectureOutput = await run('lipo', ['-archs', executable]);
  const architectures = architectureOutput.stdout.trim().split(/\s+/u).filter(Boolean).sort();
  if (architectures.join(',') !== [...manifest.architectures].sort().join(',')) {
    throw new Error('Installed executable architectures do not match manifest');
  }
  if (!signed) return;
  if (
    manifest.archiveRelativePath === undefined ||
    manifest.archiveSha256 === undefined ||
    manifest.signing === undefined
  ) {
    throw new Error('Signed manifest is missing final artifact binding');
  }
  if (manifest.signing.bundleIdentifier !== CLOUDKIT_BUNDLE_ID || manifest.notarizationStatus !== 'accepted') {
    throw new Error('Signed manifest has invalid notarization or bundle status');
  }
  const archivePath = resolve(packageRoot, manifest.archiveRelativePath);
  await assertNoSymlinkEscape(packageRoot, archivePath, 'archive');
  if ((await sha256File(archivePath)) !== manifest.archiveSha256)
    throw new Error('Signed archive digest does not match manifest');
  await run('codesign', ['--verify', '--strict', '--verbose=2', appPath]);
  const details = await run('codesign', ['--display', '--verbose=4', appPath]);
  if (
    !details.stderr.includes(`TeamIdentifier=${manifest.signing.teamId}`) &&
    !details.stdout.includes(`TeamIdentifier=${manifest.signing.teamId}`)
  ) {
    throw new Error('Installed bundle team does not match manifest');
  }
  const tempRoot = await mkdtemp(join(homedir(), 'aio-cloudkit-verify-'));
  try {
    const effective = await run('codesign', ['--display', '--entitlements', ':-', appPath]);
    const entitlementsPath = join(tempRoot, 'effective.entitlements');
    await writeFile(entitlementsPath, effective.stdout.includes('<plist') ? effective.stdout : effective.stderr);
    const entitlements = await decodePlist(entitlementsPath, tempRoot);
    validateEffectiveEntitlements(entitlements, {
      teamId: manifest.signing.teamId,
      containerId: manifest.signing.containerId,
      bundleId: CLOUDKIT_BUNDLE_ID,
      environment: manifest.signing.environment,
    });
    const embeddedProfile = join(appPath, 'Contents', 'embedded.provisionprofile');
    if (!(await Bun.file(embeddedProfile).exists()))
      throw new Error('Signed bundle is missing embedded provisioning profile');
    const decodedProfile = join(tempRoot, 'profile.plist');
    await run('security', ['cms', '-D', '-i', embeddedProfile, '-o', decodedProfile]);
    const profile = await decodePlist(decodedProfile, tempRoot);
    const profileResult = validateProfileMetadata(profile, {
      teamId: manifest.signing.teamId,
      containerId: manifest.signing.containerId,
      bundleId: CLOUDKIT_BUNDLE_ID,
    });
    if (profileResult.environment !== manifest.signing.environment) {
      throw new Error('Embedded provisioning profile environment does not match manifest');
    }
    await run('xcrun', ['stapler', 'validate', appPath]);
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function stageBundle(
  manifest: ArtifactManifest,
): Promise<{ readonly appPath: string; readonly stagingRoot: string; readonly versionRoot: string }> {
  const dataRoot = process.env.AIO_PROXY_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'aio-proxy');
  const cacheRoot =
    process.env.AIO_PROXY_CLOUDKIT_CACHE_DIR ?? join(dataRoot, 'plugins', '@aio-proxy/plugin-cloudkit', 'native');
  const versionRoot = join(cacheRoot, manifest.artifactVersion);
  const stagingRoot = join(cacheRoot, `.staging-${manifest.artifactVersion}-${crypto.randomUUID()}`);
  const sourceApp = resolve(packageRoot, manifest.appRelativePath);
  assertPathInside(packageRoot, sourceApp, 'source app');
  await assertNoSymlinkEscape(packageRoot, sourceApp, 'source app');
  await mkdir(cacheRoot, { recursive: true });
  await assertNoSymlinkEscape(dirname(cacheRoot), cacheRoot, 'cache root');
  assertPathInside(cacheRoot, versionRoot, 'version root');
  assertPathInside(cacheRoot, stagingRoot, 'staging root');
  try {
    await lstat(versionRoot);
    await assertNoSymlinkEscape(cacheRoot, versionRoot, 'version root');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await cp(sourceApp, join(stagingRoot, 'AIOProxyCloudKit.app'), {
    recursive: true,
  });
  await assertNoSymlinkEscape(cacheRoot, stagingRoot, 'staging root');
  return { appPath: join(stagingRoot, 'AIOProxyCloudKit.app'), stagingRoot, versionRoot };
}

export async function swapInstallation(
  stagingRoot: string,
  versionRoot: string,
  renameFn: typeof rename = rename,
): Promise<void> {
  let existing = true;
  try {
    await stat(versionRoot);
  } catch {
    existing = false;
  }
  if (!existing) {
    await renameFn(stagingRoot, versionRoot);
    return;
  }
  const backupRoot = `${versionRoot}.previous-${crypto.randomUUID()}`;
  await renameFn(versionRoot, backupRoot);
  try {
    await renameFn(stagingRoot, versionRoot);
  } catch (error) {
    await renameFn(backupRoot, versionRoot);
    throw error;
  }
  await rm(backupRoot, { force: true, recursive: true });
}

function evidence(
  manifest: ArtifactManifest,
  containerId: string,
  direct: ProbeResult | { readonly status: string },
  signatureStatus: string,
  osVersion: string,
  directExitCode?: number,
) {
  return {
    host: { os: process.platform, osVersion, architecture: process.arch },
    bundleVersion: manifest.artifactVersion,
    teamId: manifest.signing?.teamId ?? 'unverified',
    bundleId: CLOUDKIT_BUNDLE_ID,
    containerId,
    environment: manifest.signing?.environment ?? 'unverified',
    signatureStatus,
    notarizationStatus: manifest.signing?.notarizationStatus ?? manifest.notarizationStatus ?? 'unverified',
    directLaunch: direct,
    ...(directExitCode === undefined ? {} : { directExitCode }),
    serviceLaunch: { status: 'unverified', reason: 'run this installed path from the real launchd aio-proxy service' },
    productionGate: 'blocked',
    recordedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Installed CloudKit probing requires macOS');
  const osVersion = (await run('sw_vers', ['-productVersion'])).stdout.trim();
  if (!/^\d+(?:\.\d+){1,2}$/u.test(osVersion)) throw new Error('macOS version evidence is invalid');
  const containerId = process.env.APPLE_CLOUDKIT_CONTAINER_ID;
  if (containerId === undefined || containerId.trim() === '')
    throw new Error('Missing probe input: APPLE_CLOUDKIT_CONTAINER_ID');
  const manifestPath = join(nativeDist, 'manifest.json');
  if (!(await Bun.file(manifestPath).exists()))
    throw new Error('Native build manifest is missing; run build-native.ts first');
  const manifest = (await Bun.file(manifestPath).json()) as ArtifactManifest;
  if (manifest.bundleIdentifier !== CLOUDKIT_BUNDLE_ID || typeof manifest.artifactVersion !== 'string') {
    throw new Error('Native build manifest is invalid');
  }
  validateManifest(manifest);
  const signed = manifest.signing?.signatureStatus === 'verified' || manifest.signatureStatus === 'verified';
  const staged = await stageBundle(manifest);
  let direct: { readonly result: ProbeResult; readonly exitCode: number };
  try {
    await verifyBundle(staged.appPath, manifest, signed);
    const stagedExecutable = executablePathForApp(manifest, staged.appPath);
    direct = await runProbe(stagedExecutable, containerId);
    if (signed && !direct.result.ok) throw new Error('Signed staged native probe did not return an available account');
  } catch (error) {
    await rm(staged.stagingRoot, { force: true, recursive: true });
    throw error;
  }
  try {
    await swapInstallation(staged.stagingRoot, staged.versionRoot);
  } catch (error) {
    await rm(staged.stagingRoot, { force: true, recursive: true });
    throw error;
  }
  const output = JSON.stringify(
    evidence(manifest, containerId, direct.result, signed ? 'verified' : 'unsigned', osVersion, direct.exitCode),
    null,
    2,
  );
  const evidencePath = process.env.APPLE_CLOUDKIT_EVIDENCE_PATH;
  if (evidencePath !== undefined && evidencePath.trim() !== '') {
    await Bun.write(evidencePath, `${output}\n`);
  }
  console.log(output);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CloudKit installed probe failed');
    process.exitCode = 1;
  });
}
