import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { AiSdkProviderSchema, ConfigAuthoringSchema, ConfigSchema, OAuthProviderSchema } from '..';
import { defaultServer, providers } from './config-acceptance.test-support';

describe('ConfigSchema', () => {
  test('Given oauth provider config with openai-chatgpt vendor When parsed Then it is accepted', () => {
    const provider = {
      kind: 'oauth',
      plugin: '@aio-proxy/plugin-openai-chatgpt',
      capability: 'default',
    };

    expect(ConfigSchema.parse({ server: {}, providers: { chatgpt: provider } })).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...provider, enabled: true, id: 'chatgpt' }],
      invalidProviders: [],
    });
  });

  test('Given oauth and ai-sdk provider schemas When parsed Then name is accepted', () => {
    expect(
      OAuthProviderSchema.parse({
        kind: 'oauth',
        id: 'x',
        plugin: '@example/oauth',
        capability: 'default',
        name: 'My Copilot',
      }),
    ).toEqual({
      kind: 'oauth',
      id: 'x',
      plugin: '@example/oauth',
      capability: 'default',
      name: 'My Copilot',
      enabled: true,
    });
    expect(AiSdkProviderSchema.parse({ kind: 'ai-sdk', id: 'y', name: 'My SDK' })).toEqual({
      kind: 'ai-sdk',
      id: 'y',
      name: 'My SDK',
      enabled: true,
      packageName: '@ai-sdk/openai-compatible',
    });
  });

  test('accepts ai-sdk provider config', () => {
    const provider = {
      kind: 'ai-sdk',
      packageName: '@ai-sdk/google',
      options: { name: 'google' },
      models: ['gemini-2.5-flash'],
    };

    expect(ConfigSchema.parse(providers({ google: provider }))).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...provider, enabled: true, id: 'google' }],
      invalidProviders: [],
    });
  });

  test('Given openai-compatible ai-sdk config without packageName When parsed Then default package and options are preserved', () => {
    // Given
    const provider = {
      kind: 'ai-sdk',
      options: {
        baseURL: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        headers: { 'x-test': 'yes' },
        name: 'compatible',
      },
      parseReasoningContent: true,
      models: ['custom-reasoner'],
    };

    // When
    const config = ConfigSchema.parse(providers({ compatible: provider }));

    // Then
    expect(config.providers).toEqual([
      {
        ...provider,
        enabled: true,
        id: 'compatible',
        packageName: '@ai-sdk/openai-compatible',
      },
    ]);
  });

  test('generates object-shaped provider input schema without value id', () => {
    const jsonSchema = z.toJSONSchema(ConfigAuthoringSchema, { io: 'input' }) as {
      properties: {
        providers: {
          additionalProperties: { oneOf: { properties: Record<string, unknown> }[] };
          type: string;
        };
      };
    };

    expect(jsonSchema.properties.providers.type).toBe('object');
    for (const providerSchema of jsonSchema.properties.providers.additionalProperties.oneOf) {
      expect(providerSchema.properties).not.toHaveProperty('id');
    }
  });
});
