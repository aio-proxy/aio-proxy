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

// The upstream status survives, but nothing the upstream *said* does: its error body was
// observed echoing the caller's own SDP offer and its `Location` carries the upstream host.
test('a non-401 non-429 4xx stops the loop and is reshaped, dropping every upstream header', async () => {
  let calls = 0;
  const logs: ServerLog[] = [];
  const source = sourceWith(
    [
      realtimeProvider({
        id: 'a',
        priority: 10,
        answer: () => {
          calls += 1;
          // Every string the assertions below look for is in the *body*: a `not.toContain`
          // against a header-only value would pass however the body were relayed.
          return new Response(
            'rejected offer at api.openai.com (cookie up_session=secret123): v=0 a=candidate:secret-ice 1 udp',
            {
              status: 400,
              headers: {
                location: 'https://api.openai.com/leak?token=abc',
                'set-cookie': 'up_session=secret123; Path=/',
                'x-upstream-debug': 'internal-host-9',
              },
            },
          );
        },
      }),
      realtimeProvider({ id: 'b', answer: sdpAnswer('call_abc') }),
    ],
    undefined,
    logs,
  );

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(calls).toBe(1);
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('x-upstream-debug')).toBeNull();
  const text = await response.text();
  expect(text).not.toContain('secret-ice');
  expect(text).not.toContain('secret123');
  expect(text).not.toContain('api.openai.com');
  expect(JSON.parse(text)).toEqual({
    error: {
      message: 'The realtime upstream rejected this request.',
      type: 'invalid_request_error',
      param: null,
      code: 'upstream_rejected',
    },
  });
  // Discarding the upstream body makes the log the only surviving diagnostic, so it must
  // still name the rejecting provider and the status the caller was handed.
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'realtime.call_failed',
      providerId: 'a',
      statusCode: 400,
      errorCode: 'upstream_rejected',
    }),
  );
});

// A redirect carries its target in the one header that may never be forwarded, so once it
// is stripped the caller has nothing to act on. That makes it an availability failure of
// this attempt — not of the create — so the terminal 503 only appears once no candidate
// is left, exactly as for a 5xx.
test('an upstream redirect is the last candidate: 503, and no Location reaches the caller or the log', async () => {
  const logs: ServerLog[] = [];
  const source = sourceWith(
    [
      realtimeProvider({
        id: 'a',
        answer: () =>
          new Response('', {
            status: 302,
            headers: { location: 'https://chatgpt.com/backend-api/codex/realtime/calls/redir?token=abc' },
          }),
      }),
    ],
    undefined,
    logs,
  );

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(503);
  expect(response.headers.get('location')).toBeNull();
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_upstream_unavailable');
  // The log records the 503 the caller saw, not the upstream's 302, and the attempt was
  // consumed rather than skipped.
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'realtime.call_failed',
      statusCode: 503,
      errorCode: 'realtime_upstream_unavailable',
      attemptCount: 1,
    }),
  );
  expect(JSON.stringify(logs)).not.toContain('chatgpt.com');
});

// The two-provider shape is the point: with one provider a fall-through and a hard stop
// are indistinguishable, and a redirect from one account must not fail a create a healthy
// second account would have served.
test('an upstream redirect consumes its attempt and the next candidate still serves the create', async () => {
  const attempted: string[] = [];
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: () => {
        attempted.push('a');
        return new Response('', { status: 302, headers: { location: 'https://chatgpt.com/redir' } });
      },
    }),
    realtimeProvider({
      id: 'b',
      answer: () => {
        attempted.push('b');
        return sdpAnswer('call_abc')();
      },
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect(attempted).toEqual(['a', 'b']);
  expect(response.headers.get('location')).toBe('/v1/live/call_abc');
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

// The capacity check and the `insert` are separated by the upstream fetch, so two creates
// racing through that window both used to pass one check and both insert, putting the store
// over its advertised bound.
test('a second create cannot claim the last slot while the first is still dialing', async () => {
  const dialed: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const store = createRealtimeCallStore({ capacity: 1 });
  const source = sourceWith(
    [
      realtimeProvider({
        id: 'codex',
        answer: async (request) => {
          const id = new URL(request.url).searchParams.get('probe') ?? '';
          dialed.push(id);
          if (id === 'first') await gate;
          return sdpAnswer(`call_${id}`)();
        },
      }),
    ],
    store,
  );

  const app = new Hono().post('/create', (context) => handleRealtimeCreate(context, source, 'live'));
  const first = app.request('/create?probe=first', {
    method: 'POST',
    body: 'v=0\r\n',
    headers: { 'content-type': 'application/sdp' },
  });
  // One turn is enough: the first create is parked on its upstream fetch, holding the slot
  // with nothing inserted yet.
  await Promise.resolve();
  const second = await app.request('/create?probe=second', {
    method: 'POST',
    body: 'v=0\r\n',
    headers: { 'content-type': 'application/sdp' },
  });

  expect(second.status).toBe(503);
  // Refused before the fetch, so the second create never allocated an upstream call.
  expect(dialed).toEqual(['first']);

  releaseFirst();
  expect((await first).status).toBe(201);
  expect(store.size()).toBe(1);
});

// The slot outlives the attempt loop, so a create that forgot to drop it would wedge the
// store: every later create would see a bound already spent by a finished request.
test('a finished create leaves no slot behind, so the freed capacity is reusable', async () => {
  const store = createRealtimeCallStore({ capacity: 1 });
  let callId = 'call_1';
  const source = sourceWith([realtimeProvider({ id: 'codex', answer: () => sdpAnswer(callId)() })], store);

  expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(201);
  store.remove('call_1');
  callId = 'call_2';

  expect((await post(source, 'live', 'v=0\r\n', 'application/sdp')).status).toBe(201);
  expect(store.lookup('call_2')).toBeDefined();
});

// A 2xx settles the *headers*; the answer arrives afterwards. Reading it outside the
// candidate loop's own `try` let a mid-body reset escape as a generic 500, even though no
// answer byte had reached the caller and a second account was standing by.
test('a 2xx whose answer stream resets mid-body is a failed attempt, not a 500', async () => {
  const attempted: string[] = [];
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: () => {
        attempted.push('a');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('v=0\r\n'));
              controller.error(new Error('upstream reset mid-answer'));
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/sdp', location: '/v1/realtime/calls/call_partial' },
          },
        );
      },
    }),
    realtimeProvider({
      id: 'b',
      answer: () => {
        attempted.push('b');
        return sdpAnswer('call_abc')();
      },
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(attempted).toEqual(['a', 'b']);
  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toBe('/v1/live/call_abc');
  expect(await response.text()).toBe('v=0\r\na=answer\r\n');
});

