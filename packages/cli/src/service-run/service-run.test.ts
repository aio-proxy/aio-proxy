import { expect, test } from 'bun:test';

import { decide, runSupervisor, type SupervisorDeps } from './service-run';

const fakes: SupervisorDeps = {
  readSpec: () => ({ exec: 'A', env: {} }),
  exists: () => true,
  spawnChild: async () => 0,
  writeState: () => {},
  sleep: async () => {},
  pid: 4242,
};

test('exit codes map to systemd-like decisions', () => {
  expect(decide(0)).toBe('stop');
  expect(decide(1)).toBe('stop');
  expect(decide(75)).toBe('relaunch-now');
  expect(decide(2)).toBe('relaunch-later');
  expect(decide(137)).toBe('relaunch-later');
});

test('supervisor re-reads the spec on 75, backs off 5 s on a crash, and stops cleanly when exec vanishes', async () => {
  let spec = { exec: 'A', env: {} };
  const runs: string[] = [];
  const sleeps: number[] = [];
  let exists = true;
  const code = await runSupervisor('spec.json', {
    readSpec: () => spec,
    exists: () => exists,
    pid: 4242,
    writeState: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    spawnChild: async (e) => {
      runs.push(e);
      if (runs.length === 1) {
        spec = { exec: 'B', env: {} };
        return 75;
      }
      if (runs.length === 3) exists = false;
      return 2;
    },
  });
  expect(runs).toEqual(['A', 'B', 'B']);
  expect(sleeps).toEqual([5000, 5000]);
  expect(code).toBe(0);
});

test('an unreadable spec stops the supervisor with 1', async () => {
  expect(await runSupervisor('spec.json', { ...fakes, readSpec: () => undefined })).toBe(1);
});
