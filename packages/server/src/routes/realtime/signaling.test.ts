import { expect, test } from 'bun:test';

import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';
import { Hono } from 'hono';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import type { ServerLog } from '../../server-log';
import { createRealtimeCallStore } from './call-store';
import { callIdFromLocation, handleRealtimeCreate, rewriteLocation } from './signaling';
import type { RealtimeRouteSource } from './source';

test('a call id is recovered from an absolute, a relative, and a query-parameter Location', () => {
  expect(callIdFromLocation('https://api.openai.com/v1/realtime/calls/call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime/calls/call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime?call_id=call_abc')).toBe('call_abc');
  expect(callIdFromLocation('/v1/realtime/calls/call_abc?foo=1')).toBe('call_abc');
});

test('a Location with no extractable, or an invalid, call id yields undefined', () => {
  expect(callIdFromLocation(undefined)).toBeUndefined();
  expect(callIdFromLocation('')).toBeUndefined();
  expect(callIdFromLocation('/v1/realtime/calls/')).toBeUndefined();
  expect(callIdFromLocation('/v1/realtime/calls/not%20valid')).toBeUndefined();
  expect(callIdFromLocation(`/v1/realtime/calls/${'a'.repeat(129)}`)).toBeUndefined();
});

test('Location is rewritten to the inbound style, never the upstream host', () => {
  expect(rewriteLocation('call_abc', 'live')).toBe('/v1/live/call_abc');
  expect(rewriteLocation('call_abc', 'realtime-calls')).toBe('/v1/realtime/calls/call_abc');
  // POST /v1/realtime deliberately advertises the /calls/ GET route: no GET
  // exists at /v1/realtime/<callId>.
  expect(rewriteLocation('call_abc', 'realtime-query')).toBe('/v1/realtime/calls/call_abc');
});

test('a successful create records the call, rewrites Location, and returns the body verbatim', async () => {
  const store = createRealtimeCallStore();
  const source = sourceWith([realtimeProvider({ id: 'codex', answer: sdpAnswer('call_abc') })], store);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toBe('/v1/live/call_abc');
  expect(await response.text()).toBe('v=0\r\na=answer\r\n');
  expect(store.lookup('call_abc')).toMatchObject({
    providerId: 'codex',
    accountId: 'person@example.com',
    runtimeRevision: 3,
    model: 'gpt-live-1-codex',
    style: 'live',
  });
});

test('a JSON-wrapped answer is returned without unwrapping', async () => {
  const answer = JSON.stringify({ sdp: 'v=0\r\na=answer\r\n', type: 'answer' });
  const source = sourceWith([
    realtimeProvider({
      id: 'codex',
      answer: () =>
        new Response(answer, {
          status: 200,
          headers: { 'content-type': 'application/json', location: '/v1/realtime/calls/call_abc' },
        }),
    }),
  ]);

  const response = await post(source, 'realtime-calls', 'v=0\r\n', 'application/sdp');

  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.text()).toBe(answer);
});

test('a 5xx falls back to the next provider and replays the buffered body', async () => {
  const bodies: string[] = [];
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: async (request) => {
        bodies.push(await request.text());
        return new Response('boom', { status: 502 });
      },
    }),
    realtimeProvider({
      id: 'b',
      answer: async (request) => {
        bodies.push(await request.text());
        return sdpAnswer('call_abc')();
      },
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\nfallback\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect(bodies).toEqual(['v=0\r\nfallback\r\n', 'v=0\r\nfallback\r\n']);
});

test('a non-401 non-429 4xx is returned as the upstream sent it, without a second attempt', async () => {
  let calls = 0;
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: () => {
        calls += 1;
        return new Response('bad offer', { status: 400 });
      },
    }),
    realtimeProvider({ id: 'b', answer: sdpAnswer('call_abc') }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(calls).toBe(1);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe('bad offer');
});

test('401 and 429 do fall through to the next credential', async () => {
  for (const status of [401, 429]) {
    const source = sourceWith([
      realtimeProvider({ id: 'a', priority: 10, answer: () => new Response('', { status }) }),
      realtimeProvider({ id: 'b', answer: sdpAnswer('call_abc') }),
    ]);

    expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(201);
  }
});

