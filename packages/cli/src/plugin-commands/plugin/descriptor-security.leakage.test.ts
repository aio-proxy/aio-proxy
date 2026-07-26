import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { FormSchemaValidationError } from '../form';
import { createCliPluginDiagnosticFactory, pluginConfig } from './index';
import { createPluginTestScope, descriptorWithForm, textDescriptor } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin descriptor security leakage', () => {
  test('config never publishes plaintext from secret fields removed by a new descriptor', async () => {
    const sentinel = 'retired-secret-sentinel';
    const descriptor = textDescriptor();
    const state = scope.harness({ providers: {}, plugins: ['migrated-plugin'] });
    state.values.set('migrated-plugin', { revision: 1, value: { retiredToken: sentinel } });
    await pluginConfig(
      'migrated-plugin',
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...state.deps.prompts, input: async () => 'https://example.test' },
      },
    );
    const configText = readFileSync(state.path, 'utf8');
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([['migrated-plugin', { endpoint: 'https://example.test' }]]);
    expect(state.values.get('migrated-plugin')?.value).toEqual({});
  });

  test('config rejects an array toJSON closure that would serialize a secret', async () => {
    const sentinel = 'array-to-json-secret-sentinel';
    const descriptor = descriptorWithForm(
      [
        { type: 'json', key: 'endpoint', label: 'Endpoint' },
        { type: 'secret', key: 'token', label: 'Token' },
      ],
      (value) => {
        const { token } = value as { token: string };
        const endpoint: unknown[] = [];
        Object.defineProperty(endpoint, 'toJSON', { value: () => token, enumerable: true });
        return { endpoint, token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [['array-plugin', { endpoint: [] }]] });
    await expect(
      pluginConfig(
        'array-plugin',
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => '[]', password: async () => sentinel },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, 'utf8');
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([['array-plugin', { endpoint: [] }]]);
    expect(state.values.get('array-plugin')).toBeUndefined();
  });

  test('localized diagnostics interpolate only safe identifiers', () => {
    const diagnostic = createCliPluginDiagnosticFactory()('CAPABILITY_MISSING', {
      plugin: 'secret-value\ninvalid',
      capability: 'secret-value invalid',
      providerId: 'secret-value invalid',
      retryable: false,
    });
    expect(diagnostic.summary).not.toContain('secret-value');
  });
});
