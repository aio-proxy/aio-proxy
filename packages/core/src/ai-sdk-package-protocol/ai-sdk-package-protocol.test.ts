import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { aiSdkPackagePrimaryProtocol } from './ai-sdk-package-protocol';

describe('aiSdkPackagePrimaryProtocol', () => {
  test('maps the four known language AI SDK packages', () => {
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/openai')).toBe(ProviderProtocol.OpenAIResponse);
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/openai-compatible')).toBe(ProviderProtocol.OpenAICompatible);
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/anthropic')).toBe(ProviderProtocol.Anthropic);
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/google')).toBe(ProviderProtocol.Gemini);
    expect(aiSdkPackagePrimaryProtocol('@vendor/unknown')).toBeUndefined();
  });

  test('pins the single-capability TypeSafe package to the System One protocol', () => {
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/typesafe-ai')).toBe(ProviderProtocol.TypeSafeSystemOne);
  });

  test('leaves multi-capability packages unclassified so they keep synthesizing language', () => {
    // Pinning the Gateway would suppress language synthesis and break chat through it.
    expect(aiSdkPackagePrimaryProtocol('@ai-sdk/gateway')).toBeUndefined();
    expect(aiSdkPackagePrimaryProtocol('@some/unknown-provider')).toBeUndefined();
  });
});
