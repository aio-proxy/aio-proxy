import { expect, test } from 'bun:test';

import { hasJitRegion, serviceSmoke } from './smoke';

const jitRows = `
MALLOC_SMALL                 150000000-150800000    [ 8192K   212K   212K     0K] rw-/rwx SM=PRV
JS JIT Generated Code       121e04000-121e08000    [   16K     0K     0K     0K] ---/rwx SM=NUL
JS JIT Generated Code       121e08000-141e08000    [512.0M  2016K  2016K     0K] rwx/rwx SM=PRV
`;

test('finds the JIT region vmmap lists while JavaScriptCore can JIT', () => {
  expect(hasJitRegion(jitRows)).toBe(true);
});

test('an interpreted-only process (no allow-jit) or empty output has no JIT region', () => {
  expect(hasJitRegion('MALLOC_SMALL   150000000-150800000 [ 8192K ] rw-/rwx SM=PRV\n')).toBe(false);
  expect(hasJitRegion('')).toBe(false);
});

type FakeConnect = { job: { disabled: boolean }; instance: { reachable: boolean; controlUrl: string | null } };

async function runServiceSmokeWithFakes() {
  const commands: string[][] = [];
  const connects: FakeConnect[] = [];
  let clock = 0;
  const service = { enabled: false, running: false, uninstalled: false };
  const lifecycle: Record<string, () => void> = {
    install: () => Object.assign(service, { enabled: true, uninstalled: false }),
    start: () => Object.assign(service, { enabled: true, running: true }),
    stop: () => Object.assign(service, { enabled: false, running: false }),
    restart: () => Object.assign(service, { enabled: true, running: true }),
    uninstall: () => Object.assign(service, { enabled: false, running: false, uninstalled: true }),
  };
  await serviceSmoke('/opt/aio-proxy', {
    run: async ([, ...args]) => {
      if (args[0] === '__desktop-connect') {
        const connect = {
          job: { disabled: !service.enabled },
          instance: { reachable: service.running, controlUrl: service.running ? 'http://127.0.0.1:1' : null },
        };
        connects.push(connect);
        return JSON.stringify(connect);
      }
      commands.push(args);
      lifecycle[args[1] ?? '']?.();
      return '';
    },
    httpChecks: async () => {},
    processRemains: async () => service.running,
    sleep: async () => {},
    // Advancing time lets a wrong expectation time out instead of hanging the test.
    now: () => (clock += 1_000),
  });
  return { commands, connects };
}

test('service smoke checks that a stop and an uninstall stay put', async () => {
  const seen = await runServiceSmokeWithFakes();
  expect(seen.commands.slice(0, 2)).toEqual([
    ['service', 'install'],
    ['service', 'start'],
  ]);
  expect(seen.connects.map((c) => [c.job.disabled, c.instance.reachable])).toEqual([
    [false, true],
    [true, false],
    [false, true],
    [false, true],
    [true, false],
  ]);
});
