import { describe, expect, test } from '@rstest/core';

import { renameAlias, serializeAlias } from './alias-editor';
import { alias } from './alias-editor.test-support';

describe('provider alias editor names', () => {
  test('Given an empty alias map When serialized Then create omits it and edit clears it', () => {
    expect(serializeAlias({}, 'create')).toBeUndefined();
    expect(serializeAlias({}, 'edit')).toEqual({});
  });

  /** Names are written per keystroke now, so a rejected rename is the only thing standing between a
   * half-typed name and the sibling alias it would overwrite in the record. */
  test('Given a name another alias already owns When renamed Then reports it and leaves the record alone', () => {
    const two = { ...alias, fast: { model: 'gpt-fast', preserve: false } };

    expect(renameAlias(two, 'fast', ' mini ')).toEqual({ ok: false, code: 'name-duplicate' });
    expect(renameAlias(two, 'fast', '')).toEqual({ ok: false, code: 'name-required' });
    expect(two.fast).toEqual({ model: 'gpt-fast', preserve: false });
  });

  test('Given an alias rename When committed Then retains its position and configuration', () => {
    const result = renameAlias({ first: { model: 'one', preserve: false }, ...alias }, 'mini', '  MINI  ');

    expect(result).toEqual({
      ok: true,
      alias: {
        first: { model: 'one', preserve: false },
        MINI: alias.mini,
      },
    });
  });

  test('Given prototype-like rename keys When committed Then they remain own record entries', () => {
    const result = renameAlias(alias, 'mini', '__proto__');

    expect(result.ok).toBe(true);
    expect(result.ok && Object.hasOwn(result.alias, '__proto__')).toBe(true);
  });
});
