import { expect, test } from 'bun:test';

import { websocket } from '@aio-proxy/server';

import { EDITS_MULTIPART_ENCODED_LIMIT } from '../../../core/src/ingress/openai-image/multipart-counters';
import { MAX_REQUEST_BODY_SIZE, proxyServeOptions, shutdownProxyServer } from './run';

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

/** The realtime shutdown contract, measured over a real upgraded socket.
 *
 *  Bun 1.4.2 dispatches an upgraded socket's `close` handler **synchronously inside**
 *  `server.stop(true)`, with code `1006`. `1006` is in the relay's unforwardable set and
 *  normalizes to `1011`, so with the force stop first the relay tore itself down on `1011` and
 *  latched, and the store's own shutdown close — the `1001` the design spec pins — never went out.
 *
 *  `appClose` here stands in for `app.close()` -> `realtimeCalls.close()`: it closes the live
 *  socket with `1001`, exactly as the call store's teardown does. The assertion is on the code the
 *  CLIENT observed on the wire, which is the only place the two orderings are distinguishable.
 *
 *  Fails on a marker rather than hanging: the race resolves on whichever of the close event or the
 *  deadline lands first, and a missing close is reported as `no close observed`. */
test('proxy shutdown closes a live upgraded socket with 1001, not a force-closed 1006', async () => {
  let liveSocket: { close: (code?: number, reason?: string) => void } | undefined;
  const app = {
    fetch: (request: Request, server?: { upgrade: (request: Request) => boolean }) =>
      server?.upgrade(request) === true ? undefined : new Response('not upgraded', { status: 400 }),
    // What `state.close()` does for realtime: close every live relay with the shutdown code.
    close: () => liveSocket?.close(1_001, 'server shutting down'),
  };

  const server = Bun.serve({
    ...proxyServeOptions(app as never, '127.0.0.1', 0),
    websocket: {
      open: (ws) => {
        liveSocket = ws;
      },
      message: () => {},
      close: () => {},
    },
  });

  const client = new WebSocket(`ws://127.0.0.1:${server.port}/v1/live/call_abc`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the upgrade never opened')), 5_000);
    client.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    client.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the upgrade was refused'));
    });
  });
  // Guards the assertion below against passing because nothing was ever attached: with no live
  // socket, `appClose` is a no-op and BOTH orderings would report the same code.
  expect(liveSocket).toBeDefined();

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    client.addEventListener('close', (event: CloseEvent) => resolve({ code: event.code, reason: event.reason }));
    setTimeout(() => resolve({ code: -1, reason: 'no close observed' }), 5_000);
  });

  shutdownProxyServer(server, app);

  // 1006 is what `server.stop(true)` force-closing the socket looks like on the wire, and it is
  // what this observed before `app.close()` was moved ahead of the force stop.
  expect(await closed).toEqual({ code: 1_001, reason: 'server shutting down' });
});

/** The ordering half of the same contract, asserted without a socket so a failure names the cause
 *  rather than a close code. `app.close()` must be the first of the two, and `server.stop(true)`
 *  must still run when it throws — `ServerState.close()` rethrows its first resource-close failure,
 *  and a process that keeps listening is worse than a lost cleanup error. */
test('proxy shutdown closes the app before force-stopping, even when the app throws', () => {
  const order: string[] = [];
  const server = { stop: () => order.push('server.stop(true)') };

  shutdownProxyServer(server as never, { close: () => order.push('app.close()') });

  expect(order).toEqual(['app.close()', 'server.stop(true)']);

  const afterThrow: string[] = [];
  const failing = { stop: () => afterThrow.push('server.stop(true)') };

  expect(() =>
    shutdownProxyServer(failing as never, {
      close: () => {
        afterThrow.push('app.close()');
        throw new Error('resource close failed');
      },
    }),
  ).toThrow('resource close failed');
  expect(afterThrow).toEqual(['app.close()', 'server.stop(true)']);
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
