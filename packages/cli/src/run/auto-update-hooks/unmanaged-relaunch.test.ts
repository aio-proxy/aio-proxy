import { expect, test } from 'bun:test';

import { scheduleUnmanagedRelaunch } from './unmanaged-relaunch';

test('schedules a detached helper that execs the new launcher then exits this process', () => {
  const spawned: { readonly cmd: string[]; readonly detached?: boolean }[] = [];
  let exited: number | undefined;
  scheduleUnmanagedRelaunch({
    exec: '/opt/aio-proxy',
    args: ['run', '--port', '9317'],
    helperDelayMs: 1000,
    exitDelayMs: 0,
    spawn: ((cmd: string[], options?: { readonly detached?: boolean }) => {
      spawned.push({ cmd, detached: options?.detached });
      return { unref() {} };
    }) as typeof Bun.spawn,
    exit: (code) => {
      exited = code;
    },
  });
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.detached).toBe(true);
  expect(spawned[0]?.cmd[0]).toBe('/bin/sh');
  const script = spawned[0]?.cmd[2] ?? '';
  expect(script).toContain('sleep 1');
  expect(script).toContain("exec '/opt/aio-proxy' 'run' '--port' '9317'");
  expect(exited).toBe(0);
});

test('quotes spaces and single quotes in the relaunch command', () => {
  const spawned: string[] = [];
  scheduleUnmanagedRelaunch({
    exec: '/opt/aio proxy',
    args: ["it's", 'run'],
    exitDelayMs: 0,
    spawn: ((cmd: string[]) => {
      spawned.push(cmd[2] ?? '');
      return { unref() {} };
    }) as typeof Bun.spawn,
    exit: () => {},
  });
  expect(spawned[0]).toContain("'/opt/aio proxy'");
  expect(spawned[0]).toContain(`'it'\\''s'`);
});
