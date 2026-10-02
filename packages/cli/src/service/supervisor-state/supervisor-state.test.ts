import { expect, test } from 'bun:test';

import { parseSupervisorState, supervisorAlive } from './supervisor-state';

const exec = 'C:\\Users\\Ada\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';

test('a state file without the supervisor image (older format) or with a bad pid has no record', () => {
  expect(parseSupervisorState(JSON.stringify({ pid: 4310, exec }))).toEqual({ pid: 4310, exec });
  expect(parseSupervisorState('{"pid":4310}')).toBeUndefined();
  expect(parseSupervisorState(JSON.stringify({ pid: 0, exec }))).toBeUndefined();
  expect(parseSupervisorState('garbage')).toBeUndefined();
  expect(parseSupervisorState(undefined)).toBeUndefined();
});

test('the supervisor is alive only while its PID runs the image it recorded', () => {
  const state = { pid: 4310, exec };
  expect(supervisorAlive(state, () => exec.toUpperCase())).toBe(true);
  // The PID was recycled by another program, or nothing runs at it.
  expect(supervisorAlive(state, () => 'C:\\Windows\\System32\\notepad.exe')).toBe(false);
  expect(supervisorAlive(state, () => undefined)).toBe(false);
  expect(supervisorAlive(undefined, () => exec)).toBe(false);
});
