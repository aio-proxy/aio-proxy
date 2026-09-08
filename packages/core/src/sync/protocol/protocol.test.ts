import { expect, test } from 'bun:test';

import { beginPurge, decodeHead, decodeRevision, encode, newHead, publish, reserve, SyncProtocolError } from '.';

test('a reserved stale edit cannot publish after purge starts', () => {
  const initial = newHead(crypto.randomUUID(), {
    kind: 'provider',
    logicalKey: 'work',
    value: { kind: 'api' },
    dependencies: [],
  });
  const staged = reserve(initial, 'operation-a', 0);
  const purging = beginPurge(staged);
  expect(() => publish(purging, 'operation-a', 0)).toThrow('deleted');
  expect(purging.reserved).toEqual(['operation-a']);
});

test('publication orders complete entities and keeps prior history', () => {
  let head = newHead(crypto.randomUUID(), { kind: 'provider', logicalKey: 'work', value: {}, dependencies: [] });
  head = publish(reserve(head, 'a', 0), 'a', 0);
  head = publish(reserve(head, 'b', 0), 'b', 0);
  expect(head).toMatchObject({ current: 'b', history: ['a'], sequence: 2 });
});

test('protocol decoders reject newer versions without changing source bytes', () => {
  const value = { protocol: 2, state: 'payload', secret: 'must-not-be-in-error' };
  const bytes = encode(value);
  expect(() => decodeRevision(bytes)).toThrow(SyncProtocolError);
  expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(value));
  expect(() => decodeHead(encode({ protocol: 2 }))).toThrow(/upgrade-required/);
});

test('duplicate reservations and publications are idempotent', () => {
  let head = newHead(crypto.randomUUID(), { kind: 'provider', logicalKey: 'work', value: {}, dependencies: [] });
  head = reserve(head, 'a', 0);
  expect(reserve(head, 'a', 0)).toBe(head);
  const published = publish(head, 'a', 0);
  expect(publish(published, 'a', 0)).toBe(published);
});

test('encoding rejects non JSON values', () => {
  expect(() => encode(Number.NaN)).toThrow(/finite/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => encode(cyclic)).toThrow(/cycle/);
});
