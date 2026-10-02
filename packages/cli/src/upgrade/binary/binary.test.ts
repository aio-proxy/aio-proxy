import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    rename: async (from, to) => void ops.push(`${from} -> ${to}`),
  });
  expect(ops).toEqual([
    'C:\\b\\aio-proxy.exe -> C:\\b\\aio-proxy.exe.old',
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
      rename: async (from, to) => {
        ops.push(`${from} -> ${to}`);
        if (from === '/b/.new') throw new Error('EBUSY');
      },
    }),
  ).rejects.toThrow('EBUSY');
  expect(ops.at(-1)).toBe('/b/aio-proxy.exe.old -> /b/aio-proxy.exe');
});

test('a Windows package tarball yields aio-proxy.exe', async () => {
  const tgz = await tarball({ 'package/bin/aio-proxy.exe': new Uint8Array([7]) });
  expect(await extractBinaryFromTarball(tgz, 'win32')).toEqual(new Uint8Array([7]));
  await expect(extractBinaryFromTarball(tgz, 'linux')).rejects.toThrow('bin/aio-proxy');
});

test('a win32 upgrade keeps the previous binary at <target>.old and the next sweep removes it', async () => {
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

  writeFileSync(`${target}.old`, 'STALE');
  await sweepStaleBackups(target);
  expect(existsSync(`${target}.old`)).toBe(false);
});

test('the startup sweep removes the previous exe left at <exe>.old on win32 only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-start-'));
  const exe = join(root, 'aio-proxy.exe');
  writeFileSync(`${exe}.old`, 'OLD');
  await sweepStartupBackup(exe, 'linux');
  expect(existsSync(`${exe}.old`)).toBe(true);
  await sweepStartupBackup(exe, 'win32');
  expect(existsSync(`${exe}.old`)).toBe(false);
  await sweepStartupBackup(exe, 'win32'); // nothing left: still a no-op
});
