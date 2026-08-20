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

  // Not incidental: absent coalesces to 0 at the single ordering point, so two unweighted providers
  // genuinely share a weight and the badge must say so. The mutant is `effectiveWeight` losing its
  // coalesce, which makes `undefined === undefined` compare as NaN and the tie vanish.
  test('two absent weights coalesce to zero and still tie', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('peer', undefined, ['smart'])],
      }),
    ).toBe(true);
  });

  // A disabled provider is never materialized (materialize.ts:133-138 records a summary and
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

  // The weight only matters where two providers compete for the same alias; without an overlap there
  // is no attempt order to be ambiguous about.
  test('an equal weight with no alias in common is not a tie', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('peer', 10, ['fast'])],
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
