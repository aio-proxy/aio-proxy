import { expect, test } from 'bun:test';

import { CONNECT_END_STREAM_FLAG, ConnectFrameDecoder, frameConnectMessage, parseConnectEndStream } from './frame';

test('frameConnectMessage writes flags, big-endian length, then payload', () => {
  const framed = frameConnectMessage(new Uint8Array([1, 2, 3]));
  expect(framed.length).toBe(8);
  expect(framed[0]).toBe(0);
  expect(new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1)).toBe(3);
  expect(Array.from(framed.slice(5))).toEqual([1, 2, 3]);
});

test('ConnectFrameDecoder reassembles a frame split across two chunks', () => {
  const framed = frameConnectMessage(new Uint8Array([9, 8, 7, 6]), CONNECT_END_STREAM_FLAG);
  const decoder = new ConnectFrameDecoder();
  expect(decoder.push(framed.slice(0, 3))).toEqual([]);
  const frames = decoder.push(framed.slice(3));
  expect(frames.length).toBe(1);
  expect(frames[0]?.flags).toBe(CONNECT_END_STREAM_FLAG);
  expect([...frames[0]!.payload]).toEqual([9, 8, 7, 6]);
});

test('parseConnectEndStream surfaces an envelope error', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ error: { code: 'resource_exhausted', message: 'quota' } }));
  expect(parseConnectEndStream(payload)).toEqual({
    error: { code: 'resource_exhausted', message: 'quota' },
  });
  expect(parseConnectEndStream(new TextEncoder().encode('{}'))).toEqual({});
});
