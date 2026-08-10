import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { frameConnectMessage } from './frame';
import { buildDiscoveryHeaders, buildRunHeaders, createNodeHttp2Transport, mapH2TransportError } from './transport';

class FakeClientHttp2Stream extends EventEmitter {
  closed = false;
  ended = false;
  closeCalls = 0;
  endCalls = 0;
  readonly writes: Uint8Array[] = [];

  write(data: Uint8Array): boolean {
    this.writes.push(data);
    return true;
  }

  end(data?: Uint8Array): void {
    if (data) this.writes.push(data);
    this.endCalls += 1;
    this.ended = true;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }

  destroy(): void {
    this.closed = true;
  }
}

class FakeSession extends EventEmitter {
  closeCalls = 0;
  destroyCalls = 0;
  requestCalls = 0;

  constructor(
    readonly stream: FakeClientHttp2Stream,
    readonly requestError?: Error,
  ) {
    super();
  }

  request(): FakeClientHttp2Stream {
    this.requestCalls += 1;
    if (this.requestError !== undefined) throw this.requestError;
    return this.stream;
  }

  close(): void {
    this.closeCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
  }
}

function transportHarness(requestError?: Error): {
  transport: ReturnType<typeof createNodeHttp2Transport>;
  request: FakeClientHttp2Stream;
  session: FakeSession;
  connectCalls: () => number;
} {
  const request = new FakeClientHttp2Stream();
  const session = new FakeSession(request, requestError);
  let calls = 0;
  return {
    request,
    session,
    connectCalls: () => calls,
    transport: createNodeHttp2Transport({
      connect: () => {
        calls += 1;
        return session as never;
      },
    }),
  };
}

async function collectFrames(frames: AsyncIterable<{ payload: Uint8Array }>): Promise<number[][]> {
  const collected: number[][] = [];
  for await (const frame of frames) collected.push([...frame.payload]);
  return collected;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('promise did not settle')), 100);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('run headers carry the full Connect identity set', () => {
  const headers = buildRunHeaders({ accessToken: 'tok', requestId: 'req-1' });
  expect(headers['content-type']).toBe('application/connect+proto');
  expect(headers['connect-protocol-version']).toBe('1');
  expect(headers.te).toBe('trailers');
  expect(headers.authorization).toBe('Bearer tok');
  expect(headers['x-ghost-mode']).toBe('true');
  expect(headers['x-cursor-client-type']).toBe('cli');
  expect(headers['x-cursor-client-version']).toBeString();
  expect(headers['x-request-id']).toBe('req-1');
});

test('discovery uses application/proto, not application/connect+proto', () => {
  expect(buildDiscoveryHeaders({ accessToken: 'tok' })['content-type']).toBe('application/proto');
});

test('mapH2TransportError explains an ALPN h2 negotiation failure', () => {
  const mapped = mapH2TransportError(
    Object.assign(new Error('h2 is not supported'), { code: 'ERR_HTTP2_ERROR' }),
    'https://api2.cursor.sh',
  );
  expect(mapped).toBeInstanceOf(Error);
  expect((mapped as Error).message).toMatch(/HTTP\/2/);
  expect((mapped as Error).message).toMatch(/ALPN/);
});

test('a non-ALPN error passes through unchanged', () => {
  const original = new Error('boom');
  expect(mapH2TransportError(original, 'https://api2.cursor.sh')).toBe(original);
});

test('openRun finishes frames and releases its session once on normal EOF', async () => {
  const { transport, request, session } = transportHarness();
  const abort = new AbortController();
  const stream = await transport.openRun({ accessToken: 'tok', signal: abort.signal });
  const frames = collectFrames(stream.frames);

  request.emit('data', frameConnectMessage(new Uint8Array([7, 7])));
  request.emit('trailers', { 'grpc-status': '0' });
  request.emit('end');
  request.emit('end');
  abort.abort(new Error('late abort'));

  expect(await frames).toEqual([[7, 7]]);
  expect(await stream.trailers).toEqual({ 'grpc-status': '0' });
  expect(request.endCalls).toBe(1);
  expect(request.closeCalls).toBe(0);
  expect(session.closeCalls).toBe(1);
  expect(session.destroyCalls).toBe(0);
});

test('openRun settles frames and trailers on a request error', async () => {
  const { transport, request, session } = transportHarness();
  const stream = await transport.openRun({ accessToken: 'tok' });
  const frames = collectFrames(stream.frames);
  const error = new Error('request failed');

  request.emit('error', error);
  request.emit('error', new Error('late request error'));

  await expect(frames).rejects.toBe(error);
  expect(await stream.trailers).toEqual({});
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(0);
  expect(session.destroyCalls).toBe(1);
});

test('openRun settles frames and trailers on a session error', async () => {
  const { transport, request, session } = transportHarness();
  const stream = await transport.openRun({ accessToken: 'tok' });
  const frames = collectFrames(stream.frames);
  const error = new Error('session failed');

  session.emit('error', error);

  await expect(frames).rejects.toBe(error);
  expect(await within(stream.trailers)).toEqual({});
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(0);
  expect(session.destroyCalls).toBe(1);
});

