import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexLocation } from '../contracts';

export const isFsCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const fingerprint = (text: string): string => Bun.hash(text).toString(16);

export async function inspectRegularFile(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return stat;
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function readRegularFile(
  path: string,
): Promise<{ readonly text: string; readonly stat: Awaited<ReturnType<typeof lstat>> } | undefined> {
  const stat = await inspectRegularFile(path);
  if (stat === undefined) return undefined;
  return { text: await readFile(path, 'utf8'), stat };
}

export async function ensureManagedRoot(location: CodexLocation): Promise<void> {
  const home = await lstat(location.home).catch((error) => {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (home?.isSymbolicLink() || (home !== undefined && !home.isDirectory()))
    throw new Error(`Refusing unsafe Codex home: ${location.home}`);
  if (home === undefined) await mkdir(location.home, { recursive: true, mode: 0o700 });
  const root = await lstat(location.managedRoot).catch((error) => {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (root?.isSymbolicLink() || (root !== undefined && !root.isDirectory()))
    throw new Error(`Refusing unsafe managed directory: ${location.managedRoot}`);
  if (root === undefined) await mkdir(location.managedRoot, { recursive: true, mode: 0o700 });
  await chmod(location.managedRoot, 0o700);
}

export async function durableWrite(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${path.split('/').at(-1)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function durableDelete(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if (!isFsCode(error, 'ENOENT')) throw error;
  });
}

export async function syncParent(path: string): Promise<void> {
  const handle = await open(dirname(path), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeTomlAtomically(
  location: CodexLocation,
  original: { readonly text: string; readonly stat: Awaited<ReturnType<typeof lstat>> } | undefined,
  next: string,
): Promise<void> {
  await mkdir(location.home, { recursive: true, mode: 0o700 });
  const temporary = join(location.home, `.config.toml.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const current = await readRegularFile(location.configPath);
    if (original === undefined) {
      if (current !== undefined) throw new Error('Codex configuration changed during update');
    } else if (
      current === undefined ||
      current.stat.dev !== original.stat.dev ||
      current.stat.ino !== original.stat.ino ||
      current.text !== original.text
    ) {
      throw new Error('Codex configuration changed during update');
    }
    await rename(temporary, location.configPath);
    await chmod(location.configPath, 0o600);
    await syncParent(location.configPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
