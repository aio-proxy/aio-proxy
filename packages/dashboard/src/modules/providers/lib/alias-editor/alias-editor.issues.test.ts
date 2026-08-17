import { describe, expect, test } from '@rstest/core';

import { aliasSummaryMessage } from '../alias-editor-copy';
import { aliasEditorIssues, aliasIssueControlId, aliasSummary, preserveReferenceCount } from './alias-editor';
import { alias } from './alias-editor.test-support';

describe('provider alias editor summary and issues', () => {
  test('Given aliases and variants When summarized Then returns committed counts', () => {
    expect(aliasSummary(alias)).toEqual({ aliases: 1, variants: 1 });
  });

  test('Given singular and plural counts When formatted Then English grammar matches each count', () => {
    expect(aliasSummaryMessage({ aliases: 1, variants: 2 })).toBe('1 alias · 2 variants');
    expect(aliasSummaryMessage({ aliases: 2, variants: 1 })).toBe('2 aliases · 1 variant');
  });

  test('Given repeated preserve declarations When counted Then returns every declaration', () => {
    expect(
      preserveReferenceCount(
        {
          first: {
            model: 'shared',
            preserve: true,
            variants: { low: { model: 'shared', preserve: true } },
          },
          second: { model: 'shared', preserve: true },
        },
        'shared',
      ),
    ).toBe(3);
  });

  test('Given invalid model references and a preserved-route conflict When inspected Then returns ordered locators', () => {
    const issues = aliasEditorIssues(
      {
        legacy: {
          model: 'missing-default',
          preserve: false,
          variants: { low: { model: 'missing-low', preserve: false } },
        },
        preserved: { model: 'legacy', preserve: true },
      },
      ['legacy'],
    );

    expect(issues).toEqual([
      { code: 'preserved-route-conflict', alias: 'legacy' },
      { code: 'target-missing', alias: 'legacy' },
      { code: 'target-missing', alias: 'legacy', variant: 0 },
    ]);
  });

  test('reports no target-missing for models: [], matching the server guard', () => {
    const issues = aliasEditorIssues(
      { smart: { model: 'upstream-a', preserve: false, variants: { fast: { model: 'upstream-b', preserve: false } } } },
      [],
    );
    expect(issues).toEqual([]);
  });

  test('Given alias and variant issues When locating controls Then target errors focus their selects', () => {
    expect(aliasIssueControlId({ code: 'target-missing', alias: 'mini' })).toBe('provider-alias-mini-target');
    expect(aliasIssueControlId({ code: 'target-missing', alias: 'mini', variant: 0 })).toBe(
      'provider-alias-mini-variant-0-target',
    );
  });
});
