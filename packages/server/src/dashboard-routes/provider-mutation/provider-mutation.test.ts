import { afterEach, describe, expect, test } from 'bun:test';

import { parseProviderMutation, replaceProvider } from './provider-mutation';

const envName = 'AIO_PROXY_TEST_TRANSFORM_REGEX';
const previousEnv = process.env[envName];
const transforms = {
  request: [{ update: [{ $unset: 'request.body.store' }] }],
};

afterEach(() => {
  if (previousEnv === undefined) delete process.env[envName];
  else process.env[envName] = previousEnv;
});

describe('parseProviderMutation', () => {
  test('reruns transform validation after template expansion', () => {
    process.env[envName] = '[';

    const result = parseProviderMutation({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.example/v1',
      transforms: {
        request: [
          {
            when: { 'request.model': { $regex: `{{env.${envName}}}` } },
            update: [{ $unset: 'request.body.store' }],
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  test('accepts null as an explicit request to inherit the global proxy', () => {
    const result = parseProviderMutation({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-response',
      baseURL: 'https://api.example/v1',
      proxy: null,
    });

    expect(result).toMatchObject({ ok: true, body: { authored: { proxy: null }, materialized: { proxy: null } } });
  });
});

describe('replaceProvider', () => {
  test('drops obsolete provider metadata from an existing config entry', () => {
    const previous = { openai: { kind: 'api', metadata: { model: { limit: { context: 400_000 } } } } };

    expect(replaceProvider(previous, 'openai', { kind: 'api' })['openai']).not.toHaveProperty('metadata');
  });

  test('preserves existing transforms when an older client omits them', () => {
    const result = replaceProvider(
      { openai: { kind: 'api', baseURL: 'https://old.example/v1', transforms } },
      'openai',
      { kind: 'api', baseURL: 'https://new.example/v1' },
    );

    expect(result['openai']).toMatchObject({ baseURL: 'https://new.example/v1', transforms });
  });

  test('replaces a stored endpoints list when the client sends a new one', () => {
    const result = replaceProvider(
      {
        openai: {
          kind: 'api',
          baseURL: 'https://old.example/v1',
          endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1' }],
        },
      },
      'openai',
      {
        kind: 'api',
        endpoints: { baseURL: 'https://gw.example/v1', protocol: ['openai-response', 'anthropic'] },
      },
    );

    expect(result['openai']).toMatchObject({
      endpoints: { baseURL: 'https://gw.example/v1', protocol: ['openai-response', 'anthropic'] },
    });
    expect(result['openai']).not.toHaveProperty('baseURL');
  });

  test('clears a stored endpoints list when the client omits it', () => {
    const result = replaceProvider(
      {
        openai: {
          kind: 'api',
          baseURL: 'https://old.example/v1',
          endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1' }],
        },
      },
      'openai',
      { kind: 'api', protocol: 'openai-response', baseURL: 'https://new.example/v1' },
    );

    expect(result['openai']).toMatchObject({ protocol: 'openai-response', baseURL: 'https://new.example/v1' });
    expect(result['openai']).not.toHaveProperty('endpoints');
  });

  test('clears existing transforms when the client sends an empty request list', () => {
    const result = replaceProvider({ openai: { kind: 'api', transforms } }, 'openai', {
      kind: 'api',
      transforms: { request: [] },
    });

    expect(result['openai']).toMatchObject({ transforms: { request: [] } });
  });

  test('removes an existing provider proxy when the client explicitly selects inheritance', () => {
    const result = replaceProvider({ openai: { kind: 'api', proxy: 'https://proxy.example:8443' } }, 'openai', {
      kind: 'api',
      proxy: null,
    });

    expect(result['openai']).not.toHaveProperty('proxy');
  });
});

test('drops a whitespace-only display name instead of writing it into the config', () => {
  const result = replaceProvider({ openai: { kind: 'oauth', name: 'Personal' } }, 'openai', {
    kind: 'oauth',
    name: '   ',
  });

  expect(result['openai']).not.toHaveProperty('name');
});

test('OAuth PUT that omits alias and excludedModels deletes them instead of restoring previous', () => {
  const result = replaceProvider(
    {
      openai: {
        kind: 'oauth',
        alias: { codex: false, mini: { model: 'gpt-5-mini' } },
        excludedModels: ['o1-preview'],
      },
    },
    'openai',
    { kind: 'oauth', name: 'Personal' },
  );

  expect(result['openai']).toEqual({ kind: 'oauth', name: 'Personal' });
});

test('non-OAuth PUT still restores a previous alias when the client omits it', () => {
  const alias = { chat: { model: 'gpt-5' } };
  const result = replaceProvider({ openai: { kind: 'api', alias } }, 'openai', {
    kind: 'api',
    protocol: 'openai-compatible',
  });

  expect(result['openai']).toMatchObject({ alias });
});
