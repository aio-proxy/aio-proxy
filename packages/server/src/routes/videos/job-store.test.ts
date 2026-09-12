import { describe, expect, test } from 'bun:test';

import { createVideoJobStore, expiresAtFromUpstream, isValidVideoId, sameVideoOwner } from './job-store';

const owner = { kind: 'key', id: 'a' } as const;

function record(videoId: string, createdAt = 1_000) {
  return {
    videoId,
    providerId: 'openai',
    model: 'sora-2',
    owner,
    createdAt,
    expiresAt: createdAt + 60_000,
  };
}

describe('createVideoJobStore', () => {
  test('inserts and looks up a record', () => {
    const store = createVideoJobStore({ now: () => 1_000 });
    expect(store.insert(record('video_abc'))).toBe(true);
    expect(store.lookup('video_abc')?.providerId).toBe('openai');
  });

  test('does not replace an existing id', () => {
    const store = createVideoJobStore({ now: () => 1_000 });
    expect(store.insert(record('video_abc'))).toBe(true);
    expect(store.insert({ ...record('video_abc'), providerId: 'other' })).toBe(false);
    expect(store.lookup('video_abc')?.providerId).toBe('openai');
  });

  test('drops expired records', () => {
    let now = 1_000;
    const store = createVideoJobStore({ now: () => now });
    store.insert(record('video_abc', 1_000));
    now = 70_000;
    expect(store.lookup('video_abc')).toBeUndefined();
  });

  test('capacity reserve holds a slot across insert', () => {
    const store = createVideoJobStore({ now: () => 1_000, capacity: 1 });
    const slot = store.reserveCapacity();
    expect(slot).toBeDefined();
    expect(store.reserveCapacity()).toBeUndefined();
    expect(store.insert(record('video_abc'))).toBe(true);
    slot?.release();
    expect(store.reserveCapacity()).toBeUndefined();
  });
});

test('owner equality is kind plus id', () => {
  expect(sameVideoOwner({ kind: 'key', id: 'a' }, { kind: 'key', id: 'a' })).toBe(true);
  expect(sameVideoOwner({ kind: 'key', id: 'a' }, { kind: 'key', id: 'b' })).toBe(false);
  expect(sameVideoOwner({ kind: 'anonymous' }, { kind: 'key', id: 'a' })).toBe(false);
});

test('video ids are the official token alphabet', () => {
  expect(isValidVideoId('video_abc')).toBe(true);
  expect(isValidVideoId('..')).toBe(false);
  expect(isValidVideoId('a'.repeat(129))).toBe(false);
});

test('upstream expires_at shorter than the default wins', () => {
  expect(expiresAtFromUpstream(2, 1_000)).toBe(2_000);
  expect(expiresAtFromUpstream('nope', 1_000)).toBe(1_000 + 24 * 60 * 60 * 1000);
});
