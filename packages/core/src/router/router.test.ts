import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { ProviderInstance } from './router';
import { Router } from './router';

const provider = (
  id: string,
  alias: Record<string, { model: string; preserve: boolean }>,
  routing: { priority?: number; weight?: number } = {},
) =>
  ({
    id,
    kind: ProviderKind.Api,
    enabled: true,
    protocol: ProviderProtocol.OpenAICompatible,
    models: Object.values(alias).map(({ model }) => model),
    alias,
    ...routing,
  }) satisfies ProviderInstance;

test('prefers an exact Provider-qualified route over a slash alias', () => {
  const qualifiedProvider = provider('provider-a', {
    'openai/gpt-5': { model: 'qualified-wire', preserve: false },
  });
  const slashAliasProvider = provider('provider-b', {
    'provider-a/openai/gpt-5': { model: 'normal-wire', preserve: false },
  });
  const router = new Router([qualifiedProvider, slashAliasProvider]);
  expect(router.resolve('provider-a/openai/gpt-5')[0]?.provider.id).toBe('provider-a');
});

test('falls back to a normal slash alias when no qualified route matches', () => {
  const slashAliasProvider = provider('alias-provider', {
    'openai/gpt-5': { model: 'normal-wire', preserve: false },
  });
  const router = new Router([slashAliasProvider]);
  expect(router.resolve('openai/gpt-5')[0]?.provider.id).toBe('alias-provider');
});

test('applies exact model overrides and filters zero weight only on normal routes', () => {
  const providerA = provider('a', { shared: { model: 'a-wire', preserve: false } }, { weight: 3 });
  const providerB = provider('b', { shared: { model: 'b-wire', preserve: false } }, { weight: 1 });
  const router = new Router([providerA, providerB], {
    models: { shared: { providers: { a: { weight: 0 }, b: { priority: 20 } } } },
    random: () => 0,
  });
  expect(router.resolve('shared').map(({ provider }) => provider.id)).toEqual(['b']);
  expect(router.resolve('a/shared').map(({ provider }) => provider.id)).toEqual(['a']);
});

test('uses the same stable-session order and randomizes generated sessions', () => {
  const providerA = provider('a', { shared: { model: 'a-wire', preserve: false } }, { weight: 3 });
  const providerB = provider('b', { shared: { model: 'b-wire', preserve: false } }, { weight: 1 });
  const router = new Router([providerA, providerB], { random: () => 0.99 });
  const stable = { key: 'sha256:stable', source: 'header-session' } as const;
  expect(router.resolve('shared', {}, { session: stable })).toEqual(router.resolve('shared', {}, { session: stable }));
  expect(
    router.resolve('shared', {}, { session: { key: 'sha256:generated', source: 'generated' } })[0]?.provider.id,
  ).toBe('b');
});

test('ranks catalog candidates by priority, weight, then configuration order', () => {
  const low = provider('low', { shared: { model: 'low-wire', preserve: false } }, { priority: 10, weight: 10 });
  const highB = provider('high-b', { shared: { model: 'b-wire', preserve: false } }, { priority: 20, weight: 1 });
  const highA = provider('high-a', { shared: { model: 'a-wire', preserve: false } }, { priority: 20, weight: 3 });
  const zero = provider('zero', { shared: { model: 'zero-wire', preserve: false } }, { priority: 30, weight: 0 });
  const router = new Router([low, highB, highA, zero]);

  expect(router.catalogCandidates('shared').map((item) => item.provider.id)).toEqual(['high-a', 'high-b', 'low']);
  expect(router.modelIds()).toEqual(['shared']);
});
