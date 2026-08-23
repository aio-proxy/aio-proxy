import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ProviderInstance } from '../src/index';
import { modelRoutes, Router, RouterModelNotFoundError } from '../src/index';
import { openai } from './router-aliases.test-support';

describe('Router', () => {
  test('routes a configured model when no alias is present', () => {
    const provider = {
      ...openai,
      alias: undefined,
      models: ['gpt-5-mini'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('gpt-5-mini')).toMatchObject([{ provider, modelId: 'gpt-5-mini' }]);
    expect(router.resolve('openai/gpt-5-mini')).toMatchObject([{ provider, modelId: 'gpt-5-mini' }]);
  });

  test('hides non-preserved targets for added aliases', () => {
    const provider = {
      ...openai,
      id: 'anthropic-aliases',
      models: ['upstream-opus-48', 'upstream-opus-46', 'upstream-sonnet-46', 'untouched'],
      alias: {
        'claude-opus-4-8': { model: 'upstream-opus-48', preserve: false },
        'claude-opus-4-6': { model: 'upstream-opus-46', preserve: false },
        'claude-sonnet-4-6': {
          model: 'upstream-sonnet-46',
          preserve: false,
          variants: { fast: { model: 'upstream-opus-46', preserve: false } },
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(modelRoutes(provider)).toEqual([
      { alias: 'untouched', modelId: 'untouched' },
      { alias: 'claude-opus-4-8', modelId: 'upstream-opus-48' },
      { alias: 'claude-opus-4-6', modelId: 'upstream-opus-46' },
      { alias: 'claude-sonnet-4-6', modelId: 'upstream-sonnet-46' },
    ]);
    expect(router.resolve('claude-opus-4-8')).toMatchObject([{ provider, modelId: 'upstream-opus-48' }]);
    expect(router.resolve('claude-sonnet-4-6', { effort: 'fast' })).toMatchObject([
      { provider, modelId: 'upstream-opus-46' },
    ]);
    expect(router.resolve('claude-sonnet-4-6', { speed: 'fast' })).toMatchObject([
      { provider, modelId: 'upstream-sonnet-46' },
    ]);
    expect(() => router.resolve('upstream-opus-48')).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve('upstream-opus-46')).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve('upstream-sonnet-46')).toThrow(RouterModelNotFoundError);
    expect(router.resolve('untouched')).toMatchObject([{ provider, modelId: 'untouched' }]);
  });

  test('lets an alias shadow a same-named configured model while keeping its target routable', () => {
    const provider = {
      ...openai,
      models: ['old', 'new'],
      alias: { old: { model: 'new', preserve: false } },
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(modelRoutes(provider)).toEqual([
      { alias: 'new', modelId: 'new' },
      { alias: 'old', modelId: 'new' },
    ]);
    expect(router.resolve('old')).toMatchObject([{ provider, modelId: 'new' }]);
    expect(router.resolve('new')).toMatchObject([{ provider, modelId: 'new' }]);
  });

  test('resolves a fully-qualified preserved original model id', () => {
    const router = new Router([openai]);

    const resolved = router.resolve('openai/gpt-5-mini');

    expect(resolved).toMatchObject([{ provider: openai, modelId: 'gpt-5-mini' }]);
  });

  test('treats a preserved self-alias as a single route', () => {
    const selfAlias = {
      ...openai,
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: true } },
    } satisfies ProviderInstance;
    const router = new Router([selfAlias]);

    expect(router.resolve('gpt-5-mini')).toMatchObject([{ provider: selfAlias, modelId: 'gpt-5-mini' }]);
    expect(router.resolve('openai/gpt-5-mini')).toMatchObject([{ provider: selfAlias, modelId: 'gpt-5-mini' }]);
  });

  test('rejects a preserved provider route that conflicts with an explicit alias variant', () => {
    const conflicting = {
      kind: 'api',
      id: 'dupe',
      protocol: ProviderProtocol.OpenAIResponse,
      models: ['first', 'second'],
      alias: {
        first: {
          model: 'first',
          preserve: false,
          variants: { high: { model: 'second', preserve: false } },
        },
        firstAlias: { model: 'first', preserve: true },
      },
    } satisfies ProviderInstance;

    expect(() => new Router([conflicting])).toThrow(/dupe/);
  });
});