test('openRun preserves an in-flight abort reason and releases once', async () => {
  const { transport, request, session } = transportHarness();
  const abort = new AbortController();
  const stream = await transport.openRun({ accessToken: 'tok', signal: abort.signal });
  const frames = collectFrames(stream.frames);
  const reason = new Error('stop this run');

  abort.abort(reason);
  session.emit('error', new Error('late session error'));

  await expect(frames).rejects.toBe(reason);
  expect(await stream.trailers).toEqual({});
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(0);
  expect(session.destroyCalls).toBe(1);
});

test('openRun rejects an already-aborted signal before connecting', async () => {
  const { transport, session, connectCalls } = transportHarness();
  const abort = new AbortController();
  const reason = new Error('already stopped');
  abort.abort(reason);

  await expect(transport.openRun({ accessToken: 'tok', signal: abort.signal })).rejects.toBe(reason);
  expect(connectCalls()).toBe(0);
  expect(session.requestCalls).toBe(0);
});

test('openRun rejects and destroys its dedicated session when request construction throws', async () => {
  const error = new Error('request construction failed');
  const { transport, request, session, connectCalls } = transportHarness(error);
  let pending!: Promise<unknown>;

  expect(() => {
    pending = transport.openRun({ accessToken: 'tok' });
  }).not.toThrow();
  await expect(pending).rejects.toBe(error);
  expect(connectCalls()).toBe(1);
  expect(session.requestCalls).toBe(1);
  expect(session.destroyCalls).toBe(1);
  expect(request.closeCalls).toBe(0);
});

test('openRun rejects a truncated frame after an earlier complete frame', async () => {
  const { transport, request, session } = transportHarness();
  const stream = await transport.openRun({ accessToken: 'tok' });
  const frames = stream.frames[Symbol.asyncIterator]();

  request.emit('data', frameConnectMessage(new Uint8Array([7])));
  expect(await frames.next()).toEqual({ done: false, value: { flags: 0, payload: new Uint8Array([7]) } });
  request.emit('data', frameConnectMessage(new Uint8Array([1, 2])).slice(0, 6));
  request.emit('end');

  await expect(frames.next()).rejects.toThrow('Truncated Cursor Connect frame');
  expect(await stream.trailers).toEqual({});
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(0);
  expect(session.destroyCalls).toBe(1);
});

test('openRun locally releases an MCP suspension with a buffered partial next frame', async () => {
  const { transport, request, session } = transportHarness();
  const stream = await transport.openRun({ accessToken: 'tok' });
  const frames = stream.frames[Symbol.asyncIterator]();
  const complete = frameConnectMessage(new Uint8Array([7]));
  const partialNext = frameConnectMessage(new Uint8Array([1, 2])).slice(0, 6);

  request.emit('data', new Uint8Array([...complete, ...partialNext]));
  expect(await frames.next()).toEqual({ done: false, value: { flags: 0, payload: new Uint8Array([7]) } });
  stream.end();
  stream.close();

  expect(await frames.next()).toEqual({ done: true, value: undefined });
  expect(await stream.trailers).toEqual({});
  expect(request.endCalls).toBe(1);
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(1);
  expect(session.destroyCalls).toBe(0);
});

test('unary rejects an already-aborted signal before connecting', async () => {
  const { transport, session, connectCalls } = transportHarness();
  const abort = new AbortController();
  const reason = new Error('already stopped');
  abort.abort(reason);

  const error = await transport
    .unary({ path: '/test', headers: {}, body: new Uint8Array(), timeoutMs: 10, signal: abort.signal })
    .catch((caught: unknown) => caught);

  expect(connectCalls()).toBe(0);
  expect(session.requestCalls).toBe(0);
  expect(error).toBe(reason);
});

test('unary rejects and destroys its dedicated session when request construction throws', async () => {
  const error = new Error('request construction failed');
  const { transport, request, session, connectCalls } = transportHarness(error);
  let pending!: Promise<unknown>;

  expect(() => {
    pending = transport.unary({ path: '/test', headers: {}, body: new Uint8Array(), timeoutMs: 10 });
  }).not.toThrow();
  await expect(pending).rejects.toBe(error);
  expect(connectCalls()).toBe(1);
  expect(session.requestCalls).toBe(1);
  expect(session.destroyCalls).toBe(1);
  expect(request.closeCalls).toBe(0);
});

test('unary preserves an in-flight abort reason and destroys its session', async () => {
  const { transport, request, session } = transportHarness();
  const abort = new AbortController();
  const pending = transport.unary({
    path: '/test',
    headers: {},
    body: new Uint8Array(),
    timeoutMs: 1_000,
    signal: abort.signal,
  });
  const reason = new Error('stop unary');

  abort.abort(reason);

  await expect(pending).rejects.toBe(reason);
  expect(request.closeCalls).toBe(1);
  expect(session.closeCalls).toBe(0);
  expect(session.destroyCalls).toBe(1);
});

for (const source of ['request', 'session'] as const) {
  test(`unary destroys its session on a ${source} error`, async () => {
    const { transport, request, session } = transportHarness();
    const pending = transport.unary({
      path: '/test',
      headers: {},
      body: new Uint8Array(),
      timeoutMs: 1_000,
    });
    const error = new Error(`${source} failed`);

    if (source === 'request') request.emit('error', error);
    else session.emit('error', error);

    await expect(pending).rejects.toBe(error);
    expect(request.closeCalls).toBe(1);
    expect(session.closeCalls).toBe(0);
    expect(session.destroyCalls).toBe(1);
  });
}
