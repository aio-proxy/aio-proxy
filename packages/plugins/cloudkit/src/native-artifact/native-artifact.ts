import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { zod } from '@aio-proxy/plugin-sdk';

export interface NativeManifest {
  format: 1;
  pluginVersion: string;
  nativeVersion: string;
  bundleId: 'dev.aioproxy';
  teamId: string;
  minimumMacOS: '14.0';
  archive: string;
  sha256: string;
}

export const NativeManifestSchema = zod.object({
  format: zod.literal(1),
  pluginVersion: zod.string().regex(/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u),
  nativeVersion: zod.string().regex(/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u),
  bundleId: zod.literal('dev.aioproxy'),
  teamId: zod.string().trim().min(1),
  minimumMacOS: zod.literal('14.0'),
  archive: zod.string().trim().min(1),
  sha256: zod.string().regex(/^[a-f0-9]{64}$/u),
}) satisfies zod.ZodType<NativeManifest>;

export class NativeArtifactError extends Error {
  readonly code: 'invalid-data' | 'unsupported';
  readonly retryable = true as const;

  constructor(message: string, code: 'invalid-data' | 'unsupported' = 'invalid-data') {
    super(message);
    this.code = code;
  }
}

export type NativeArtifactHooks = {
  readonly verifyBundle?: (appPath: string, manifest: NativeManifest, executable: string) => Promise<void>;
  readonly extractArchive?: (archivePath: string, stagingRoot: string) => Promise<void>;
};

function inside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function safeArchiveEntry(entry: string): void {
  if (entry.includes('\0') || isAbsolute(entry) || /^[A-Za-z]:[\\/]/u.test(entry)) {
    throw new NativeArtifactError(`Native archive entry is unsafe: ${entry}`);
  }
  const normalized = entry.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new NativeArtifactError(`Native archive entry escapes staging: ${entry}`);
  }
}

async function run(command: string, args: readonly string[], cwd?: string): Promise<string> {
  const child = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0)
    throw new NativeArtifactError(`${command} rejected the native artifact: ${stderr.trim()}`);
  return stdout;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await Bun.file(path).bytes())
    .digest('hex');
}

async function rejectSymlinks(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new NativeArtifactError('Native archive contains a symlink');
    if (!entry.isDirectory()) return;
    for (const child of await readdir(path)) await visit(join(path, child));
  };
  await visit(root);
}

async function rejectSymlinkPath(root: string, target: string): Promise<void> {
  let current = resolve(root);
  const parts = relative(current, resolve(target)).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => null);
    if (entry?.isSymbolicLink()) throw new NativeArtifactError('Native artifact path contains a symlink');
  }
}

async function verifyBundle(appPath: string, manifest: NativeManifest, executable: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new NativeArtifactError('CloudKit native artifacts require macOS 14 or later', 'unsupported');
  }
  const executableStat = await stat(executable).catch(() => null);
  if (executableStat === null || !executableStat.isFile())
    throw new NativeArtifactError('Native executable is missing');
  const info = await run('plutil', ['-convert', 'json', '-o', '-', '--', join(appPath, 'Contents', 'Info.plist')]);
  const parsed = JSON.parse(info) as Record<string, unknown>;
  if (parsed.CFBundleIdentifier !== manifest.bundleId)
    throw new NativeArtifactError('Native bundle identifier is invalid');
  if (parsed.CFBundleVersion !== manifest.nativeVersion)
    throw new NativeArtifactError('Native bundle version is older than the manifest');
  if (Number.parseFloat(String(parsed.LSMinimumSystemVersion ?? '0')) < 14)
    throw new NativeArtifactError('Native bundle requires an unsupported macOS version');
  await run('codesign', ['--verify', '--strict', '--verbose=2', appPath]);
  const details = await run('codesign', ['--display', '--verbose=4', appPath]);
  if (!details.includes(`TeamIdentifier=${manifest.teamId}`))
    throw new NativeArtifactError('Native signing team is invalid');
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
}

export async function ensureNativeArtifact(input: {
  packageRoot: string;
  cacheRoot: string;
  manifest: NativeManifest;
  signal: AbortSignal;
  hooks?: NativeArtifactHooks;
}): Promise<{ executable: string }> {
  input.signal.throwIfAborted();
  const manifest = NativeManifestSchema.parse(input.manifest);
  if (!inside(input.packageRoot, join(input.packageRoot, manifest.archive)))
    throw new NativeArtifactError('Native archive path escapes the package');
  const archivePath = resolve(input.packageRoot, manifest.archive);
  await rejectSymlinkPath(input.packageRoot, archivePath);
  if ((await Bun.file(archivePath).exists()) === false) throw new NativeArtifactError('Native archive is missing');
  if ((await sha256File(archivePath)) !== manifest.sha256)
    throw new NativeArtifactError('Native archive digest is invalid');
  input.signal.throwIfAborted();

  await mkdir(input.cacheRoot, { recursive: true });
  const installRoot = join(input.cacheRoot, manifest.nativeVersion);
  const existing = join(installRoot, 'AIOProxyCloudKit.app', 'Contents', 'MacOS', 'AIOProxyCloudKit');
  if (await Bun.file(existing).exists()) {
    await verifyBundle(dirname(dirname(dirname(existing))), manifest, existing);
    return { executable: existing };
  }
  const stagingRoot = await mkdtemp(join(input.cacheRoot, '.staging-'));
  let previousRoot: string | undefined;
  let previousMoved = false;
  try {
    const entries = (await run('unzip', ['-Z1', archivePath])).split(/\r?\n/u).filter(Boolean);
    for (const entry of entries) safeArchiveEntry(entry);
    input.signal.throwIfAborted();
    if (input.hooks?.extractArchive) await input.hooks.extractArchive(archivePath, stagingRoot);
    else await run('unzip', ['-q', archivePath, '-d', stagingRoot]);
    await rejectSymlinks(stagingRoot);
    const apps: string[] = [];
    const findApps = async (root: string): Promise<void> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && entry.name.endsWith('.app')) apps.push(path);
        else if (entry.isDirectory()) await findApps(path);
      }
    };
    await findApps(stagingRoot);
    if (apps.length !== 1) throw new NativeArtifactError('Native archive must contain exactly one app bundle');
    const appPath = apps[0]!;
    const executable = join(appPath, 'Contents', 'MacOS', 'AIOProxyCloudKit');
    await (input.hooks?.verifyBundle ?? verifyBundle)(appPath, manifest, executable);
    input.signal.throwIfAborted();
    previousRoot = `${installRoot}.previous-${crypto.randomUUID()}`;
    const hadPrevious = await stat(installRoot)
      .then(() => true)
      .catch(() => false);
    if (hadPrevious) {
      await rename(installRoot, previousRoot);
      previousMoved = true;
    }
    if (dirname(appPath) !== stagingRoot) {
      await rename(appPath, join(stagingRoot, 'AIOProxyCloudKit.app'));
    }
    await rename(stagingRoot, installRoot);
    if (previousMoved) await rm(previousRoot, { force: true, recursive: true });
    return { executable: join(installRoot, 'AIOProxyCloudKit.app', 'Contents', 'MacOS', 'AIOProxyCloudKit') };
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true });
    if (previousMoved && previousRoot !== undefined) {
      await rm(installRoot, { force: true, recursive: true }).catch(() => undefined);
      await rename(previousRoot, installRoot).catch(() => undefined);
    }
    if (error instanceof NativeArtifactError) throw error;
    throw new NativeArtifactError(error instanceof Error ? error.message : 'Native artifact installation failed');
  }
}

export type { NativeManifest as NativeManifestType };
