import { describe, expect, test } from 'bun:test';

import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '../provider';
import { ConfigSchema } from './config';

const baseConfig = (provider: Record<string, unknown>) => ({
  providers: { p: { kind: 'api', apiKey: 'k', models: ['m'], ...provider } },
});

const parsedProvider = (provider: Record<string, unknown>) => {
  const config = ConfigSchema.parse(baseConfig(provider));
  expect(config.invalidProviders).toEqual([]);
  const parsed = config.providers[0];
  if (parsed?.kind !== ProviderKind.Api) throw new Error('expected api provider');
  return parsed;
};

const invalidPaths = (provider: Record<string, unknown>) => {
  const config = ConfigSchema.parse(baseConfig(provider));
  expect(config.providers).toEqual([]);
  return config.invalidProviders[0]?.issuePaths ?? [];
};

describe('endpoints acceptance', () => {
  test('legacy-only provider parses exactly as before', () => {
    const provider = parsedProvider({ protocol: 'openai-response', baseURL: 'https://api.openai.com/v1' });
    expect(provider.protocol).toBe(ProviderProtocol.OpenAIResponse);
    expect(provider.baseURL).toBe('https://api.openai.com/v1');
    expect(provider.endpoints).toBeUndefined();
    expect(apiProviderEndpoints(provider)).toEqual([
      { protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1', mode: 'origin' },
    ]);
  });

  test('merge form keeps the legacy pair as the primary endpoint', () => {
    const provider = parsedProvider({
      protocol: 'openai-compatible',
      baseURL: 'https://api.moonshot.cn/v1',
      endpoints: [{ protocol: 'anthropic', baseURL: 'https://api.moonshot.cn/anthropic/v1', auth: 'bearer' }],
    });
    expect(apiProviderEndpoints(provider).map((endpoint) => [endpoint.protocol, endpoint.mode])).toEqual([
      [ProviderProtocol.OpenAICompatible, 'origin'],
      [ProviderProtocol.Anthropic, 'sdk'],
    ]);
  });

  test('endpoints-only array form parses without the legacy pair', () => {
    const provider = parsedProvider({
      endpoints: [
        { protocol: 'openai-compatible', baseURL: 'https://api.z.ai/api/paas/v4' },
        { protocol: 'anthropic', baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' },
      ],
    });
    expect(provider.protocol).toBeUndefined();
    expect(apiProviderEndpoints(provider)[0]).toEqual({
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.z.ai/api/paas/v4',
      mode: 'sdk',
    });
  });

  test('shared object form expands in declared order', () => {
    const provider = parsedProvider({
      endpoints: { baseURL: 'https://gw.example.com/v1', protocol: ['openai-response', 'anthropic'] },
    });
    expect(apiProviderEndpoints(provider).map((endpoint) => endpoint.protocol)).toEqual([
      ProviderProtocol.OpenAIResponse,
      ProviderProtocol.Anthropic,
    ]);
  });

  test.each([
    { name: 'lone protocol', provider: { protocol: 'anthropic' } },
    { name: 'lone baseURL', provider: { baseURL: 'https://a.test' } },
    { name: 'missing everything', provider: {} },
    {
      name: 'duplicate protocol across legacy and endpoints',
      provider: {
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://b.test' }],
      },
    },
    { name: 'empty endpoints array', provider: { endpoints: [] } },
    {
      name: 'auth on non-anthropic endpoint',
      provider: { endpoints: [{ protocol: 'gemini', baseURL: 'https://g.test/v1beta', auth: 'bearer' }] },
    },
  ])('rejects $name into invalidProviders', ({ provider }) => {
    expect(invalidPaths(provider).length).toBeGreaterThan(0);
  });

  test('rejects an anthropic bearer endpoint when the provider has no apiKey', () => {
    const config = ConfigSchema.parse({
      providers: {
        p: {
          kind: 'api',
          models: ['m'],
          endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1', auth: 'bearer' }],
        },
      },
    });

    expect(config.providers).toEqual([]);
    expect(config.invalidProviders[0]?.issuePaths).toContainEqual(['endpoints', 0, 'auth']);
  });

  test('mutation body schema silently strips endpoints (documented dashboard limitation)', async () => {
    const { ProviderMutationBodySchema } = await import('../provider');
    const parsed = ProviderMutationBodySchema.parse({
      kind: 'api',
      id: 'p',
      protocol: 'openai-response',
      baseURL: 'https://api.openai.com/v1',
      proxy: null,
      endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1' }],
    });
    expect('endpoints' in parsed).toBeFalse();
  });

  test('authoring schema accepts template strings inside endpoints', async () => {
    const { ConfigAuthoringSchema } = await import('./config');
    const parsed = ConfigAuthoringSchema.safeParse({
      providers: {
        p: {
          kind: 'api',
          apiKey: '{{env.KEY}}',
          models: ['m'],
          endpoints: [{ protocol: '{{env.PROTO}}', baseURL: '{{env.BASE}}', auth: '{{env.AUTH}}' }],
        },
      },
    });
    expect(parsed.success).toBeTrue();
  });
});
