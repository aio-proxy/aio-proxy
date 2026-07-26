import { describe, expect, test } from 'bun:test';

import { ProviderMutationBodySchema } from '../src/index';

describe('ConfigSchema', () => {
  describe('ProviderMutationBodySchema alias', () => {
    test('Given api mutation body with alias target outside models When parsed Then rejects at alias.mini.model', () => {
      // Given
      const body = {
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-5-mini'],
        alias: { mini: { model: 'missing-model' } },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['alias', 'mini', 'model']);
      }
    });

    test('Given api mutation body with variant target outside models When parsed Then rejects at alias.mini.variants.low.model', () => {
      // Given
      const body = {
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-5-mini'],
        alias: {
          mini: {
            model: 'gpt-5-mini',
            variants: { low: 'missing-model' },
          },
        },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          'alias',
          'mini',
          'variants',
          'low',
          'model',
        ]);
      }
    });

    test('Given an explicit alias conflicting with a preserved model id When parsed Then rejects the alias', () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-default', 'gpt-raw'],
        alias: {
          'gpt-raw': { model: 'gpt-default' },
          mini: { model: 'gpt-raw', preserve: true },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['alias', 'gpt-raw']);
      }
    });
  });
});
