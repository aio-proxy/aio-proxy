import { describe, expect, test } from '@rstest/core';

import { aliasSummaryMessage } from '../alias-editor-copy';
import { aliasEditorIssues, aliasSummary, serializeAlias } from './alias-editor';
import { alias, aliasRow } from './alias-editor.test-support';

describe('provider alias editor summary and issues', () => {
  test('Given aliases and variants When summarized Then returns committed counts', () => {
    expect(aliasSummary([aliasRow('mini', alias.mini)])).toEqual({ aliases: 1, variants: 1 });
  });

  test('Given singular and plural counts When formatted Then English grammar matches each count', () => {
    expect(aliasSummaryMessage({ aliases: 1, variants: 2 })).toBe('1 alias · 2 variants');
    expect(aliasSummaryMessage({ aliases: 2, variants: 1 })).toBe('2 aliases · 1 variant');
  });

  /** Both rows are equally wrong, so both are marked: flagging only the second reads as "the first one
   * is fine", and the row the user goes on to fix may well be the other one. */
  test('Given names that collide once normalized When inspected Then every colliding row is flagged', () => {
    const issues = aliasEditorIssues([
      aliasRow('mini', { model: 'a', preserve: false }, 'first'),
      aliasRow(' mini ', { model: 'a', preserve: false }, 'second'),
    ]);

    expect(issues).toEqual([
      { code: 'alias-name-duplicate', alias: 'first' },
      { code: 'alias-name-duplicate', alias: 'second' },
    ]);
  });

  /** The unnamed row an Add Alias click leaves behind: it has to report something, or the save button
   * stays enabled over a row the user has not finished. */
  // Same name, different ids: `issue.alias` has to be the row id. If it were the name, both
  // locators would be `mini` and `aria-describedby` / control ids would collide.
  test('Given two rows that share a name When inspected Then each duplicate issue names the row id', () => {
    const issues = aliasEditorIssues([
      aliasRow('mini', { model: 'model-a', preserve: false }, 'r1'),
      aliasRow('mini', { model: 'model-b', preserve: false }, 'r2'),
    ]);

    expect(issues).toEqual([
      { code: 'alias-name-duplicate', alias: 'r1' },
      { code: 'alias-name-duplicate', alias: 'r2' },
    ]);
  });

  /** Alias names are user-typed, so a prototype member is a legal thing to type. Counting them in a
   * plain object answered `constructor` from the prototype instead of the tally, so neither row was
   * flagged, nothing gated Save, and the record form below kept only the last of the two. */
  test('Given two rows named after a prototype member When inspected Then both are still flagged', () => {
    const rows = [
      aliasRow('constructor', { model: 'model-a', preserve: false }, 'r1'),
      aliasRow('constructor', { model: 'model-b', preserve: false }, 'r2'),
    ];

    expect(aliasEditorIssues(rows)).toEqual([
      { code: 'alias-name-duplicate', alias: 'r1' },
      { code: 'alias-name-duplicate', alias: 'r2' },
    ]);
    // The reason the issue has to exist: serialization is keyed by name, so one row is dropped.
    expect(Object.keys(serializeAlias(rows, 'edit') ?? {})).toEqual(['constructor']);
  });

  test('Given an unnamed alias When inspected Then it reports a required name', () => {
    expect(aliasEditorIssues([aliasRow('', { model: 'a', preserve: false }, 'new')])).toEqual([
      { code: 'alias-name-required', alias: 'new' },
    ]);
  });

  test('Given invalid model references and a preserved-route conflict When inspected Then returns ordered locators', () => {
    const issues = aliasEditorIssues(
      [
        aliasRow(
          'legacy',
          {
            model: 'missing-default',
            preserve: false,
            variants: { low: { model: 'missing-low', preserve: false } },
          },
          'legacy-row',
        ),
        aliasRow('preserved', { model: 'legacy', preserve: true }, 'preserved-row'),
      ],
      ['legacy'],
    );

    expect(issues).toEqual([
      { code: 'preserved-route-conflict', alias: 'legacy-row' },
      { code: 'target-missing', alias: 'legacy-row' },
      { code: 'target-missing', alias: 'legacy-row', variant: 0 },
    ]);
  });

  test('reports no target-missing for models: [], matching the server guard', () => {
    const issues = aliasEditorIssues(
      [
        aliasRow('smart', {
          model: 'upstream-a',
          preserve: false,
          variants: { fast: { model: 'upstream-b', preserve: false } },
        }),
      ],
      [],
    );
    expect(issues).toEqual([]);
  });
});
