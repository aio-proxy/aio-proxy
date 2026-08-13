import { describe, expect, test } from 'bun:test';

import type { AliasConfig, AliasTarget } from '../common';
import { normalizeAliasName, normalizeVariantKey } from '../common';
import {
  canonicalEffort,
  flattenAliasVariants,
  foldEffortSpelling,
  matchAliasRows,
  resolveAliasTargetFromConfig,
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

describe('resolveAliasTargetFromConfig', () => {
  test('object config plus bag selects the flattened row', () => {
    const config: AliasConfig = {
      model: 'model-default',
      preserve: false,
      variants: { ' High ': { model: 'model-high', preserve: true } },
    };
    expect(resolveAliasTargetFromConfig(config, { effort: 'HIGH' })).toEqual({
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
    expect(resolveAliasTargetFromConfig(config, { effort: 'medium' })).toEqual({
      model: 'model-default',
      preserve: true,
    });
  });
});
