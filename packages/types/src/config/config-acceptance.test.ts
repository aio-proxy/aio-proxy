import { describe, expect, test } from 'bun:test';

import { ConfigSchema } from '..';
import { apiProvider, defaultServer, providers } from './config-acceptance.test-support';

describe('ConfigSchema', () => {
  test('accepts api provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...apiProvider, enabled: true, id: 'openai' }],
      invalidProviders: [],
    });
  });

  test('accepts a provider proxy override and headers alongside an inherited top-level proxy', () => {
    const provider = {
      ...apiProvider,
      proxy: 'http://provider-proxy.example:8080',
      headers: { 'X-Tenant': 'team-a' },
    };

    expect(ConfigSchema.parse({ proxy: 'https://proxy.example:8443', providers: { openai: provider } })).toEqual({
      plugins: [],
      server: defaultServer,
      proxy: 'https://proxy.example:8443',
      providers: [{ ...provider, enabled: true, id: 'openai' }],
      invalidProviders: [],
    });
  });

  test('accepts disabled provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...apiProvider, enabled: false, id: 'openai' }],
      invalidProviders: [],
    });
  });

  test('sorts providers by descending weight and preserves key order for ties', () => {
    const config = ConfigSchema.parse(
      providers({
        first: { ...apiProvider, weight: 10 },
        second: { ...apiProvider, weight: 20 },
        third: { ...apiProvider, weight: 10 },
      }),
    );

    expect(config.providers.map((provider) => provider.id)).toEqual(['second', 'first', 'third']);
    expect(config.providers.map((provider) => provider.weight)).toEqual([20, 10, 10]);
  });
});
