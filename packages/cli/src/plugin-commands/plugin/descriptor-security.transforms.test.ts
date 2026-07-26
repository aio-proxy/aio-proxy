import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { FormSchemaValidationError } from '../form';
import { pluginConfig } from './index';
import { createPluginTestScope, descriptorWithForm } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin descriptor security transforms', () => {
  test('config rejects a secret-renaming transform without publishing the secret', async () => {
    const sentinel = 'transform-secret-sentinel';
    const descriptor = descriptorWithForm(
      [
        { type: 'text', key: 'endpoint', label: 'Endpoint' },
        { type: 'secret', key: 'token', label: 'Token' },
      ],
      (value) => {
        const { endpoint, token } = value as { endpoint: string; token: string };
        return { endpoint, leaked: token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [['transform-plugin', { endpoint: 'https://old.test' }]] });
    state.values.set('transform-plugin', { revision: 1, value: { token: sentinel } });
    const result = pluginConfig(
      'transform-plugin',
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...state.deps.prompts, input: async () => 'https://new.test', password: async () => '' },
      },
    );
    await expect(result).rejects.toBeInstanceOf(FormSchemaValidationError);
    await result.catch((error) => expect(String(error)).not.toContain(sentinel));
    const configText = readFileSync(state.path, 'utf8');
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([['transform-plugin', { endpoint: 'https://old.test' }]]);
  });

  test('config rejects a transform that copies a secret into a declared public field', async () => {
    const sentinel = 'declared-public-secret-sentinel';
    const descriptor = descriptorWithForm(
      [
        { type: 'text', key: 'endpoint', label: 'Endpoint' },
        { type: 'secret', key: 'token', label: 'Token' },
      ],
      (value) => {
        const { token } = value as { token: string };
        return { endpoint: token, token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [['copy-plugin', { endpoint: 'https://old.test' }]] });
    state.values.set('copy-plugin', { revision: 1, value: { token: sentinel } });
    await expect(
      pluginConfig(
        'copy-plugin',
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => 'https://new.test', password: async () => '' },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, 'utf8');
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([['copy-plugin', { endpoint: 'https://old.test' }]]);
  });

  test('config rejects a schema that mutates its input to copy a secret into public config', async () => {
    const sentinel = 'mutated-input-secret-sentinel';
    const descriptor = descriptorWithForm(
      [
        { type: 'text', key: 'endpoint', label: 'Endpoint' },
        { type: 'secret', key: 'token', label: 'Token' },
      ],
      (value) => {
        const input = value as { endpoint: string; token: string };
        input.endpoint = input.token;
        return input;
      },
    );
    const state = scope.harness({ providers: {}, plugins: [['mutation-plugin', { endpoint: 'https://old.test' }]] });
    await expect(
      pluginConfig(
        'mutation-plugin',
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => 'https://new.test', password: async () => sentinel },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, 'utf8');
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([['mutation-plugin', { endpoint: 'https://old.test' }]]);
    expect(state.values.get('mutation-plugin')).toBeUndefined();
  });
});
