import { expect, test } from 'bun:test';

import { parseRuntimeConfig } from './parse-runtime-config';

test('expands env templates before URL and header validation runs', () => {
  const raw = {
    proxy: '{{env.PROXY_URL}}',
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: '{{env.API_BASE_URL}}',
        headers: { Authorization: 'Bearer {{env.API_TOKEN}}' },
      },
    },
  };
  const env = {
    PROXY_URL: 'https://proxy.example:8443',
    API_BASE_URL: 'https://api.example.test/v1',
    API_TOKEN: 'secret-token',
  };

  const config = parseRuntimeConfig(raw, env);

  expect(config.invalidProviders).toEqual([]);
  expect(config.proxy).toBe('https://proxy.example:8443');
  expect(config.providers[0]).toMatchObject({
    baseURL: 'https://api.example.test/v1',
    headers: { Authorization: 'Bearer secret-token' },
  });
});

test('degrades a provider whose template resolves to an invalid base URL', () => {
  const config = parseRuntimeConfig(
    {
      providers: {
        api: { kind: 'api', protocol: 'openai-response', baseURL: '{{env.API_BASE_URL}}' },
      },
    },
    { API_BASE_URL: 'not-a-url' },
  );

  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    { id: 'api', kind: 'api', code: 'PROVIDER_CONFIG_INVALID', issuePaths: [['baseURL']] },
  ]);
});

// `models` on an oauth provider used to be silently stripped and is now validated, so a hand-edited
// malformed value newly fails its schema. This pins that the failure stays QUARANTINED: the proxy still
// loads, sibling providers still route, and the bad one is named. Kills a mutant that lets the entry's
// ZodError escape `ConfigSchema`'s per-provider `safeParse` and take the whole config load down.
test('a malformed oauth models whitelist degrades only its own provider', () => {
  const config = parseRuntimeConfig({
    providers: {
      'my-claude': { kind: 'oauth', plugin: '@example/oauth', capability: 'default', models: [''] },
      api: { kind: 'api', protocol: 'openai-response', baseURL: 'https://api.example.test/v1' },
    },
  });

  expect(config.providers.map(({ id }) => id)).toEqual(['api']);
  expect(config.invalidProviders).toEqual([
    { id: 'my-claude', kind: 'oauth', code: 'PROVIDER_CONFIG_INVALID', issuePaths: [['models', 0]] },
  ]);
});

test('accepts a digit server.port expanded from an environment template', () => {
  const config = parseRuntimeConfig(
    {
      server: { host: '{{env.AGENT_BIND_HOST}}', port: '{{env.AGENT_BIND_PORT}}' },
      providers: {},
    },
    { AGENT_BIND_HOST: '127.0.0.9', AGENT_BIND_PORT: '9417' },
  );

  expect(config.server).toMatchObject({ host: '127.0.0.9', port: 9417 });
});

test('does not expand nested environment templates a second time', () => {
  const config = parseRuntimeConfig(
    { server: { host: '{{env.OUTER_HOST}}' }, providers: {} },
    { OUTER_HOST: '{{env.INNER_HOST}}', INNER_HOST: '127.0.0.1' },
  );

  expect(config.server.host).toBe('{{env.INNER_HOST}}');
});

test.each(['not-a-port', '0', '65536', '{{env.INNER}}'] as const)(
  'rejects expanded server.port %s instead of defaulting',
  (port) => {
    expect(() => parseRuntimeConfig({ server: { port: '{{env.PORT}}' }, providers: {} }, { PORT: port })).toThrow();
  },
);
test('leaves the raw config record byte-for-byte unchanged', () => {
  const raw = {
    proxy: '{{env.PROXY_URL}}',
    providers: {
      api: { kind: 'api', protocol: 'openai-response', baseURL: '{{env.API_BASE_URL}}' },
    },
  };
  const snapshot = structuredClone(raw);

  parseRuntimeConfig(raw, { PROXY_URL: 'https://proxy.example:8443', API_BASE_URL: 'https://api.example.test/v1' });

  expect(structuredClone(raw)).toEqual(snapshot);
});
