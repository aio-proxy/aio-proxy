import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { connectNative } from '../src/native-session';
import { directoryDigest, validateManifest, type ArtifactManifest } from './artifact';
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
  const appPath = join(cacheRoot(), manifest.artifactVersion, 'AIOProxyCloudKit.app');
  if (!(await Bun.file(join(appPath, 'Contents', 'Info.plist')).exists())) return undefined;
  return directoryDigest(appPath);
}

export async function connectInstalledPair(): Promise<InstalledPair> {
  if (process.platform !== 'darwin') throw new LiveSetupError('live CloudKit conformance requires macOS');
  const containerId = process.env.CLOUDKIT_CONTAINER_ID?.trim();
  if (containerId === undefined || containerId === '') throw new LiveSetupError('CLOUDKIT_CONTAINER_ID is required');
  if (!/^iCloud\.[A-Za-z0-9.-]+$/u.test(containerId)) throw new LiveSetupError('CLOUDKIT_CONTAINER_ID is invalid');

  let packageManifest: { readonly version?: unknown };
  let nativeManifest: ArtifactManifest;
  try {
    packageManifest = await readJson<{ readonly version?: unknown }>(join(packageRoot, 'package.json'));
    nativeManifest = await readJson<ArtifactManifest>(join(packageRoot, 'dist', 'native', 'manifest.json'));
  } catch (error) {
    throw new LiveSetupError(error instanceof Error ? error.message : 'installed manifest is unavailable');
  }
  if (packageManifest.version !== nativeManifest.artifactVersion)
    throw new LiveSetupError('installed artifact version does not match the package manifest');
  try {
    validateManifest(nativeManifest);
  } catch (error) {
    throw new LiveSetupError(error instanceof Error ? error.message : 'installed manifest is invalid');
  }
  if (nativeManifest.signing?.containerId !== containerId)
    throw new LiveSetupError('requested container does not match signed artifact metadata');
  if (nativeManifest.bundleIdentifier !== bundleId || nativeManifest.signatureStatus !== 'verified')
    throw new LiveSetupError('installed native artifact is not a verified signed bundle');

  const executable = join(
    cacheRoot(),
    nativeManifest.artifactVersion,
    'AIOProxyCloudKit.app',
    'Contents',
    'MacOS',
    'AIOProxyCloudKit',
  );
  const appPath = join(cacheRoot(), nativeManifest.artifactVersion, 'AIOProxyCloudKit.app');
  if (!(await Bun.file(executable).exists())) throw new LiveSetupError('verified native artifact is not installed');
  try {
    await verifyBundle(appPath, nativeManifest, true);
  } catch (error) {
    throw new LiveSetupError(error instanceof Error ? error.message : 'installed artifact verification failed');
  }
  const signal = new AbortController().signal;
  const a = await connectNative({ executable, containerId, signal });
  try {
    const b = await connectNative({ executable, containerId, signal });
    if (a === b) throw new Error('live sessions must be backed by distinct native processes');
    let cleaned = false;
    return {
      a,
      b,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await Promise.allSettled([a.dispose(), b.dispose()]);
      },
    };
  } catch (error) {
    await a.dispose();
    throw error;
  }
}
