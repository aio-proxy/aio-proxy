import { describe, expect, test } from '@rstest/core';

import { serializeAlias, toAliasRecord, toAliasRows } from './alias-editor';
import { alias, aliasRow } from './alias-editor.test-support';

describe('provider alias editor names', () => {
  test('Given an empty alias list When serialized Then create omits it and edit clears it', () => {
    expect(serializeAlias([], 'create')).toBeUndefined();
    expect(serializeAlias([], 'edit')).toEqual({});
  });

  test('Given rows When converted Then names are trimmed and a collision keeps the later row', () => {
    expect(
      toAliasRecord([
        aliasRow(' mini ', { model: 'first', preserve: false }, 'a'),
        aliasRow('mini', { model: 'second', preserve: false }, 'b'),
      ]),
    ).toEqual({ mini: { model: 'second', preserve: false } });
  });

  test('Given a wire record When converted Then each row keeps its name and config under a unique id', () => {
    const rows = toAliasRows({
      mini: alias.mini,
      fast: { model: 'gpt-fast', preserve: true },
    });

    expect(rows.map((row) => row.name)).toEqual(['mini', 'fast']);
    expect(rows.map((row) => row.config)).toEqual([alias.mini, { model: 'gpt-fast', preserve: true }]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(toAliasRecord(rows)).toEqual({
      mini: alias.mini,
      fast: { model: 'gpt-fast', preserve: true },
    });
  });

  test('Given prototype-like names When serialized Then they remain own record entries', () => {
    const record = toAliasRecord([aliasRow('__proto__', alias.mini)]);

    expect(Object.hasOwn(record, '__proto__')).toBe(true);
  });
});
