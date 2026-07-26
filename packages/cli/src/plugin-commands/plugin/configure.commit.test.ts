import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { PluginConfigChangedError, PluginNotInstalledError, pluginConfig } from './index';
import { createPluginTestScope, textDescriptor, textSecretDescriptor } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);
describe('plugin configure commit conflicts', () => {
  test('config rejects a changed entry and a missing cache under the lifecycle lock', async () => {
    const changed = scope.harness({ providers: {}, plugins: [['racing-plugin', { endpoint: 'old' }]] });
    await expect(
      pluginConfig(
        'racing-plugin',
        {},
        {
          ...changed.deps,
          importPackage: async () => ({ default: textDescriptor() }),
          prompts: {
            ...changed.deps.prompts,
            input: async () => {
              await changed.config.replace((current) => ({
                ...current,
                plugins: [['racing-plugin', { endpoint: 'concurrent' }]],
              }));
              return 'new';
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginConfigChangedError);
    const pruned = scope.harness({ providers: {}, plugins: ['racing-plugin'] });
    await expect(
      pluginConfig(
        'racing-plugin',
        {},
        {
          ...pruned.deps,
          importPackage: async () => ({ default: textDescriptor() }),
          findInstalledNpmPackage: async () => null,
          withNpmPackageLifecycle: async (_packageName, use) => use(async () => {}),
          prompts: { ...pruned.deps.prompts, input: async () => 'new' },
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotInstalledError);
    expect(JSON.parse(readFileSync(pruned.path, 'utf8')).plugins).toEqual(['racing-plugin']);
  });
  test('config rejects a concurrent secret revision even when its rendered secret value is unchanged', async () => {
    const state = scope.harness({ providers: {}, plugins: [['secret-race-plugin', { endpoint: 'old' }]] });
    state.values.set('secret-race-plugin', { revision: 1, value: { token: 'old-secret' } });
    await expect(
      pluginConfig(
        'secret-race-plugin',
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: textSecretDescriptor() }),
          prompts: {
            ...state.deps.prompts,
            input: async () => {
              state.values.set('secret-race-plugin', { revision: 2, value: { token: 'new-secret' } });
              return 'new-public';
            },
            password: async () => '',
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginConfigChangedError);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([['secret-race-plugin', { endpoint: 'old' }]]);
    expect(state.values.get('secret-race-plugin')?.value).toEqual({ token: 'new-secret' });
  });
});
