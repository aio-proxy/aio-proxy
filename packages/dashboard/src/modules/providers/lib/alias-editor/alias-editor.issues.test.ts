import { describe, expect, test } from '@rstest/core';

import { aliasSummaryMessage } from '../alias-editor-copy';
import { aliasEditorIssues, aliasIssueControlId, aliasSummary } from './alias-editor';
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

  test('Given alias and variant issues When locating controls Then target errors focus their selects', () => {
    expect(aliasIssueControlId({ code: 'target-missing', alias: 'row-1' })).toBe('provider-alias-row-1-target');
    expect(aliasIssueControlId({ code: 'target-missing', alias: 'row-1', variant: 0 })).toBe(
      'provider-alias-row-1-variant-0-target',
    );
  });
});