// With no candidate left, the reset must still surface as the branch's own availability
// error rather than as Hono's untyped 500: only the former carries the realtime error body.
test('a reset answer with no candidate left is the realtime 503, not an escaped throw', async () => {
  const source = sourceWith([
    realtimeProvider({
      id: 'a',
      answer: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('upstream reset mid-answer'));
            },
          }),
          { status: 201, headers: { 'content-type': 'application/sdp', location: '/v1/live/call_x' } },
        ),
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_upstream_unavailable');
});

// A closed store drops every `insert`, so a create that dialed anyway would hand the caller
// a 201 whose Location can never be attached. Shutdown has to refuse the create instead.
test('a create against a closed store answers 503 without dialing upstream', async () => {
  let attempted = false;
  const store = createRealtimeCallStore();
  store.close();
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
    store,
  );

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(503);
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

// `commit` rewrites `Location`, but the rest of the upstream's headers reached the caller
// untouched until the allowlist. A success carries the same disclosure risk as a failure.
test('a successful create forwards only content-type plus the rewritten Location', async () => {
  const source = sourceWith([
    realtimeProvider({
      id: 'codex',
      answer: () =>
        new Response('v=0\r\na=answer\r\n', {
          status: 201,
          headers: {
            'content-type': 'application/sdp',
            location: 'https://api.openai.com/v1/realtime/calls/call_abc',
            'set-cookie': 'up_session=secret123; Path=/',
            'x-upstream-debug': 'internal-host-9',
          },
        }),
    }),
  ]);

  const response = await post(source, 'live', 'v=0\r\n', 'application/sdp');

  expect(response.status).toBe(201);
  expect([...response.headers.keys()].toSorted()).toEqual(['content-type', 'location']);
  expect(response.headers.get('location')).toBe('/v1/live/call_abc');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('x-upstream-debug')).toBeNull();
});

// Releasing an unread upstream body is cleanup, never the outcome. `cancel()` can reject —
// a plugin's `realtime.fetch` may answer over a hand-built stream whose `cancel` algorithm
// throws, and a body already errored by a transport reset rejects too — and awaiting that bare
// let the rejection escape the candidate loop as Hono's untyped 500 in place of the fallback.
test('an upstream body whose cancel rejects does not escape the candidate loop', async () => {
  const attempted: string[] = [];
  const retryable = sourceWith([
    realtimeProvider({
      id: 'a',
      priority: 10,
      answer: () => {
        attempted.push('a');
        return uncancellableResponse(502);
      },
    }),
    realtimeProvider({
      id: 'b',
      answer: () => {
        attempted.push('b');
        return sdpAnswer('call_abc')();
      },
    }),
  ]);

  const failedOver = await post(retryable, 'live', 'v=0\r\n', 'application/sdp');

  expect(attempted).toEqual(['a', 'b']);
  expect(failedOver.status).toBe(201);
  expect(failedOver.headers.get('location')).toBe('/v1/live/call_abc');

  // The 4xx site is the same cleanup one branch over: the caller must still get the reshaped
  // rejection rather than a 500 that says nothing about what the upstream refused.
  const rejected = sourceWith([realtimeProvider({ id: 'a', answer: () => uncancellableResponse(400) })]);

  const reshaped = await post(rejected, 'live', 'v=0\r\n', 'application/sdp');

  expect(reshaped.status).toBe(400);
  expect(((await reshaped.json()) as { error: { code: string } }).error.code).toBe('upstream_rejected');
});

function sdpAnswer(callId: string): () => Response {
  return () =>
    new Response('v=0\r\na=answer\r\n', {
      status: 201,
      headers: { 'content-type': 'application/sdp', location: `https://api.openai.com/v1/realtime/calls/${callId}` },
    });
}

/** A response over a stream whose `cancel` algorithm throws, which is what makes
 *  `response.body.cancel()` reject. Verified on Bun 1.4.2: the rejection carries the thrown
 *  error, so a bare `await` propagates it. */
function uncancellableResponse(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upstream detail'));
      },
      cancel() {
        throw new Error('cancel algorithm failed');
      },
    }),
    { status, headers: { 'content-type': 'text/plain' } },
  );
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
