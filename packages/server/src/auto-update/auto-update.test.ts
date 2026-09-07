import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCheckState, type UpdateCheckState } from '@aio-proxy/core';

import { AUTO_UPDATE_PACKAGE, createAutoUpdateController } from './auto-update';

const createClock = () => {
  let handler: (() => void) | undefined;
  let cleared = 0;
  return {
    setInterval: (next: () => void) => {
      handler = next;
      return 1;
    },
    clearInterval: () => {
      cleared += 1;
      handler = undefined;
    },
    tick: () => handler?.(),
    cleared: () => cleared,
  };
};

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const memoryState = (initial?: UpdateCheckState) => {
  let state = initial;
  return {
    readState: () => state,
    writeState: async (next: UpdateCheckState) => {
      state = next;
    },
    get: () => state,
  };
};

const base = {
  isManagedService: () => true,
  currentVersion: '1.2.0',
  fetchLatest: async () => '1.10.0',
  setInterval: () => 1,
  clearInterval: () => {},
  now: () => 1_700_000_000_000,
} as const;

test('start checks immediately and again on each interval tick', async () => {
  const fetchLatest = mock(async () => '1.0.0');
  const clock = createClock();
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    currentVersion: '1.0.0',
    fetchLatest,
    intervalMs: 50,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    ...memoryState(),
  });
  controller.start();
  await flush();
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  expect(fetchLatest).toHaveBeenCalledWith(AUTO_UPDATE_PACKAGE);
  clock.tick();
  await flush();
  expect(fetchLatest).toHaveBeenCalledTimes(2);
  controller.stop();
  expect(clock.cleared()).toBe(1);
});

