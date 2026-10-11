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

type FakeConnect = {
  unit: { present: boolean; home: string | null; owner: string | null };
  job: { disabled: boolean };
  instance: { reachable: boolean; controlUrl: string | null };
};

/** `unitHome` stands in for a unit installed somewhere other than the home the smoke passed. */
async function runServiceSmokeWithFakes(unitHome?: string) {
  const commands: string[][] = [];
  // Lifecycle commands and process checks in the order they ran.
  const events: string[] = [];
  const connects: FakeConnect[] = [];
  const envs: Array<Readonly<Record<string, string>>> = [];
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
    home: '/tmp/smoke-home',
    run: async ([, ...args], env) => {
      envs.push(env);
      if (args[0] === '__desktop-connect') {
        const connect = {
          unit: service.uninstalled
            ? { present: false, home: null, owner: null }
            : { present: true, home: unitHome ?? env['AIO_PROXY_HOME'] ?? null, owner: 'desktop' },
          job: { disabled: !service.enabled },
          instance: { reachable: service.running, controlUrl: service.running ? 'http://127.0.0.1:1' : null },
        };
        connects.push(connect);
        return JSON.stringify(connect);
      }
      commands.push(args);
      events.push(args.join(' '));
      lifecycle[args[1] ?? '']?.();
      return '';
    },
    httpChecks: async () => {},
    processRemains: async () => {
      events.push('processRemains');
      return service.running;
    },
    sleep: async () => {},
    // Advancing time lets a wrong expectation time out instead of hanging the test.
    now: () => (clock += 1_000),
  });
  return { commands, events, connects, envs };
}

test('service smoke checks that a stop and an uninstall stay put', async () => {
  const seen = await runServiceSmokeWithFakes();
  expect(seen.commands).toEqual([
    ['service', 'install'],
    ['service', 'start'],
    ['service', 'stop'],
    ['service', 'start'],
    ['service', 'restart'],
    ['service', 'uninstall'],
  ]);
  // Every CLI call, discovery included, must target the throwaway home as the desktop-owned exec.
  expect(seen.envs.every((env) => env['AIO_PROXY_HOME'] === '/tmp/smoke-home')).toBe(true);
  expect(seen.envs.every((env) => env['AIO_PROXY_DESKTOP_EXEC'] === '/opt/aio-proxy')).toBe(true);
  expect(seen.events.slice(-2)).toEqual(['service uninstall', 'processRemains']);
  expect(seen.connects.map((c) => [c.job.disabled, c.instance.reachable])).toEqual([
    [false, true],
    [true, false],
    [false, true],
    [false, true],
    [true, false],
  ]);
});

test('a unit recording some other home fails at the first discovery instead of timing out', async () => {
  await expect(runServiceSmokeWithFakes('/home/runner/.aio-proxy')).rejects.toThrow(
    "the unit is not the smoke's desktop-owned service at /tmp/smoke-home",
  );
});
