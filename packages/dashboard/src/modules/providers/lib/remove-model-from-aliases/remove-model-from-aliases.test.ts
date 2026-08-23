import { describe, expect, test } from '@rstest/core';

import { aliasRow } from '../alias-editor/alias-editor.test-support';
import { removeModelFromAliases } from './remove-model-from-aliases';

describe('removeModelFromAliases', () => {
  test('drops aliases whose target is the removed model and strips matching variants', () => {
    const next = removeModelFromAliases(
      [
        aliasRow('gone', { model: 'drop-me', preserve: false }),
        aliasRow('keep', {
          model: 'stay',
          preserve: true,
          variants: {
            high: { model: 'drop-me', preserve: false },
            low: { model: 'stay', preserve: false },
          },
        }),
      ],
      'drop-me',
    );

    expect(next).toEqual([
      aliasRow('keep', {
        model: 'stay',
        preserve: true,
        variants: [{ when: { effort: 'low' }, model: 'stay', preserve: false }],
      }),
    ]);
  });

  test('leaves an unrelated alias map untouched', () => {
    const rows = [aliasRow('smart', { model: 'other', preserve: false })];
    expect(removeModelFromAliases(rows, 'missing')).toEqual(rows);
  });
});
