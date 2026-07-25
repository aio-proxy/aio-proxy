import { afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../index';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-trace-'));
  homes.push(home);
  return home;
}

export function openTestDb() {
  return openDb({ home: tempHome() });
}
