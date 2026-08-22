import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ProviderInstance } from '../src/index';
import { Router, RouterModelNotFoundError } from '../src/index';

const openai = {
  kind: 'api',
  id: 'openai',
  protocol: ProviderProtocol.OpenAIResponse,
  models: ['gpt-5-mini'],
  alias: { mini: { model: 'gpt-5-mini', preserve: true } },
} satisfies ProviderInstance;

describe('Router', () => {
  test('resolves a simple alias to provider and model id', () => {
    const router = new Router([openai]);

    const resolved = router.resolve('mini');

    expect(resolved).toMatchObject([{ provider: openai, modelId: 'gpt-5-mini' }]);
  });

  test('resolves a fully-qualified provider alias override', () => {
    const anthropic = {
      kind: 'api',
      id: 'anthropic',
      protocol: ProviderProtocol.Anthropic,
      models: ['claude-3-5-haiku'],
      alias: { haiku: { model: 'claude-3-5-haiku', preserve: false } },
    } satisfies ProviderInstance;
    const router = new Router([openai, anthropic]);

    const resolved = router.resolve('anthropic/haiku');

    expect(resolved).toMatchObject([{ provider: anthropic, modelId: 'claude-3-5-haiku' }]);
  });

  test('returns ordered candidates for duplicate aliases', () => {
    const other = {
      kind: 'api',
      id: 'other',
      protocol: ProviderProtocol.OpenAICompatible,
      models: ['other-mini'],
      alias: { mini: { model: 'other-mini', preserve: false } },
    } satisfies ProviderInstance;

    const router = new Router([openai, other], { random: () => 0 });

    expect(router.resolve('mini')).toMatchObject([
      { provider: openai, modelId: 'gpt-5-mini' },
      { provider: other, modelId: 'other-mini' },
    ]);
  });

  test('resolves a normalized variant for every provider candidate without reordering', () => {
    const primary = {
      ...openai,
      alias: {
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: { high: { model: 'gpt-5', preserve: false } },
        },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const fallback = {
      kind: 'api',
      id: 'fallback',
      protocol: ProviderProtocol.OpenAICompatible,
      models: ['fallback-mini', 'fallback-high'],
      alias: {
        mini: {
          model: 'fallback-mini',
          preserve: false,
          variants: { high: { model: 'fallback-high', preserve: false } },
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([primary, fallback], { random: () => 0 });

    expect(router.resolve('mini', { effort: ' High ' })).toMatchObject([
      { provider: primary, modelId: 'gpt-5' },
      { provider: fallback, modelId: 'fallback-high' },
    ]);
  });

  test('falls back to each alias default when the variant is missing', () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: { high: { model: 'gpt-5', preserve: false } },
        },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('mini', { effort: 'unknown' })).toMatchObject([{ provider, modelId: 'gpt-5-mini' }]);
  });

  test('resolves provider-qualified aliases with variants', () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: { high: { model: 'gpt-5', preserve: false } },
        },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('openai/mini', { effort: 'high' })).toMatchObject([{ provider, modelId: 'gpt-5' }]);
  });

  test('resolves array variants from cached rows and preserves row ids', () => {
    const provider = {
      ...openai,
      models: ['cursor-grok-4.6-medium', 'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast'],
      alias: {
        'grok-4.6': {
          model: 'cursor-grok-4.6-medium',
          preserve: false,
          variants: [
            { when: { effort: 'high', speed: 'fast' }, model: 'cursor-grok-4.6-high-fast', preserve: true },
            { when: { effort: 'high' }, model: 'cursor-grok-4.6-high', preserve: false },
          ],
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('grok-4.6', { effort: 'high', speed: 'fast' })).toMatchObject([
      { provider, modelId: 'cursor-grok-4.6-high-fast' },
    ]);
    expect(router.resolve('cursor-grok-4.6-high-fast')).toMatchObject([
      { provider, modelId: 'cursor-grok-4.6-high-fast' },
    ]);
    expect(() => router.resolve('cursor-grok-4.6-high')).toThrow(RouterModelNotFoundError);
  });
});
