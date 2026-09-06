import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { cleanupServerTestLifecycle, createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInput } from '../../runtime';
import type { ServerLog } from '../../server-log';

afterEach(cleanupServerTestLifecycle);

/** Every module under test here is unit-tested in isolation. What no unit test can see is
 *  whether the real Hono app composes them: the unsupported set has to survive
 *  route-registration order, and the ownership check only means anything once the `/v1/*`
 *  auth middleware is the thing supplying the principal. */

test('every unsupported realtime endpoint answers 501 not_supported_error', async () => {
  const app = await createServer({ config: { providers: {} }, logger: discard });
  const paths = [
    ['POST', '/v1/realtime/client_secrets'],
    ['POST', '/v1/realtime/sessions'],
    ['POST', '/v1/realtime/transcription_sessions'],
    ['GET', '/v1/realtime/translations'],
    ['POST', '/v1/realtime/translations'],
    ['POST', '/v1/realtime/translations/client_secrets'],
    ['POST', '/v1/realtime/calls/call_abc/accept'],
    ['POST', '/v1/realtime/calls/call_abc/reject'],
    ['POST', '/v1/realtime/calls/call_abc/refer'],
  ] as const;

  for (const [method, path] of paths) {
    const response = await app.request(path, { method });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('not_supported_error');
    expect(body.error.code).toBe('realtime_capability_not_supported');
  }

  // The negative control the loop cannot supply: a wildcard 501 over `/v1/realtime/*` would
  // satisfy every assertion above while swallowing the endpoints that are supported.
  const supported = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });
  expect(supported.status).not.toBe(501);
});

// The create runs first so the 426 cannot be a disguised 404: the call exists and is owned by
// this caller, and the only thing missing is the upgrade.
test('a sideband path reached without an upgrade header answers 426 with Upgrade: websocket', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(app);

  const response = await app.request('/v1/live/call_abc');

  expect(response.status).toBe(426);
  expect(response.headers.get('upgrade')).toBe('websocket');
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('websocket_upgrade_required');
});

// `/v1/realtime` is both the sideband-attach and the direct-connection route, so a `call_id`
// the pattern rejects must be an error rather than a quiet demotion into a direct connection
// to the upstream. A fall-through dials, and the fixture's `dial` rejects with a 502, so the
// two outcomes are distinguishable.
test('a malformed call id is 400, never a silent fall-through to a direct connection', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });

  const response = await app.request('/v1/realtime?call_id=..%2Fsecrets', {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });

  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_call_id');
});

// The two requests of a realtime session carry two independent credentials, and `/v1/*`
// authentication only proves that a caller may use the proxy. Both the attach and the hangup
// therefore fall back on the owner recorded at create time.
test('a different static key cannot attach to or hang up another caller’s call', async () => {
  const app = await createServer({
    config: { providers: {}, server: { apiKeys: [{ key: 'key-owner' }, { key: 'key-other' }] } },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(app, 'key-owner');

  const attach = await app.request('/v1/live/call_abc', {
    headers: { authorization: 'Bearer key-other', upgrade: 'websocket', connection: 'Upgrade' },
  });
  const hangup = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: 'Bearer key-other' },
  });

  expect(attach.status).toBe(403);
  expect(((await attach.json()) as { error: { code: string } }).error.code).toBe('realtime_call_scope_mismatch');
  expect(hangup.status).toBe(403);
  expect(((await hangup.json()) as { error: { code: string } }).error.code).toBe('realtime_call_scope_mismatch');
});

// The positive controls for the test above. Without them, a route that 403s whenever keys are
// configured — or one that compares only the principal `kind`, so every anonymous caller
// collides — would pass the ownership test while breaking both supported deployments.
test('the creating key is not 403ed, and anonymous mode does not 403 its only caller', async () => {
  const keyed = await createServer({
    config: { providers: {}, server: { apiKeys: [{ key: 'key-owner' }] } },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(keyed, 'key-owner');
  const keyedHangup = await keyed.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: 'Bearer key-owner' },
  });

  const anonymous = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(anonymous);
  const anonymousHangup = await anonymous.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });

  expect(keyedHangup.status).toBe(204);
  expect(anonymousHangup.status).toBe(204);
});

test('a hangup for an unknown call is 404 and a 2xx hangup deletes the record', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(app);

  const first = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });
  const second = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });

  expect(first.status).toBe(204);
  expect(second.status).toBe(404);
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe('realtime_call_not_found');
});

/** SDP bodies, `Location` values, and credentials are never logged. Types are the only
 *  compile-time enforcement of that and they are provably insufficient: the excess-property
 *  check that rejects an unknown key does not fire on a pre-built variable nor on a literal
 *  containing a spread, and nothing at all stops an offer or a credential being smuggled into
 *  an *allowed* `string` field such as `RealtimeCallFailedLog.errorCode`. So the rule needs a
 *  runtime assertion, and it has to scan the whole serialized entry rather than a hand-picked
 *  field list — the value that leaks is the one in the field nobody thought to check.
 *
 *  Run without configured keys deliberately: `authenticateStaticOrAnonymous` only calls
 *  `stripCallerCredentials` on the keyed branch, so on a keyless proxy the caller's
 *  `Authorization` header is still readable inside the route. That is the live channel a
 *  credential could leak through, and asserting against it on a keyed server instead would be
 *  an assertion nothing could break. */
