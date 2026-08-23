import { describe, expect, test } from 'bun:test';

import { ProviderMutationBodySchema } from '../src/index';

describe('ConfigSchema', () => {
  describe('ProviderMutationBodySchema alias', () => {
    test('Given padded alias and variant names When parsed Then keys are normalized', () => {
      const result = ProviderMutationBodySchema.parse({
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-5-mini', 'gpt-5'],
        alias: {
          ' mini ': {
            model: 'gpt-5-mini',
            variants: { ' HIGH ': { model: 'gpt-5', preserve: false } },
          },
        },
      });

      expect(result.alias).toEqual({
        mini: {
          model: 'gpt-5-mini',
          preserve: false,
          variants: [{ when: { effort: 'high' }, model: 'gpt-5', preserve: false }],
        },
      });
    });

    test('Given normalized duplicate variant keys When parsed Then rejects the duplicate', () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-5-mini'],
        alias: {
          mini: {
            model: 'gpt-5-mini',
            variants: {
              High: 'gpt-5-mini',
              ' high ': 'gpt-5-mini',
            },
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
      }
    });

    test('Given normalized duplicate alias names When parsed Then rejects the duplicate', () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
        models: ['gpt-5-mini'],
        alias: {
          mini: 'gpt-5-mini',
          ' mini ': 'gpt-5-mini',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['alias', ' mini ']);
      }
    });
  });
});
