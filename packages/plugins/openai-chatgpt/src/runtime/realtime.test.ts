import { expect, test } from 'bun:test';

import {
  type CredentialPort,
  RealtimeDialError,
  type RealtimeDialInput,
  type RealtimeTransport,
} from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT } from '../codex-client';
import type { ChatGPTCredential } from '../schema';
import { createOpenAIChatGPTRealtime, realtimeEndpointFor } from './realtime';

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
