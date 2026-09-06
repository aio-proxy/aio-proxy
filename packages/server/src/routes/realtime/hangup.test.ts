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

  expect(response.status).toBe(200);
  expect(store.lookup('call_abc')).toBeUndefined();
});

function hangupApp(store: RealtimeCallStore, logs: ServerLog[] = []) {
  const source = sourceWith(store, logs);
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

function sourceWith(store: RealtimeCallStore, logs: ServerLog[]): RealtimeRouteSource {
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
            ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
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
