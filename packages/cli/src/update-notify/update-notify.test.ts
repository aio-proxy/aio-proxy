import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCheckState, writeUpdateCheckState } from '@aio-proxy/core';

import { notifyUpdateAvailable, printUpdateBanner, shouldPrintUpdateBanner } from './update-notify';

const original = process.env.AIO_PROXY_HOME;

afterEach(() => {
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

test('skips the banner for upgrade, Codex auth, and version flags', () => {
  expect(shouldPrintUpdateBanner('status', ['aio-proxy', 'status'])).toBe(true);
  expect(shouldPrintUpdateBanner('upgrade', ['aio-proxy', 'upgrade'])).toBe(false);
  expect(shouldPrintUpdateBanner('update', ['aio-proxy', 'update'])).toBe(false);
  expect(shouldPrintUpdateBanner('auth', ['aio-proxy', 'agent', 'auth', 'codex'])).toBe(false);
  expect(shouldPrintUpdateBanner('status', ['aio-proxy', '--version'])).toBe(false);
  expect(shouldPrintUpdateBanner('run', ['aio-proxy', '-v'])).toBe(false);
});

test('prints a banner only when the persisted latest is newer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-banner-'));
  process.env.AIO_PROXY_HOME = home;
  const lines: string[] = [];
  try {
    printUpdateBanner('1.0.0', (line) => lines.push(line));
    expect(lines).toEqual([]);
    await writeUpdateCheckState({ latest: '1.0.0', checkedAt: 1 });
    printUpdateBanner('1.0.0', (line) => lines.push(line));
    expect(lines).toEqual([]);
    await writeUpdateCheckState({ latest: '2.0.0', checkedAt: 1 });
    printUpdateBanner('1.0.0', (line) => lines.push(line));
    expect(lines.join('\n')).toContain('2.0.0');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('notify-send receives the version on Linux', async () => {
  if (process.platform !== 'linux') return;
  const calls: string[][] = [];
  const home = mkdtempSync(join(tmpdir(), 'aio-notify-linux-'));
  try {
    await notifyUpdateAvailable(
      '2.0.0',
      async (command) => {
        calls.push([...command]);
      },
      join(home, 'notifications.json'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  expect(calls[0]?.[0]).toBe('notify-send');
  expect(calls[0]?.join(' ')).toContain('2.0.0');
});

test('desktop notifications are deduplicated across homes, concurrent callers, and restarts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-notify-'));
  const path = join(home, 'notifications.json');
  const calls: string[][] = [];
  const spawn = async (command: readonly string[]) => {
    calls.push([...command]);
  };
  try {
    process.env.AIO_PROXY_HOME = join(home, 'instance-a');
    await Promise.all([notifyUpdateAvailable('2.0.0', spawn, path), notifyUpdateAvailable('2.0.0', spawn, path)]);
    process.env.AIO_PROXY_HOME = join(home, 'instance-b');
    await notifyUpdateAvailable('2.0.0', spawn, path);
    await notifyUpdateAvailable('1.9.0', spawn, path);
    await notifyUpdateAvailable('2.0.0', spawn, path);
    expect(calls).toHaveLength(process.platform === 'darwin' || process.platform === 'linux' ? 1 : 0);
    await notifyUpdateAvailable('2.1.0', spawn, path);
    expect(calls).toHaveLength(process.platform === 'darwin' || process.platform === 'linux' ? 2 : 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const failure of ['lock', 'state'] as const) {
  test(`still sends a desktop notification when shared ${failure} persistence fails`, async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const home = mkdtempSync(join(tmpdir(), 'aio-notify-unwritable-'));
    const path = join(home, 'shared', 'notifications.json');
    const calls: string[][] = [];
    try {
      process.env.AIO_PROXY_HOME = join(home, 'instance');
      await writeUpdateCheckState({ latest: '2.0.0', checkedAt: 1 });
      // File collisions fail deterministically even when tests run as root.
      if (failure === 'lock') writeFileSync(join(home, 'shared'), '');
      else mkdirSync(path, { recursive: true });
      await notifyUpdateAvailable(
        '2.0.0',
        async (command) => {
          calls.push([...command]);
        },
        path,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.join(' ')).toContain('2.0.0');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const failure of ['missing', 'nonzero'] as const) {
  test(`a ${failure} notification command does not suppress a later instance`, async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const home = mkdtempSync(join(tmpdir(), 'aio-notify-delivery-'));
    const path = join(home, 'notifications.json');
    try {
      if (failure === 'nonzero') {
        writeFileSync(join(home, process.platform === 'darwin' ? 'osascript' : 'notify-send'), '#!/bin/sh\nexit 1\n', {
          mode: 0o755,
        });
      }
      const child = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `import { notifyUpdateAvailable } from ${JSON.stringify(new URL('./update-notify.ts', import.meta.url).pathname)}; await notifyUpdateAvailable('2.0.0', undefined, ${JSON.stringify(path)});`,
        ],
        { env: { ...process.env, PATH: home }, stdout: 'ignore', stderr: 'pipe' },
      );
      expect(await child.exited).toBe(0);
      expect(readUpdateCheckState(path)).toBeUndefined();
      let calls = 0;
      await notifyUpdateAvailable(
        '2.0.0',
        async () => {
          calls += 1;
        },
        path,
      );
      expect(calls).toBe(1);
      expect(readUpdateCheckState(path)?.latest).toBe('2.0.0');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const succeeds of [true, false]) {
  test(`a waiter survives lock timeout when the first delivery ${succeeds ? 'succeeds' : 'fails'}`, async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const home = mkdtempSync(join(tmpdir(), 'aio-notify-busy-'));
    const path = join(home, 'notifications.json');
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    let retries = 0;
    let settled = false;
    const first = notifyUpdateAvailable(
      '2.0.0',
      async () => {
        started();
        await delivery;
        if (!succeeds) throw new Error('No graphical session');
      },
      path,
    );
    let second: Promise<void> | undefined;
    try {
      await sending;
      second = notifyUpdateAvailable(
        '2.0.0',
        async () => {
          retries += 1;
        },
        path,
      ).then(() => {
        settled = true;
      });
      // Keep delivery pending beyond the lock helper's six-second timeout.
      await Bun.sleep(6_500);
      expect(retries).toBe(0);
      expect(settled).toBe(false);
      expect(readUpdateCheckState(path)).toBeUndefined();
      release();
      await Promise.all([first, second]);
      expect(retries).toBe(succeeds ? 0 : 1);
      expect(readUpdateCheckState(path)?.latest).toBe('2.0.0');
    } finally {
      release();
      await Promise.all([first, second]);
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
}
