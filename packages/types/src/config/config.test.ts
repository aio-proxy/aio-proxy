import { expect, test } from 'bun:test';

import {
  ConfigAuthoringSchema,
  ConfigSchema,
  DashboardOAuthProviderPatchSchema,
  ProviderKind,
  ProviderMutationAuthoringBodySchema,
  ProviderMutationBodySchema,
} from '..';

const transforms = {
  request: [{ update: [{ $unset: 'request.body.store' }] }],
};

test('preserves an exact non-empty dashboard password', () => {
  expect(ConfigSchema.parse({ server: { password: '  ' }, providers: {} }).server.password).toBe('  ');
  expect(ConfigAuthoringSchema.safeParse({ server: { password: '' }, providers: {} }).success).toBe(false);
});

test.each(['0.0.0.0', '192.168.1.20', 'example.test', '127.0.0.1', '::1', 'localhost'])(
  'accepts server host %s',
  (host) => {
    expect(ConfigSchema.parse({ server: { host }, providers: {} }).server.host).toBe(host);
  },
);

test('accepts labeled caller API keys and authoring templates', () => {
  expect(
    ConfigSchema.parse({
      server: { apiKeys: [{ key: 'caller-secret', label: 'CI' }] },
      providers: {},
    }).server.apiKeys,
  ).toEqual([{ key: 'caller-secret', label: 'CI' }]);
  expect(
    ConfigAuthoringSchema.safeParse({
      server: { apiKeys: [{ key: '{{env.AIO_PROXY_KEY}}', label: 'CI' }] },
      providers: {},
    }).success,
  ).toBe(true);
});

test.each(['aio_agent_at_v1_static', 'aio_agent_rt_v1_static'])(
  'rejects reserved Agent prefix %s as a static API key',
  (key) => {
    const input = { server: { apiKeys: [{ key }] }, providers: {} };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
    expect(ConfigAuthoringSchema.safeParse(input).success).toBe(false);
  },
);

test.each(['aio_agent_at_v1_static', 'aio_agent_rt_v1_static'])(
  'rejects reserved Agent prefix %s as a labeled static API key on both config schemas',
  (key) => {
    const input = { server: { apiKeys: [{ key, label: 'CI' }] }, providers: {} };
    const runtime = ConfigSchema.safeParse(input);
    const authoring = ConfigAuthoringSchema.safeParse(input);
    expect(runtime.success).toBe(false);
    expect(authoring.success).toBe(false);
    expect(runtime.error?.issues.some((issue) => issue.path.join('.') === 'server.apiKeys.0.key')).toBe(true);
    expect(authoring.error?.issues.some((issue) => issue.path.join('.') === 'server.apiKeys.0.key')).toBe(true);
  },
);

test('keeps unresolved API-key templates valid in the authoring schema', () => {
  const input = { server: { apiKeys: [{ key: '{{ env.AIO_PROXY_API_KEY }}' }] }, providers: {} };
  expect(ConfigAuthoringSchema.safeParse(input).success).toBe(true);
});

test('defaults server.retry.retryAfterCapMs', () => {
  expect(ConfigSchema.parse({ server: {}, providers: {} }).server.retry).toEqual({ retryAfterCapMs: 30_000 });
});
test('accepts a custom retryAfterCapMs', () => {
  expect(ConfigSchema.parse({ server: { retry: { retryAfterCapMs: 5_000 } }, providers: {} }).server.retry).toEqual({
    retryAfterCapMs: 5_000,
  });
});
test('rejects out-of-range retryAfterCapMs', () => {
  expect(ConfigSchema.safeParse({ server: { retry: { retryAfterCapMs: -1 } }, providers: {} }).success).toBe(false);
  expect(ConfigSchema.safeParse({ server: { retry: { retryAfterCapMs: 400_000 } }, providers: {} }).success).toBe(
    false,
  );
});

test('normalizes plugin enablements while degrading legacy OAuth provider config', () => {
  const config = ConfigSchema.parse({
    plugins: [['@example/enterprise', { baseURL: 'https://example.test' }]],
    providers: {
      legacyDuringScaffolding: { kind: 'oauth', vendor: 'legacy-provider' },
    },
  });

  expect(config.plugins).toEqual([
    { packageName: '@example/enterprise', options: { baseURL: 'https://example.test' } },
  ]);
  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    {
      id: 'legacyDuringScaffolding',
      kind: ProviderKind.OAuth,
      code: 'LEGACY_OAUTH_CONFIG_UNSUPPORTED',
      issuePaths: [['vendor']],
    },
  ]);
});

