import { describe, expect, test } from '@rstest/core';

import { commitAliasDraft, commitVariantDraft, renameAlias, renameVariant, serializeAlias } from './alias-editor';
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

  test('Given a variant draft When committed Then normalizes its key within the parent alias', () => {
    const result = commitVariantDraft(alias, 'mini', {
      name: '  XHigh  ',
      model: 'gpt-xhigh',
      preserve: true,
    });

    expect(result).toEqual({
      ok: true,
      alias: {
        mini: {
          ...alias.mini,
          variants: {
            low: { model: 'gpt-low', preserve: false },
            xhigh: { model: 'gpt-xhigh', preserve: true },
          },
        },
      },
    });
  });

  test('Given equal variant names in different aliases When committed Then both are allowed', () => {
    const aliases = {
      first: { model: 'one', preserve: false },
      second: { model: 'two', preserve: false },
    };
    const draft = { name: 'shared', model: 'shared-model', preserve: false };

    expect([commitVariantDraft(aliases, 'first', draft).ok, commitVariantDraft(aliases, 'second', draft).ok]).toEqual([
      true,
      true,
    ]);
  });

  test('Given a variant rename colliding in its parent When committed Then returns a duplicate error', () => {
    const result = renameVariant(
      {
        mini: {
          ...alias.mini,
          variants: {
            low: { model: 'gpt-low', preserve: false },
            high: { model: 'gpt-high', preserve: false },
          },
        },
      },
      { alias: 'mini', variant: 'high', name: ' LOW ' },
    );

    expect(result).toEqual({ ok: false, code: 'name-duplicate' });
  });

  test('Given prototype-like rename keys When committed Then they remain own record entries', () => {
    const aliasResult = renameAlias(alias, 'mini', '__proto__');
    const variantResult = renameVariant(alias, { alias: 'mini', variant: 'low', name: 'constructor' });

    expect(aliasResult.ok).toBe(true);
    expect(aliasResult.ok && Object.hasOwn(aliasResult.alias, '__proto__')).toBe(true);
    expect(variantResult.ok).toBe(true);
    expect(variantResult.ok && Object.hasOwn(variantResult.alias.mini?.variants ?? {}, 'constructor')).toBe(true);
  });
});
