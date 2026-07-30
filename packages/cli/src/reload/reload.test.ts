import { expect, test } from 'bun:test';

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
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('boom');
  } finally {
    server.stop(true);
  }
});
