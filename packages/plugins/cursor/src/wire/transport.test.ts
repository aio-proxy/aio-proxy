import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { frameConnectMessage } from './frame';
import { buildDiscoveryHeaders, buildRunHeaders, createNodeHttp2Transport, mapH2TransportError } from './transport';

class FakeClientHttp2Stream extends EventEmitter {
  closed = false;
  ended = false;
  readonly writes: Uint8Array[] = [];

  write(data: Uint8Array): boolean {
    this.writes.push(data);
    return true;
  }

  end(data?: Uint8Array): void {
    if (data) this.writes.push(data);
    this.ended = true;
  }

  close(): void {
    this.closed = true;
  }

  destroy(): void {
    this.closed = true;
  }
}

class FakeSession extends EventEmitter {
  constructor(private readonly stream: FakeClientHttp2Stream) {
    super();
  }

  request(): FakeClientHttp2Stream {
    return this.stream;
  }

  close(): void {}

  destroy(): void {}
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

test('openRun decodes framed server chunks into Connect frames', async () => {
  const fakeStream = new FakeClientHttp2Stream();
  const transport = createNodeHttp2Transport({
    connect: () => new FakeSession(fakeStream) as never,
  });
  const stream = await transport.openRun({ accessToken: 'tok' });
  const collected: number[][] = [];
  const reader = (async () => {
    for await (const frame of stream.frames) collected.push([...frame.payload]);
  })();
  fakeStream.emit('response', { ':status': 200 });
  fakeStream.emit('data', frameConnectMessage(new Uint8Array([7, 7])));
  fakeStream.emit('end');
  await reader;
  expect(collected).toEqual([[7, 7]]);
});
