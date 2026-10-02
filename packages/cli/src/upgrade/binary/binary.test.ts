import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitStagedBinary,
  extractBinaryFromTarball,
  replaceBinaryForUpdate,
  sweepStaleBackups,
  sweepStartupBackup,
} from './binary';

const tarball = async (entries: Record<string, Uint8Array>): Promise<Uint8Array> =>
  new Bun.Archive(entries, { compress: 'gzip' }).bytes();

test('win32 commit renames the running binary aside before moving the staged one in', async () => {
  const ops: string[] = [];
  await commitStagedBinary({
    target: 'C:\\b\\aio-proxy.exe',
    staged: 'C:\\b\\.aio-proxy.new',
    platform: 'win32',
    pid: 4312,
    rename: async (from, to) => void ops.push(`${from} -> ${to}`),
  });
  expect(ops).toEqual([
    'C:\\b\\aio-proxy.exe -> C:\\b\\aio-proxy.exe.old-4312',
    'C:\\b\\.aio-proxy.new -> C:\\b\\aio-proxy.exe',
  ]);
});

test('a failed move of the staged binary restores the old one and rethrows', async () => {
  const ops: string[] = [];
  await expect(
    commitStagedBinary({
      target: '/b/aio-proxy.exe',
      staged: '/b/.new',
      platform: 'win32',
      pid: 4312,
      rename: async (from, to) => {
        ops.push(`${from} -> ${to}`);
        if (from === '/b/.new') throw new Error('EBUSY');
      },
    }),
  ).rejects.toThrow('EBUSY');
  expect(ops.at(-1)).toBe('/b/aio-proxy.exe.old-4312 -> /b/aio-proxy.exe');
});

test('a Windows package tarball yields aio-proxy.exe', async () => {
  const tgz = await tarball({ 'package/bin/aio-proxy.exe': new Uint8Array([7]) });
  expect(await extractBinaryFromTarball(tgz, 'win32')).toEqual(new Uint8Array([7]));
  await expect(extractBinaryFromTarball(tgz, 'linux')).rejects.toThrow('bin/aio-proxy');
});

// The in-service supervisor keeps running from the first backup, so neither the sweep nor a rename can
// touch it; the second upgrade must still go through.
test('two consecutive win32 commits succeed while the first backup is still in use', async () => {
  const files = new Map([['C:\\b\\aio-proxy.exe', 'V1']]);
  const inUse = new Set<string>();
  const rename = async (from: string, to: string) => {
    if (files.has(to)) throw Object.assign(new Error(`EPERM ${to}`), { code: 'EPERM' });
    files.set(to, files.get(from) ?? '');
    files.delete(from);
  };
  for (const [pid, version] of [
    [4312, 'V2'],
    [4400, 'V3'],
  ] as const) {
    files.set('C:\\b\\.new', version);
    await commitStagedBinary({ target: 'C:\\b\\aio-proxy.exe', staged: 'C:\\b\\.new', platform: 'win32', pid, rename });
    inUse.add(`C:\\b\\aio-proxy.exe.old-${pid}`);
  }
  expect(files.get('C:\\b\\aio-proxy.exe')).toBe('V3');
  expect([...inUse].map((path) => files.get(path))).toEqual(['V1', 'V2']);
});

test('a win32 upgrade that fails verification restores the previous binary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-win-'));
  const target = join(root, 'aio-proxy.exe');
  const temp = join(root, '.aio-proxy.new');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({
    targetPath: target,
    tempPath: temp,
    backupPath: join(root, 'unused.bak'),
    expectedVersion: '1.0.0',
    platform: 'win32',
    verify: async () => ({ ok: false }),
  });
  expect(res.ok).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('OLD');
  expect(readdirSync(root)).toEqual(['aio-proxy.exe']);
});

test('the post-upgrade and startup sweeps remove every <exe>.old* backup, the startup one on win32 only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-sweep-'));
  const exe = join(root, 'aio-proxy.exe');
  const backups = ['aio-proxy.exe.old', 'aio-proxy.exe.old-4312', 'AIO-PROXY.EXE.old-77'];
  const plant = () => {
    for (const name of [...backups, 'aio-proxy.exe', 'aio-proxy.exe.older', 'other.exe.old-1']) {
      writeFileSync(join(root, name), 'X');
    }
  };
  const left = () => readdirSync(root).sort();
  plant();
  await sweepStartupBackup(exe, 'linux');
  expect(left()).toHaveLength(6);
  await sweepStartupBackup(exe, 'win32');
  expect(left()).toEqual(['aio-proxy.exe', 'aio-proxy.exe.older', 'other.exe.old-1']);
  await sweepStartupBackup(exe, 'win32'); // nothing left: still a no-op
  plant();
  await sweepStaleBackups(exe, 'win32');
  expect(left()).toEqual(['aio-proxy.exe', 'aio-proxy.exe.older', 'other.exe.old-1']);
});
