import { afterEach, expect, test } from 'bun:test';

import { RealtimeDialError } from '@aio-proxy/plugin-sdk';
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
  // satisfy every assertion above while swallowing the endpoints that are supported. Asserted
  // as the hangup handler's own `realtime_call_not_found` envelope rather than as `not.toBe(501)`,
  // which a route deleted from the app would also satisfy through Hono's bare text 404.
  const supported = await app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST' });
  expect(supported.status).toBe(404);
  expect(((await supported.json()) as { error: { code: string } }).error.code).toBe('realtime_call_not_found');
});

// The 426 is decided before any call-store lookup, so a missing upgrade header cannot be
// answered as a 404 for one caller and a 426 for another — and a probe cannot learn whether a
// call id exists by omitting the header. Both store states are driven: `call_abc` was created
// and is owned by this caller, `call_missing` never existed. Moving the upgrade check to after
// `prepare()` turns the second request into a 404, which is the regression this pair pins;
// asserting only the created call would leave that reordering invisible.
test('a sideband path without an upgrade header answers 426 with Upgrade: websocket, before any call lookup', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });
  await create(app);

  const created = await app.request('/v1/live/call_abc');
  const unknown = await app.request('/v1/live/call_missing');

  for (const response of [created, unknown]) {
    expect(response.status).toBe(426);
    expect(response.headers.get('upgrade')).toBe('websocket');
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('websocket_upgrade_required');
  }
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

// `/v1/realtime` without a `call_id` is the direct route, and its `model` query is sent
// upstream and recorded in both sideband log entries. It is the second place a caller supplies
// a model id, so it carries the same 128-character bound as the create body — asserted through
// the real app because the bound has to sit ahead of selection, not inside the log.
test('a direct-connection model query over 128 characters is 400, not dialed', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [realtimeProvider()],
    logger: discard,
  });

  const response = await app.request(`/v1/realtime?model=gpt-${'x'.repeat(200)}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });

  // The fixture's `dial` rejects, so a bound that failed to run would surface as the 502 the
  // malformed-call-id test above relies on rather than as this 400.
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_invalid_model');
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

/** `RealtimeDialInput.headers` documents to every plugin that caller credentials are already
 *  stripped, and the ChatGPT plugin forwards inbound headers selectively on that basis. The
 *  auth middleware only delivers it on its keyed branch: with `server.apiKeys` empty,
 *  `authenticateStaticOrAnonymous` admits the request without calling
 *  `stripCallerCredentials`, so the caller's own `Authorization` was still on the request
 *  when the sideband handed the headers to `dial`.
 *
 *  Run without configured keys deliberately, and only meaningful that way: on a keyed proxy
 *  the middleware has already deleted these three headers, so the same assertions would hold
 *  no matter what the sideband did. Asserted through the real app because the fix is a
 *  property of the composition of the middleware and the route. A header the middleware never
 *  touches is checked too, otherwise handing `dial` an empty `Headers` would pass. */
test('a dial on a keyless proxy receives no caller credential, only the harmless headers', async () => {
  let dialed: Headers | undefined;
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [
      capturingDialProvider((input) => {
        dialed = input;
      }),
    ],
    logger: discard,
  });

  const response = await app.request('/v1/realtime', {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      authorization: `Bearer ${SENTINEL_CREDENTIAL}`,
      'x-api-key': SENTINEL_CREDENTIAL,
      'x-goog-api-key': SENTINEL_CREDENTIAL,
      'openai-beta': 'realtime=v1',
    },
  });

  // The fixture rejects the dial, so reaching it at all is what proves the headers were read.
  expect(response.status).toBe(502);
  expect(dialed).toBeDefined();
  for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) {
    expect(dialed?.get(header)).toBeNull();
  }
  expect([...(dialed?.keys() ?? [])]).toContain('openai-beta');
  expect([...(dialed?.values() ?? [])].join('\n')).not.toContain(SENTINEL_CREDENTIAL);
});

/** The query analogue of the header test above, and the same asymmetry one channel over.
 *  `stripCallerCredentials` rewrites the request — removing `?key=` and `?auth_token=` — only on
 *  the keyed branch, so on a keyless proxy both are still on the inbound URL. Both the create and
 *  the hangup build their upstream `Request` from that URL, and the ChatGPT plugin's
 *  `mergeEndpointQuery` copies every inbound parameter onto its own upstream endpoint, so a
 *  caller presenting a credential in a supported query form disclosed it upstream.
 *
 *  Run keyless deliberately, for the same reason: on a keyed proxy the middleware already
 *  rewrote the URL, so these assertions would hold no matter what the routes did. A parameter
 *  the middleware never touches is asserted present too, otherwise a route that fetched a
 *  bare path with no query at all would pass. */
test('a keyless create and hangup send no caller query credential upstream, only the harmless query', async () => {
  const urls: string[] = [];
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [urlCapturingProvider(urls)],
    logger: discard,
  });

  const query = `key=${SENTINEL_CREDENTIAL}&auth_token=${SENTINEL_CREDENTIAL}&intent=quicksilver`;
  const created = await app.request(`/v1/live?${query}`, {
    method: 'POST',
    body: 'v=0\r\n',
    headers: { 'content-type': 'application/sdp' },
  });
  const hungUp = await app.request(`/v1/realtime/calls/call_abc/hangup?${query}`, { method: 'POST' });

  // Both upstream calls must have happened, or the absence assertions below would hold
  // because nothing was ever fetched.
  expect([created.status, hungUp.status]).toEqual([201, 204]);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    const searchParams = new URL(url).searchParams;
    expect(searchParams.get('key')).toBeNull();
    expect(searchParams.get('auth_token')).toBeNull();
    // The positive control: an unrelated inbound parameter still reaches the plugin, so a
    // route that discarded the whole query could not pass.
    expect(searchParams.get('intent')).toBe('quicksilver');
  }
  expect(urls.join('\n')).not.toContain(SENTINEL_CREDENTIAL);
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
 *  an assertion nothing could break.
 *
 *  All three `realtime.call_failed` emit sites are driven, because the guard is a runtime scan
 *  and a scan only covers the sites the fixture reaches. `realtime_upstream_unavailable` has two
 *  call sites — the zero-candidate/capacity pre-check and the exhausted-candidate loop tail — and
 *  neither was reached by a sentinel-carrying request, so an offer smuggled into any of their
 *  fields was invisible here. The pre-check one is the cheapest reach of all: no upstream call, no
 *  credential, no successful create. */
test('no realtime log entry carries the offer, the upstream Location, or the caller credential', async () => {
  const logs: ServerLog[] = [];
  let creates = 0;
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [
      realtimeProvider(() => {
        creates += 1;
        if (creates === 1) return upstreamCreated();
        return creates === 2 ? upstreamRejected() : upstreamUnavailable();
      }),
    ],
    logger: (entry) => logs.push(entry),
  });

  const created = await sentinelCreate(app);
  const rejected = await sentinelCreate(app);
  // The caller's own `model` is the one log field types cannot police: it is a legal
  // `string` a caller fills in, so only a length bound stops an offer being pasted into it.
  // Over the bound the create is refused before selection and nothing is logged at all; the
  // sentinel prefix means an unbounded passthrough would instead reach the log below.
  const overlongModel = await sentinelModelCreate(app, `${SENTINEL_ICE}${'x'.repeat(200)}`);
  // A model no provider advertises leaves zero candidates, which is the pre-check
  // `realtime_upstream_unavailable` site — reached with a sentinel-carrying offer and a
  // sentinel credential still on the request, so the scan below finally covers it.
  const noCandidate = await sentinelModelCreate(app, 'unadvertised-live-model');
  // The loop-tail site of the same error: an advertised model whose only candidate 5xxs.
  const exhausted = await sentinelModelCreate(app, 'gpt-live-1-codex');
  const hungUp = await app.request('/v1/realtime/calls/call_abc/hangup', {
    method: 'POST',
    headers: { authorization: `Bearer ${SENTINEL_CREDENTIAL}` },
  });

  // Asserted before the scan: an empty `logs` would make every `not.toContain` below pass for
  // the one reason that proves nothing. This also pins which log sites the sequence reaches, so
  // a new realtime log point makes it fail: extend this expected sequence with the new entry —
  // do not relax it to a subset match or a length check, which would restore the vacuous pass.
  expect(logs.map((entry) => `${entry.event}/${'errorCode' in entry ? entry.errorCode : ''}`)).toEqual([
    'realtime.call_created/',
    'realtime.call_failed/upstream_rejected',
    'realtime.call_failed/realtime_upstream_unavailable',
    'realtime.call_failed/realtime_upstream_unavailable',
  ]);
  expect([
    created.status,
    rejected.status,
    overlongModel.status,
    noCandidate.status,
    exhausted.status,
    hungUp.status,
  ]).toEqual([201, 400, 400, 503, 503, 204]);
  expect(((await overlongModel.json()) as { error: { code: string } }).error.code).toBe('realtime_invalid_model');

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

/** A JSON create, the only shape that carries a caller-chosen `model`, with the sentinel offer
 *  in `sdp` and the sentinel credential still on the request. */
function sentinelModelCreate(app: Awaited<ReturnType<typeof createServer>>, model: string): Promise<Response> {
  return app.request('/v1/live', {
    method: 'POST',
    body: JSON.stringify({ sdp: SENTINEL_OFFER, model }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_CREDENTIAL}` },
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

