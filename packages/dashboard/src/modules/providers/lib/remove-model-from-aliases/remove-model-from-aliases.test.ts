import { describe, expect, test } from '@rstest/core';

import { removeModelFromAliases } from './remove-model-from-aliases';

describe('removeModelFromAliases', () => {
  test('drops aliases whose target is the removed model and strips matching variants', () => {
    const next = removeModelFromAliases(
      {
        gone: { model: 'drop-me', preserve: false },
        keep: {
          model: 'stay',
          preserve: true,
          variants: {
            high: { model: 'drop-me', preserve: false },
            low: { model: 'stay', preserve: false },
          },
        },
      },
      'drop-me',
    );

    expect(next).toEqual({
      keep: {
        model: 'stay',
        preserve: true,
        variants: { low: { model: 'stay', preserve: false } },
      },
    });
  });

  test('leaves an unrelated alias map untouched', () => {
    const alias = { smart: { model: 'other', preserve: false } };
    expect(removeModelFromAliases(alias, 'missing')).toEqual(alias);
  });
});
