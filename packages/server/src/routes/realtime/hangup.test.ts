import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';
import { Hono } from 'hono';

import { type CallerPrincipalEnv, staticKeyCallerPrincipal } from '../../caller-principal';
import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import type { ServerLog } from '../../server-log';
import { createRealtimeCallStore, type RealtimeCallStore } from './call-store';
import { handleRealtimeHangup } from './hangup';
import { handleRealtimeCreate } from './signaling';
import type { RealtimeRouteSource } from './source';

// The two requests of a realtime session carry two independent credentials, so the
// hangup's only defense against a stranger holding a `call_id` is the recorded owner.
// Asserting the pure `sameCallerPrincipal` comparison is not enough: nothing there
// notices if the route stops calling it, or records the wrong principal at create.
test('a hangup presented under a different configured key is 403 and leaves the call alive', async () => {
  const logs: ServerLog[] = [];
  const store = createRealtimeCallStore();
  const app = hangupApp(store, logs);
  await create(app, 'key-owner');

  const response = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-other' },
  });

  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_call_scope_mismatch');
  // The record survives, so the refusal cannot be used to hang up someone else's call.
  expect(store.lookup('call_abc')).toBeDefined();
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'realtime.call_failed',
      statusCode: 403,
      errorCode: 'realtime_call_scope_mismatch',
    }),
  );
});

// The positive control. Without it, recording a constant owner at create time (or
// comparing only `kind`) would pass the test above while admitting every caller.
test('the key that created the call hangs it up and the record is deleted', async () => {
  const store = createRealtimeCallStore();
  const app = hangupApp(store);
  await create(app, 'key-owner');

  const response = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });

  expect(response.status).toBe(204);
  expect(store.lookup('call_abc')).toBeUndefined();
});

// A record with no attachment expires, and `insert` evicts an expired entry, so a create landing
// while a slow upstream hangup is in flight can legitimately take the same call ID. The hangup's
// 2xx then arrived holding only that ID: closing and deleting by ID alone tore down the
// REPLACEMENT — another caller's live call — and answered 204 for a teardown that never happened
// to the record it was asked about. The record's disappearance is driven with `remove` rather
// than a fake clock because the create route stamps `createdAt` from the real `Date.now()`; what
// the route must survive is the record being GONE and re-taken while it awaits the upstream,
// whichever of expiry, relay teardown, or an earlier hangup got there first.
test('a slow hangup does not delete a replacement record that took the same call id', async () => {
  const store = createRealtimeCallStore();
  let releaseUpstream: (() => void) | undefined;
  const upstreamParked = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const app = hangupApp(store, [], async () => {
    await upstreamParked;
    return new Response('{}', { status: 200 });
  });
  await create(app, 'key-owner');
  const original = store.lookup('call_abc');

  const hangup = app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });
  // Yield so the route is parked on the upstream fetch, holding the record it looked up.
  await Bun.sleep(1);
  // The original record goes away and a second caller's create claims the freed call ID.
  store.remove('call_abc');
  await create(app, 'key-other');
  const replacement = store.lookup('call_abc');
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(original);
  expect(replacement?.owner.id).not.toBe(original?.owner.id);

  releaseUpstream?.();
  const response = await hangup;

  expect(response.status).toBe(204);
  // The stranger's call is untouched: still present, still theirs.
  expect(store.lookup('call_abc')).toBe(replacement!);
});

// A 200 hangup was observed carrying the upstream's own `Location` (its host), a
// `Set-Cookie`, and the caller's own offer echoed back in its JSON. Nothing in a hangup
// reply is information the caller lacks, so the whole upstream response is dropped. The
// record teardown must still happen, so this is not just a disclosure check.
test('a 2xx hangup answers an empty 204, discarding the upstream headers and body', async () => {
  const store = createRealtimeCallStore();
  const app = hangupApp(
    store,
    [],
    () =>
      new Response(
        '{"ok":true,"self":"https://api.openai.com/v1/realtime/calls/call_abc","echo":"v=0\\r\\na=candidate:secret-ice 1 udp 10.1.2.3 typ host\\r\\n"}',
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            location: 'https://api.openai.com/v1/realtime/calls/call_abc',
            'set-cookie': 'x=y',
            'x-upstream-debug': 'internal-host-9',
          },
        },
      ),
  );
  await create(app, 'key-owner');

  const response = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });

  expect(response.status).toBe(204);
  expect([...response.headers.keys()].sort()).toEqual([]);
  const text = await response.text();
  expect(text).toBe('');
  // Live because the fixture body carries all three strings: relaying it verbatim trips
  // each one, verified by isolating them individually against a body-forwarding mutation.
  expect(text).not.toContain('secret-ice');
  expect(text).not.toContain('10.1.2.3');
  expect(text).not.toContain('api.openai.com');
  expect(store.lookup('call_abc')).toBeUndefined();
});

