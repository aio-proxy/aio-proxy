import { afterEach, expect, jest, test } from 'bun:test';

import {
  type CredentialPort,
  RealtimeDialError,
  type RealtimeDialInput,
  type RealtimeTransport,
} from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT } from '../codex-client';
import type { ChatGPTCredential } from '../schema';
import { createOpenAIChatGPTRealtime, realtimeEndpointFor } from './realtime';

afterEach(() => {
  jest.useRealTimers();
});

test('every accepted realtime fetch path maps to an exact upstream endpoint', () => {
  expect(realtimeEndpointFor('/v1/live')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime/calls')).toBe(
    'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  );
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc/hangup')).toBe(
    'https://api.openai.com/v1/realtime/calls/call_abc/hangup',
  );

  // Exact match, not endsWith: these are prefixes or neighbors of the accepted set.
  expect(realtimeEndpointFor('/v1/realtime/sessions')).toBeUndefined();
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc')).toBeUndefined();
  expect(realtimeEndpointFor('/prefix/v1/live')).toBeUndefined();
  expect(realtimeEndpointFor('/v1/realtime/calls/call_abc/accept')).toBeUndefined();
});

test('the endpoint-owned query survives an inbound request that carries none', async () => {
  const calls: string[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch(calls),
    proxy: null,
  });

  await realtime.fetch(new Request('http://127.0.0.1:8787/v1/live', { method: 'POST', body: 'v=0' }));

  expect(calls[0]).toBe('https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
});

test('an unmapped realtime path fails closed instead of looping back into the proxy', async () => {
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
  });

  await expect(
    realtime.fetch(new Request('http://127.0.0.1:8787/v1/realtime/sessions', { method: 'POST', body: '{}' })),
  ).rejects.toThrow('Unmapped realtime path');
});

test('the realtime transport injects Codex credentials and never forwards a caller credential', async () => {
  const headers: Headers[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: async (input, init) => {
      headers.push(new Headers(new Request(input, init).headers));
      return new Response('v=0', { status: 200, headers: { location: '/v1/realtime/calls/call_abc' } });
    },
    proxy: null,
  });

  const response = await realtime.fetch(
    new Request('http://127.0.0.1:8787/v1/live', {
      method: 'POST',
      body: 'v=0',
      headers: { authorization: 'Bearer caller-key', 'content-type': 'application/sdp' },
    }),
  );

  const sent = headers[0];
  expect(response.status).toBe(200);
  expect(sent?.get('authorization')).toBe('Bearer access-token');
  expect(sent?.get('ChatGPT-Account-Id')).toBe('acct-123');
  expect(sent?.get('Originator')).toBe('codex-tui');
  expect(sent?.get('User-Agent')).toBe(CHATGPT_USER_AGENT);
  expect(sent?.get('session-id')).toMatch(/^[0-9a-f-]{36}$/u);
  expect(sent?.get('content-type')).toBe('application/sdp');
});

// The literal is the cross-package contract: `@aio-proxy/server`'s realtime
// selection normalizes to the same literal (`CODEX_REALTIME_MODEL` in
// packages/server/src/routes/realtime/model.ts) and matches with
// `models.includes(...)`, so drift on either side leaves every realtime request
// without a candidate provider. The two packages pin it independently because
// server does not depend on this plugin.
test('realtime models advertise only the Codex realtime model', () => {
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
  });

  expect(realtime.models).toEqual(['gpt-live-1-codex']);
});

test('dial builds the sideband URL per style and resolves only once the socket is open', async () => {
  const seen: { url?: string; proxy?: unknown } = {};
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: 'http://127.0.0.1:8123',
    createWebSocket: (url, init) => {
      seen.url = url;
      seen.proxy = init.proxy;
      return openSocketStub();
    },
  });

  const socket = await realtime.dial({
    style: 'realtime-calls',
    callId: 'call_abc',
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  expect(seen.url).toBe('wss://api.openai.com/v1/realtime/calls/call_abc');
  expect(seen.proxy).toBe('http://127.0.0.1:8123');
  expect(socket.readyState).toBe(1);
});