test('no realtime log entry carries the offer, the upstream Location, or the caller credential', async () => {
  const logs: ServerLog[] = [];
  let creates = 0;
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [
      realtimeProvider(() => {
        creates += 1;
        return creates === 1 ? upstreamCreated() : upstreamRejected();
      }),
    ],
    logger: (entry) => logs.push(entry),
  });

  const created = await sentinelCreate(app);
  const rejected = await sentinelCreate(app);
  const hungUp = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: `Bearer ${SENTINEL_CREDENTIAL}` },
  });

  // Asserted before the scan: an empty `logs` would make every `not.toContain` below pass for
  // the one reason that proves nothing. This also pins which log sites the sequence reaches.
  expect(logs.map((entry) => `${entry.event}/${'errorCode' in entry ? entry.errorCode : ''}`)).toEqual([
    'realtime.call_created/',
    'realtime.call_failed/upstream_rejected',
  ]);
  expect([created.status, rejected.status, hungUp.status]).toEqual([201, 400, 204]);

  const serialized = logs.map((entry) => JSON.stringify(entry)).join('\n');
  for (const sentinel of [SENTINEL_ICE, SENTINEL_HOST, SENTINEL_CREDENTIAL]) {
    expect(serialized).not.toContain(sentinel);
  }

  // The same values must not come back down the wire either. The upstream host lives in a
  // header on the 201 and in the body on the 400, so each is checked where it actually is.
  expect(created.headers.get('location')).toBe('/v1/live/call_abc');
  expect(rejected.headers.get('location')).toBeNull();
  expect(rejected.headers.get('set-cookie')).toBeNull();
  const envelope = await rejected.text();
  expect(envelope).not.toContain(SENTINEL_HOST);
  expect(envelope).not.toContain(SENTINEL_ICE);
  expect(JSON.parse(envelope)).toEqual({
    error: {
      message: 'The realtime upstream rejected this request.',
      type: 'invalid_request_error',
      param: null,
      code: 'upstream_rejected',
    },
  });
});

/** Distinctive enough that a substring match cannot collide with anything a log legitimately
 *  carries — notably not with `call_abc`, which `realtime.call_created` records on purpose. */
const SENTINEL_ICE = 'a=candidate:SENTINEL-ICE-7c2f9b1d';
const SENTINEL_HOST = 'sentinel-upstream-host.invalid';
const SENTINEL_CREDENTIAL = 'sk-sentinel-caller-credential-7f31';
const SENTINEL_OFFER = `v=0\r\n${SENTINEL_ICE} 1 udp 2130706433 typ host\r\n`;

/** No-op sink for the tests that assert on responses: `defaultLogger` otherwise writes every
 *  realtime event to stderr, burying the output of a real failure. */
const discard = (): void => {};

function sentinelCreate(app: Awaited<ReturnType<typeof createServer>>): Promise<Response> {
  return app.request('/v1/live', {
    method: 'POST',
    body: SENTINEL_OFFER,
    headers: { 'content-type': 'application/sdp', authorization: `Bearer ${SENTINEL_CREDENTIAL}` },
  });
}

function upstreamCreated(): Response {
  return new Response('v=0\r\na=answer\r\n', {
    status: 201,
    headers: {
      'content-type': 'application/sdp',
      location: `https://${SENTINEL_HOST}/v1/realtime/calls/call_abc`,
    },
  });
}

function upstreamRejected(): Response {
  return new Response(`{"error":{"message":"rejected ${SENTINEL_ICE} for https://${SENTINEL_HOST}/calls"}}`, {
    status: 400,
    headers: {
      'content-type': 'application/json',
      location: `https://${SENTINEL_HOST}/gone`,
      'set-cookie': 'upstream-session=leak',
    },
  });
}

async function create(app: Awaited<ReturnType<typeof createServer>>, key?: string): Promise<void> {
  const response = await app.request('/v1/live', {
    method: 'POST',
    body: 'v=0\r\n',
    headers: {
      'content-type': 'application/sdp',
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
  });
  if (response.status !== 201) throw new Error(`create failed with ${response.status}`);
}

/** A fake `RuntimeProviderInstance` carrying only a `realtime` capability, so the real app is
 *  exercised with no plugin machinery, OAuth account, or credential store involved. */
function realtimeProvider(createAnswer: () => Response = upstreamCreated): RuntimeProviderInput {
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
      fetch: (request: Request) =>
        Promise.resolve(
          new URL(request.url).pathname.endsWith('/hangup')
            ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
            : createAnswer(),
        ),
      dial: () => Promise.reject(new Error('not dialed in this test')),
    },
  } as unknown as RuntimeProviderInput;
}
