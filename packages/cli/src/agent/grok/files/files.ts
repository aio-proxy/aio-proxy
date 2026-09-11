import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MAX_GROK_FILE_BYTES, readOpenFileText, withHandleBudget, withReadBudget } from '../read-bounded';
import type { GrokDeadline } from '../types';

export type GrokFileSnapshot = {
  readonly text: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
};
export type GrokFileIdentity = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
};
export type GrokPaths = {
  readonly root: string;
  readonly config: string;
  readonly privateDir: string;
  readonly marker: string;
  readonly ownership: string;
  readonly credential: string;
  readonly lock: string;
  readonly removalJournal: string;
};
export type ReplaceGrokFileTestDeps = {
  readonly beforeRename?: () => Promise<void>;
};

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

export const grokPaths = (root: string): GrokPaths => {
  const privateDir = join(root, 'aio-proxy');
  return {
    root,
    config: join(root, 'config.toml'),
    privateDir,
    marker: join(privateDir, '.aio-proxy-managed.json'),
    ownership: join(privateDir, 'ownership.json'),
    credential: join(privateDir, 'credential.json'),
    lock: join(root, '.aio-proxy.lock'),
    removalJournal: join(root, '.aio-proxy-removal.json'),
  };
};

export async function readGrokCredentialText(root: string, budget?: GrokDeadline): Promise<string | undefined> {
  const snapshot = await readGrokPrivateFile(grokPaths(root).credential, 'credential', budget);
  if (snapshot === undefined || snapshot.text.trim() === '') return undefined;
  return snapshot.text;
}

export const isFsCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export async function inspectPath(path: string, budget?: GrokDeadline): Promise<Stats | undefined> {
  try {
    return await withReadBudget(
      budget,
      () => new Error('Grok path unverifiable'),
      () => lstat(path),
    );
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

const currentUid = (): number | undefined => process.getuid?.();

const reject = (message: string): never => {
  throw new Error(message);
};

const assertOwnedByCurrentUser = (stats: Stats, kind: string): void => {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) reject(`Grok ${kind} has unexpected owner`);
};

export function assertSafeRoot(stats: Stats): void {
  if (stats.isSymbolicLink()) reject('Grok root is a symlink');
  if (!stats.isDirectory()) reject('Grok root is not a directory');
}

export function assertSafePrivateDir(stats: Stats): void {
  if (stats.isSymbolicLink()) reject('Grok private directory is a symlink');
  if (!stats.isDirectory()) reject('Grok private directory is not a directory');
  assertOwnedByCurrentUser(stats, 'private directory');
  if ((stats.mode & 0o022) !== 0) reject('Grok private directory is group or world writable');
}

function assertSafeFile(stats: Stats, kind: string, privateFile: boolean): void {
  if (stats.isSymbolicLink()) reject(`Grok ${kind} is a symlink`);
  if (!stats.isFile()) reject(`Grok ${kind} is not a regular file`);
  if (stats.nlink !== 1) reject(`Grok ${kind} is a hardlink`);
  if (!privateFile) return;
  assertOwnedByCurrentUser(stats, kind);
  if ((stats.mode & 0o077) !== 0) reject(`Grok ${kind} has unsafe permissions`);
}

async function readGrokSnapshot(
  path: string,
  kind: string,
  privateFile: boolean,
  budget?: GrokDeadline,
): Promise<GrokFileSnapshot | undefined> {
  const unverifiable = (): Error => new Error(`Grok ${kind} unverifiable`);
  const link = await inspectPath(path, budget);
  if (link === undefined) return undefined;
  assertSafeFile(link, kind, privateFile);
  let handle;
  try {
    handle = await withReadBudget(budget, unverifiable, () => open(path, READ_FLAGS));
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    if (isFsCode(error, 'ELOOP') || isFsCode(error, 'EPERM')) reject(`Grok ${kind} is a symlink`);
    throw error;
  }
  try {
    const file = await withReadBudget(budget, unverifiable, () => handle.stat());
    if (file.dev !== link.dev || file.ino !== link.ino) reject(`Grok ${kind} changed during read`);
    assertSafeFile(file, kind, privateFile);
    const text = await readOpenFileText(handle, file.size, {
      maxBytes: MAX_GROK_FILE_BYTES,
      budget,
      limitError: unverifiable,
    });
    return { text, dev: file.dev, ino: file.ino, mode: file.mode };
  } finally {
    void handle.close().catch(() => undefined);
  }
}

export const readGrokFile = (path: string, budget?: GrokDeadline): Promise<GrokFileSnapshot | undefined> =>
  readGrokSnapshot(path, 'configuration', false, budget);

export const readGrokPrivateFile = (
  path: string,
  kind: string,
  budget?: GrokDeadline,
): Promise<GrokFileSnapshot | undefined> => readGrokSnapshot(path, kind, true, budget);

export async function tryReadGrokPrivateFile(
  path: string,
  kind: string,
  budget?: GrokDeadline,
): Promise<GrokFileSnapshot | undefined> {
  try {
    return await readGrokPrivateFile(path, kind, budget);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Grok ')) return undefined;
    throw error;
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

export async function removeMatchingFile(identity: GrokFileIdentity): Promise<void> {
  const current = await inspectPath(identity.path);
  if (current === undefined) return;
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  await unlink(identity.path);
}

export async function removeMatchingDir(identity: GrokFileIdentity): Promise<void> {
  const current = await inspectPath(identity.path);
  if (current === undefined) return;
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  try {
    await rmdir(identity.path);
  } catch (error) {
    if (isFsCode(error, 'ENOTEMPTY') || isFsCode(error, 'ENOENT')) return;
    throw error;
  }
}

export async function captureIdentity(path: string): Promise<GrokFileIdentity> {
  const stats = await lstat(path);
  return { path, dev: stats.dev, ino: stats.ino };
}

export async function createPrivateDir(path: string): Promise<GrokFileIdentity> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isFsCode(error, 'EEXIST')) reject('Grok private directory already exists');
    throw error;
  }
  const stats = await lstat(path);
  assertSafePrivateDir(stats);
  return { path, dev: stats.dev, ino: stats.ino };
}

