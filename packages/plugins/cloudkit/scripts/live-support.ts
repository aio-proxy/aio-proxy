import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { connectNative } from '../src/native-session';
import { directoryDigest, executablePathForApp, validateManifest, type ArtifactManifest } from './artifact';
import { verifyBundle } from './probe-installed';

export class LiveSetupError extends Error {
  override readonly name = 'LiveSetupError';
}

export type InstalledPair = {
  readonly a: SyncSession;
  readonly b: SyncSession;
  readonly cleanup: () => Promise<void>;
};

const packageRoot = resolve(import.meta.dir, '..');
const bundleId = 'dev.aioproxy';

function cacheRoot(): string {
  const dataRoot = process.env.AIO_PROXY_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'aio-proxy');
  return process.env.AIO_PROXY_CLOUDKIT_CACHE_DIR ?? join(dataRoot, 'plugins', '@aio-proxy/plugin-cloudkit', 'native');
}

async function readJson<T>(path: string): Promise<T> {
  if (!(await Bun.file(path).exists())) throw new Error('required installed artifact file is missing');
  return (await Bun.file(path).json()) as T;
}

export async function installedArtifactDigest(): Promise<string | undefined> {
  const manifestPath = join(packageRoot, 'dist', 'native', 'manifest.json');
  if (!(await Bun.file(manifestPath).exists())) return undefined;
  const manifest = (await Bun.file(manifestPath).json()) as ArtifactManifest;
  const appPath = join(cacheRoot(), manifest.artifactVersion, basename(manifest.appRelativePath));
  if (!(await Bun.file(join(appPath, 'Contents', 'Info.plist')).exists())) return undefined;
  const digest = await directoryDigest(appPath);
  return digest === manifest.appSha256 ? digest : undefined;
}

// Every setup step reports the same way: a LiveSetupError marks the run blocked rather than failed.
async function setupStep<T>(fallback: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new LiveSetupError(error instanceof Error ? error.message : fallback);
  }
}

export async function connectInstalledPair(): Promise<InstalledPair> {
  if (process.platform !== 'darwin') throw new LiveSetupError('live CloudKit conformance requires macOS');
  const containerId = process.env.APPLE_CLOUDKIT_CONTAINER_ID?.trim();
  if (containerId === undefined || containerId === '')
    throw new LiveSetupError('APPLE_CLOUDKIT_CONTAINER_ID is required');
  if (!/^iCloud\.[A-Za-z0-9.-]+$/u.test(containerId))
    throw new LiveSetupError('APPLE_CLOUDKIT_CONTAINER_ID is invalid');

  const { packageManifest, nativeManifest } = await setupStep('installed manifest is unavailable', async () => ({
    packageManifest: await readJson<{ readonly version?: unknown }>(join(packageRoot, 'package.json')),
    nativeManifest: await readJson<ArtifactManifest>(join(packageRoot, 'dist', 'native', 'manifest.json')),
  }));
  if (packageManifest.version !== nativeManifest.artifactVersion)
    throw new LiveSetupError('installed artifact version does not match the package manifest');
  await setupStep('installed manifest is invalid', async () => validateManifest(nativeManifest));
  if (nativeManifest.signing?.containerId !== containerId)
    throw new LiveSetupError('requested container does not match signed artifact metadata');
  if (nativeManifest.bundleIdentifier !== bundleId || nativeManifest.signatureStatus !== 'verified')
    throw new LiveSetupError('installed native artifact is not a verified signed bundle');

  const appPath = join(cacheRoot(), nativeManifest.artifactVersion, basename(nativeManifest.appRelativePath));
  const executable = executablePathForApp(nativeManifest, appPath);
  if (!(await Bun.file(executable).exists())) throw new LiveSetupError('verified native artifact is not installed');
  await setupStep('installed artifact verification failed', () => verifyBundle(appPath, nativeManifest, true));

  const signal = new AbortController().signal;
  const a = await setupStep('native session could not connect', () =>
    connectNative({ executable, containerId, signal }),
  );
  try {
    const b = await setupStep('second native session could not connect', () =>
      connectNative({ executable, containerId, signal }),
    );
    if (a === b) throw new LiveSetupError('live sessions must be backed by distinct native processes');
    return {
      a,
      b,
      // The conformance harness calls this once and aggregates whatever it throws.
      async cleanup() {
        await Promise.all([a, b].map((session) => session.dispose()));
      },
    };
  } catch (error) {
    await a.dispose().catch(() => undefined);
    throw error;
  }
}