/** A 5xx with the sentinels in the places an upstream was observed putting them, so the
 *  exhausted-candidate log site is reached with something to leak. */
function upstreamUnavailable(): Response {
  return new Response(`upstream down: ${SENTINEL_ICE} at https://${SENTINEL_HOST}/calls`, {
    status: 503,
    headers: { 'content-type': 'text/plain', location: `https://${SENTINEL_HOST}/retry` },
  });
}

/** A realtime provider whose `dial` records the headers it was handed and then rejects, so
 *  the assertions run on the input the plugin contract is about rather than on a live relay. */
function capturingDialProvider(capture: (headers: Headers) => void): RuntimeProviderInput {
  return {
    ...(realtimeProvider() as unknown as Record<string, unknown>),
    realtime: {
      models: ['gpt-live-1-codex'],
      fetch: () => Promise.reject(new Error('not created in this test')),
      dial: (input: { readonly headers: Headers }) => {
        capture(input.headers);
        return Promise.reject(new RealtimeDialError('refused', { kind: 'rejected' }));
      },
    },
  } as unknown as RuntimeProviderInput;
}

/** A realtime provider whose `fetch` records the URL it was handed, so the assertions run on
 *  what the plugin would rewrite onto its upstream endpoint rather than on a live upstream. */
function urlCapturingProvider(urls: string[]): RuntimeProviderInput {
  const base = realtimeProvider() as unknown as { realtime: { fetch: (request: Request) => Promise<Response> } };
  return {
    ...(base as unknown as Record<string, unknown>),
    realtime: {
      ...base.realtime,
      fetch: (request: Request) => {
        urls.push(request.url);
        return base.realtime.fetch(request);
      },
    },
  } as unknown as RuntimeProviderInput;
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