export const sameGrokSnapshot = (
  expected: GrokFileSnapshot | undefined,
  current: GrokFileSnapshot | undefined,
): boolean =>
  expected === undefined
    ? current === undefined
    : current !== undefined &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.text === expected.text &&
      current.mode === expected.mode;

export async function replaceGrokFile(
  path: string,
  text: string,
  expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline,
  assertOwnership: () => Promise<void>,
  testDeps?: ReplaceGrokFileTestDeps,
): Promise<void> {
  const temporaryPath = path + '.aio-' + randomUUID();
  const unverifiable = (): Error => new Error('Grok file unverifiable');
  let temporary: GrokFileIdentity | undefined;
  try {
    const handle = await withReadBudget(budget, unverifiable, () => open(temporaryPath, WRITE_FLAGS, 0o600));
    try {
      const opened = await withHandleBudget(handle, budget, unverifiable, () => handle.stat());
      temporary = { path: temporaryPath, dev: opened.dev, ino: opened.ino };
      await withHandleBudget(handle, budget, unverifiable, () => handle.writeFile(text));
      await withHandleBudget(handle, budget, unverifiable, () => handle.sync());
    } finally {
      void handle.close().catch(() => undefined);
    }
    if (expected !== undefined) {
      await withReadBudget(budget, unverifiable, () => chmod(temporaryPath, expected.mode & 0o777));
    }
    await testDeps?.beforeRename?.();
    // Last check plus rename is not CAS against an uncooperative writer.
    // Configure while Grok is not also saving settings.
    budget.signal.throwIfAborted();
    await assertOwnership();
    const current = await readGrokFile(path, budget);
    if (!sameGrokSnapshot(expected, current)) {
      throw new Error('Grok file changed during update. Configure while Grok is not also saving settings.');
    }
    budget.signal.throwIfAborted();
    await withReadBudget(budget, unverifiable, () => rename(temporaryPath, path));
    temporary = undefined;
    await withReadBudget(budget, unverifiable, () => syncDirectory(dirname(path)));
  } finally {
    if (temporary !== undefined) await removeMatchingFile(temporary);
  }
}

export async function unlinkGrokFile(
  path: string,
  expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline,
  assertOwnership: () => Promise<void>,
  kind = 'credential',
): Promise<void> {
  budget.signal.throwIfAborted();
  await assertOwnership();
  const current = await readGrokPrivateFile(path, kind, budget);
  if (!sameGrokSnapshot(expected, current)) {
    throw new Error('Grok file changed during update. Configure while Grok is not also saving settings.');
  }
  if (current === undefined) return;
  budget.signal.throwIfAborted();
  await unlink(path);
  await syncDirectory(dirname(path));
}

const TMP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNED_PRIVATE_BASENAMES = ['.aio-proxy-managed.json', 'ownership.json', 'credential.json'] as const;

export function isGrokOwnedTmpName(name: string, basename: string): boolean {
  const prefix = `${basename}.aio-`;
  return name.startsWith(prefix) && TMP_UUID.test(name.slice(prefix.length));
}

export async function listGrokDirectoryNames(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return [];
    throw error;
  }
}

export async function removeOwnedGrokTmp(directory: string, basename: string): Promise<void> {
  for (const name of await listGrokDirectoryNames(directory)) {
    if (!isGrokOwnedTmpName(name, basename)) continue;
    const path = join(directory, name);
    const stats = await inspectPath(path);
    if (stats === undefined || stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) continue;
    await removeMatchingFile({ path, dev: stats.dev, ino: stats.ino });
  }
}

export async function removeGrokOwnedTemporaryFiles(paths: GrokPaths): Promise<void> {
  for (const basename of OWNED_PRIVATE_BASENAMES) {
    await removeOwnedGrokTmp(paths.privateDir, basename);
  }
  await removeOwnedGrokTmp(paths.root, 'config.toml');
}

export async function isRecoverableBootstrapPrivateDir(privateDir: string): Promise<boolean> {
  const names = await listGrokDirectoryNames(privateDir);
  for (const name of names) {
    if (!OWNED_PRIVATE_BASENAMES.some((basename) => isGrokOwnedTmpName(name, basename))) return false;
    const stats = await inspectPath(join(privateDir, name));
    if (stats === undefined || stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) return false;
  }
  return true;
}
