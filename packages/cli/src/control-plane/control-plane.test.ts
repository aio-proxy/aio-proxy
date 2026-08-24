import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  controlBaseUrl,
  DEFAULT_CONTROL_HOST,
  DEFAULT_CONTROL_PORT,
  probeHealth,
  resolveControlAddress,
} from './control-plane';

test('controlBaseUrl brackets an IPv6 host so the URL is valid', () => {
  // Raw interpolation would yield http://::1:9317, which is not a parseable URL
  // and makes every control-plane probe wrongly report the daemon unavailable.
  expect(controlBaseUrl('::1', '9317')).toBe('http://[::1]:9317');
  expect(() => new URL(controlBaseUrl('::1', '9317'))).not.toThrow();
  expect(controlBaseUrl('127.0.0.1', '9317')).toBe('http://127.0.0.1:9317');
});

test("probeHealth only accepts a response carrying aio-proxy's status marker", async () => {
  const cases: Array<{ body: unknown; running: boolean }> = [
    { body: { status: 'ok', version: '1.2.3' }, running: true },
    { body: {}, running: false }, // another service answering /health must not count
    { body: 'ok', running: false }, // a bare JSON string is not our health shape
    { body: { status: 'degraded' }, running: false },
  ];
  for (const { body, running } of cases) {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(body) });
    try {
      const health = await probeHealth(`http://127.0.0.1:${server.port}`);
      expect(health !== null).toBe(running);
    } finally {
      server.stop(true);
    }
  }
});

// resolveControlAddress lets status/reload/doctor honor a config-only bind so a
// non-default server.host/server.port is not mistaken for a down daemon, while an
// explicit flag still wins and a broken/absent config falls back to loopback.
const withHome = async (setup: (home: string) => void, run: () => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), 'aio-ctrl-'));
  const prev = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  try {
    setup(home);
    await run();
  } finally {
    if (prev === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

test('resolveControlAddress falls back to the configured server.host/port', async () => {
  await withHome(
    (home) =>
      writeFileSync(join(home, 'config.jsonc'), '{ "server": { "host": "::1", "port": 8080 }, "providers": {} }\n'),
    async () => {
      const { host, port } = await resolveControlAddress({});
      expect(host).toBe('::1');
      expect(port).toBe('8080');
      // The resolved IPv6 host must still produce a valid bracketed URL.
      expect(controlBaseUrl(host, port)).toBe('http://[::1]:8080');
    },
  );
});

test('an explicit flag overrides the configured value', async () => {
  await withHome(
    (home) => writeFileSync(join(home, 'config.jsonc'), '{ "server": { "port": 8080 }, "providers": {} }\n'),
    async () => {
      const { port } = await resolveControlAddress({ port: '9999' });
      expect(port).toBe('9999');
    },
  );
});

test('a malformed config falls back to the loopback defaults instead of throwing', async () => {
  await withHome(
    (home) => writeFileSync(join(home, 'config.jsonc'), '{ not valid json'),
    async () => {
      const addr = await resolveControlAddress({});
      expect(addr).toEqual({ host: DEFAULT_CONTROL_HOST, port: DEFAULT_CONTROL_PORT });
    },
  );
});

test('the shared control address resolves host and port templates from service.env', async () => {
  const previousHost = process.env.AGENT_BIND_HOST;
  const previousPort = process.env.AGENT_BIND_PORT;
  try {
    delete process.env.AGENT_BIND_HOST;
    delete process.env.AGENT_BIND_PORT;
    await withHome(
      (home) => {
        writeFileSync(
          join(home, 'config.jsonc'),
          JSON.stringify({
            server: { host: '{{env.AGENT_BIND_HOST}}', port: '{{env.AGENT_BIND_PORT}}' },
            providers: {},
          }),
        );
        writeFileSync(join(home, 'service.env'), 'AGENT_BIND_HOST=127.0.0.9\nAGENT_BIND_PORT=9417\n');
      },
      async () => {
        await expect(resolveControlAddress({})).resolves.toEqual({ host: '127.0.0.9', port: '9417' });
      },
    );
  } finally {
    if (previousHost === undefined) delete process.env.AGENT_BIND_HOST;
    else process.env.AGENT_BIND_HOST = previousHost;
    if (previousPort === undefined) delete process.env.AGENT_BIND_PORT;
    else process.env.AGENT_BIND_PORT = previousPort;
  }
});
