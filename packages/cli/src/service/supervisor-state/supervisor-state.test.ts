import { expect, test } from 'bun:test';

import { parseSupervisorState, supervisorAlive } from './supervisor-state';

const exec = 'C:\\Users\\Ada\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
const created = '133000000000000000';

test('a state file without the supervisor image or start time (older format) or with a bad pid has no record', () => {
  expect(parseSupervisorState(JSON.stringify({ pid: 4310, exec, created }))).toEqual({ pid: 4310, exec, created });
  expect(parseSupervisorState(JSON.stringify({ pid: 4310, exec }))).toBeUndefined();
  expect(parseSupervisorState('{"pid":4310}')).toBeUndefined();
  expect(parseSupervisorState(JSON.stringify({ pid: 0, exec, created }))).toBeUndefined();
  expect(parseSupervisorState('garbage')).toBeUndefined();
  expect(parseSupervisorState(undefined)).toBeUndefined();
});

test('the supervisor is alive only while its PID runs the image it recorded, started when it did', () => {
  const state = { pid: 4310, exec, created };
  expect(
    supervisorAlive(
      state,
      () => exec.toUpperCase(),
      () => created,
    ),
  ).toBe(true);
  // The PID was recycled by another program, or nothing runs at it.
  expect(
    supervisorAlive(
      state,
      () => 'C:\\Windows\\System32\\notepad.exe',
      () => created,
    ),
  ).toBe(false);
  expect(
    supervisorAlive(
      state,
      () => undefined,
      () => undefined,
    ),
  ).toBe(false);
  // Recycled by a manual run of the same binary: same image, later start.
  expect(
    supervisorAlive(
      state,
      () => exec,
      () => '133000000000000001',
    ),
  ).toBe(false);
  expect(
    supervisorAlive(
      undefined,
      () => exec,
      () => created,
    ),
  ).toBe(false);
});