test('dial builds the live, query, and direct styles', async () => {
  const urls: string[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: (url) => {
      urls.push(url);
      return openSocketStub();
    },
  });
  const base = { headers: new Headers(), signal: new AbortController().signal };

  await realtime.dial({ ...base, style: 'live', callId: 'call_abc' });
  await realtime.dial({ ...base, style: 'realtime-query', callId: 'call_abc' });
  await realtime.dial({ ...base, style: 'realtime-direct', model: 'gpt-realtime' });

  expect(urls).toEqual([
    'wss://api.openai.com/v1/live/call_abc',
    'wss://api.openai.com/v1/realtime?intent=quicksilver&call_id=call_abc',
    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
  ]);
});

test('a non-101 upstream handshake rejects with kind "rejected" and a refused connect with "unreachable"', async () => {
  const closeWith = (code: number, reason: string) => (): WebSocket => {
    const socket = socketStub();
    queueMicrotask(() => socket.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: false })));
    return socket;
  };

  const rejected = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: closeWith(1002, 'Expected 101 status code'),
  });
  const unreachable = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: closeWith(1006, 'Failed to connect'),
  });
  const base = { callId: 'call_abc', headers: new Headers(), signal: new AbortController().signal } as const;

  const rejectedError = await realtime_dialError(rejected, base);
  const unreachableError = await realtime_dialError(unreachable, base);

  expect(rejectedError).toBeInstanceOf(RealtimeDialError);
  expect(rejectedError.kind).toBe('rejected');
  expect(unreachableError.kind).toBe('unreachable');
});

test('an aborted dial rejects with kind "aborted" and closes a socket that opens late', async () => {
  const closed: number[] = [];
  const controller = new AbortController();
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: () => {
      const socket = socketStub();
      socket.close = (code?: number) => closed.push(code ?? 1000);
      return socket;
    },
  });

  const pending = realtime.dial({
    style: 'realtime-calls',
    callId: 'call_abc',
    headers: new Headers(),
    signal: controller.signal,
  });
  controller.abort();

  const error = await pending.catch((cause: unknown) => cause);
  expect((error as RealtimeDialError).kind).toBe('aborted');
  expect(closed).toEqual([1001]);
});

test('a socket that never opens times out at the dial deadline, and an early settle disarms it', async () => {
  const closed: number[] = [];
  const sockets: WebSocket[] = [];
  const realtime = createOpenAIChatGPTRealtime(staticCredentialPort(credential()), {
    fetch: captureFetch([]),
    proxy: null,
    createWebSocket: () => {
      const socket = socketStub();
      socket.close = (code?: number) => closed.push(code ?? 1000);
      sockets.push(socket);
      return socket;
    },
  });
  const base = { style: 'realtime-calls', callId: 'call_abc', headers: new Headers() } as const;

  jest.useFakeTimers();

  // A dial that settles before the deadline must leave no timer armed.
  const early = realtime.dial({ ...base, signal: new AbortController().signal });
  // The credential read runs before the socket exists, so the deadline timer is
  // only armed once those microtasks drain.
  await until(() => jest.getTimerCount() === 1);
  sockets[0]?.dispatchEvent(new CloseEvent('close', { code: 1002, wasClean: false }));
  await expect(early).rejects.toBeInstanceOf(RealtimeDialError);
  expect(jest.getTimerCount()).toBe(0);

  const pending = realtime.dial({ ...base, signal: new AbortController().signal });
  let settled: unknown;
  void pending.catch((cause: unknown) => {
    settled = cause;
  });
  await until(() => jest.getTimerCount() === 1);
  expect(closed).toEqual([]);

  jest.advanceTimersByTime(10_000);
  await until(() => settled !== undefined);

  expect(settled).toBeInstanceOf(RealtimeDialError);
  expect((settled as RealtimeDialError).kind).toBe('timeout');
  expect(closed).toEqual([1001]);
});

