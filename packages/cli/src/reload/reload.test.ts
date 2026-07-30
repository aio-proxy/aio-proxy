import { expect, test } from 'bun:test';

import { ReloadError } from '../errors';
import { reloadCommand } from './reload';

test('reload posts /admin/reload and resolves on ok', async () => {
  let hit = '';
  let method = '';
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      hit = new URL(req.url).pathname;
      method = req.method;
      return Response.json({ ok: true, diff: {} });
    },
  });
  try {
    await reloadCommand({ port: String(server.port) });
    expect(hit).toBe('/admin/reload');
    expect(method).toBe('POST');
  } finally {
    server.stop(true);
  }
});

test('reload throws a user-facing error when the server reports failure', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: false, error: 'boom', stage: 'validate' }, { status: 409 }),
  });
  try {
    let caught: unknown;
    await reloadCommand({ port: String(server.port) }).catch((err) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(ReloadError);
    expect((caught as Error).message).toContain('boom');
    // A 409 is a terminal reload rejection (invalid config): retrying is futile.
    expect((caught as ReloadError).transient).toBe(false);
  } finally {
    server.stop(true);
  }
});

test('a 5xx reload failure is flagged transient so automation keeps retrying', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: false, error: 'busy' }, { status: 503 }),
  });
  try {
    let caught: unknown;
    await reloadCommand({ port: String(server.port) }).catch((err) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(ReloadError);
    expect((caught as ReloadError).transient).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('an unreachable daemon flags the reload failure transient', async () => {
  // Reserve then release a port so the POST cannot connect at all.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const deadPort = probe.port;
  probe.stop(true);

  let caught: unknown;
  await reloadCommand({ port: String(deadPort) }).catch((err) => {
    caught = err;
  });
  expect(caught).toBeInstanceOf(ReloadError);
  expect((caught as ReloadError).transient).toBe(true);
});
