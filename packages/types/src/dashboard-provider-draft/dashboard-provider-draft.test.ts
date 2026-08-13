import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '../provider';
import { DashboardProviderDraftSchema } from './dashboard-provider-draft';

describe('DashboardProviderDraftSchema', () => {
  test('rejects misspelled fields on API drafts instead of stripping them', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      baseURL: 'https://api.example/v1',
      baseUrl: 'https://misspelled.example/v1',
      id: 'api-draft',
      kind: 'api',
      protocol: ProviderProtocol.OpenAICompatible,
    });

    expect(result.success).toBeFalse();
  });

  test('rejects API-only fields on AI SDK drafts instead of stripping them', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      baseURL: 'https://api.example/v1',
      id: 'sdk-draft',
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
    });

    expect(result.success).toBeFalse();
  });

  test('rejects OAuth-only fields on non-OAuth drafts instead of stripping them', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      capability: 'account',
      id: 'sdk-draft',
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
      plugin: '@aio-proxy/plugin-example',
    });

    expect(result.success).toBeFalse();
  });

  test('accepts an oauth draft with a whitelist', () => {
    const result = DashboardProviderDraftSchema.safeParse({
      kind: 'oauth',
      id: 'oauth-p',
      enabled: true,
      proxy: null,
      models: ['m1'],
    });
    expect(result.success).toBeTrue();
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
