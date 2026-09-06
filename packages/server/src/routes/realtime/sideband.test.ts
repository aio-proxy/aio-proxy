import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';
import { Hono } from 'hono';
import { websocket } from 'hono/bun';

import { type CallerPrincipalEnv, staticKeyCallerPrincipal } from '../../caller-principal';
import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import type { ServerLog } from '../../server-log';
import { createRealtimeCallStore, type RealtimeCallStore } from './call-store';
import { handleRealtimeHangup } from './hangup';
import { handleRealtimeSideband } from './sideband';
import { handleRealtimeCreate } from './signaling';
import type { RealtimeRouteSource } from './source';

const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

// A realtime session spans two requests carrying two independent credentials, so the
// only thing standing between a stranger holding a `call_id` and someone else's live
// media session is the recorded owner. `call-store.test.ts` tests `sameCallerPrincipal`
// as a pure function; nothing there notices if the attach stops calling it.
test('an attach presented under a different configured key is 403 before any dial or reservation', async () => {
  const logs: ServerLog[] = [];
  const harness = await createHarness({ logs });
  await harness.create('key-owner');

  const response = await harness.attachWithoutUpgradeSupport('key-other');

  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('realtime_call_scope_mismatch');
  // No dial happened, so no reservation was taken and no upstream socket was opened.
  expect(harness.dials).toBe(0);
  expect(harness.store.attachment('call_abc')).toBeUndefined();
  expect(harness.store.lookup('call_abc')).toBeDefined();
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'realtime.call_failed',
      statusCode: 403,
      errorCode: 'realtime_call_scope_mismatch',
    }),
  );
});

// The positive control for the test above: if the create recorded a constant owner, or
// the comparison were weakened to `kind` only, the 403 test would still pass while
// every caller was admitted. This one fails in that case.
test('the key that created the call attaches, relays in both directions, and closes the call', async () => {
  const logs: ServerLog[] = [];
  const harness = await createHarness({ logs });
  await harness.create('key-owner');

  const attached = await harness.attach('key-owner');
  // The origin sends this from its own `open`, before the downstream's 101 has been
  // handed back. Nothing is buffered on the proxy side — Bun runs `websocket.open`
  // synchronously inside `server.upgrade()`, so `onOpen` has already assigned the
  // downstream by the time any upstream frame can be dispatched — and this is the
  // assertion that would notice if the earliest frame were ever lost.
  expect(await attached.nextMessage()).toBe('origin greeting');
  attached.socket.send('client->origin');
  const echoed = await attached.nextMessage();

  expect(echoed).toBe('origin saw: client->origin');
  expect(harness.store.attachment('call_abc')).toBeDefined();

  const closed = attached.closed();
  harness.origin.closeLast(4002, 'origin done');
  expect(await closed).toMatchObject({ code: 4002, reason: 'origin done' });
  // An upstream close ends the call, so this record must be gone.
  expect(harness.store.lookup('call_abc')).toBeUndefined();
  expect(logs).toContainEqual(expect.objectContaining({ event: 'realtime.sideband_opened', callId: 'call_abc' }));
  expect(logs).toContainEqual(
    expect.objectContaining({ event: 'realtime.sideband_closed', closeCode: 4002, origin: 'upstream' }),
  );
});

// `relayEvents(...)` is an argument, so its upstream close listener is live before the
// upgrade is attempted. A refused upgrade therefore does run `teardown`, and `teardown`
// must not treat that as the end of the call: the record is still valid and the owner's
// next attach has to find it.
test('a refused upgrade leaves the call attachable and logs no sideband_closed', async () => {
  const logs: ServerLog[] = [];
  const harness = await createHarness({ logs });
  await harness.create('key-owner');

  const refused = await harness.attachWithoutUpgradeSupport('key-owner');

  expect(refused.status).toBe(503);
  // The 503 must be the upgrade refusal, not an earlier rejection: only the refusal
  // path has already dialed and already armed the relay's upstream close listener.
  expect(harness.dials).toBe(1);
  expect(harness.store.lookup('call_abc')).toBeDefined();
  expect(harness.store.attachment('call_abc')).toBeUndefined();

  const attached = await harness.attach('key-owner');
  expect(await attached.nextMessage()).toBe('origin greeting');
  attached.socket.send('after the refusal');

  expect(await attached.nextMessage()).toBe('origin saw: after the refusal');
  // A sideband that never opened must not be reported as one that closed: an unpaired
  // `sideband_closed` reads to an operator as a phantom upstream failure. Asserted
  // after the second attach so the refused socket's own close has had turns to land.
  expect(logs.filter(({ event }) => event === 'realtime.sideband_closed')).toEqual([]);
  attached.socket.close(1000, 'done');
});

// The hangup's own 403 has its own test; this asserts the pair that only a live
// sideband can show — a 2xx hangup by the owner tears the attached socket down.
test('a 2xx hangup by the owner closes the live sideband', async () => {
  const harness = await createHarness({});
  await harness.create('key-owner');
  const attached = await harness.attach('key-owner');
  const closed = attached.closed();

  const response = await harness.hangup('key-owner');

  expect(response.status).toBe(200);
  expect((await closed).code).toBe(1000);
  expect(harness.store.lookup('call_abc')).toBeUndefined();
});

