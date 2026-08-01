import { expect, test } from 'bun:test';

import { CONNECT_END_STREAM_FLAG, frameConnectMessage } from './frame';
import { decodeConnectUnaryBody } from './unary';

test('returns the first non-end-stream frame body', () => {
  const body = new Uint8Array([10, 20, 30]);
  expect([...(decodeConnectUnaryBody(frameConnectMessage(body)) ?? [])]).toEqual([10, 20, 30]);
});

test('returns null when the compression flag is set', () => {
  expect(decodeConnectUnaryBody(frameConnectMessage(new Uint8Array([1]), 0b0000_0001))).toBeNull();
});

test('skips a leading end-stream frame and returns null when only end-stream is present', () => {
  expect(decodeConnectUnaryBody(frameConnectMessage(new Uint8Array([1, 2]), CONNECT_END_STREAM_FLAG))).toBeNull();
});
