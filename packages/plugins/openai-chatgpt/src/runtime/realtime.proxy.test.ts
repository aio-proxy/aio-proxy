import { expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { ChatGPTCredential } from '../schema';
import { createOpenAIChatGPTRealtime } from './realtime';

test('a dial through a configured proxy issues CONNECT rather than connecting direct', async () => {
  const connects: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
    websocket: { open: (ws) => ws.send('ok'), message: () => {} },
  });

  // A minimal CONNECT proxy: record the target, then splice the two sockets.
  const proxy = Bun.listen<{ upstream?: Bun.Socket }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: async (socket, chunk) => {
        const pending = socket.data.upstream;
        if (pending !== undefined) {
          pending.write(chunk);
          return;
        }
        const target = /^CONNECT (\S+)/u.exec(chunk.toString('utf8'))?.[1];
        if (target === undefined) {
          socket.end();
          return;
        }
        connects.push(target);
        const [host, port] = target.split(':');
        socket.data.upstream = await Bun.connect({
          hostname: host!,
          port: Number(port),
          socket: { data: (_upstream, response) => socket.write(response), close: () => socket.end() },
        });
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      },
      // `Bun.listen`'s accepted sockets carry no `data` until one is assigned, so
      // the per-connection state is created here rather than in the listen options.
      open: (socket) => {
        socket.data = {};
      },
      close: (socket) => socket.data?.upstream?.end(),
    },
  });

  // No `createWebSocket` seam: the production factory is the code under test, since
  // a plugin-constructed socket inherits nothing from `createProxyFetch` and would
  // otherwise send sideband traffic direct while signaling honored the proxy.
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: globalThis.fetch,
    proxy: `http://127.0.0.1:${proxy.port}`,
    baseUrl: `ws://localhost:${upstream.port}`,
  });

  try {
    const socket = await realtime.dial({
      style: 'live',
      callId: 'call_abc',
      headers: new Headers(),
      signal: new AbortController().signal,
    });
    expect(socket.readyState).toBe(1);
    socket.close(1000);
    expect(connects).toEqual([`localhost:${upstream.port}`]);
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
});

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}
