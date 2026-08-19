import type { Stats } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FsIdentity = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
};

export const isFsCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const inspectPath = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
};

export const matchesIdentity = (identity: FsIdentity, stat: Stats): boolean =>
  identity.dev === stat.dev && identity.ino === stat.ino;

export async function captureIdentity(path: string): Promise<FsIdentity> {
  const stat = await lstat(path);
  return { path, dev: stat.dev, ino: stat.ino };
}

export function relocateIdentity(identity: FsIdentity, path: string): FsIdentity {
  return { path, dev: identity.dev, ino: identity.ino };
}

export async function writeDurable(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function isolateOwned(
  identity: FsIdentity,
  afterIsolate?: (isolated: string, originalPath: string) => void | Promise<void>,
): Promise<string | undefined> {
  const isolated = join(dirname(identity.path), `.aio-proxy-owned-${crypto.randomUUID()}`);
  try {
    await rename(identity.path, isolated);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  await afterIsolate?.(isolated, identity.path);
  const stat = await inspectPath(isolated);
  if (stat !== undefined && matchesIdentity(identity, stat)) return isolated;
  if (stat !== undefined && (await inspectPath(identity.path)) === undefined) {
    try {
      await rename(isolated, identity.path);
    } catch {
      // Leave the mismatched occupant at the isolated sibling rather than delete it.
    }
  }
  return undefined;
}

export async function removeOwned(identity: FsIdentity): Promise<void> {
  const isolated = await isolateOwned(identity);
  if (isolated === undefined) return;
  await rm(isolated, { recursive: true, force: true });
}

export async function restoreOwned(identity: FsIdentity, dest: string): Promise<boolean> {
  const source = await inspectPath(identity.path);
  if (source === undefined || !matchesIdentity(identity, source)) return false;
  if ((await inspectPath(dest)) !== undefined) return false;
  try {
    await rename(identity.path, dest);
  } catch {
    return false;
  }
  const atDest = await inspectPath(dest);
  return atDest !== undefined && matchesIdentity(identity, atDest);
}
