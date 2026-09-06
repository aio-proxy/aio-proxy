import { expect, test } from 'bun:test';

import { websocket } from '@aio-proxy/server';

import { EDITS_MULTIPART_ENCODED_LIMIT } from '../../../core/src/ingress/openai-image/multipart-counters';
import { MAX_REQUEST_BODY_SIZE, proxyServeOptions } from './run';

test('serve maxRequestBodySize matches the edits multipart encoded limit', () => {
  expect(MAX_REQUEST_BODY_SIZE).toBe(EDITS_MULTIPART_ENCODED_LIMIT);
  expect(MAX_REQUEST_BODY_SIZE).toBeGreaterThanOrEqual(851_048_559);
});

/** The realtime routes attach through `upgradeWebSocket`, which calls `server.upgrade()` —
 *  something no `app.request()` test can reach, and something Bun refuses outright unless the
 *  `Bun.serve` call site carries a `websocket` handler. Bound as a real server here so a
 *  missing `websocket` key, or a `fetch` wrapper that drops Bun's second argument (the route
 *  reaches the server through `c.env`), is a failed upgrade rather than a silent 503 in
 *  production. */
test('the proxy serve options can complete a real websocket upgrade and relay a frame', async () => {
  // Stands in for the Hono app: it upgrades through the same `ws.data.events` contract that
  // `hono/bun`'s `upgradeWebSocket` uses, so the handler under test is the production one.
  const app = {
    fetch: (request: Request, server?: { upgrade: (request: Request, options: unknown) => boolean }) => {
      if (server === undefined) return new Response('fetch lost Bun’s server argument', { status: 500 });
      const upgraded = server.upgrade(request, {
        data: {
          url: new URL(request.url),
          protocol: '',
          events: {
            onOpen: (_event: Event, ws: { send: (data: string) => void }) => ws.send('opened'),
            onMessage: (event: { data: unknown }, ws: { send: (data: string) => void }) =>
              ws.send(`echo:${String(event.data)}`),
          },
        },
      });
      return upgraded ? undefined : new Response('not upgraded', { status: 400 });
    },
  };

  const server = Bun.serve(proxyServeOptions(app as never, '127.0.0.1', 0));
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/v1/live/call_abc`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('error', () => reject(new Error('the upgrade was refused')));
      client.addEventListener('message', (event: MessageEvent<string>) => {
        received.push(event.data);
        if (received.length === 2) resolve();
      });
      client.addEventListener('open', () => client.send('ping'));
      setTimeout(() => reject(new Error(`only received ${received.length} frames: ${received.join(', ')}`)), 5_000);
    });

    expect(received).toEqual(['opened', 'echo:ping']);
    client.close(1_000);
  } finally {
    server.stop(true);
  }
});

/** Bun's `websocket` handler has its own idle window, defaulting to 120s; the top-level
 *  `idleTimeout: 255` does not carry over to an upgraded socket, so a long-quiet realtime
 *  session would be dropped at 120s without this. Asserted alongside the invariant that makes
 *  it safe: `websocket` is a module singleton shared by every importer of `hono/bun`, so it
 *  must be spread — mutating it would set the timeout for unrelated call sites too. */
test('the websocket handler carries its own 255s idle window without mutating Hono’s singleton', () => {
  const options = proxyServeOptions({ fetch: () => new Response(null) } as never, '127.0.0.1', 0);

  expect(options.websocket.idleTimeout).toBe(255);
  expect(options.idleTimeout).toBe(255);
  expect(options.websocket).not.toBe(websocket);
  expect(websocket).not.toHaveProperty('idleTimeout');
  // `sendPings` stays at its default `true`; pinning it here would be pinning Bun's default.
  expect(options.websocket).not.toHaveProperty('sendPings');
});
