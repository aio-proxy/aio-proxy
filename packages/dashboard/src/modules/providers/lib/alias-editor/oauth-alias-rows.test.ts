import { INHERIT_OFF_KEY } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { aliasEditorIssues } from './alias-editor';
import { aliasRow } from './alias-editor.test-support';
import {
  editorEffectiveAlias,
  hideAliasRow,
  isOAuthInheritOff,
  mergeInheritedAliasRows,
  restoreAliasRow,
  serializeOAuthAlias,
  toOAuthAliasRows,
} from './oauth-alias-rows';

const cfg = (model: string) => ({ model, preserve: false });

describe('oauth alias rows', () => {
  test('toOAuthAliasRows keeps hides and skips the inherit-off key', () => {
    const rows = toOAuthAliasRows({
      mini: cfg('gpt-5-mini'),
      codex: false,
      [INHERIT_OFF_KEY]: false,
    });

    expect(rows.map((row) => ({ name: row.name, origin: row.origin }))).toEqual([
      { name: 'mini', origin: 'authored' },
      { name: 'codex', origin: 'hidden' },
    ]);
  });

  test('serializeOAuthAlias on edit always emits an object and never snapshots inherit rows', () => {
    const inherited = { ...aliasRow('fast', cfg('gpt-5-nano'), 'fast'), origin: 'inherited' as const };
    const hidden = { ...aliasRow('codex', cfg('gpt-5'), 'codex'), origin: 'hidden' as const };

    expect(serializeOAuthAlias([], false, 'edit')).toEqual({});
    expect(serializeOAuthAlias([], false, 'create')).toBeUndefined();
    expect(serializeOAuthAlias([inherited, hidden, aliasRow('mini', cfg('gpt-5-mini'))], false, 'edit')).toEqual({
      mini: cfg('gpt-5-mini'),
      codex: false,
    });
    expect(serializeOAuthAlias([], true, 'edit')).toEqual({ [INHERIT_OFF_KEY]: false });
  });

  test('mergeInheritedAliasRows drops excluded and inherit-off defaults', () => {
    const defaults = { mini: cfg('gpt-5-mini'), gone: cfg('hidden') };
    const authored = [aliasRow('chat', cfg('gpt-5'))];

    expect(mergeInheritedAliasRows(authored, defaults, ['gpt-5', 'gpt-5-mini'], true)).toEqual(authored);
    expect(mergeInheritedAliasRows(authored, defaults, ['gpt-5', 'gpt-5-mini'], false).map((row) => row.name)).toEqual([
      'chat',
      'mini',
    ]);
  });

  test('aliasEditorIssues skips inherited and hidden rows', () => {
    const issues = aliasEditorIssues(
      [
        { ...aliasRow('fast', cfg('missing'), 'fast'), origin: 'inherited' },
        { ...aliasRow('codex', cfg('missing'), 'codex'), origin: 'hidden' },
        aliasRow('mini', cfg('missing'), 'mini'),
      ],
      ['gpt-5'],
    );

    expect(issues).toEqual([{ code: 'target-missing', alias: 'mini' }]);
  });

  test('hide and restore persist false then drop the authored key', () => {
    const rows = [aliasRow('codex', cfg('gpt-5'))];
    const hidden = hideAliasRow(rows, 'codex');
    expect(serializeOAuthAlias(hidden, false, 'edit')).toEqual({ codex: false });
    expect(serializeOAuthAlias(restoreAliasRow(hidden, 'codex'), false, 'edit')).toEqual({});
  });

  test('editorEffectiveAlias includes inherited names for weight-tie and the rail', () => {
    expect(
      editorEffectiveAlias(
        [aliasRow('chat', cfg('gpt-5'))],
        { mini: cfg('gpt-5-mini') },
        ['gpt-5', 'gpt-5-mini'],
        false,
      ),
    ).toEqual({
      chat: cfg('gpt-5'),
      mini: cfg('gpt-5-mini'),
    });
  });

  test('isOAuthInheritOff reads the reserved key after trim', () => {
    expect(isOAuthInheritOff({ ' *': false })).toBe(true);
    expect(isOAuthInheritOff({ mini: cfg('gpt-5') })).toBe(false);
  });
});
