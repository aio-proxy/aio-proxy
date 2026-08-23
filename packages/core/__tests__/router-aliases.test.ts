import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ProviderInstance } from '../src/index';
import { Router, RouterModelCollisionError, RouterModelNotFoundError } from '../src/index';
import { legacyOAuth, openai } from './router-aliases.test-support';

describe('Router', () => {
  test('exposes a preserved variant target under its original model id', () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: { high: { model: 'gpt-5', preserve: true } },
        },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('gpt-5')).toMatchObject([{ provider, modelId: 'gpt-5' }]);
  });

  test('reuses an explicit self-alias for a preserved variant targeting the same model', () => {
    const provider = {
      ...openai,
      alias: {
        'gpt-5': { model: 'gpt-5', preserve: false },
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: { high: { model: 'gpt-5', preserve: true } },
        },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('gpt-5')).toMatchObject([{ provider, modelId: 'gpt-5' }]);
  });

  test('deduplicates identical preserved routes within a provider', () => {
    const provider = {
      ...openai,
      alias: {
        mini: { model: 'gpt-5-mini', preserve: true },
        fast: { model: 'gpt-5-mini', preserve: true },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve('gpt-5-mini')).toMatchObject([{ provider, modelId: 'gpt-5-mini' }]);
  });

  test('rejects an explicit alias that conflicts with a preserved model id', () => {
    const provider = {
      ...openai,
      alias: {
        'gpt-5-mini': { model: 'gpt-5', preserve: false },
        mini: { model: 'gpt-5-mini', preserve: true },
      },
      models: ['gpt-5-mini', 'gpt-5'],
    } satisfies ProviderInstance;

    expect(() => new Router([provider])).toThrow(RouterModelCollisionError);
  });

  test('provider-qualified aliases only return the requested provider', () => {
    const other = {
      kind: 'api',
      id: 'other',
      protocol: ProviderProtocol.OpenAICompatible,
      models: ['other-mini'],
      alias: { mini: { model: 'other-mini', preserve: false } },
    } satisfies ProviderInstance;

    const router = new Router([openai, other]);

    expect(router.resolve('other/mini')).toMatchObject([{ provider: other, modelId: 'other-mini' }]);
  });

  test('throws a 404 sentinel for a missing alias', () => {
    const router = new Router([openai]);

    expect(() => router.resolve('missing')).toThrow(RouterModelNotFoundError);
    try {
      router.resolve('missing');
    } catch (error) {
      expect(error).toBeInstanceOf(RouterModelNotFoundError);
      if (error instanceof RouterModelNotFoundError) {
        expect(error.code).toBe('MODEL_NOT_FOUND');
        expect(error.status).toBe(404);
      }
    }
  });

  test('ignores disabled providers', () => {
    const router = new Router([{ ...openai, enabled: false }]);

    expect(() => router.resolve('gpt-5-mini')).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve('openai/gpt-5-mini')).toThrow(RouterModelNotFoundError);
  });

  test('resolves the plan QA legacy OAuth sonnet alias', () => {
    const router = new Router([legacyOAuth]);

    const resolved = router.resolve('sonnet');

    expect(resolved).toMatchObject([{ provider: legacyOAuth, modelId: 'claude-sonnet-4-5' }]);
  });
});
