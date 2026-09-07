import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('withUpdateCheckLock serializes overlapping writers', async () => {
  const dir = home();
  try {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withUpdateCheckLock(async () => {
      order.push(1);
      await firstGate;
      order.push(2);
    });
    await Promise.resolve();
    const second = withUpdateCheckLock(async () => {
      order.push(3);
    });
    await Promise.resolve();
    expect(order).toEqual([1]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
