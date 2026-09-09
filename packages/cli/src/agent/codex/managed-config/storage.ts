import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import type { CodexLocation } from '../contracts';

export const isFsCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const fingerprint = (text: string): string => Bun.hash(text).toString(16);

export type FileSnapshot = {
  readonly text: string;
  readonly stat: Awaited<ReturnType<typeof lstat>>;
};

export async function assertNoSymlinkParents(path: string): Promise<void> {
  // macOS exposes /var and /tmp as stable system aliases; every component below them is user-controlled.
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        if (current !== '/var' && current !== '/tmp') throw new Error(`Refusing symbolic link parent: ${current}`);
        continue;
      }
      if (!stat.isDirectory()) throw new Error(`Expected a directory parent: ${current}`);
    } catch (error) {
      if (isFsCode(error, 'ENOENT')) return;
      throw error;
    }
  }
}

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

export async function chmodChecked(path: string, mode: number): Promise<void> {
  const expected = await lstat(path);
  if (expected.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error(`Path changed during chmod: ${path}`);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

export async function readRegularFile(
  path: string,
): Promise<{ readonly text: string; readonly stat: Awaited<ReturnType<typeof lstat>> } | undefined> {
  const stat = await inspectRegularFile(path);
  if (stat === undefined) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error(`Path changed during read: ${path}`);
    return { text: await handle.readFile('utf8'), stat: actual };
  } finally {
    await handle.close();
  }
}

export async function ensureManagedRoot(location: CodexLocation): Promise<void> {
  await assertNoSymlinkParents(location.home);
  const home = await lstat(location.home).catch((error) => {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (home?.isSymbolicLink() || (home !== undefined && !home.isDirectory()))
    throw new Error(`Refusing unsafe Codex home: ${location.home}`);
  if (home === undefined) await mkdir(location.home, { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents(location.managedRoot);
  const root = await lstat(location.managedRoot).catch((error) => {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (root?.isSymbolicLink() || (root !== undefined && !root.isDirectory()))
    throw new Error(`Refusing unsafe managed directory: ${location.managedRoot}`);
  if (root === undefined) await mkdir(location.managedRoot, { recursive: true, mode: 0o700 });
  await chmodChecked(location.managedRoot, 0o700);
}

export async function durableWrite(path: string, text: string, mode: number, expected?: FileSnapshot): Promise<void> {
  await assertNoSymlinkParents(dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents(dirname(path));
  const temporary = join(dirname(path), `.${path.split('/').at(-1)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const current = await readRegularFile(path);
    if (expected === undefined) {
      if (current !== undefined) throw new Error(`Destination changed during durable write: ${path}`);
    } else if (
      current === undefined ||
      current.stat.dev !== expected.stat.dev ||
      current.stat.ino !== expected.stat.ino ||
      current.text !== expected.text
    ) {
      throw new Error(`Destination changed during durable write: ${path}`);
    }
    await rename(temporary, path);
    await syncParent(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function durableDelete(path: string, expected?: FileSnapshot): Promise<void> {
  await assertNoSymlinkParents(dirname(path));
  const current = await readRegularFile(path);
  if (current === undefined) return;
  if (
    expected !== undefined &&
    (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino || current.text !== expected.text)
  ) {
    throw new Error(`Destination changed during durable delete: ${path}`);
  }
  const latest = await readRegularFile(path);
  if (latest === undefined || latest.stat.dev !== current.stat.dev || latest.stat.ino !== current.stat.ino)
    throw new Error(`Destination changed during durable delete: ${path}`);
  await assertNoSymlinkParents(dirname(path));
  await unlink(path).catch((error) => {
    if (!isFsCode(error, 'ENOENT')) throw error;
  });
  await syncParent(path);
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
  original: FileSnapshot | undefined,
  next: string,
  testDeps?: { readonly beforeFinalCheck?: () => void | Promise<void> },
): Promise<void> {
  await assertNoSymlinkParents(location.home);
  await mkdir(location.home, { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents(location.home);
  const temporary = join(location.home, `.config.toml.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await testDeps?.beforeFinalCheck?.();
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
    const installed = await inspectRegularFile(location.configPath);
    if (installed === undefined) throw new Error('Codex configuration disappeared after replacement');
    await syncParent(location.configPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
