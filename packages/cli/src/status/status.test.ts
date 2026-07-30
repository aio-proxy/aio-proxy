import { expect, test } from 'bun:test';

import { statusCommand } from './status';

test('status reports running + version from /health', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: 'ok', uptime: 1, version: '1.2.3' }),
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port) }, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('1.2.3');
    expect(out).toContain(String(server.port));
  } finally {
    server.stop(true);
  }
});

test('status reports not-running when the server is unreachable', async () => {
  // Reserve then release a port so nothing is listening.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const deadPort = probe.port;
  probe.stop(true);

  const lines: string[] = [];
  await statusCommand({ port: String(deadPort) }, (l) => lines.push(l));
  expect(lines.join('\n')).toContain(String(deadPort));
  // Not-running is a normal (non-throwing) outcome; the exit-code contract is Task 6.
});

test('--deep notes the limitation when the providers endpoint is password-gated', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      // provider probe endpoint is auth-gated → 401
      return new Response('Unauthorized', { status: 401 });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true }, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('1.2.3');
    expect(out.toLowerCase()).toContain('password');
  } finally {
    server.stop(true);
  }
});
