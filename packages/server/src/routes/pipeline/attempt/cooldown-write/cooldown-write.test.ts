import { describe, expect, test } from 'bun:test';

import type { CandidateHold } from '../../quota-gate';
import { cooldownTtlMs, selectLiveCandidates } from './cooldown-write';

const cap = 30_000;
describe('cooldownTtlMs', () => {
  test('non-429 never cools', () => {
    expect(cooldownTtlMs(503, '5', cap)).toBe(0);
    expect(cooldownTtlMs(500, null, cap)).toBe(0);
  });
  test('429 numeric Retry-After within cap', () => {
    expect(cooldownTtlMs(429, '5', cap)).toBe(5_000);
  });
  test('429 Retry-After above cap clamps', () => {
    expect(cooldownTtlMs(429, '120', cap)).toBe(cap);
  });
  test('429 without parseable Retry-After does not cool', () => {
    expect(cooldownTtlMs(429, null, cap)).toBe(0);
    expect(cooldownTtlMs(429, 'garbage', cap)).toBe(0);
  });
});

describe('selectLiveCandidates', () => {
  const candidate = (id: string) =>
    ({ provider: { id } }) as unknown as Parameters<typeof selectLiveCandidates>[0][number];
  const holds = (table: Record<string, CandidateHold>) => (c: { readonly provider: { readonly id: string } }) =>
    table[c.provider.id];

  test('keeps survivors in order and reports each skipped candidate with its reason', () => {
    const selection = selectLiveCandidates(
      ['a', 'b', 'c', 'd'].map(candidate),
      holds({ a: { reason: 'quota_exhausted', remainingMs: 5_000 }, c: { reason: 'cooldown', remainingMs: 1_000 } }),
    );
    expect(selection.kind).toBe('proceed');
    if (selection.kind !== 'proceed') return;
    expect(selection.live.map((c) => c.provider.id)).toEqual(['b', 'd']);
    expect(selection.skipped).toEqual([
      { providerId: 'a', reason: 'quota_exhausted' },
      { providerId: 'c', reason: 'cooldown' },
    ]);
  });

  test('every candidate held synthesizes a retry window from the shortest hold', () => {
    const selection = selectLiveCandidates(
      ['a', 'b'].map(candidate),
      holds({ a: { reason: 'quota_exhausted', remainingMs: 90_400 }, b: { reason: 'cooldown', remainingMs: 200_000 } }),
    );
    expect(selection).toEqual({
      kind: 'all-cooled',
      retryAfterSeconds: 91,
      skipped: [
        { providerId: 'a', reason: 'quota_exhausted' },
        { providerId: 'b', reason: 'cooldown' },
      ],
    });
  });

  test('a sub-second hold still asks the client to wait one second', () => {
    const selection = selectLiveCandidates([candidate('a')], holds({ a: { reason: 'cooldown', remainingMs: 10 } }));
    expect(selection).toMatchObject({ kind: 'all-cooled', retryAfterSeconds: 1 });
  });
});
