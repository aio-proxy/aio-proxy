import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { definePlugin } from '@aio-proxy/plugin-sdk';

import { pluginConfig } from './index';
import { createPluginTestScope, secretDescriptor, textDescriptor } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);
describe('plugin configure basics', () => {
  test('config retains blank secret and supports explicit clear', async () => {
    const descriptor = secretDescriptor();
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'keep' } });
    const deps = { ...state.deps, importPackage: async () => ({ default: descriptor }) };
    await pluginConfig('secret-plugin', {}, deps);
    expect(state.values.get('secret-plugin')?.value).toEqual({ token: 'keep' });
    await pluginConfig('secret-plugin', { clearSecret: ['token'] }, deps);
    expect(state.values.get('secret-plugin')?.value).toEqual({});
  });
  test('config rewrites a legacy non-record vault value to the current descriptor secret shape', async () => {
    const sentinel = 'legacy-secret-sentinel';
    const state = scope.harness({ providers: {}, plugins: ['legacy-secret-plugin'] });
    state.values.set('legacy-secret-plugin', { revision: 1, value: sentinel as never });
    await pluginConfig(
      'legacy-secret-plugin',
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: textDescriptor() }),
        prompts: { ...state.deps.prompts, input: async () => 'https://example.test' },
      },
    );
    expect(readFileSync(state.path, 'utf8')).not.toContain(sentinel);
    expect(state.values.get('legacy-secret-plugin')?.value).toEqual({});
  });
  test('config uses an injected built-in descriptor without npm or dynamic import', async () => {
    const packageName = '@aio-proxy/plugin-github-copilot';
    const state = scope.harness({ providers: {}, plugins: [packageName] });
    let externalAccess = 0;
    await pluginConfig(
      packageName,
      {},
      {
        ...state.deps,
        builtIns: [{ packageName, version: 'built-in', descriptor: definePlugin(() => {}) }],
        findInstalledNpmPackage: async () => {
          externalAccess += 1;
          return null;
        },
        importPackage: async () => {
          externalAccess += 1;
          throw new Error('must not import built-in');
        },
      },
    );
    expect(externalAccess).toBe(0);
  });
});
