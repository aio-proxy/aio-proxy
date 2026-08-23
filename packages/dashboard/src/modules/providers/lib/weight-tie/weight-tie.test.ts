import { describe, expect, test } from '@rstest/core';

import { hasWeightTie, type WeightTieInput } from './weight-tie';

const other = (
  id: string,
  weight: number | undefined,
  clientModels: readonly string[],
  enabled = true,
): WeightTieInput['others'][number] => ({ id, weight, clientModels, enabled });

describe('hasWeightTie', () => {
  test('another provider on the same weight serving the same exposed alias is a tie', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('peer', 10, ['smart'])],
      }),
    ).toBe(true);
  });

  // The coalesce is load-bearing, not decorative: `routes/providers/new.tsx` seeds new providers with an
  // explicit `0` while providers created before it have no weight key at all, so absent-against-stored-`0`
  // is a config shape that really occurs. Two *absent* weights would not pin this — dropping the `?? 0`
  // leaves `undefined === undefined` true — but here it compares `undefined === 0` and the tie vanishes.
  test('an absent weight ties with a stored explicit one', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('seeded', 1, ['smart'])],
      }),
    ).toBe(true);
  });

  // A disabled provider is never materialized (materialize.ts:137-140 records a summary and
  // continues), so reporting a tie against it would flag a conflict the router cannot reach.
  test('a disabled provider on the same weight is not a tie', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 100,
        exposedAliases: ['smart'],
        others: [other('off', 100, ['smart'], false)],
      }),
    ).toBe(false);
  });

  // Both non-tie clauses at once, because each rescues a different mutation: a provider competing for the
  // same alias on a *different* weight has an unambiguous place in the attempt order (drop the weight
  // comparison and `heavier` reports a tie), and an equal weight with no alias in common has no attempt
  // order to be ambiguous about (drop the alias overlap and `peer` reports one).
  test('neither a differing weight nor a disjoint alias set is a tie', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('heavier', 20, ['smart']), other('peer', 10, ['fast'])],
      }),
    ).toBe(false);
  });

  // The summaries query includes the provider being edited, so its own stale row arrives in `others`
  // and would tie with itself. The row carries only the four fields the narrow `Pick` promises, which
  // is also what keeps a widened summary shape from reaching this predicate.
  test('self appearing in the summaries list never ties with itself', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 20,
        exposedAliases: ['smart'],
        others: [other('self', 20, ['smart'])],
      }),
    ).toBe(false);
  });
});
