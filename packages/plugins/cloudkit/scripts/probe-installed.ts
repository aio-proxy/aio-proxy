import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const nativeDist = join(packageRoot, 'dist', 'native');
const expectedBundleId = 'dev.aioproxy';
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

type NativeManifest = {
  readonly artifactVersion: string;
  readonly bundleIdentifier: string;
  readonly appRelativePath: string;
  readonly executableRelativePath?: string;
  readonly signatureStatus?: string;
  readonly notarizationStatus?: string;
  readonly signing?: {
    readonly teamId?: string;
    readonly containerId?: string;
    readonly environment?: string;
    readonly signatureStatus?: string;
    readonly notarizationStatus?: string;
  };
};

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
      !record.identityId.startsWith('sha256:') ||
      record.bundleId !== expectedBundleId
    ) {
      throw new Error('Native probe success response is invalid');
    }
    return {
      ok: true,
      account: 'available',
      identityId: record.identityId,
      bundleId: expectedBundleId,
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

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > limit) throw new Error('Native probe output exceeded its bound');
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function runProbe(
  executable: string,
  containerId: string,
): Promise<{ readonly result: ProbeResult; readonly exitCode: number }> {
  const child = Bun.spawn([executable, '--probe'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(`${JSON.stringify({ containerId, expectedBundleId })}\n`);
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([
    readBounded(child.stdout, 1024 * 1024),
    readBounded(child.stderr, 1024 * 1024),
  ]);
  void stderr;
  const exitCode = await child.exited;
  if (stdout.trim() === '') {
    return { result: { ok: false, error: { code: 'unsupported' } }, exitCode };
  }
  if (exitCode !== 0) return { result: { ok: false, error: { code: 'unsupported' } }, exitCode };
  return { result: parseProbeResult(stdout), exitCode };
}

async function verifyBundle(appPath: string, signed: boolean): Promise<void> {
  const infoPath = join(appPath, 'Contents', 'Info.plist');
  if (!(await Bun.file(infoPath).exists())) throw new Error('Installed native bundle is missing Info.plist');
  const infoProcess = Bun.spawn(['plutil', '-convert', 'json', '-o', '-', '--', infoPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [infoOutput, infoError] = await Promise.all([
    new Response(infoProcess.stdout).text(),
    new Response(infoProcess.stderr).text(),
  ]);
  if ((await infoProcess.exited) !== 0) {
    void infoError;
    throw new Error('Installed native bundle Info.plist cannot be decoded');
  }
  const info = JSON.parse(infoOutput) as { readonly CFBundleIdentifier?: unknown };
  if (info.CFBundleIdentifier !== expectedBundleId) throw new Error('Installed native bundle identifier is invalid');
  if (!signed) return;
  const child = Bun.spawn(['codesign', '--verify', '--strict', '--verbose=2', appPath], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) {
    void stderr;
    throw new Error('Installed native bundle signature verification failed');
  }
}

async function stageBundle(manifest: NativeManifest): Promise<string> {
  const dataRoot = process.env.AIO_PROXY_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'aio-proxy');
  const cacheRoot =
    process.env.AIO_PROXY_CLOUDKIT_CACHE_DIR ?? join(dataRoot, 'plugins', '@aio-proxy/plugin-cloudkit', 'native');
  const versionRoot = join(cacheRoot, manifest.artifactVersion);
  const stagingRoot = join(cacheRoot, `.staging-${manifest.artifactVersion}-${crypto.randomUUID()}`);
  await mkdir(cacheRoot, { recursive: true });
  await cp(resolve(packageRoot, manifest.appRelativePath), join(stagingRoot, 'AIOProxyCloudKit.app'), {
    recursive: true,
  });
  await rm(versionRoot, { force: true, recursive: true });
  await rename(stagingRoot, versionRoot);
  return join(versionRoot, 'AIOProxyCloudKit.app');
}

function evidence(
  manifest: NativeManifest,
  containerId: string,
  direct: ProbeResult | { readonly status: string },
  signatureStatus: string,
  directExitCode?: number,
) {
  return {
    host: { os: process.platform, architecture: process.arch },
    bundleVersion: manifest.artifactVersion,
    teamId: manifest.signing?.teamId ?? 'unverified',
    bundleId: expectedBundleId,
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
  const containerId = process.env.CLOUDKIT_CONTAINER_ID;
  if (containerId === undefined || containerId.trim() === '')
    throw new Error('Missing probe input: CLOUDKIT_CONTAINER_ID');
  const manifestPath = join(nativeDist, 'manifest.json');
  if (!(await Bun.file(manifestPath).exists()))
    throw new Error('Native build manifest is missing; run build-native.ts first');
  const manifest = (await Bun.file(manifestPath).json()) as NativeManifest;
  if (manifest.bundleIdentifier !== expectedBundleId || typeof manifest.artifactVersion !== 'string') {
    throw new Error('Native build manifest is invalid');
  }
  const signed = manifest.signing?.signatureStatus === 'verified' || manifest.signatureStatus === 'verified';
  const installedApp = await stageBundle(manifest);
  await verifyBundle(installedApp, signed);
  const executable = join(installedApp, 'Contents', 'MacOS', 'AIOProxyCloudKit');
  const direct = await runProbe(executable, containerId);
  const output = JSON.stringify(
    evidence(manifest, containerId, direct.result, signed ? 'verified' : 'unsigned', direct.exitCode),
    null,
    2,
  );
  const evidencePath = process.env.CLOUDKIT_EVIDENCE_PATH;
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
