import { describe, expect, test } from 'bun:test';

import type { RouterCandidate } from '@aio-proxy/core';
import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';

import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import type { RuntimeProviderInstance } from '../../../runtime';
import { applySelectionPolicy, orderByQuotaReset } from './quota-order';

const now = 1_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type Candidate = RouterCandidate<RuntimeProviderInstance>;

function candidate(
  id: string,
  {
    priority = 0,
    kind = ProviderKind.OAuth,
    source = 'weighted_random',
  }: {
    readonly priority?: number;
    readonly kind?: string;
    readonly source?: Candidate['selectionSource'];
  } = {},
): Candidate {
  return {
    provider: { id, kind },
    modelId: 'm',
    routing: { priority, weight: 1, prioritySource: 'provider', weightSource: 'provider', configurationIndex: 0 },
    selectionSource: source,
  } as unknown as Candidate;
}

const window = (resetIn: number, windowMinutes?: number): OAuthQuotaItem => ({
  id: `w-${resetIn}-${windowMinutes ?? 'x'}`,
  displayName: 'W',
  remainingRatio: 0.5,
  resetsAt: now + resetIn,
  scope: 'account',
  ...(windowMinutes === undefined ? {} : { windowMinutes }),
});

const ready = (items: readonly OAuthQuotaItem[], extra: { sampledAt?: number; stale?: boolean } = {}) =>
  ({
    kind: 'ready',
    entry: { snapshot: { items }, sampledAt: extra.sampledAt ?? now - 1_000, stale: extra.stale ?? false },
  }) as const satisfies OAuthQuotaCacheStatus;

const statuses =
  (table: Readonly<Record<string, OAuthQuotaCacheStatus>>) =>
  (providerId: string): OAuthQuotaCacheStatus =>
    table[providerId] ?? { kind: 'none' };

const ids = (ordered: readonly Candidate[]) => ordered.map((entry) => entry.provider.id);

const WEEK = 7 * 24 * 60;
const FIVE_HOURS = 5 * 60;

