import { describe, expect, test } from 'bun:test';

import type { AliasConfig, AliasTarget } from '../common';
import { normalizeAliasName, normalizeVariantKey } from '../common';
import { OAuthPluginProviderSchema, ProviderSchema } from '../provider';
import {
  AliasConfigSchema,
  canonicalEffort,
  flattenAliasVariants,
  foldEffortSpelling,
  matchAliasRows,
  resolveAliasTarget,
  type AliasSelectRow,
} from './alias-variant';

const fallback: AliasTarget = { model: 'cursor-grok-4.6-medium', preserve: false };

const grokRows: readonly AliasSelectRow[] = [
  { when: { effort: 'low', speed: 'fast' }, model: 'cursor-grok-4.6-low-fast', preserve: false },
  { when: { effort: 'high', speed: 'fast' }, model: 'cursor-grok-4.6-high-fast', preserve: false },
  { when: { effort: 'low' }, model: 'cursor-grok-4.6-low', preserve: false },
  { when: { effort: 'high' }, model: 'cursor-grok-4.6-high', preserve: false },
];

const fableFallback: AliasTarget = { model: 'claude-fable-5-medium', preserve: false };

const fableRows: readonly AliasSelectRow[] = [
  { when: { thinking: true, effort: 'high' }, model: 'claude-fable-5-thinking-high', preserve: false },
  { when: { thinking: true }, model: 'claude-fable-5-thinking', preserve: false },
  { when: { effort: 'high' }, model: 'claude-fable-5-high', preserve: false },
];

describe('normalizeAliasName', () => {
  test('Given an alias name When normalized Then trims without changing case', () => {
    expect(normalizeAliasName('  GPT-Mini  ')).toBe('GPT-Mini');
  });
});

describe('normalizeVariantKey', () => {
  test('Given a variant key When normalized Then trims and lowercases it', () => {
    expect(normalizeVariantKey('  XHigh  ')).toBe('xhigh');
  });
});

describe('canonicalEffort', () => {
  test('trims, lowercases, and folds spellings', () => {
    expect(canonicalEffort(' X-High ')).toBe('xhigh');
    expect(canonicalEffort('x_high')).toBe('xhigh');
    expect(canonicalEffort('extrahigh')).toBe('xhigh');
    expect(canonicalEffort('extra-high')).toBe('xhigh');
    expect(canonicalEffort('Extra-High')).toBe('xhigh');
    expect(canonicalEffort('HIGH')).toBe('high');
  });

  test('foldEffortSpelling does not trim', () => {
    expect(foldEffortSpelling(' low ')).toBe(' low ');
    expect(foldEffortSpelling('x-high')).toBe('xhigh');
  });
});

describe('flattenAliasVariants', () => {
  test('undefined becomes empty', () => {
    expect(flattenAliasVariants(undefined)).toEqual([]);
  });

  test('object keys become effort rows and fold spellings', () => {
    expect(
      flattenAliasVariants({
        high: { model: 'm', preserve: false },
        'X-High': { model: 'xh', preserve: true },
      }),
    ).toEqual([
      { when: { effort: 'high' }, model: 'm', preserve: false },
      { when: { effort: 'xhigh' }, model: 'xh', preserve: true },
    ]);
  });

  test('array copies rows and canonicalizes effort', () => {
    expect(flattenAliasVariants([{ when: { effort: 'X-High' }, model: 'm', preserve: false }])).toEqual([
      { when: { effort: 'xhigh' }, model: 'm', preserve: false },
    ]);
  });
});