test('a credential Bun rejects as a header value never reaches the dial error message', async () => {
  const token = 'sk-SUPER-SECRET-TOKEN';
  // No `createWebSocket`: the leak lives in Bun's real constructor, which validates
  // header values and echoes the offending one verbatim. It throws before opening a
  // socket, so this exercises the production path without touching the network.
  const realtime = createOpenAIChatGPTRealtime(
    staticCredentialPort(credential({ accessToken: `${token}\nX-Injected: 1` })),
    { fetch: captureFetch([]), proxy: null },
  );

  const error = await realtime_dialError(realtime, {
    callId: 'call_abc',
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  expect(error.kind).toBe('unreachable');
  expect(error.message).not.toContain(token);
  expect(error.message).toBe('sideband socket could not be created (TypeError)');
});

test('a credential Bun rejects as a header value never reaches the fetch error message', async () => {
  const token = 'sk-SUPER-SECRET-TOKEN';
  // Bun's real `Headers.set` validates the value and echoes it verbatim, and it
  // throws while building the upstream headers — before `fetch` is ever called, so
  // the stub below is never reached.
  const calls: string[] = [];
  const realtime = createOpenAIChatGPTRealtime(
    staticCredentialPort(credential({ accessToken: `${token}\nX-Injected: 1` })),
    { fetch: captureFetch(calls), proxy: null },
  );

  const error = await realtime
    .fetch(new Request('http://127.0.0.1:8787/v1/live', { method: 'POST', body: 'v=0' }))
    .catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(token);
  expect((error as Error).message).toBe('Codex credential is not a valid header value');
  expect(calls).toEqual([]);
});

test('a credential read that fails still rejects dial with a RealtimeDialError carrying no cause text', async () => {
  const secret = 'REFRESH_FAILED_SENTINEL';
  const realtime = createOpenAIChatGPTRealtime(
    {
      read: async () => {
        throw new Error(secret);
      },
      refresh: async () => {
        throw new Error(secret);
      },
    },
    { fetch: captureFetch([]), proxy: null, createWebSocket: () => openSocketStub() },
  );

  const error = await realtime_dialError(realtime, {
    callId: 'call_abc',
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  expect(error.kind).toBe('unreachable');
  expect(error.message).not.toContain(secret);
});

/** Drains microtasks until `done()` or a bounded number of turns. Fake timers make
 *  wall-clock waiting impossible, so settlement is observed by yielding. */
async function until(done: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !done(); index++) await Promise.resolve();
}

async function realtime_dialError(
  realtime: RealtimeTransport,
  input: Omit<RealtimeDialInput, 'style'>,
): Promise<RealtimeDialError> {
  const error = await realtime.dial({ ...input, style: 'realtime-calls' }).catch((cause: unknown) => cause);
  if (!(error instanceof RealtimeDialError)) throw new Error(`expected a RealtimeDialError, got ${String(error)}`);
  return error;
}

/** A minimal `EventTarget`-backed stand-in: `dial` only ever reads `readyState`,
 *  registers `open`/`close`/`error`, and calls `close`. */
function socketStub(): WebSocket {
  const target = new EventTarget() as EventTarget & { readyState: number; close: (code?: number) => void };
  target.readyState = 0;
  target.close = () => {
    target.readyState = 3;
  };
  return target as unknown as WebSocket;
}

function openSocketStub(): WebSocket {
  const socket = socketStub() as WebSocket & { readyState: number };
  queueMicrotask(() => {
    socket.readyState = 1;
    socket.dispatchEvent(new Event('open'));
  });
  return socket;
}

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

function captureFetch(urls: string[]): typeof fetch {
  return async (input, init) => {
    urls.push(new Request(input, init).url);
    return new Response('v=0', { status: 200, headers: { location: '/v1/realtime/calls/call_abc' } });
  };
}
