import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliRunArgs, freePort, repoCwd, waitForOk } from './cli-test-helpers';

test.each(['SIGINT', 'SIGTERM'] as const)(
  '%s closes the app before the CLI exits',
  async (signal) => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-run-close-'));
    const port = freePort();
    const start = () =>
      Bun.spawn(cliRunArgs(port), {
        cwd: repoCwd,
        env: { ...process.env, AIO_PROXY_HOME: home },
        stderr: 'ignore',
        stdout: 'ignore',
      });
    const first = start();
    await waitForOk(`http://127.0.0.1:${port}/health`, {
      probeTimeoutMs: 250,
      readinessTimeoutMs: 20_000,
    });
    first.kill(signal);
    await first.exited;
    expect(existsSync(join(home, 'aio-proxy.db.server.lock'))).toBe(false);

    const restarted = start();
    await waitForOk(`http://127.0.0.1:${port}/health`, {
      probeTimeoutMs: 250,
      readinessTimeoutMs: 20_000,
    });
    restarted.kill(signal);
    await restarted.exited;
  },
  60_000,
);
