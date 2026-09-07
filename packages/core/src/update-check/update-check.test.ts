import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as processIdentity from '../file-lock/process-identity';
import { processStarttime } from '../file-lock/process-identity';
import { mergeUpdateCheckState, readUpdateCheckState, writeUpdateCheckState } from './update-check';
import { withUpdateCheckLock } from './update-check-lock';

const original = process.env.AIO_PROXY_HOME;

afterEach(() => {
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-update-check-'));
  process.env.AIO_PROXY_HOME = dir;
  return dir;
};

test('round-trips a valid update-check file', async () => {
  const dir = home();
  try {
    const state = { latest: '1.10.0', checkedAt: 1_700_000_000_000, notifiedVersion: '1.10.0' };
    await writeUpdateCheckState(state);
    expect(readUpdateCheckState()).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing, unreadable, or invalid files are no check', () => {
  const dir = home();
  try {
    expect(readUpdateCheckState()).toBeUndefined();
    mkdirSync(join(dir, 'update-check.json'));
    expect(readUpdateCheckState()).toBeUndefined();
    rmSync(join(dir, 'update-check.json'), { recursive: true, force: true });
    writeFileSync(join(dir, 'update-check.json'), '{');
    expect(readUpdateCheckState()).toBeUndefined();
    writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ latest: 'not-a-version', checkedAt: 1 }));
    expect(readUpdateCheckState()).toBeUndefined();
    writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ latest: '1.0.0' }));
    expect(readUpdateCheckState()).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeUpdateCheckState keeps a newer on-disk latest from an overlapping check', () => {
  expect(
    mergeUpdateCheckState(
      { latest: '1.10.0', checkedAt: 20, fetchStartedAt: 1 },
      { latest: '1.11.0', checkedAt: 9, notifiedVersion: '1.11.0' },
    ),
  ).toEqual({ latest: '1.11.0', checkedAt: 9, notifiedVersion: '1.11.0' });
});

test('mergeUpdateCheckState keeps a later overlapping rollback over a stale higher fetch', () => {
  expect(
    mergeUpdateCheckState(
      { latest: '2.0.0', checkedAt: 25, fetchStartedAt: 1 },
      { latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' },
    ),
  ).toEqual({ latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' });
});

test('mergeUpdateCheckState records a later registry rollback', () => {
  expect(
    mergeUpdateCheckState(
      { latest: '1.9.0', checkedAt: 20, fetchStartedAt: 15 },
      { latest: '2.0.0', checkedAt: 1, notifiedVersion: '2.0.0' },
    ),
  ).toEqual({ latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' });
});

test('mergeUpdateCheckState writes the incoming latest and keeps an existing notify marker', () => {
  expect(
    mergeUpdateCheckState(
      { latest: '1.10.0', checkedAt: 20, fetchStartedAt: 20 },
      { latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.10.0' },
    ),
  ).toEqual({ latest: '1.10.0', checkedAt: 20, notifiedVersion: '1.10.0' });
});

test('mergeUpdateCheckState uses the incoming check when nothing is on disk', () => {
  expect(mergeUpdateCheckState({ latest: '1.10.0', checkedAt: 20, fetchStartedAt: 20 })).toEqual({
    latest: '1.10.0',
    checkedAt: 20,
  });
});

test.serial('withUpdateCheckLock serializes overlapping writers', async () => {
  const dir = home();
  try {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = withUpdateCheckLock(async () => {
      enteredFirst();
      order.push(1);
      await firstGate;
      order.push(2);
    });
    await firstEntered;
    const second = withUpdateCheckLock(async () => {
      order.push(3);
    });
    expect(order).toEqual([1]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.serial(
  'withUpdateCheckLock does not steal a live-owner lock from mtime',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    try {
      writeFileSync(lockPath, `${process.pid}\n`);
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);
      await expect(withUpdateCheckLock(async () => 'held', path)).rejects.toThrow();
      expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial(
  'withUpdateCheckLock steals a lock whose owner pid is dead',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    const child = Bun.spawn(['sleep', '30']);
    const deadPid = child.pid;
    child.kill();
    await child.exited;
    try {
      writeFileSync(lockPath, `${deadPid}\n`);
      await expect(withUpdateCheckLock(async () => 'ok', path)).resolves.toBe('ok');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial(
  'withUpdateCheckLock steals a live pid whose recorded starttime does not match',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    const child = Bun.spawn(['sleep', '30']);
    try {
      writeFileSync(lockPath, `${child.pid}\nSat Jan  1 00:00:00 2000\n`);
      await expect(withUpdateCheckLock(async () => 'ok', path)).resolves.toBe('ok');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial(
  'withUpdateCheckLock does not steal a live pid with a matching starttime',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    try {
      const starttime = await processStarttime(process.pid);
      expect(starttime).not.toBeNull();
      writeFileSync(lockPath, `${process.pid}\n${starttime}\n`);
      await expect(withUpdateCheckLock(async () => 'held', path)).rejects.toThrow();
      expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n${starttime}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial(
  'withUpdateCheckLock does not unlink a replacement lock after observing a stale owner',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    const child = Bun.spawn(['sleep', '30']);
    const starttime = await processStarttime(process.pid);
    expect(starttime).not.toBeNull();
    const live = `${process.pid}\n${starttime}\n`;
    writeFileSync(lockPath, `${child.pid}\nSat Jan  1 00:00:00 2000\n`);
    const realStarttime = processIdentity.processStarttime.bind(processIdentity);
    const spy = spyOn(processIdentity, 'processStarttime').mockImplementation(async (pid: number) => {
      if (pid === child.pid) writeFileSync(lockPath, live);
      return realStarttime(pid);
    });
    try {
      await expect(withUpdateCheckLock(async () => 'held', path)).rejects.toThrow();
      expect(readFileSync(lockPath, 'utf8')).toBe(live);
    } finally {
      spy.mockRestore();
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial(
  'withUpdateCheckLock publishes pid and starttime together when starttime is available',
  async () => {
    const dir = home();
    const path = join(dir, 'update-check.json');
    const lockPath = `${path}.lock`;
    const snapshots: string[] = [];
    try {
      let entered!: () => void;
      const enteredGate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = withUpdateCheckLock(async () => {
        entered();
        await Bun.sleep(50);
      }, path);
      const poll = (async () => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try {
            snapshots.push(readFileSync(lockPath, 'utf8'));
          } catch {
            // Create and first write have not landed yet.
          }
          await Bun.sleep(0);
        }
      })();
      await enteredGate;
      await hold;
      await poll;
      const pidOnly = snapshots.some((raw) => {
        const lines = raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        return lines.length === 1 && lines[0] === String(process.pid);
      });
      expect(pidOnly).toBe(false);
      expect(
        snapshots.some((raw) => {
          const lines = raw
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
          return lines[0] === String(process.pid) && lines[1] !== undefined && lines[1] !== '';
        }),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);

test.serial('withUpdateCheckLock does not unlink a lock owned by another pid', async () => {
  const dir = home();
  const path = join(dir, 'update-check.json');
  const lockPath = `${path}.lock`;
  try {
    await withUpdateCheckLock(async () => {
      writeFileSync(lockPath, '999999999\n');
    }, path);
    expect(readFileSync(lockPath, 'utf8')).toBe('999999999\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
