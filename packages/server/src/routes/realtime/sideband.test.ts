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

// The relay is built before the upgrade is attempted, so a refused upgrade runs the one
// `teardown` — which must not treat that as the end of the call: the record is still
// valid and the owner's next attach has to find it. `teardown` is also the only thing
// that releases the reservation once the relay exists, so a refusal that skipped it
// would pin the call at 409 forever.
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

// An upstream that accepts the handshake and drops the socket immediately is a real
// shape — `close-code.ts` already treats `1006` as the distinguishable "connect failed"
// case, so everything else, including this one, arrives as an accepted-then-closed
// socket. The relay binds its upstream `close` listener only after `dial()` returns, so
// a close dispatched inside that gap is never observed and `teardown` never runs at all.
// A leaked reservation is unrecoverable: `expired()` exempts an entry with a live
// attachment, so TTL can never reclaim the slot and the owner's every later attach 409s.
test('an upstream already closed when the dial returns refuses the attach and frees the reservation', async () => {
  const logs: ServerLog[] = [];
  const harness = await createHarness({ logs, originClosesOnOpen: true });
  await harness.create('key-owner');

  // The downstream never reaches `open`: the handshake is answered with the error
  // status below instead of a 101.
  await expect(harness.attach('key-owner')).rejects.toThrow('downstream attach failed');

  expect(harness.store.attachment('call_abc')).toBeUndefined();
  // A dead sideband socket is a failed attach, not the end of the call, so the record
  // survives for the owner's retry — same as any other dial failure.
  expect(harness.store.lookup('call_abc')).toBeDefined();
  // Nothing opened, so neither half of the sideband log pair may appear.
  expect(logs.filter(({ event }) => event.startsWith('realtime.sideband_'))).toEqual([]);

  // 502 `realtime_dial_failed` rather than the upgrade-refusal 503 pins the ordering:
  // the dead-upstream check has to run *before* the upgrade is attempted, because after
  // it there is no longer a response to fail with.
  const refused = await harness.attachWithoutUpgradeSupport('key-owner');
  expect(refused.status).toBe(502);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('realtime_dial_failed');
});

// The hangup's own 403 has its own test; this asserts the pair that only a live
// sideband can show — a 2xx hangup by the owner tears the attached socket down.
test('a 2xx hangup by the owner closes the live sideband', async () => {
  const harness = await createHarness({});
  await harness.create('key-owner');
  const attached = await harness.attach('key-owner');
  const closed = attached.closed();

  const response = await harness.hangup('key-owner');

  expect(response.status).toBe(204);
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

async function createHarness(options: { logs?: ServerLog[]; originClosesOnOpen?: boolean }): Promise<Harness> {
  const logs = options.logs ?? [];
  const store = createRealtimeCallStore();
  const closesOnOpen = options.originClosesOnOpen ?? false;
  const origin = await startOrigin(closesOnOpen);
  let dials = 0;
  const source = sourceWith(store, logs, origin, closesOnOpen, () => {
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

/** Same workaround as `openai-chatgpt`'s `runtime/realtime.ts`: `bun-types` defers the
 *  global `WebSocket` constructor to `lib.dom`'s two-argument `(url, protocols)` form
 *  whenever the DOM lib is loaded, so the option object needs the real overload back.
 *  Bun does honor it at runtime — the 403 test above depends on the header arriving. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

async function openDownstream(url: string, key: string): Promise<Attached> {
  const socket = new BunWebSocket(url, { headers: { 'x-test-principal': key } });
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
 *  the relay's byte path and the close handshake are the production ones.
 *  `closesOnOpen` models an upstream that accepts the handshake and drops the socket
 *  at once — the only shape a client `WebSocket` cannot distinguish from a healthy one
 *  at dial time. */
async function startOrigin(closesOnOpen: boolean): Promise<Origin> {
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
        if (closesOnOpen) {
          ws.close(4009, 'origin gone');
          return;
        }
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
  closesOnOpen: boolean,
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
        // The production dial resolves from its own `open` listener and then unbinds,
        // so there is a real gap before the relay binds its `close` listener; whether
        // the upstream's close lands inside it is a race. Awaiting the close here makes
        // the worst case of that race deterministic instead of timing-dependent — the
        // dial still honors its contract, returning a socket that did reach `open`.
        if (closesOnOpen) {
          await new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) resolve();
            else socket.addEventListener('close', () => resolve());
          });
        }
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