test('degrades invalid and legacy provider entries independently', () => {
  const config = ConfigSchema.parse({
    plugins: [],
    providers: {
      valid: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://api.example.test/v1',
      },
      legacy: { kind: 'oauth', vendor: 'legacy-provider' },
      broken: {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: '',
      },
    },
  });

  expect(config.providers.map((provider) => provider.id)).toEqual(['valid']);
  expect(config.invalidProviders).toEqual([
    {
      id: 'legacy',
      kind: ProviderKind.OAuth,
      code: 'LEGACY_OAUTH_CONFIG_UNSUPPORTED',
      issuePaths: [['vendor']],
    },
    {
      id: 'broken',
      kind: ProviderKind.OAuth,
      code: 'PROVIDER_CONFIG_INVALID',
      issuePaths: [['capability']],
    },
  ]);
  expect(JSON.stringify(config)).not.toContain('legacy-provider');
  expect(JSON.stringify(config)).not.toContain('@example/oauth');
});

test('marks an OAuth Provider invalid when an input limit exceeds context', () => {
  const config = ConfigSchema.parse({
    providers: {
      bad: {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
        metadata: { model: { limit: { context: 272_000, input: 400_000 } } },
      },
    },
  });

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders[0]?.issuePaths).toContainEqual(['metadata', 'model', 'limit', 'input']);
});

test('keeps authoring schema strict and documents the structured oauth shape', () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: { legacy: { kind: 'oauth', vendor: 'legacy-provider' } },
    }).success,
  ).toBe(false);
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: {
        copilot: {
          kind: 'oauth',
          plugin: '@aio-proxy/plugin-github-copilot',
          capability: 'default',
        },
      },
    }).success,
  ).toBe(true);
});

test.each([
  { server: { port: 0 }, plugins: [], providers: {} },
  { server: {}, plugins: ['NOT A PACKAGE'], providers: {} },
  { server: {}, plugins: [], providers: [] },
])('rejects an invalid operational config envelope', (input) => {
  expect(ConfigSchema.safeParse(input).success).toBe(false);
});

test('rejects duplicate plugin enablements', () => {
  expect(() =>
    ConfigSchema.parse({
      plugins: ['@example/duplicate', '@example/duplicate'],
      providers: {},
    }),
  ).toThrow('Duplicate plugin @example/duplicate');
});

test('resolves top-level and per-provider proxy plus API headers on the runtime config', () => {
  const runtime = ConfigSchema.parse({
    proxy: 'https://proxy.example:8443',
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        proxy: false,
        headers: { Authorization: 'Bearer upstream', 'X-Tenant': 'team-a' },
      },
      sdk: {
        kind: 'ai-sdk',
        packageName: '@ai-sdk/anthropic',
        proxy: 'http://provider-proxy.example:8080',
      },
    },
  });

  expect(runtime.proxy).toBe('https://proxy.example:8443');
  expect(runtime.providers[0]).toMatchObject({ proxy: false, headers: { 'X-Tenant': 'team-a' } });
  expect(runtime.providers[1]).toMatchObject({ proxy: 'http://provider-proxy.example:8080' });
});

test('rejects a non-HTTP(S) top-level proxy scheme', () => {
  expect(ConfigSchema.safeParse({ proxy: 'socks5://localhost:1080', providers: {} }).success).toBe(false);
});

test('degrades an API provider with an invalid header name instead of failing the whole config', () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example/v1',
        headers: { 'Bad\nName': 'value' },
      },
    },
  });

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    { id: 'api', kind: ProviderKind.Api, code: 'PROVIDER_CONFIG_INVALID', issuePaths: [['headers']] },
  ]);
});

test('accepts config templates for top-level proxy, provider base URL, and header values in the authoring schema', () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      proxy: '{{env.PROXY_URL}}',
      providers: {
        api: {
          kind: 'api',
          protocol: 'openai-response',
          baseURL: '{{env.API_BASE_URL}}',
          headers: { Authorization: 'Bearer {{env.API_TOKEN}}' },
        },
      },
    }).success,
  ).toBe(true);
});

