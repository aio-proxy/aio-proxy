import { lstat, open, rm } from 'node:fs/promises';

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

export async function removeOwnedDirectory(path: string): Promise<void> {
  const stat = await inspectPath(path);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return;
  await rm(path, { recursive: true, force: true });
}
