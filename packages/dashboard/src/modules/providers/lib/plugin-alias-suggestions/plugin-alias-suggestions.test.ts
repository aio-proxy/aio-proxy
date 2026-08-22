import { describe, expect, test } from '@rstest/core';

import { blankAliasRow } from '../alias-editor';
import { alias, aliasRow, thinkingAlias } from '../alias-editor/alias-editor.test-support';
import { applicablePluginAliases, mergePluginAliasRows } from './plugin-alias-suggestions';

const config = (model: string) => ({ model, preserve: false });

describe('mergePluginAliasRows', () => {
  // Same-name replace, not insert-only: the plugin's alias wins over the one already under that name,
  // and the row keeps its identity so the editor does not remount it mid-edit.
  test('replaces a same-named row config while keeping its id and name, and leaves other rows alone', () => {
    const kept = aliasRow('fast', config('model-b'));
    const next = mergePluginAliasRows([aliasRow('mini', config('old')), kept], { mini: config('model-a') });

    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ id: 'mini', name: 'mini', config: config('model-a') });
    expect(next[1]).toBe(kept);
  });

  // The record key of a row named `" mini"` is `mini`, so comparing raw names would append a second
  // row under the same normalized name — a duplicate alias, which greys out Save.
  test('matches a row whose name only differs by surrounding whitespace', () => {
    const next = mergePluginAliasRows([aliasRow(' mini', config('old'))], { mini: config('model-a') });

    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ id: ' mini', name: ' mini', config: config('model-a') });
  });

  // The production chain: suggestion keys are normalized by `applicablePluginAliases`, so an untrimmed
  // plugin key still finds the trimmed row instead of landing beside it.
  test('matches a row when the plugin key is the one carrying whitespace', () => {
    const suggestions = applicablePluginAliases({ ' mini': config('model-a') }, []);
    const next = mergePluginAliasRows([aliasRow('mini', config('old'))], suggestions!);

    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ id: 'mini', name: 'mini', config: config('model-a') });
  });

  // New keys are appended, and their ids come from the editor's own shared sequence — a private
  // counter would restart at `k1` and collide with a row Add Alias had already minted.
  test('appends unmatched suggestions last with ids that cannot collide with a blank row', () => {
    const blank = blankAliasRow('model-a');
    const next = mergePluginAliasRows([aliasRow('mini', config('old'))], {
      mini: config('model-a'),
      fast: config('model-b'),
    });

    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ name: 'fast', config: config('model-b') });
    expect(next[1]?.id).not.toBe(blank.id);
    expect(new Set(next.map((row) => row.id)).size).toBe(next.length);
  });
});

describe('applicablePluginAliases', () => {
  // A suggestion whose variant points outside the whitelist would report `target-missing` just as
  // loudly as its default target would, so the whole entry goes rather than half of it.
  test('drops a whole suggestion when any target, variant included, is outside the whitelist', () => {
    expect(applicablePluginAliases({ ...alias, sonnet: thinkingAlias.sonnet }, ['gpt-default', 'gpt-low'])).toEqual(
      alias,
    );
    expect(applicablePluginAliases(thinkingAlias, ['claude-sonnet-4'])).toBeUndefined();
  });

  // Absent and empty both mean "no whitelist" everywhere else in the editor and on the server, so an
  // empty `models` filters nothing — but the keys are still normalized here, the one place that happens.
  test('skips target filtering for an empty whitelist while still normalizing keys', () => {
    expect(applicablePluginAliases({ ' mini': config('model-a'), '   ': config('model-b') }, [])).toEqual({
      mini: config('model-a'),
    });
    expect(applicablePluginAliases(undefined, ['model-a'])).toBeUndefined();
  });
});
