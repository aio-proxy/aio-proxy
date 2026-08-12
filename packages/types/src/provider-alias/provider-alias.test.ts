import { expect, test } from 'bun:test';

import * as types from '@aio-proxy/types';
import { z } from 'zod';

import { modelRoutes, validateAliasTargets } from './provider-alias';

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
    ['alias', 'smart', 'variants', 'fast', 'model'],
  ]);
});

test('modelRoutes: aliases shadow their targets unless preserved', () => {
  expect(modelRoutes({ enabled: true, models: ['a', 'b'], alias: { smart: { model: 'a', preserve: false } } })).toEqual(
    [
      { alias: 'smart', modelId: 'a' },
      { alias: 'b', modelId: 'b' },
    ],
  );
});

test('modelRoutes: preserve keeps the original id routable next to the alias', () => {
  expect(
    modelRoutes({ enabled: true, models: ['a'], alias: { smart: { model: 'a', preserve: true } } }).sort((l, r) =>
      l.alias.localeCompare(r.alias),
    ),
  ).toEqual([
    { alias: 'a', modelId: 'a' },
    { alias: 'smart', modelId: 'a' },
  ]);
});

test('modelRoutes and its helpers reach the package root barrel', () => {
  expect(typeof types.modelRoutes).toBe('function');
  expect(typeof types.directModelIds).toBe('function');
  expect(typeof types.sameRouteTargets).toBe('function');
});