test('attempts stop at two even with three eligible providers', async () => {
  const attempted: string[] = [];
  const source = sourceWith(
    ['a', 'b', 'c'].map((id, index) =>
      realtimeProvider({
        id,
        priority: 10 - index,
        answer: () => {
          attempted.push(id);
          return new Response('', { status: 503 });
        },
      }),
    ),
  );

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(attempted).toEqual(['a', 'b']);
  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_upstream_unavailable');
});

test('a 2xx with an empty body or an unusable Location is a failed attempt', async () => {
  for (const answer of [
    () => new Response(null, { status: 204, headers: { location: '/v1/live/call_abc' } }),
    () => new Response('v=0\r\n', { status: 200 }),
    () => new Response('v=0\r\n', { status: 200, headers: { location: 'not a url at all ///' } }),
  ]) {
    const source = sourceWith([realtimeProvider({ id: 'codex', answer })]);
    const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');
    expect(response.status).toBe(503);
  }
});

test('no eligible candidate answers 503 without dialing, and a full store answers 503 too', async () => {
  const empty = sourceWith([]);
  expect((await post(empty, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(503);

  let attempted = false;
  const full = createRealtimeCallStore({ capacity: 0 });
  const source = sourceWith(
    [
      realtimeProvider({
        id: 'codex',
        answer: () => {
          attempted = true;
          return sdpAnswer('call_abc')();
        },
      }),
    ],
    full,
  );

  expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(503);
  expect(attempted).toBe(false);
});

test('the create logs carry no SDP, no Location, and no credential', async () => {
  const logs: ServerLog[] = [];
  const source = sourceWith([realtimeProvider({ id: 'codex', answer: sdpAnswer('call_abc') })], undefined, logs);

  await post(source, 'live', 'v=0\r\na=secret-ice-candidate\r\n', 'application/sdp');

  const created = logs.find((entry) => entry.event === 'realtime.call_created');
  expect(created).toMatchObject({ callId: 'call_abc', providerId: 'codex', model: 'gpt-live-1-codex' });
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('secret-ice-candidate');
  expect(serialized).not.toContain('v=0');
  expect(serialized).not.toContain('api.openai.com');
});

function sdpAnswer(callId: string): () => Response {
  return () =>
    new Response('v=0\r\na=answer\r\n', {
      status: 201,
      headers: { 'content-type': 'application/sdp', location: `https://api.openai.com/v1/realtime/calls/${callId}` },
    });
}

async function post(
  source: RealtimeRouteSource,
  style: RealtimeStyle,
  body: string,
  contentType: string,
): Promise<Response> {
  const app = new Hono().post('/create', (context) => handleRealtimeCreate(context, source, style));
  return await app.request('/create', { method: 'POST', body, headers: { 'content-type': contentType } });
}

function realtimeProvider(overrides: {
  readonly id: string;
  readonly priority?: number;
  readonly answer: (request: Request) => Response | Promise<Response>;
}): RuntimeProviderInstance {
  return {
    id: overrides.id,
    kind: ProviderKind.OAuth,
    enabled: true,
    priority: overrides.priority ?? 0,
    weight: 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: ['gpt-5.5'],
    raw: { resolve: () => undefined },
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: (request: Request) => Promise.resolve(overrides.answer(request)).then((value) => value),
      dial: () => Promise.reject(new Error('not dialed in this test')),
    },
  } as unknown as RuntimeProviderInstance;
}

function sourceWith(
  providers: readonly RuntimeProviderInstance[],
  store = createRealtimeCallStore(),
  logs: ServerLog[] = [],
): RealtimeRouteSource {
  const snapshot = { providers, config: { router: { models: {} }, providers: [] } } as unknown as ProviderRouteSnapshot;
  return {
    acquireProviderSnapshot: () => ({ snapshot, release: () => {} }),
    logger: (entry) => logs.push(entry),
    realtimeCalls: store,
  };
}
