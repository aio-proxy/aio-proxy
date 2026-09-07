import { expect, mock, test } from 'bun:test';

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

const base = {
  isManagedService: () => true,
  currentVersion: '1.2.0',
  fetchLatest: async () => '1.10.0',
  setInterval: () => 1,
  clearInterval: () => {},
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
  });
  controller.start();
  await Promise.resolve();
  expect(fetchLatest).toHaveBeenCalledTimes(1);
  expect(fetchLatest).toHaveBeenCalledWith(AUTO_UPDATE_PACKAGE);
  clock.tick();
  await Promise.resolve();
  expect(fetchLatest).toHaveBeenCalledTimes(2);
  controller.stop();
  expect(clock.cleared()).toBe(1);
});

test('tick never calls applyUpdate even when outdated', async () => {
  const applyUpdate = mock(async () => 'installed' as const);
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate,
  });
  controller.start();
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
  controller.stop();
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
  });
  const first = controller.apply();
  await Promise.resolve();
  expect(await controller.apply()).toEqual({ status: 'in_progress' });
  expect(controller.snapshot()).toEqual({ status: 'in_progress' });
  expect(await first).toEqual({ status: 'started' });
  release();
  await Promise.resolve();
  expect(controller.snapshot()).toEqual({ status: 'restart_required' });
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
  });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(unchanged.snapshot()).toEqual({ status: 'idle' });
  expect(await unchanged.apply()).toEqual({ status: 'started' });
});

test('apply reports up_to_date, unavailable, and check_failed', async () => {
  const missing = createAutoUpdateController({
    ...base,
  });
  expect(await missing.apply()).toEqual({ status: 'unavailable' });

  const current = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => '1.2.0',
  });
  expect(await current.apply()).toEqual({ status: 'up_to_date' });

  const offline = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => {
      throw new Error('offline');
    },
  });
  expect(await offline.apply()).toEqual({ status: 'check_failed' });
  expect(offline.snapshot()).toEqual({ status: 'failed' });

  const malformed = createAutoUpdateController({
    ...base,
    applyUpdate: async () => 'installed',
    fetchLatest: async () => 'not-a-version',
  });
  expect(await malformed.apply()).toEqual({ status: 'check_failed' });
  expect(malformed.snapshot()).toEqual({ status: 'failed' });
  expect(await malformed.apply()).toEqual({ status: 'check_failed' });
});

test('applyUpdate failure sets failed and releases the lock', async () => {
  const controller = createAutoUpdateController({
    ...base,
    applyUpdate: async () => {
      throw new Error('install failed');
    },
    onError: mock(() => {}),
  });
  expect(await controller.apply()).toEqual({ status: 'started' });
  await Promise.resolve();
  expect(controller.snapshot()).toEqual({ status: 'failed' });
  expect(await controller.apply()).toEqual({ status: 'started' });
});

test('stop during a pending check does not apply', async () => {
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
    applyUpdate,
    fetchLatest,
  });
  controller.start();
  await Promise.resolve();
  controller.stop();
  releaseFetch('1.10.0');
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
});

test('start without applyUpdate still checks', async () => {
  const fetchLatest = mock(async () => '1.10.0');
  const setInterval = mock(() => 1);
  const controller = createAutoUpdateController({
    ...base,
    currentVersion: '1.0.0',
    fetchLatest,
    setInterval,
  });
  controller.start();
  await Promise.resolve();
  expect(setInterval).toHaveBeenCalledTimes(1);
  expect(fetchLatest).toHaveBeenCalledTimes(1);
});
