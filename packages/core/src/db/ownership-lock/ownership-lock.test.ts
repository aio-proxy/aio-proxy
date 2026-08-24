import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveDbPath } from '../open-db';
import { acquireDatabaseOwnershipLock, DatabaseOwnershipError } from './ownership-lock';

test('one normalized database path has one owner and synchronous release permits immediate reacquire', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-db-owner-'));
  const path = resolveDbPath({ home });
  const first = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  await expect(acquireDatabaseOwnershipLock(path, { waitMs: 25 })).rejects.toBeInstanceOf(DatabaseOwnershipError);
  first.release();
  const second = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  second.release();
});

test('a dead PID/starttime generation is recovered under the existing recovery fence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-db-stale-owner-'));
  const path = resolveDbPath({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    `${path}.server.lock`,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      starttime: 'dead',
      owner: crypto.randomUUID(),
      createdAt: 0,
    }),
    { mode: 0o600 },
  );
  const recovered = await acquireDatabaseOwnershipLock(path, { waitMs: 250 });
  recovered.release();
});

test('a first start creates a private missing database parent before exclusive lock creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-db-new-parent-'));
  const path = resolveDbPath({ home: join(root, 'nested', 'db-home') });
  const ownership = await acquireDatabaseOwnershipLock(path, { waitMs: 25 });
  expect(lstatSync(dirname(path)).isDirectory()).toBe(true);
  if (process.platform !== 'win32') expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
  ownership.release();
  expect(existsSync(`${path}.server.lock`)).toBe(false);
});

test('parent-directory aliases resolve to one canonical database owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-db-parent-alias-'));
  const realHome = join(root, 'real');
  const aliasHome = join(root, 'alias');
  mkdirSync(realHome, { recursive: true });
  symlinkSync(realHome, aliasHome, 'dir');
  const first = await acquireDatabaseOwnershipLock(resolveDbPath({ home: realHome }), { waitMs: 25 });
  expect(first.databasePath).toBe(join(realpathSync(realHome), 'aio-proxy.db'));
  await expect(acquireDatabaseOwnershipLock(resolveDbPath({ home: aliasHome }), { waitMs: 25 })).rejects.toBeInstanceOf(
    DatabaseOwnershipError,
  );
  first.release();
});

test.each(['symlink', 'hardlink'] as const)('rejects a database-file %s alias', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), `aio-proxy-db-${kind}-`));
  const home = join(root, 'home');
  const other = join(root, 'other.db');
  mkdirSync(home, { recursive: true });
  writeFileSync(other, '');
  const path = resolveDbPath({ home });
  if (kind === 'symlink') symlinkSync(other, path, 'file');
  else linkSync(other, path);
  await expect(acquireDatabaseOwnershipLock(path, { waitMs: 25 })).rejects.toMatchObject({ reason: kind });
});