type Harness = {
  readonly store: RealtimeCallStore;
  readonly origin: Origin;
  readonly dials: number;
  readonly create: (key: string) => Promise<void>;
  readonly hangup: (key: string) => Promise<Response>;
  readonly attach: (key: string) => Promise<Attached>;
  /** The Hono `app.request()` path, whose env carries no Bun server, so
   *  `upgradeWebSocket` throws exactly as it does when `server.upgrade` refuses. */
  readonly attachWithoutUpgradeSupport: (key: string) => Promise<Response>;
};

type Attached = {
  readonly socket: WebSocket;
  readonly nextMessage: () => Promise<string>;
  readonly closed: () => Promise<{ code: number; reason: string }>;
};

async function createHarness(options: { logs?: ServerLog[] }): Promise<Harness> {
  const logs = options.logs ?? [];
  const store = createRealtimeCallStore();
  const origin = await startOrigin();
  let dials = 0;
  const source = sourceWith(store, logs, origin, () => {
    dials += 1;
  });

  const app = new Hono<CallerPrincipalEnv>()
    // Stands in for the `/v1/*` auth middleware: the routes read the principal off the
    // context, so a per-request header models two distinct configured credentials.
    .use('*', async (context, next) => {
      const key = context.req.header('x-test-principal');
      if (key !== undefined) context.set('callerPrincipal', staticKeyCallerPrincipal(key));
      await next();
    })
    .post('/v1/live', (context) => handleRealtimeCreate(context, source, 'live'))
    .post('/v1/realtime/calls/:call_id/hangup', (context) => handleRealtimeHangup(context, source))
    .get('/v1/live/:call_id', (context) => handleRealtimeSideband(context, source, 'live'));

  const proxy = Bun.serve({
    port: 0,
    fetch: (request, server) => app.fetch(request, server),
    websocket: { ...websocket, idleTimeout: 255 },
  });
  stoppers.push(async () => {
    store.close();
    await proxy.stop(true);
  });

  return {
    store,
    origin,
    get dials() {
      return dials;
    },
    async create(key) {
      const response = await app.request('/v1/live', {
        method: 'POST',
        body: 'v=0\r\n',
        headers: { 'content-type': 'application/sdp', 'x-test-principal': key },
      });
      if (response.status !== 201) throw new Error(`create failed with ${response.status}`);
    },
    hangup: (key) =>
      Promise.resolve(
        app.request('/v1/realtime/calls/call_abc/hangup', { method: 'POST', headers: { 'x-test-principal': key } }),
      ),
    attach: (key) => openDownstream(`ws://localhost:${proxy.port}/v1/live/call_abc`, key),
    attachWithoutUpgradeSupport: (key) =>
      Promise.resolve(app.request('/v1/live/call_abc', { headers: { 'x-test-principal': key, upgrade: 'websocket' } })),
  };
}

async function openDownstream(url: string, key: string): Promise<Attached> {
  const socket = new WebSocket(url, { headers: { 'x-test-principal': key } });
  const inbox: string[] = [];
  let deliver: ((value: string) => void) | undefined;
  socket.addEventListener('message', (event: MessageEvent) => {
    const text = String(event.data);
    if (deliver !== undefined) {
      const resolve = deliver;
      deliver = undefined;
      resolve(text);
      return;
    }
    inbox.push(text);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', (event: CloseEvent) => resolve({ code: event.code, reason: event.reason }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('downstream attach failed')));
  });
  return {
    socket,
    nextMessage: () => {
      const buffered = inbox.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<string>((resolve) => {
        deliver = resolve;
      });
    },
    closed: () => closed,
  };
}

type Origin = {
  readonly url: string;
  readonly closeLast: (code: number, reason: string) => void;
};

/** The upstream realtime endpoint. A real `Bun.serve` WebSocket rather than a stub, so
 *  the relay's byte path and the close handshake are the production ones. */
async function startOrigin(): Promise<Origin> {
  let last: { close: (code: number, reason: string) => void } | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(request, self) {
      if (self.upgrade(request)) return undefined as unknown as Response;
      return new Response('not a websocket', { status: 400 });
    },
    websocket: {
      open(ws) {
        last = { close: (code, reason) => ws.close(code, reason) };
        // Speaks the instant it opens. That is the window the deleted pre-open buffer
        // claimed to protect, and it is why the relay binds its upstream `message`
        // listener before the upgrade rather than inside `onOpen`.
        ws.send('origin greeting');
      },
      message(ws, message) {
        ws.send(`origin saw: ${String(message)}`);
      },
    },
  });
  stoppers.push(async () => {
    await server.stop(true);
  });
  return {
    url: `ws://localhost:${server.port}`,
    closeLast(code, reason) {
      if (last === undefined) throw new Error('no origin socket is open');
      last.close(code, reason);
    },
  };
}

function sourceWith(
  store: RealtimeCallStore,
  logs: ServerLog[],
  origin: Origin,
  onDial: () => void,
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
            ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response('v=0\r\na=answer\r\n', {
                status: 201,
                headers: {
                  'content-type': 'application/sdp',
                  location: 'https://api.openai.com/v1/realtime/calls/call_abc',
                },
              }),
        ),
      dial: async () => {
        onDial();
        const socket = new WebSocket(origin.url);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve());
          socket.addEventListener('error', () => reject(new Error('origin dial failed')));
        });
        return socket;
      },
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
