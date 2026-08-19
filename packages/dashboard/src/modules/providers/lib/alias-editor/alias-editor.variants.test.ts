import { describe, expect, test } from '@rstest/core';

import {
  addVariantRow,
  aliasEditorIssues,
  fromRowDraft,
  toAliasVariants,
  toRowDraft,
  variantRows,
  withVariantRows,
} from './alias-editor';
import { alias, thinkingAlias } from './alias-editor.test-support';

describe('provider alias editor variant rows', () => {
  // The data-loss guard, and the reason this task exists. Every dashboard site used to read
  // `Object.entries(variants)`, which sees an array as `{ "0": row }` and writes that record back —
  // re-parsing `when: { thinking: true }` as `when: { effort: '0' }`, silently unroutable.
  test('Given array-form variants When a row is edited Then thinking survives the round trip', () => {
    const rows = variantRows(thinkingAlias.sonnet);
    expect(rows).toEqual([{ when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false }]);

    const edited = withVariantRows(thinkingAlias, 'sonnet', [{ ...rows[0]!, model: 'claude-sonnet-4-retimed' }]);

    expect(edited['sonnet']?.variants).toEqual([
      { when: { thinking: true }, model: 'claude-sonnet-4-retimed', preserve: false },
    ]);
  });

  // Every existing config uses the record form. Always emitting rows would rewrite a user's whole
  // alias block on the first save of an unrelated field, so the compact shape has to survive.
  test('Given all-effort-only rows When serialized Then the compact record form is kept', () => {
    const rows = variantRows(alias.mini);

    expect(toAliasVariants(rows)).toEqual({ low: { model: 'gpt-low', preserve: false } });
    expect(withVariantRows(alias, 'mini', rows)['mini']?.variants).toEqual({
      low: { model: 'gpt-low', preserve: false },
    });
  });

  test('Given a thinking row added to a record-form alias When serialized Then the whole value flips to rows', () => {
    const next = addVariantRow(alias, 'mini', { when: { thinking: true }, model: 'gpt-thinking', preserve: false });

    expect(next['mini']?.variants).toEqual([
      { when: { effort: 'low' }, model: 'gpt-low', preserve: false },
      { when: { thinking: true }, model: 'gpt-thinking', preserve: false },
    ]);
  });

  test('Given every row removed When serialized Then variants is dropped rather than left empty', () => {
    expect(toAliasVariants([])).toBeUndefined();
    expect(withVariantRows(alias, 'mini', [])['mini']).toEqual({ model: 'gpt-default', preserve: false });
  });

  // The record is keyed on effort, and `x-high` folds to `xhigh`, so serializing these two as a record
  // dropped the first row outright — a valid payload the server cannot refuse. They must stay rows.
  test('Given two efforts that canonicalize alike When serialized Then no row is dropped', () => {
    const rows = [
      { when: { effort: 'xhigh' }, model: 'gpt-5-xhigh', preserve: false },
      { when: { effort: 'x-high' }, model: 'gpt-5-other', preserve: false },
    ] as const;

    expect(toAliasVariants(rows)).toEqual([...rows]);
    expect(variantRows({ model: 'gpt-default', preserve: false, variants: toAliasVariants(rows) })).toHaveLength(2);
  });

  // `whenIdentity` is the server's own rule: these two canonicalize to the same condition, so a
  // string comparison of the raw `when` values would let the editor build a payload Zod refuses.
  test('Given two rows matching the same condition When inspected Then a duplicate issue names the later row', () => {
    const issues = aliasEditorIssues({
      mini: {
        model: 'gpt-default',
        preserve: false,
        variants: [
          { when: { effort: 'High' }, model: 'gpt-high', preserve: false },
          { when: { effort: 'high' }, model: 'gpt-other', preserve: false },
        ],
      },
    });

    expect(issues).toEqual([{ code: 'variant-when-duplicate', alias: 'mini', variant: 1 }]);
  });

  // Upstream's rewrite deleted `validateVariants`, so `{ "  ": "model-x" }` now parses and yields
  // `when: { effort: '' }` — a condition no request bag can match. The editor is the only guard left.
  test('Given an empty condition or a blank effort When inspected Then each row reports its own issue', () => {
    const issues = aliasEditorIssues({
      mini: {
        model: 'gpt-default',
        preserve: false,
        variants: [
          { when: {}, model: 'gpt-a', preserve: false },
          { when: { effort: '   ' }, model: 'gpt-b', preserve: false },
        ],
      },
    });

    expect(issues).toEqual([
      { code: 'variant-when-required', alias: 'mini', variant: 0 },
      { code: 'variant-effort-blank', alias: 'mini', variant: 1 },
    ]);
  });

  // `thinking: false` is a real condition ("route non-thinking requests here"), so the editor's
  // "any" sentinel has to erase the key entirely — storing `false` would silently narrow the row.
  test('Given an unset dimension When the draft is serialized Then its key is absent, not false', () => {
    const row = fromRowDraft({ thinking: 'any', effort: '  ', speed: 'any', model: 'gpt-a', preserve: false });

    expect(Object.hasOwn(row.when, 'thinking')).toBe(false);
    expect(row.when).toEqual({});
    expect(fromRowDraft({ ...toRowDraft(row), thinking: 'off' }).when).toEqual({ thinking: false });
  });

  test('Given a full condition When round-tripped through the draft Then every dimension survives', () => {
    const row = { when: { thinking: true, effort: 'high', speed: 'fast' }, model: 'gpt-a', preserve: true } as const;

    expect(fromRowDraft(toRowDraft(row))).toEqual(row);
  });
});
