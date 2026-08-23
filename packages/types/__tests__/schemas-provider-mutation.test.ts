import { describe, expect, test } from 'bun:test';

import { ApiProviderMutationBodySchema, ProviderMutationBodySchema } from '../src/index';

describe('ConfigSchema', () => {
  test('accepts api provider mutation body', () => {
    expect(
      ProviderMutationBodySchema.parse({
        kind: 'api',
        id: 'openai',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
      }),
    ).toMatchObject({ kind: 'api', id: 'openai' });
  });

  test('accepts ai-sdk provider mutation body', () => {
    expect(
      ProviderMutationBodySchema.parse({
        kind: 'ai-sdk',
        id: 'google',
        packageName: '@ai-sdk/google',
      }),
    ).toMatchObject({ kind: 'ai-sdk', id: 'google' });
  });

  test('rejects oauth kind in mutation body', () => {
    expect(() => ProviderMutationBodySchema.parse({ kind: 'oauth', id: 'x', vendor: 'legacy-provider' })).toThrow();
  });

  test('requires id field', () => {
    expect(() =>
      ApiProviderMutationBodySchema.parse({
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.openai.com',
      }),
    ).toThrow();
  });

  test('Given ai-sdk mutation with a blank packageName When parsed Then it is rejected', () => {
    // Given
    const body = { kind: 'ai-sdk', id: 'blank-package', packageName: '   ' };

    // When
    const result = ProviderMutationBodySchema.safeParse(body);

    // Then
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['packageName']);
    }
  });

  test('rejects fractional priorities and non-number weights', () => {
    expect(
      ProviderMutationBodySchema.safeParse({
        kind: 'ai-sdk',
        id: 'x',
        priority: 1.5,
        packageName: '@ai-sdk/openai-compatible',
      }).success,
    ).toBe(false);
    expect(
      ProviderMutationBodySchema.safeParse({
        kind: 'ai-sdk',
        id: 'x',
        weight: '2',
        packageName: '@ai-sdk/openai-compatible',
      }).success,
    ).toBe(false);
  });
});
