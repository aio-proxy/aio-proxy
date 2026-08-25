import { expect, test } from 'bun:test';

import { z } from 'zod';

import * as types from '../index';
import { directModelIds, modelRoutes, validateAliasTargets } from './provider-alias';

const issuesFor = (provider: {
  models?: readonly string[];
  alias?: Record<string, { model: string; variants?: Record<string, { model: string }> }>;
}) => {
  const issues: z.core.$ZodIssue[] = [];
  const ctx = { addIssue: (issue: never) => issues.push(issue), value: provider } as unknown as z.RefinementCtx;
  validateAliasTargets(provider as never, ctx);
  return issues;
};

test('an alias-only provider with models: [] passes validation, including variant targets', () => {
  const issues = issuesFor({
    models: [],
    alias: { smart: { model: 'upstream-a', variants: { fast: { model: 'upstream-b' } } } },
  });
  expect(issues).toEqual([]);
});

test('an absent models list still skips the target check', () => {
  expect(issuesFor({ alias: { smart: { model: 'upstream-a' } } })).toEqual([]);
});

test('an alias outside a non-empty whitelist still fails, for alias and variant targets', () => {
  const issues = issuesFor({
    models: ['listed'],
    alias: { smart: { model: 'missing', variants: { fast: { model: 'also-missing' } } } },
  });
  expect(issues.map((issue) => issue.path)).toEqual([
    ['alias', 'smart', 'model'],
    ['alias', 'smart', 'variants', 0, 'model'],
  ]);
});

test('modelRoutes: unpreserved variant targets stay hidden when the alias name is also in models', () => {
  expect(
    modelRoutes({
      enabled: true,
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-thinking', 'gemini-2.5-flash-lite'],
      alias: {
        'gemini-2.5-flash': {
          model: 'gemini-2.5-flash',
          preserve: false,
          variants: [{ when: { thinking: true }, model: 'gemini-2.5-flash-thinking', preserve: false }],
        },
      },
    }),
  ).toEqual([
    { alias: 'gemini-2.5-flash-lite', modelId: 'gemini-2.5-flash-lite' },
    { alias: 'gemini-2.5-flash', modelId: 'gemini-2.5-flash' },
  ]);
});

test('modelRoutes: aliases shadow their targets unless preserved', () => {
  expect(modelRoutes({ enabled: true, models: ['a', 'b'], alias: { smart: { model: 'a', preserve: false } } })).toEqual(
    [
      { alias: 'b', modelId: 'b' },
      { alias: 'smart', modelId: 'a' },
    ],
  );
});

// Two models and no .sort(): with a single model the `!config.preserve` guard and the
// preservedModelIds re-add mask each other exactly, so the test only fails when BOTH break.
// Order is a product contract, not an implementation detail — clientModels
// (`materialize.ts:200,224`, `catalog.ts:37`) is this array's aliases in this order.
test('modelRoutes: preserve keeps the original id routable next to the alias', () => {
  expect(modelRoutes({ enabled: true, models: ['a', 'b'], alias: { smart: { model: 'a', preserve: true } } })).toEqual([
    { alias: 'a', modelId: 'a' },
    { alias: 'b', modelId: 'b' },
    { alias: 'smart', modelId: 'a' },
  ]);
});

// The right rail previews this array verbatim, so direct-before-alias is the contract, not a
// by-product of how the two sources happen to be concatenated.
test('modelRoutes: a direct model comes before an alias', () => {
  expect(
    modelRoutes({
      enabled: true,
      models: ['direct', 'aliased'],
      alias: { smart: { model: 'aliased', preserve: false } },
    }),
  ).toEqual([
    { alias: 'direct', modelId: 'direct' },
    { alias: 'smart', modelId: 'aliased' },
  ]);
});

// A preserved self-alias is the only input where both sources produce the same route; the dedup has
// to collapse it to one whichever source is emitted first.
test('modelRoutes: a preserved self-alias stays a single route', () => {
  expect(modelRoutes({ enabled: true, models: ['a'], alias: { a: { model: 'a', preserve: true } } })).toEqual([
    { alias: 'a', modelId: 'a' },
  ]);
});

test('modelRoutes and its helpers reach the package root barrel', () => {
  expect(typeof types.modelRoutes).toBe('function');
  expect(typeof types.directModelIds).toBe('function');
  expect(typeof types.sameRouteTargets).toBe('function');
  expect(typeof types.aliasTargetModels).toBe('function');
  expect(typeof types.preservedAliasModels).toBe('function');
  expect(typeof types.whenIdentity).toBe('function');
});

// `provider-alias/index.ts` is a bare `export *`, so every helper this file exports is public whether
// or not that was intended. Pinning the list makes widening it a deliberate edit to this test.
test('the provider-alias barrel exports exactly its intended surface', async () => {
  const barrel = await import('./index');
  expect(Object.keys(barrel).sort()).toEqual([
    'aliasTargetModels',
    'directModelIds',
    'exposedAliases',
    'modelRoutes',
    'normalizeProviderAlias',
    'normalizeProviderAliasKeys',
    'preservedAliasModels',
    'sameRouteTargets',
    'validateAliasTargets',
  ]);
});

// Both helpers now read variants through flattenAliasVariants, so the array branch counts. A copy
// that walked `Object.values(variants)` would see the row objects and miss `model` entirely.
test('aliasTargetModels and preservedAliasModels read array-form variants', () => {
  const config = {
    model: 'default-model',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'thinking-model', preserve: true }],
  } as const;

  expect(types.aliasTargetModels(config)).toEqual(['default-model', 'thinking-model']);
  expect([...types.preservedAliasModels({ smart: config })]).toEqual(['thinking-model']);
});

test('sameRouteTargets compares array-form and record-form variants by the models they reach', () => {
  const rows = {
    model: 'a',
    preserve: false,
    variants: [{ when: { effort: 'high' }, model: 'b', preserve: false }],
  } as const;
  const record = { model: 'a', preserve: false, variants: { high: { model: 'b', preserve: false } } } as const;

  expect(types.sameRouteTargets(rows, record)).toBe(true);
  expect(types.sameRouteTargets(rows, { model: 'a', preserve: false })).toBe(false);
});

// The editor rejects duplicates before it builds a payload, so it has to agree with the server on
// what "the same condition" means: case and x-high spellings fold, key order does not matter.
test('whenIdentity folds effort spelling and ignores key order', () => {
  expect(types.whenIdentity({ effort: 'High' })).toBe(types.whenIdentity({ effort: 'high' }));
  expect(types.whenIdentity({ effort: 'x-high' })).toBe(types.whenIdentity({ effort: 'XHIGH' }));
  expect(types.whenIdentity({ thinking: true, effort: 'low' })).toBe(
    types.whenIdentity({ effort: 'low', thinking: true }),
  );
  expect(types.whenIdentity({ thinking: false })).not.toBe(types.whenIdentity({}));
});

test('directModelIds: metadata keys register as direct routes', () => {
  expect(directModelIds({ enabled: true, metadata: { 'gpt-image-2': {} } })).toEqual(['gpt-image-2']);
});

test('directModelIds: metadata on a hidden alias target stays hidden', () => {
  expect(
    directModelIds({
      enabled: true,
      alias: { public: { model: 'secret-internal', preserve: false } },
      metadata: { 'secret-internal': {} },
    }),
  ).toEqual([]);
});

test('directModelIds: absent models alias and metadata yield no direct routes', () => {
  expect(directModelIds({ enabled: true })).toEqual([]);
});