test('default persist writes the home captured at controller creation', async () => {
  const original = process.env.AIO_PROXY_HOME;
  const homeA = mkdtempSync(join(tmpdir(), 'aio-persist-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'aio-persist-b-'));
  try {
    process.env.AIO_PROXY_HOME = homeA;
    const controller = createAutoUpdateController({
      ...base,
      currentVersion: '1.0.0',
      fetchLatest: async () => '2.0.0',
    });
    process.env.AIO_PROXY_HOME = homeB;
    expect(await controller.check()).toEqual({ current: '1.0.0', latest: '2.0.0', outdated: true });
    expect(readUpdateCheckState(join(homeB, 'update-check.json'))).toBeUndefined();
    expect(readUpdateCheckState(join(homeA, 'update-check.json'))).toEqual({
      latest: '2.0.0',
      checkedAt: 1_700_000_000_000,
    });
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    if (original === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = original;
  }
});

test('tick persists an outdated latest and never calls applyUpdate', async () => {
  const applyUpdate = mock(async () => 'installed' as const);
  const store = memoryState();
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate,
    ...store,
  });
  controller.start();
  await flush();
  expect(applyUpdate).not.toHaveBeenCalled();
  expect(store.get()).toEqual({ latest: '1.10.0', checkedAt: 1_700_000_000_000 });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.10.0', outdated: true });
  controller.stop();
});

test('an outdated check without notifyAvailable does not claim notifiedVersion', async () => {
  const store = memoryState();
  const controller = createAutoUpdateController({
    ...base,
    ...store,
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(store.get()).toEqual({ latest: '1.10.0', checkedAt: 1_700_000_000_000 });
});

test('a later check with notifyAvailable still notifies after a no-callback persist', async () => {
  const store = memoryState();
  const silent = createAutoUpdateController({
    ...base,
    ...store,
  });
  expect(await silent.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  const notifyAvailable = mock(() => {});
  const notifier = createAutoUpdateController({
    ...base,
    notifyAvailable,
    ...store,
  });
  expect(await notifier.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).toHaveBeenCalledTimes(1);
  expect(notifyAvailable).toHaveBeenCalledWith('1.10.0');
  expect(store.get()?.notifiedVersion).toBe('1.10.0');
});

test('second check of the same latest does not notify again', async () => {
  const notifyAvailable = mock(() => {});
  const store = memoryState({ latest: '1.10.0', checkedAt: 1, notifiedVersion: '1.10.0' });
  const controller = createAutoUpdateController({
    ...base,
    notifyAvailable,
    ...store,
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).not.toHaveBeenCalled();
});

test('re-reads on-disk notifiedVersion so a sibling process does not notify twice', async () => {
  let disk: UpdateCheckState | undefined = { latest: '1.5.0', checkedAt: 1 };
  const notifyAvailable = mock(() => {});
  const controller = createAutoUpdateController({
    ...base,
    notifyAvailable,
    readState: () => disk,
    writeState: async (next) => {
      disk = next;
    },
  });
  disk = { latest: '1.10.0', checkedAt: 2, notifiedVersion: '1.10.0' };
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).not.toHaveBeenCalled();
  expect(disk).toEqual({ latest: '1.10.0', checkedAt: 1_700_000_000_000, notifiedVersion: '1.10.0' });
});

test('does not replace a newer on-disk latest with a slower stale fetch', async () => {
  let t = 5;
  let disk: UpdateCheckState | undefined = { latest: '1.5.0', checkedAt: 1 };
  const controller = createAutoUpdateController({
    ...base,
    now: () => t,
    fetchLatest: async () => {
      disk = { latest: '1.11.0', checkedAt: 9, notifiedVersion: '1.11.0' };
      t = 20;
      return '1.10.0';
    },
    notifyAvailable: () => {},
    readState: () => disk,
    writeState: async (next) => {
      disk = next;
    },
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(disk).toEqual({ latest: '1.11.0', checkedAt: 9, notifiedVersion: '1.11.0' });
});

test('does not replace a later overlapping rollback with a slower stale higher fetch', async () => {
  let t = 5;
  let disk: UpdateCheckState | undefined = { latest: '1.5.0', checkedAt: 1 };
  const controller = createAutoUpdateController({
    ...base,
    currentVersion: '1.9.0',
    now: () => t,
    fetchLatest: async () => {
      disk = { latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' };
      t = 25;
      return '2.0.0';
    },
    notifyAvailable: () => {},
    readState: () => disk,
    writeState: async (next) => {
      disk = next;
    },
  });
  expect(await controller.check()).toEqual({ current: '1.9.0', latest: '2.0.0', outdated: true });
  expect(disk).toEqual({ latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.9.0', outdated: false });
});

test('a later successful check records a registry rollback', async () => {
  const store = memoryState({ latest: '2.0.0', checkedAt: 1, notifiedVersion: '2.0.0' });
  const controller = createAutoUpdateController({
    ...base,
    currentVersion: '1.9.0',
    fetchLatest: async () => '1.9.0',
    now: () => 20,
    notifyAvailable: () => {},
    ...store,
  });
  expect(await controller.check()).toEqual({ current: '1.9.0', latest: '1.9.0', outdated: false });
  expect(store.get()).toEqual({ latest: '1.9.0', checkedAt: 20, notifiedVersion: '2.0.0' });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.9.0', outdated: false });
});

test('notifyAvailable runs after the persist lock is released', async () => {
  let held = false;
  let notifiedWhileHeld = true;
  const notifyAvailable = mock(() => {
    notifiedWhileHeld = held;
  });
  const controller = createAutoUpdateController({
    ...base,
    notifyAvailable,
    withLock: async (fn) => {
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    },
    ...memoryState(),
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).toHaveBeenCalledTimes(1);
  expect(notifiedWhileHeld).toBe(false);
});

test('claims notifiedVersion before notifyAvailable runs', async () => {
  const store = memoryState();
  const notifyAvailable = mock(() => {
    expect(store.get()?.notifiedVersion).toBe('1.10.0');
  });
  const controller = createAutoUpdateController({
    ...base,
    notifyAvailable,
    ...store,
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).toHaveBeenCalledTimes(1);
});

test('a newer latest notifies once', async () => {
  const notifyAvailable = mock(() => {});
  const store = memoryState({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' });
  const controller = createAutoUpdateController({
    ...base,
    notifyAvailable,
    ...store,
  });
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.10.0', outdated: true });
  expect(notifyAvailable).toHaveBeenCalledTimes(1);
  expect(notifyAvailable).toHaveBeenCalledWith('1.10.0');
  expect(store.get()?.notifiedVersion).toBe('1.10.0');
});

test('persist failure is check_failed and leaves the previous snapshot', async () => {
  const store = memoryState({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' });
  const writeState = mock(async () => {
    throw new Error('erofs');
  });
  const controller = createAutoUpdateController({
    ...base,
    readState: store.readState,
    writeState,
  });
  expect(await controller.check()).toEqual({ status: 'check_failed' });
  expect(store.get()).toEqual({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.5.0', outdated: true });
});

test('tick persist failure stays quiet and does not reject', async () => {
  const writeState = mock(async () => {
    throw new Error('erofs');
  });
  const controller = createAutoUpdateController({
    ...base,
    readState: () => ({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' }),
    writeState,
  });
  controller.start();
  await flush();
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.5.0', outdated: true });
  controller.stop();
});

test('failed fetch leaves the previous file intact', async () => {
  const store = memoryState({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' });
  const controller = createAutoUpdateController({
    ...base,
    fetchLatest: async () => {
      throw new Error('offline');
    },
    ...store,
  });
  controller.start();
  await flush();
  expect(await controller.check()).toEqual({ status: 'check_failed' });
  expect(store.get()).toEqual({ latest: '1.5.0', checkedAt: 1, notifiedVersion: '1.5.0' });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.5.0', outdated: true });
  controller.stop();
});

test('check during an in-progress apply does not fetch again', async () => {
  let release!: () => void;
  const fetchLatest = mock(
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve('1.10.0');
      }),
  );
  const store = memoryState({ latest: '1.5.0', checkedAt: 1 });
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest,
    ...store,
  });
  const apply = controller.apply();
  await Promise.resolve();
  expect(await controller.check()).toEqual({ current: '1.2.0', latest: '1.5.0', outdated: true });
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  release();
  expect(await apply).toEqual({ status: 'started' });
});

test('manual apply ignores the managed gate and is single-flight', async () => {
  let release!: () => void;
  const applyUpdate = mock(
    () =>
      new Promise<'installed'>((resolve) => {
        release = () => resolve('installed');
      }),
  );
  const controller = createAutoUpdateController({
    ...base,
    isManagedService: () => false,
    applyUpdate,
    ...memoryState(),
  });
  const first = controller.apply();
  await Promise.resolve();
  expect(await controller.apply()).toEqual({ status: 'in_progress' });
  expect(controller.snapshot()).toMatchObject({ status: 'in_progress' });
  expect(await first).toEqual({ status: 'started' });
  release();
  await Promise.resolve();
  expect(controller.snapshot()).toMatchObject({ status: 'restart_required' });
});

test('second apply during a pending fetchLatest is in_progress and does not apply twice', async () => {
  let releaseFetch!: (version: string) => void;
  const fetchLatest = mock(
    () =>
      new Promise<string>((resolve) => {
        releaseFetch = resolve;
      }),
  );
  const applyUpdate = mock(async () => 'installed' as const);
  const controller = createAutoUpdateController({
    ...base,
    isManagedService: () => false,
    applyUpdate,
    fetchLatest,
    ...memoryState(),
  });
  const first = controller.apply();
  await Promise.resolve();
  expect(await controller.apply()).toEqual({ status: 'in_progress' });
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  releaseFetch('1.10.0');
  expect(await first).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(applyUpdate).toHaveBeenCalledTimes(1);
  expect(applyUpdate).toHaveBeenCalledWith('1.10.0');
});

test('applyUpdate unchanged returns to idle; installed stays restart_required', async () => {
  const unchanged = createAutoUpdateController({
    ...base,
    applyUpdate: async (version) => {
      expect(version).toBe('1.10.0');
      return 'unchanged';
    },
    ...memoryState(),
  });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(unchanged.snapshot()).toMatchObject({ status: 'idle' });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
});

test('apply up_to_date persists the current latest so later snapshots are not outdated', async () => {
  const store = memoryState({ latest: '1.10.0', checkedAt: 1, notifiedVersion: '1.10.0' });
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => '1.2.0',
    now: () => 20,
    ...store,
  });
  expect(await controller.apply()).toEqual({ status: 'up_to_date' });
  expect(store.get()).toEqual({ latest: '1.2.0', checkedAt: 20, notifiedVersion: '1.10.0' });
  expect(controller.snapshot()).toEqual({ status: 'idle', latest: '1.2.0', outdated: false });
});

test('apply reports up_to_date, unavailable, and check_failed', async () => {
  const missing = createAutoUpdateController({
    ...base,
    ...memoryState(),
  });
  expect(await missing.apply()).toEqual({ status: 'unavailable' });

  const current = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => '1.2.0',
    ...memoryState(),
  });
  expect(await current.apply()).toEqual({ status: 'up_to_date' });

  const offline = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => {
      throw new Error('offline');
    },
    ...memoryState(),
  });
  expect(await offline.apply()).toEqual({ status: 'check_failed' });
  expect(offline.snapshot()).toMatchObject({ status: 'failed' });

  const malformed = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => 'not-a-version',
    ...memoryState(),
  });
  expect(await malformed.apply()).toEqual({ status: 'check_failed' });
  expect(malformed.snapshot()).toMatchObject({ status: 'failed' });
  expect(await malformed.apply()).toEqual({ status: 'check_failed' });
});

test('applyUpdate failure sets failed and releases the lock', async () => {
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate: async () => {
      throw new Error('install failed');
    },
    onError: mock(() => {}),
    ...memoryState(),
  });
  expect(await controller.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(controller.snapshot()).toMatchObject({ status: 'failed' });
  expect(await controller.apply()).toEqual({ status: 'started' });
});

test('start without applyUpdate still checks and persists', async () => {
  const fetchLatest = mock(async () => '1.10.0');
  const setInterval = mock(() => 1);
  const store = memoryState();
  const controller = createAutoUpdateController({
    ...base,
    currentVersion: '1.0.0',
    fetchLatest,
    setInterval,
    ...store,
  });
  controller.start();
  await flush();
  expect(setInterval).toHaveBeenCalledTimes(1);
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  expect(store.get()?.latest).toBe('1.10.0');
  expect(await controller.apply()).toEqual({ status: 'unavailable' });
});