// The upstream's 404 body is not the proxy's envelope, and its headers are not the
// proxy's to relay. The record must survive, as it does for any non-2xx.
test('a non-2xx hangup is reshaped into the realtime envelope and keeps the record', async () => {
  const store = createRealtimeCallStore();
  const app = hangupApp(
    store,
    [],
    () =>
      new Response('<html>no such call at api.openai.com host internal-host-9</html>', {
        status: 404,
        headers: { 'content-type': 'text/html', location: 'https://api.openai.com/gone', 'set-cookie': 'x=y' },
      }),
  );
  await create(app, 'key-owner');

  const response = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });

  expect(response.status).toBe(404);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  const text = await response.text();
  expect(text).not.toContain('internal-host-9');
  expect(text).not.toContain('api.openai.com');
  expect(JSON.parse(text)).toEqual({
    error: {
      message: 'The realtime upstream rejected this request.',
      type: 'invalid_request_error',
      param: null,
      code: 'upstream_rejected',
    },
  });
  expect(store.lookup('call_abc')).toBeDefined();
});

// Both hangup outcomes discard the upstream body, and `cancel()` can reject: a plugin's
// `realtime.fetch` may answer over a hand-built stream whose `cancel` algorithm throws.
// Awaiting that bare turned a completed teardown into Hono's untyped 500 — for the 2xx, after
// the record was already deleted, so the caller was told the hangup failed when it had not.
test('a hangup whose upstream body cannot be cancelled still answers, on both outcomes', async () => {
  const closed = createRealtimeCallStore();
  const closingApp = hangupApp(closed, [], () => uncancellableResponse(200));
  await create(closingApp, 'key-owner');

  const success = await closingApp.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });

  expect(success.status).toBe(204);
  expect(closed.lookup('call_abc')).toBeUndefined();

  const kept = createRealtimeCallStore();
  const failingApp = hangupApp(kept, [], () => uncancellableResponse(404));
  await create(failingApp, 'key-owner');

  const failure = await failingApp.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { 'x-test-principal': 'key-owner' },
  });

  expect(failure.status).toBe(404);
  expect(((await failure.json()) as { error: { code: string } }).error.code).toBe('upstream_rejected');
  expect(kept.lookup('call_abc')).toBeDefined();
});

/** A response over a stream whose `cancel` algorithm throws, which is what makes
 *  `response.body.cancel()` reject. */
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

function hangupApp(
  store: RealtimeCallStore,
  logs: ServerLog[] = [],
  hangupAnswer?: () => Response | Promise<Response>,
) {
  const source = sourceWith(store, logs, hangupAnswer);
  return (
    new Hono<CallerPrincipalEnv>()
      // Stands in for the `/v1/*` auth middleware: the route reads the principal off the
      // context, so a per-request header is enough to model two distinct credentials.
      .use('*', async (context, next) => {
        const key = context.req.header('x-test-principal');
        if (key !== undefined) context.set('callerPrincipal', staticKeyCallerPrincipal(key));
        await next();
      })
      .post('/v1/live', (context) => handleRealtimeCreate(context, source, 'live'))
      .post('/v1/realtime/calls/:call_id/hangup', (context) => handleRealtimeHangup(context, source))
  );
}

async function create(app: ReturnType<typeof hangupApp>, key: string): Promise<void> {
  const response = await app.request('/v1/live', {
    method: 'POST',
    body: 'v=0\r\n',
    headers: { 'content-type': 'application/sdp', 'x-test-principal': key },
  });
  if (response.status !== 201) throw new Error(`create failed with ${response.status}`);
}

function sourceWith(
  store: RealtimeCallStore,
  logs: ServerLog[],
  hangupAnswer?: () => Response | Promise<Response>,
): RealtimeRouteSource {
  const provider = {
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
      fetch: (request: Request) =>
        Promise.resolve(
          new URL(request.url).pathname.endsWith('/hangup')
            ? (hangupAnswer?.() ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
            : new Response('v=0\r\na=answer\r\n', {
                status: 201,
                headers: {
                  'content-type': 'application/sdp',
                  location: 'https://api.openai.com/v1/realtime/calls/call_abc',
                },
              }),
        ),
      dial: () => Promise.reject(new Error('not dialed in this test')),
    },
  } as unknown as RuntimeProviderInstance;
  const snapshot = {
    providers: [provider],
    config: { router: { models: {} }, providers: [] },
  } as unknown as ProviderRouteSnapshot;
  return {
    acquireProviderSnapshot: () => ({ snapshot, release: () => {} }),
    logger: (entry) => logs.push(entry),
    realtimeCalls: store,
  };
}