describe('matchAliasRows', () => {
  test('empty bag returns fallback', () => {
    expect(matchAliasRows(grokRows, {}, fallback)).toEqual(fallback);
  });

  test('effort-only hits the effort row', () => {
    expect(matchAliasRows(grokRows, { effort: 'high' }, fallback).model).toBe('cursor-grok-4.6-high');
  });

  test('combined row wins over subsets', () => {
    expect(matchAliasRows(grokRows, { effort: 'high', speed: 'fast' }, fallback).model).toBe(
      'cursor-grok-4.6-high-fast',
    );
  });

  test('incomparable effort vs speed prefers effort', () => {
    const rows: readonly AliasSelectRow[] = [
      { when: { effort: 'high' }, model: '…-high', preserve: false },
      { when: { speed: 'fast' }, model: '…-fast', preserve: false },
    ];
    expect(matchAliasRows(rows, { effort: 'high', speed: 'fast' }, fallback).model).toBe('…-high');
  });

  test('flex is do not care when no flex row exists', () => {
    expect(matchAliasRows(grokRows, { effort: 'high', speed: 'flex' }, fallback).model).toBe('cursor-grok-4.6-high');
  });

  test('missing effort level returns fallback', () => {
    expect(matchAliasRows(grokRows, { effort: 'lowx' }, fallback)).toEqual(fallback);
  });

  test('1D object key fast is effort not speed', () => {
    const rows = flattenAliasVariants({ fast: { model: 'upstream-fast', preserve: false } });
    expect(matchAliasRows(rows, { speed: 'fast' }, fallback)).toEqual(fallback);
    expect(matchAliasRows(rows, { effort: 'fast' }, fallback).model).toBe('upstream-fast');
  });

  test('thinking combined row wins; incomparable prefers thinking', () => {
    expect(matchAliasRows(fableRows, { thinking: true, effort: 'high' }, fableFallback).model).toBe(
      'claude-fable-5-thinking-high',
    );
    const incomparable: readonly AliasSelectRow[] = [
      { when: { thinking: true }, model: 'think', preserve: false },
      { when: { effort: 'high' }, model: 'high', preserve: false },
    ];
    expect(matchAliasRows(incomparable, { thinking: true, effort: 'high' }, fableFallback).model).toBe('think');
  });

  test('thinking true only hits catch-all; thinking false is do not care on effort rows', () => {
    expect(matchAliasRows(fableRows, { thinking: true }, fableFallback).model).toBe('claude-fable-5-thinking');
    expect(matchAliasRows(fableRows, { thinking: false, effort: 'high' }, fableFallback).model).toBe(
      'claude-fable-5-high',
    );
  });

  test('canonicalizes padded bag effort', () => {
    const rows = flattenAliasVariants({ high: { model: 'model-high', preserve: true } });
    expect(matchAliasRows(rows, { effort: ' HIGH ' }, fallback)).toEqual({
      model: 'model-high',
      preserve: true,
    });
  });
});

