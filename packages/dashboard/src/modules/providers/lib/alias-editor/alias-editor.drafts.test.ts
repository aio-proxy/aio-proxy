import { describe, expect, test } from '@rstest/core';

import { commitAliasDraft, renameAlias, serializeAlias } from './alias-editor';
import { alias } from './alias-editor.test-support';

describe('provider alias editor drafts', () => {
  test('Given an empty alias map When serialized Then create omits it and edit clears it', () => {
    expect(serializeAlias({}, 'create')).toBeUndefined();
    expect(serializeAlias({}, 'edit')).toEqual({});
  });

  test('Given a valid alias draft When committed Then trims the name and preserves insertion order', () => {
    const result = commitAliasDraft(alias, { name: '  fast  ', model: 'gpt-fast', preserve: true });

    expect(result).toEqual({
      ok: true,
      alias: {
        ...alias,
        fast: { model: 'gpt-fast', preserve: true },
      },
    });
  });

  test('Given a missing target or duplicate alias name When committed Then returns a typed error', () => {
    expect(commitAliasDraft(alias, { name: 'fast', model: '', preserve: false })).toEqual({
      ok: false,
      code: 'target-required',
    });
    expect(commitAliasDraft(alias, { name: ' mini ', model: 'gpt-fast', preserve: false })).toEqual({
      ok: false,
      code: 'name-duplicate',
    });
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
