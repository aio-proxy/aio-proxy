import { expect, spyOn, test } from 'bun:test';
import { constants, existsSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireFileLock, observeFileLockOwner } from './index';
import { MAX_LOCK_RECORD_BYTES } from './read-lock-text';

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

test('a caller abort during lock contention keeps the abort reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-abort-reason-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, owner: 'held-owner', createdAt: Date.now() }), {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('still owned')), 20);
  try {
    await expect(acquireFileLock(path, { signal: controller.signal })).rejects.toThrow('still owned');
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});

test('a contending owner cannot wait past its supplied deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-'));
  const path = join(root, '.aio-proxy.lock');
  const first = await acquireFileLock(path);
  try {
    const started = Date.now();
    await expect(
      acquireFileLock(path, {
        deadline: started + 120,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    await first.withOwnership(async (assertOwned) => {
      await assertOwned();
    });
  } finally {
    await first.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('observes the current owner without waiting for its lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-owner-'));
  const path = join(root, '.aio-proxy.lock');
  const holder = await acquireFileLock(path);
  try {
    try {
      expect(await observeFileLockOwner(path, { deadline: Date.now() + 500 })).toBe(holder.owner);
    } finally {
      await holder.release();
    }
    expect(await observeFileLockOwner(path)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observing a held lock does not wait, fence, or modify the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-observe-readonly-'));
  const path = join(root, '.aio-proxy.lock');
  const holder = await acquireFileLock(path);
  try {
    const before = await readFile(path, 'utf8');
    const started = Date.now();
    expect(await observeFileLockOwner(path, { deadline: Date.now() + 500 })).toBe(holder.owner);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await readdir(root)).filter((name) => name.includes('.recovery.'))).toEqual([]);
  } finally {
    await holder.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('a dead lock pid is observed as no contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-dead-pid-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, JSON.stringify({ pid: 999_999, owner: 'dead-owner', createdAt: Date.now() }), { mode: 0o600 });
  await chmod(path, 0o600);
  try {
    expect(await observeFileLockOwner(path)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a reused pid with a mismatched starttime is observed as no contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-pid-reuse-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, owner: 'reused-owner', createdAt: Date.now(), starttime: 'DIFFERENT' }),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  try {
    expect(await observeFileLockOwner(path)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observing a symlink lock is a temporary failure, not absent contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-symlink-'));
  const path = join(root, '.aio-proxy.lock');
  const target = join(root, 'target.lock');
  await writeFile(
    target,
    JSON.stringify({ pid: process.pid, owner: 'link-owner', createdAt: Date.now(), starttime: 'live' }),
    { mode: 0o600 },
  );
  await chmod(target, 0o600);
  await symlink(target, path);
  try {
    await expect(observeFileLockOwner(path)).rejects.toThrow(/temporary/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unverifiable live identity is a temporary observation failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-unknown-id-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, owner: 'unknown-owner', createdAt: Date.now() }), {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  try {
    await expect(observeFileLockOwner(path)).rejects.toThrow(/temporary/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acquiring an oversized lock record fails within the caller deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-acquire-oversize-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, 'x'.repeat(MAX_LOCK_RECORD_BYTES + 1), { mode: 0o600 });
  await chmod(path, 0o600);
  try {
    const started = Date.now();
    await expect(acquireFileLock(path, { deadline: Date.now() + 5_000 })).rejects.toThrow(/too large/i);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale lock with a valid prefix and oversized trailing padding is reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-padded-stale-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(
    path,
    `${JSON.stringify({ pid: 999_999, owner: 'dead', createdAt: Date.now() })}${' '.repeat(MAX_LOCK_RECORD_BYTES * 4)}`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  try {
    const started = Date.now();
    const lock = await acquireFileLock(path, { deadline: Date.now() + 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ownership verification and release fail fast on an oversized lock record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-verify-oversize-'));
  const path = join(root, '.aio-proxy.lock');
  const lock = await acquireFileLock(path, { deadline: Date.now() + 5_000 });
  try {
    await writeFile(path, 'x'.repeat(MAX_LOCK_RECORD_BYTES + 1), { mode: 0o600 });
    const started = Date.now();
    await expect(lock.withOwnership(async (assertOwned) => assertOwned())).rejects.toThrow(/too large/i);
    await expect(lock.release()).rejects.toThrow(/too large/i);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an aged empty lock is observed as no contention and reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-empty-aged-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, '', { mode: 0o600 });
  await chmod(path, 0o600);
  const aged = new Date(Date.now() - 1_000);
  await utimes(path, aged, aged);
  try {
    const started = Date.now();
    expect(await observeFileLockOwner(path, { deadline: Date.now() + 5_000 })).toBeUndefined();
    const lock = await acquireFileLock(path, { deadline: Date.now() + 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized lock record is a temporary observation failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-oversize-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, 'x'.repeat(MAX_LOCK_RECORD_BYTES + 1), { mode: 0o600 });
  await chmod(path, 0o600);
  try {
    const started = Date.now();
    await expect(observeFileLockOwner(path, { deadline: Date.now() + 500 })).rejects.toThrow(/temporary/i);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe lock permissions are a temporary observation failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-perms-'));
  const path = join(root, '.aio-proxy.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, owner: 'open-owner', createdAt: Date.now() }), {
    mode: 0o666,
  });
  await chmod(path, 0o666);
  try {
    await expect(observeFileLockOwner(path)).rejects.toThrow(/temporary/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'abandoned lock recovery honors the acquire deadline on a stalled path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-abandoned-stall-'));
    const path = join(root, '.aio-proxy.lock');
    const realUnlink = fsPromises.unlink.bind(fsPromises);
    let failed = false;
    const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
      if (target === path && !failed) {
        failed = true;
        throw new Error('release failed');
      }
      return realUnlink(target);
    });
    const holder = await acquireFileLock(path);
    try {
      await expect(holder.release()).rejects.toThrow('release failed');
      unlinkSpy.mockRestore();
      await unlink(path);
      const created = Bun.spawn(['mkfifo', path]);
      expect(await created.exited).toBe(0);
      const started = Date.now();
      await expect(
        acquireFileLock(path, {
          deadline: started + 250,
          signal: AbortSignal.timeout(250),
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      unlinkSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('an abandoned owner is observed as no contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-abandoned-'));
  const path = join(root, '.aio-proxy.lock');
  const realUnlink = fsPromises.unlink.bind(fsPromises);
  let failed = false;
  const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
    if (target === path && !failed) {
      failed = true;
      throw new Error('release failed');
    }
    return realUnlink(target);
  });
  const holder = await acquireFileLock(path);
  const owner = holder.owner;
  try {
    await expect(holder.release()).rejects.toThrow('release failed');
    unlinkSpy.mockRestore();
    expect(await observeFileLockOwner(path)).toBeUndefined();
    expect(owner).not.toBeUndefined();
  } finally {
    unlinkSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit deadline is not reset for a later ownership fence or release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-deadline-lifetime-'));
  const path = join(root, '.aio-proxy.lock');
  const lock = await acquireFileLock(path, { deadline: Date.now() + 200 });
  try {
    await Bun.sleep(250);
    const fenceStarted = Date.now();
    await expect(
      lock.withOwnershipFence(async (assertOwned) => {
        await assertOwned();
      }),
    ).rejects.toThrow();
    expect(Date.now() - fenceStarted).toBeLessThan(1_000);
    const releaseStarted = Date.now();
    await expect(lock.release()).rejects.toThrow();
    expect(Date.now() - releaseStarted).toBeLessThan(1_000);
  } finally {
    await lock.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a former owner cannot write or unlink a replacement lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-replaced-'));
  const path = join(root, '.aio-proxy.lock');
  const first = await acquireFileLock(path);
  try {
    await unlink(path);
    await writeFile(path, JSON.stringify({ pid: process.pid, owner: 'replacement', createdAt: Date.now() }), {
      mode: 0o600,
    });
    await chmod(path, 0o600);
    await expect(
      first.withOwnership(async (assertOwned) => {
        await assertOwned();
      }),
    ).rejects.toThrow('File lock ownership lost');
    expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe('replacement');
    await first.release();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe('replacement');
  } finally {
    await first.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('release fencing prevents a former owner from unlinking a replacement lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-release-race-'));
  const path = join(root, '.aio-proxy.lock');
  const unlinkPaused = join(root, 'unlink-paused');
  const resumeUnlink = join(root, 'resume-unlink');
  const realUnlink = fsPromises.unlink.bind(fsPromises);
  let intercepted = false;
  const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
    if (target === path && !intercepted) {
      intercepted = true;
      writeFileSync(unlinkPaused, 'paused');
      await waitForFile(resumeUnlink);
    }
    return realUnlink(target);
  });

  const first = await acquireFileLock(path);
  try {
    const releasing = first.release();
    await waitForFile(unlinkPaused);
    let replacementAcquired = false;
    const replacement = acquireFileLock(path).then((lock) => {
      replacementAcquired = true;
      return lock;
    });
    await Bun.sleep(100);
    expect(replacementAcquired).toBe(false);
    writeFileSync(resumeUnlink, 'resume');
    await releasing;
    const replacementLock = await replacement;
    try {
      expect(existsSync(path)).toBe(true);
      await expect(
        first.withOwnership(async (assertOwned) => {
          await assertOwned();
        }),
      ).rejects.toThrow('File lock ownership lost');
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(replacementLock.owner);
    } finally {
      await replacementLock.release();
    }
  } finally {
    writeFileSync(resumeUnlink, 'resume');
    unlinkSpy.mockRestore();
    await first.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('a cancelled lock write does not keep committing after abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-cancel-write-'));
  const path = join(root, '.aio-proxy.lock');
  const realOpen = fsPromises.open.bind(fsPromises);
  let resumeWrite!: () => void;
  const writePaused = new Promise<void>((resolve) => {
    resumeWrite = resolve;
  });
  let writeStarted = false;
  let writeFinished = false;
  const open = spyOn(fsPromises, 'open').mockImplementation(async (target, flags, mode) => {
    const handle = await realOpen(target, flags, mode);
    if (target === path && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
      const originalWriteFile = handle.writeFile.bind(handle);
      Object.defineProperty(handle, 'writeFile', {
        configurable: true,
        value: async (data: Parameters<typeof handle.writeFile>[0]) => {
          writeStarted = true;
          await writePaused;
          writeFinished = true;
          return originalWriteFile(data);
        },
      });
    }
    return handle;
  });

  const controller = new AbortController();
  const pending = acquireFileLock(path, { deadline: Date.now() + 5_000, signal: controller.signal });
  try {
    const waitStarted = Date.now();
    while (!writeStarted) {
      if (Date.now() - waitStarted > 2_000) throw new Error('exclusive lock write did not start');
      await Bun.sleep(5);
    }
    controller.abort(new Error('cancelled'));
    resumeWrite();
    await expect(pending).rejects.toThrow();
    await Bun.sleep(50);
    const started = Date.now();
    const lock = await acquireFileLock(path, { deadline: Date.now() + 800 });
    try {
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(writeFinished).toBe(true);
    } finally {
      await lock.release();
    }
  } finally {
    resumeWrite();
    open.mockRestore();
    await pending.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