describe('orderByQuotaReset', () => {
  test('tries the subscription whose allowance expires first', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([window(6 * DAY, WEEK)]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'a']);
    expect(ordered.map((entry) => entry.selectionSource)).toEqual(['quota_reset', 'quota_reset']);
  });

  test('keys on the longest covering window', () => {
    const weeklyDecides = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({
        a: ready([window(HOUR, FIVE_HOURS), window(6 * DAY, WEEK)]),
        b: ready([window(3 * HOUR, FIVE_HOURS), window(DAY, WEEK)]),
      }),
      now,
    );
    expect(ids(weeklyDecides)).toEqual(['b', 'a']);

    // The weekly window can reset before a 5-hour one that started later; it still decides.
    const weeklyResetsFirst = orderByQuotaReset(
      [candidate('b'), candidate('a')],
      statuses({
        a: ready([window(30 * 60_000, WEEK), window(4 * HOUR, FIVE_HOURS)]),
        b: ready([window(2 * HOUR, WEEK), window(3 * HOUR, FIVE_HOURS)]),
      }),
      now,
    );
    expect(ids(weeklyResetsFirst)).toEqual(['a', 'b']);
  });

  test('a single covering window keys without a length', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([window(6 * DAY)]), b: ready([window(DAY)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'a']);
  });

  test('several covering windows without lengths are unknown', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([window(HOUR), window(DAY)]), b: ready([window(6 * DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'a']);
    expect(ordered[1]?.selectionSource).toBe('weighted_random');
  });

  test('mixed known and unknown window lengths are unknown', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([window(HOUR, WEEK), window(30 * 60_000)]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'a']);
    expect(ordered[1]?.selectionSource).toBe('weighted_random');
  });

  test('never reorders across priority tiers', () => {
    const ordered = orderByQuotaReset(
      [candidate('a', { priority: 10 }), candidate('b')],
      statuses({ a: ready([window(6 * DAY, WEEK)]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['a', 'b']);
  });

  test('unknown candidates follow the keyed ones in their original order', () => {
    const ordered = orderByQuotaReset(
      [candidate('api-x', { kind: 'api' }), candidate('c'), candidate('b')],
      statuses({ 'api-x': ready([window(HOUR, WEEK)]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'api-x', 'c']);
    expect(ordered.map((entry) => entry.selectionSource)).toEqual([
      'quota_reset',
      'weighted_random',
      'weighted_random',
    ]);
  });

  test('warms unknown subscriptions demoted behind a keyed one', () => {
    const warmed: string[] = [];
    orderByQuotaReset(
      [candidate('a'), candidate('b'), candidate('api-x', { kind: 'api' })],
      statuses({ b: ready([window(DAY, WEEK)]) }),
      now,
      (providerId) => warmed.push(providerId),
    );
    expect(warmed).toEqual(['a']);
  });

  test('warms cold subscriptions behind an api Provider that leads the tier', () => {
    const warmed: string[] = [];
    orderByQuotaReset(
      [candidate('api-x', { kind: 'api' }), candidate('a'), candidate('c')],
      statuses({}),
      now,
      (providerId) => warmed.push(providerId),
    );
    expect(warmed).toEqual(['a', 'c']);
  });

  test('does not warm the subscription about to serve', () => {
    const warmed: string[] = [];
    orderByQuotaReset([candidate('a'), candidate('c')], statuses({}), now, (providerId) => warmed.push(providerId));
    expect(warmed).toEqual(['c']);
  });

  test('ties keep the router order', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([window(DAY, WEEK)]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['a', 'b']);
  });

  test('a stale or aged snapshot is unknown', () => {
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b'), candidate('c')],
      statuses({
        a: ready([window(HOUR, WEEK)], { stale: true }),
        b: ready([window(HOUR, WEEK)], { sampledAt: now - 11 * 60_000 }),
        c: ready([window(DAY, WEEK)]),
      }),
      now,
    );
    expect(ids(ordered)).toEqual(['c', 'a', 'b']);
  });

  test('windows that do not cover the model are ignored', () => {
    const other: OAuthQuotaItem = { ...window(HOUR, WEEK), scope: { models: ['other-*'] } };
    const ordered = orderByQuotaReset(
      [candidate('a'), candidate('b')],
      statuses({ a: ready([other]), b: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ids(ordered)).toEqual(['b', 'a']);
  });

  test('a provider-qualified candidate is untouched', () => {
    const qualified = candidate('a', { source: 'provider_qualified' });
    const ordered = orderByQuotaReset([qualified], statuses({ a: ready([window(DAY, WEEK)]) }), now);
    expect(ordered[0]).toBe(qualified);
  });

  test('a one-candidate tier is not re-marked', () => {
    const only = candidate('a');
    const ordered = orderByQuotaReset(
      [only, candidate('b', { priority: -1 })],
      statuses({ a: ready([window(DAY, WEEK)]) }),
      now,
    );
    expect(ordered[0]).toBe(only);
  });
});

describe('applySelectionPolicy', () => {
  const candidates = [candidate('a'), candidate('b')];
  const quotaStatus = statuses({ a: ready([window(6 * DAY, WEEK)]), b: ready([window(DAY, WEEK)]) });

  test('the weighted draw is left exactly as the router produced it', () => {
    expect(applySelectionPolicy(candidates, 'weighted', { quotaStatus }, now)).toBe(candidates);
    expect(applySelectionPolicy(candidates, undefined, { quotaStatus }, now)).toBe(candidates);
  });

  test('without a quota cache the policy has nothing to order by', () => {
    expect(applySelectionPolicy(candidates, 'quota-reset', {}, now)).toBe(candidates);
  });

  test('quota-reset orders by reset', () => {
    expect(ids(applySelectionPolicy(candidates, 'quota-reset', { quotaStatus }, now))).toEqual(['b', 'a']);
  });
});
