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
  expect(store.reserveCapacity()).toBeUndefined();

  clock += REALTIME_CALL_TTL_MS + 1;
  expect(store.reserveCapacity()).toBeDefined();
  expect(store.size()).toBe(0);
});

// The create that owns a slot yields on the upstream fetch before it inserts, so a
// second create running in that window sees a store whose `size()` has not moved yet.
// Counting only inserted records would hand both of them the last slot and overshoot
// the bound; the slot must be what is counted.
test('an unreleased capacity slot occupies the bound before its record is inserted', () => {
  const store = createRealtimeCallStore({ capacity: 2 });
  store.insert(record({ callId: 'call_1' }));

  const slot = store.reserveCapacity();

  expect(slot).toBeDefined();
  // `size()` is still 1 of 2 — the slot is the only thing standing in the way.
  expect(store.size()).toBe(1);
  expect(store.reserveCapacity()).toBeUndefined();

  slot!.release();
  expect(store.reserveCapacity()).toBeDefined();
});

// Every create path releases through one `finally`, and `commit` may also have inserted
// the record. A release that decremented twice would let the store exceed its capacity by
// one slot per double-released create.
test('releasing a capacity slot twice does not manufacture a second slot', () => {
  const store = createRealtimeCallStore({ capacity: 1 });
  const slot = store.reserveCapacity()!;

  slot.release();
  slot.release();
  const second = store.reserveCapacity();

  expect(second).toBeDefined();
  expect(store.reserveCapacity()).toBeUndefined();
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

// The store is keyed on the call ID alone, so a second record under a live ID would hand the
// FIRST call's owner and provider pin to the second caller. Worse, the first call's attachment
// is orphaned by the replacement — and the relay's teardown deletes by call ID, so that stale
// socket's close would delete the REPLACEMENT's record, leaving a live sideband the proxy can no
// longer route. Both are asserted here because the second is the sharper failure.
test('insert refuses a call id already held by a live record and leaves the first call intact', () => {
  const store = createRealtimeCallStore();
  expect(store.insert(record({ owner: { kind: 'key', id: 'first' } }))).toBe(true);
  const firstAttachment = store.reserve('call_abc')!;

  expect(store.insert(record({ owner: { kind: 'key', id: 'second' }, providerId: 'other' }))).toBe(false);

  // The live call kept its own owner and provider pin, so the second caller cannot attach to it.
  expect(store.lookup('call_abc')).toMatchObject({ owner: { kind: 'key', id: 'first' }, providerId: 'codex' });
  // And the first call's attachment is still the one the store holds, so its teardown can only
  // ever delete the record it actually belongs to.
  expect(store.attachment('call_abc')?.token).toBe(firstAttachment.token);
  expect(store.size()).toBe(1);
});

// A refused insert must not consume the ID forever: once the first call has expired, the same
// ID is ordinary free space again. Without this the collision check would turn a transient
// overlap into a permanently unusable call ID for the life of the process.
test('insert accepts a call id whose previous record has expired', () => {
  let clock = 1_000;
  const store = createRealtimeCallStore({ now: () => clock });
  expect(store.insert({ ...record(), createdAt: clock })).toBe(true);

  clock += REALTIME_CALL_TTL_MS + 1;

  expect(store.insert({ ...record({ providerId: 'later' }), createdAt: clock })).toBe(true);
  expect(store.lookup('call_abc')).toMatchObject({ providerId: 'later' });
});

// `insert` is a no-op after `close()` — a create that still dialed would otherwise answer 201
// with a Location no attach could resolve — so it must report that, not silently succeed.
test('insert reports failure once the store is closed', () => {
  const store = createRealtimeCallStore();
  store.close();

  expect(store.insert(record())).toBe(false);
  expect(store.lookup('call_abc')).toBeUndefined();
});

// A direct `GET /v1/realtime` has no `call_id`, so it never reaches `entries` — and `entries` is
// all the server's shutdown walks. Without a registration of its own, a live direct relay was
// force-terminated by `server.stop(true)` instead of being closed with the spec's `1001`.
test('close tears down a tracked relay that owns no call record', () => {
  const store = createRealtimeCallStore();
  const codes: number[] = [];
  const hook = store.trackShutdown((code) => codes.push(code));

  store.close();
  store.close();

  expect(hook).toBeDefined();
  expect(codes).toEqual([1001]);
});

// Two concurrent direct relays are ordinary: nothing keys them apart but their registration,
// so a store that kept only one teardown would leave the other force-closed.
test('every tracked relay is torn down, and a released one is not', () => {
  const store = createRealtimeCallStore();
  const closed: string[] = [];
  store.trackShutdown(() => closed.push('first'));
  const second = store.trackShutdown(() => closed.push('second'));
  const third = store.trackShutdown(() => closed.push('third'));

  // A relay whose own socket ended before shutdown: its teardown already ran, and running it
  // again from `close()` would be a second teardown for one relay.
  third!.release();
  third!.release();

  store.close();

  expect(second).toBeDefined();
  expect(closed).toEqual(['first', 'second']);
});

// Registration happens up to a full dial deadline after the request began, so shutdown can land
// first. Refusing silently would leave the upstream socket with nothing to close it, which is the
// same hazard `reserve().onClose` already handles for a call-backed attach.
test('trackShutdown refuses a registration once the store is closed', () => {
  const store = createRealtimeCallStore();
  store.close();

  expect(store.trackShutdown(() => {})).toBeUndefined();
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
