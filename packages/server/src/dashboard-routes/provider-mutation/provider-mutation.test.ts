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
  test('preserves existing metadata when an older client omits it and clears it when explicitly empty', () => {
    const previous = { openai: { kind: 'api', metadata: { model: { limit: { context: 400_000 } } } } };

    expect(replaceProvider(previous, 'openai', { kind: 'api' })['openai']).toMatchObject({
      metadata: { model: { limit: { context: 400_000 } } },
    });
    expect(replaceProvider(previous, 'openai', { kind: 'api', metadata: {} })['openai']).toMatchObject({
      metadata: {},
    });
  });

  test('preserves existing transforms when an older client omits them', () => {
    const result = replaceProvider(
      { openai: { kind: 'api', baseURL: 'https://old.example/v1', transforms } },
      'openai',
      { kind: 'api', baseURL: 'https://new.example/v1' },
    );

    expect(result['openai']).toMatchObject({ baseURL: 'https://new.example/v1', transforms });
  });

  // The dashboard's mutation body schema strips `endpoints`, so every save from the editor arrives
  // without one. Retaining it is what stops a routine "rename this provider" from deleting a
  // hand-written multi-protocol list out of config.jsonc and still answering 200.
  test('preserves a hand-authored endpoints list the editor cannot send back', () => {
    const endpoints = [
      { protocol: 'anthropic', baseURL: 'https://a.test/v1' },
      { protocol: 'openai-response', baseURL: 'https://o.test/v1' },
    ];

    const result = replaceProvider(
      { openai: { kind: 'api', baseURL: 'https://old.example/v1', endpoints } },
      'openai',
      { kind: 'api', baseURL: 'https://new.example/v1' },
    );

    expect(result['openai']).toMatchObject({ baseURL: 'https://new.example/v1', endpoints });
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