describe('AliasConfigSchema', () => {
  test('parses array variants and keeps when', () => {
    const parsed = AliasConfigSchema.parse({
      model: 'cursor-grok-4.6-medium',
      variants: [{ when: { effort: 'high' }, model: 'cursor-grok-4.6-high' }],
    });
    expect(Array.isArray(parsed.variants)).toBe(true);
    expect(parsed.variants).toEqual([{ when: { effort: 'high' }, model: 'cursor-grok-4.6-high', preserve: false }]);
  });

  test('round-trips array variants through JSON', () => {
    const parsed = AliasConfigSchema.parse({
      model: 'm',
      variants: [{ when: { thinking: true }, model: 't' }],
    });
    const again = AliasConfigSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(Array.isArray(again.variants)).toBe(true);
  });

  test('keeps object variants as objects', () => {
    const parsed = AliasConfigSchema.parse({
      model: 'gemini-3.5-flash-extra-low',
      variants: { high: 'gemini-3-flash-agent' },
    });
    expect(Array.isArray(parsed.variants)).toBe(false);
    expect(parsed.variants).toEqual({ high: { model: 'gemini-3-flash-agent', preserve: false } });
  });

  test('rejects empty when, unknown when keys, and duplicate canonical when on the schema alone', () => {
    expect(AliasConfigSchema.safeParse({ model: 'm', variants: [{ when: {}, model: 'x' }] }).success).toBe(false);
    expect(
      AliasConfigSchema.safeParse({
        model: 'm',
        variants: [{ when: { effort: 'high', verbosity: 'high' }, model: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      AliasConfigSchema.safeParse({
        model: 'm',
        variants: [
          { when: { effort: 'high' }, model: 'a' },
          { when: { effort: 'HIGH' }, model: 'b' },
        ],
      }).success,
    ).toBe(false);
    expect(
      AliasConfigSchema.safeParse({
        model: 'm',
        variants: { 'x-high': 'a', xhigh: 'b' },
      }).success,
    ).toBe(false);
  });

  test('DashboardOAuthProviderPatchSchema rejects duplicate when without models', async () => {
    const { DashboardOAuthProviderPatchSchema } = await import('../dashboard-oauth');
    const result = DashboardOAuthProviderPatchSchema.safeParse({
      enabled: true,
      alias: {
        grok: {
          model: 'medium',
          variants: [
            { when: { effort: 'high' }, model: 'high-a' },
            { when: { effort: 'high' }, model: 'high-b' },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('provider-level alias validation', () => {
  test('array row model missing from models is rejected', () => {
    const result = ProviderSchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.openai.com',
      models: ['gpt-5-mini'],
      alias: {
        mini: {
          model: 'gpt-5-mini',
          variants: [{ when: { effort: 'high' }, model: 'missing' }],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['alias', 'mini', 'variants', 0, 'model']);
    }
  });

  test('OAuth parse without models does not require catalog membership', () => {
    const parsed = OAuthPluginProviderSchema.parse({
      kind: 'oauth',
      id: 'cursor',
      plugin: '@example/oauth',
      capability: 'default',
      alias: {
        grok: {
          model: 'not-in-any-catalog',
          variants: [{ when: { effort: 'high' }, model: 'also-missing' }],
        },
      },
    });
    expect(parsed.alias?.['grok']?.model).toBe('not-in-any-catalog');
  });

  test('provider-level refine does not emit a second duplicate-variant issue', () => {
    const result = ProviderSchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.openai.com',
      models: ['gpt-5-mini'],
      alias: {
        mini: {
          model: 'gpt-5-mini',
          variants: { High: 'gpt-5-mini', ' high ': 'gpt-5-mini' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const variantIssues = result.error.issues.filter((issue) => issue.path.includes('variants'));
      expect(variantIssues).toHaveLength(1);
    }
  });

  test('ProviderSchema parse keeps array variants (does not smash into numeric keys)', () => {
    const parsed = ProviderSchema.parse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.openai.com',
      models: ['gpt-5-mini', 'gpt-5'],
      alias: {
        mini: {
          model: 'gpt-5-mini',
          variants: [{ when: { effort: 'high' }, model: 'gpt-5' }],
        },
      },
    });
    expect(Array.isArray(parsed.alias?.mini?.variants)).toBe(true);
    expect(parsed.alias?.mini?.variants).toEqual([{ when: { effort: 'high' }, model: 'gpt-5', preserve: false }]);
  });
});

describe('resolveAliasTarget', () => {
  test('object config plus bag selects the flattened row', () => {
    const config: AliasConfig = {
      model: 'model-default',
      preserve: false,
      variants: { ' High ': { model: 'model-high', preserve: true } },
    };
    expect(resolveAliasTarget(config, { effort: 'HIGH' })).toEqual({
      model: 'model-high',
      preserve: true,
    });
  });

  test('missing row returns alias default', () => {
    const config: AliasConfig = {
      model: 'model-default',
      preserve: true,
      variants: { low: { model: 'model-low', preserve: false } },
    };
    expect(resolveAliasTarget(config, { effort: 'medium' })).toEqual({
      model: 'model-default',
      preserve: true,
    });
  });
});
