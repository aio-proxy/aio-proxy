import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCheckState, writeUpdateCheckState } from './update-check';

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
