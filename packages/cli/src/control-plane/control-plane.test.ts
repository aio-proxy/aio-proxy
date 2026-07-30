import { expect, test } from 'bun:test';

import { controlBaseUrl, probeHealth } from './control-plane';

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
