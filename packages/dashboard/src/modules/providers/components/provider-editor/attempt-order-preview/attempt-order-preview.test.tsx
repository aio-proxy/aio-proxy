import { describe, expect, test } from '@rstest/core';

import { attemptOrder, hasWeightTie } from './attempt-order-preview';

const other = (
  id: string,
  weight: number | undefined,
  clientModels: readonly string[],
  enabled = true,
): { id: string; weight?: number | undefined; clientModels: readonly string[]; enabled: boolean } => ({
  id,
  weight,
  clientModels,
  enabled,
});

describe('attemptOrder', () => {
  test('orders every provider serving an exposed alias by descending weight, self at its edited weight', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: 7,
        exposedAliases: ['smart'],
        others: [other('high', 10, ['smart']), other('low', 5, ['smart'])],
      }),
    ).toEqual([{ alias: 'smart', providerIds: ['high', 'self', 'low'], tie: false }]);
  });

  // `tie: true` is not incidental: absent coalesces to 0 at the single ordering point, so three
  // unweighted providers genuinely share a weight and the section must say so.
  test('absent weights keep configuration order and still count as a tie', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('first', undefined, ['smart']), other('second', undefined, ['smart'])],
      }),
    ).toEqual([{ alias: 'smart', providerIds: ['first', 'second', 'self'], tie: true }]);
  });

  test('an equal weight keeps configuration order and reports a tie', () => {
    const rows = attemptOrder({
      selfId: 'self',
      selfWeight: 10,
      exposedAliases: ['smart'],
      others: [other('peer', 10, ['smart'])],
    });

    expect(rows).toEqual([{ alias: 'smart', providerIds: ['peer', 'self'], tie: true }]);
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('peer', 10, ['smart'])],
      }),
    ).toBe(true);
  });

  // materialize.ts:133-138 records a config summary and `continue`s for a disabled provider, so it is
  // never built into a runtime instance. Previewing it as the first attempt would state something the
  // router will never do, and reporting a tie against it would flag a conflict that cannot happen.
  test('a disabled provider is neither previewed nor counted as a tie', () => {
    const props = {
      selfId: 'self',
      selfWeight: 100,
      exposedAliases: ['smart'],
      others: [other('off', 100, ['smart'], false)],
    };

    expect(attemptOrder(props)).toEqual([{ alias: 'smart', providerIds: ['self'], tie: false }]);
    expect(hasWeightTie(props)).toBe(false);
  });

  // The summaries query includes the provider being edited; its stored row must not appear next to
  // the edited one, and the edited weight must win over the persisted one.
  test('self is substituted in place when the summaries list already contains it', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: 20,
        exposedAliases: ['smart'],
        others: [other('self', 1, ['stale']), other('peer', 10, ['smart'])],
      }),
    ).toEqual([{ alias: 'smart', providerIds: ['self', 'peer'], tie: false }]);
  });
});
