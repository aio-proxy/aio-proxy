import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '../provider';
import { DashboardProviderDraftSchema } from './dashboard-provider-draft';

describe('DashboardProviderDraftSchema', () => {
  test('strips leftover API fields on an AI SDK draft instead of rejecting it', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      baseURL: 'https://api.example/v1',
      headers: { Authorization: 'Bearer leftover' },
      id: 'sdk-draft',
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
    });

    expect(result.success).toBeTrue();
    if (!result.success) return;
    expect(result.data).toEqual({
      id: 'sdk-draft',
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
    });
  });

  test('strips a misspelled API field instead of rejecting the draft', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      baseURL: 'https://api.example/v1',
      baseUrl: 'https://misspelled.example/v1',
      id: 'api-draft',
      kind: 'api',
      protocol: ProviderProtocol.OpenAICompatible,
    });

    expect(result.success).toBeTrue();
    if (!result.success) return;
    expect('baseUrl' in result.data).toBe(false);
    expect(result.data).toMatchObject({
      baseURL: 'https://api.example/v1',
      id: 'api-draft',
      kind: 'api',
      protocol: ProviderProtocol.OpenAICompatible,
    });
  });

  test('accepts an oauth draft with a denylist', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      kind: 'oauth',
      id: 'oauth-p',
      enabled: true,
      proxy: null,
      excludedModels: ['m1'],
    });
    expect(result.success).toBeTrue();
  });

  test('rejects leftover models on an oauth draft', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      kind: 'oauth',
      id: 'oauth-p',
      enabled: true,
      proxy: null,
      models: ['m1'],
    });
    expect(result.success).toBeFalse();
  });

  test('rejects a redacted proxy sentinel instead of accepting it as an unchanged marker', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      baseURL: 'https://api.example/v1',
      id: 'api-draft',
      kind: 'api',
      protocol: ProviderProtocol.OpenAICompatible,
      proxy: '****',
    });

    expect(result.success).toBeFalse();
  });
});