test('authoring schema accepts templates on constrained string leaves', () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      server: { host: '{{env.HOST}}' },
      plugins: ['{{env.PLUGIN_PACKAGE}}'],
      providers: {
        api: {
          kind: 'api',
          protocol: '{{env.PROTOCOL}}',
          baseURL: 'https://api.example/v1',
        },
        sdk: {
          kind: 'ai-sdk',
          packageName: '{{env.SDK_PACKAGE}}',
        },
        oauth: {
          kind: 'oauth',
          plugin: '{{env.OAUTH_PLUGIN}}',
          capability: '{{env.OAUTH_CAPABILITY}}',
        },
      },
    }).success,
  ).toBe(true);
});

test('authoring and mutation schemas reject templated provider kind', () => {
  expect(
    ConfigAuthoringSchema.safeParse({
      providers: {
        api: {
          kind: '{{env.KIND}}',
          protocol: 'openai-response',
          baseURL: 'https://api.example/v1',
        },
      },
    }).success,
  ).toBe(false);
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: '{{env.KIND}}',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.example/v1',
    }).success,
  ).toBe(false);
});

test('provider mutation authoring accepts proxy templates and API headers', () => {
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: '{{env.API_BASE_URL}}',
      proxy: '{{env.PROVIDER_PROXY}}',
      headers: { Authorization: 'Bearer {{env.API_TOKEN}}' },
    }).success,
  ).toBe(true);
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: 'ai-sdk',
      id: 'anthropic',
      packageName: '@ai-sdk/anthropic',
      proxy: '{{env.PROVIDER_PROXY}}',
    }).success,
  ).toBe(true);
});

test('provider mutation authoring accepts protocol and packageName templates', () => {
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: '{{env.PROTOCOL}}',
      baseURL: 'https://api.example/v1',
    }).success,
  ).toBe(true);
  expect(
    ProviderMutationAuthoringBodySchema.safeParse({
      kind: 'ai-sdk',
      id: 'anthropic',
      packageName: '{{env.SDK_PACKAGE}}',
    }).success,
  ).toBe(true);
});

test('provider mutation body accepts API headers', () => {
  expect(
    ProviderMutationBodySchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.example/v1',
      headers: { Authorization: 'Bearer upstream' },
    }).success,
  ).toBe(true);
});

test('provider mutation body rejects unresolved proxy and base URL templates', () => {
  expect(
    ProviderMutationBodySchema.safeParse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: '{{env.API_BASE_URL}}',
      proxy: '{{env.PROVIDER_PROXY}}',
    }).success,
  ).toBe(false);
});

test('runtime and authoring configs retain transforms for every provider kind', () => {
  const providers = {
    api: {
      kind: 'api',
      protocol: 'openai-response',
      baseURL: 'https://api.example/v1',
      transforms,
    },
    sdk: {
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai',
      transforms,
    },
    oauth: {
      kind: 'oauth',
      plugin: '@example/oauth',
      capability: 'default',
      transforms,
    },
  };

  const runtime = ConfigSchema.parse({ providers });
  const authoring = ConfigAuthoringSchema.parse({ providers });

  expect(runtime.providers.map((provider) => provider.transforms)).toEqual([transforms, transforms, transforms]);
  expect(Object.values(authoring.providers).map((provider) => provider.transforms)).toEqual([
    transforms,
    transforms,
    transforms,
  ]);
});

test.each([
  {
    kind: 'api',
    id: 'api',
    protocol: 'openai-response',
    baseURL: 'https://api.example/v1',
    transforms,
  },
  { kind: 'ai-sdk', id: 'sdk', packageName: '@ai-sdk/openai', transforms },
  { kind: 'oauth', id: 'oauth', transforms },
])('provider mutation body retains transforms for $kind providers', (provider) => {
  expect(ProviderMutationBodySchema.parse(provider).transforms).toEqual(transforms);
  expect(ProviderMutationAuthoringBodySchema.parse(provider).transforms).toEqual(transforms);
});

test('dashboard OAuth patches retain transforms', () => {
  expect(DashboardOAuthProviderPatchSchema.parse({ enabled: true, transforms }).transforms).toEqual(transforms);
});
