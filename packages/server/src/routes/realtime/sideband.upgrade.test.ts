import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { cleanupServerTestLifecycle, createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInput } from '../../runtime';
import { websocket } from '../../server';

afterEach(cleanupServerTestLifecycle);

/** Every other realtime test drives the app through `app.request()`, which never reaches
 *  `server.upgrade()`. Only a real `Bun.serve` carrying the `websocket` handler can prove the
 *  production attach path, so this test stands up two of them — the proxy and a fake upstream —
 *  and relays real frames between them. */
test('a real Bun.serve upgrade relays every framing at exact byte length', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open: (ws) => ws.send('greeting'),
      // Echo the exact byte length back so the assertion is on the wire, not on
      // our own bookkeeping.
      message: (ws, message) => ws.send(typeof message === 'string' ? message : `bytes:${message.byteLength}`),
    },
  });

  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider(`ws://localhost:${upstream.port}`)],
  });
  const proxy = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket: { ...websocket, idleTimeout: 255 },
  });

  try {
    const create = await fetch(`http://localhost:${proxy.port}/v1/live`, {
      method: 'POST',
      body: 'v=0\r\n',
      headers: { 'content-type': 'application/sdp' },
    });
    expect(create.status).toBe(201);
    expect(create.headers.get('location')).toBe('/v1/live/call_abc');

    const client = new WebSocket(`ws://localhost:${proxy.port}/v1/live/call_abc`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('error', () => reject(new Error('the proxy refused the upgrade')));
      client.addEventListener('message', (event: MessageEvent<string>) => {
        received.push(event.data);
        if (received.length === 5) resolve();
      });
      client.addEventListener('open', () => {
        client.send('text frame');
        // One frame per write, then many frames in a single write, then a large
        // frame. All three must arrive with their exact byte length.
        client.send(new Uint8Array(7));
        client.send(new Uint8Array(3));
        client.send(new Uint8Array(200_000));
      });
      setTimeout(() => reject(new Error(`only received ${received.length} frames: ${received.join(', ')}`)), 5_000);
    });

    expect(received).toEqual(['greeting', 'text frame', 'bytes:7', 'bytes:3', 'bytes:200000']);
    client.close(1000);
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});

function realtimeProvider(base: string): RuntimeProviderInput {
  return {
    id: 'codex',
    kind: ProviderKind.OAuth,
    enabled: true,
    priority: 0,
    weight: 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: [],
    raw: { resolve: () => undefined },
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: () =>
        Promise.resolve(
          new Response('v=0\r\na=answer\r\n', {
            status: 201,
            headers: {
              'content-type': 'application/sdp',
              location: 'https://api.openai.com/v1/realtime/calls/call_abc',
            },
          }),
        ),
      dial: () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(base);
          socket.addEventListener('open', () => resolve(socket));
          socket.addEventListener('error', () => reject(new Error('dial failed')));
        }),
    },
  } as unknown as RuntimeProviderInput;
}
