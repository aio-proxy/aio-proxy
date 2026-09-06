import { expect, test } from 'bun:test';

import { createRealtimeCallStore, type RealtimeCallRecord, REALTIME_CALL_TTL_MS } from './call-store';

test('a reservation is exclusive and released reservations are reusable', () => {
  const store = createRealtimeCallStore();
  store.insert(record());

  const first = store.reserve('call_abc');
  expect(first).toBeDefined();
  expect(store.reserve('call_abc')).toBeUndefined();

  store.release(first!.token);
  const second = store.reserve('call_abc');
  expect(second).toBeDefined();
  expect(second?.token).not.toBe(first?.token);
});

test('a superseded reservation cannot release a newer one', () => {
  const store = createRealtimeCallStore();
  store.insert(record());

  const first = store.reserve('call_abc')!;
  store.release(first.token);
  const second = store.reserve('call_abc')!;

  store.release(first.token);

  expect(store.attachment('call_abc')?.token).toBe(second.token);
  expect(store.reserve('call_abc')).toBeUndefined();
});

test('a record expires on lookup with no intervening insert, and a live attachment does not', () => {
  let clock = 1_000;
  const store = createRealtimeCallStore({ now: () => clock });
  store.insert({ ...record(), createdAt: clock });

  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.lookup('call_abc')).toBeUndefined();
  expect(store.size()).toBe(0);

  clock = 1_000;
  store.insert({ ...record({ callId: 'call_live' }), createdAt: clock });
  store.reserve('call_live');
  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.lookup('call_live')?.callId).toBe('call_live');
});

test('capacity counts only unexpired records', () => {
  let clock = 1_000;
  const store = createRealtimeCallStore({ capacity: 2, now: () => clock });
  store.insert({ ...record({ callId: 'call_1' }), createdAt: clock });
  store.insert({ ...record({ callId: 'call_2' }), createdAt: clock });
  expect(store.hasCapacity()).toBe(false);

  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.hasCapacity()).toBe(true);
  expect(store.size()).toBe(0);
});

test('close runs every live attachment teardown once with 1001 and empties the store', () => {
  const store = createRealtimeCallStore();
  store.insert(record());
  const attachment = store.reserve('call_abc')!;
  const codes: number[] = [];
  attachment.onClose((code) => codes.push(code));

  store.close();
  store.close();

  expect(codes).toEqual([1001]);
  expect(store.size()).toBe(0);
});

test('closeAttachment tears down a live socket with the given code and reports whether one existed', () => {
  const store = createRealtimeCallStore();
  store.insert(record());
  const codes: number[] = [];
  store.reserve('call_abc')!.onClose((code) => codes.push(code));

  expect(store.closeAttachment('call_abc', 1000)).toBe(true);
  expect(codes).toEqual([1000]);
  expect(store.closeAttachment('call_abc', 1000)).toBe(false);
  expect(store.closeAttachment('call_missing', 1000)).toBe(false);
});

test('remove drops the record so a later lookup and reserve both miss', () => {
  const store = createRealtimeCallStore();
  store.insert(record());

  store.remove('call_abc');

  expect(store.lookup('call_abc')).toBeUndefined();
  expect(store.reserve('call_abc')).toBeUndefined();
  expect(store.size()).toBe(0);
});

test('a teardown registered after the reservation is gone runs immediately instead of being dropped', () => {
  // Task 9's real ordering is reserve -> await dial() (up to 10s) -> onClose(...).
  // A shutdown or a hangup landing inside that window used to leave the upstream
  // socket with no teardown at all, because the store had already forgotten the
  // reservation the handle's closure still points at.
  const store = createRealtimeCallStore();
  store.insert(record());
  const shutdownHandle = store.reserve('call_abc')!;
  const shutdownCodes: number[] = [];

  store.close();
  shutdownHandle.onClose((code) => shutdownCodes.push(code));

  expect(shutdownCodes).toEqual([1001]);

  const live = createRealtimeCallStore();
  live.insert(record());
  const hangupHandle = live.reserve('call_abc')!;
  const hangupCodes: number[] = [];

  expect(live.closeAttachment('call_abc', 1000)).toBe(true);
  hangupHandle.onClose((code) => hangupCodes.push(code));

  expect(hangupCodes).toEqual([1000]);
});

test('a teardown registered while the reservation is still held is not run early', () => {
  const store = createRealtimeCallStore();
  store.insert(record());
  const codes: number[] = [];

  store.reserve('call_abc')!.onClose((code) => codes.push(code));

  expect(codes).toEqual([]);
  expect(store.closeAttachment('call_abc', 1000)).toBe(true);
  expect(codes).toEqual([1000]);
});

function record(overrides: Partial<RealtimeCallRecord> = {}): RealtimeCallRecord {
  return {
    callId: 'call_abc',
    providerId: 'codex',
    accountId: 'person@example.com',
    runtimeRevision: 3,
    model: 'gpt-live-1-codex',
    requestedModel: 'gpt-realtime',
    style: 'live',
    owner: { kind: 'anonymous' },
    createdAt: Date.now(),
    ...overrides,
  };
}
