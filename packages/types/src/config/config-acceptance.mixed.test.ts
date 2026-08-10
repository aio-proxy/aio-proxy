import { describe, expect, test } from 'bun:test';

import { ConfigSchema } from '..';
import { apiProvider, defaultRouter, defaultServer, providers } from './config-acceptance.test-support';

describe('ConfigSchema', () => {
  test('accepts mixed provider config', () => {
    const input = {
      openai: apiProvider,
      copilot: { kind: 'oauth', plugin: '@aio-proxy/plugin-github-copilot', capability: 'default' },
      anthropic: { kind: 'ai-sdk', packageName: '@ai-sdk/anthropic' },
    };

    expect(
      ConfigSchema.parse({
        server: { host: '127.0.0.1', port: 3000 },
        providers: input,
      }),
    ).toEqual({
      plugins: [],
      server: { ...defaultServer, port: 3000 },
      router: defaultRouter,
      providers: [
        { ...apiProvider, enabled: true, id: 'openai' },
        {
          kind: 'oauth',
          enabled: true,
          id: 'copilot',
          plugin: '@aio-proxy/plugin-github-copilot',
          capability: 'default',
        },
        { kind: 'ai-sdk', enabled: true, id: 'anthropic', packageName: '@ai-sdk/anthropic' },
      ],
      invalidProviders: [],
    });
  });

  test('accepts provider alias config and normalizes variant shorthand', () => {
    const provider = {
      ...apiProvider,
      models: ['gemini-3.5-flash', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low'],
      alias: {
        'gemini-3-flash-agent': {
          model: 'gemini-3.5-flash',
          preserve: true,
          variants: {
            medium: { model: 'gemini-3.5-flash-medium', preserve: true },
            low: 'gemini-3.5-flash-low',
          },
        },
        'gemini-3.5-flash': 'gemini-3.5-flash',
      },
    };

    expect(ConfigSchema.parse(providers({ gemini: provider })).providers[0]).toEqual({
      ...provider,
      enabled: true,
      id: 'gemini',
      alias: {
        'gemini-3-flash-agent': {
          model: 'gemini-3.5-flash',
          preserve: false,
          variants: {
            medium: { model: 'gemini-3.5-flash-medium', preserve: true },
            low: { model: 'gemini-3.5-flash-low', preserve: false },
          },
        },
        'gemini-3.5-flash': { model: 'gemini-3.5-flash', preserve: false },
      },
    });
  });
});
