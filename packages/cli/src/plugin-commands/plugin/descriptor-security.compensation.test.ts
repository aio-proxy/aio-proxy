import { afterEach, describe, expect, test } from 'bun:test';

import { configFacade, configureSecret, createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin descriptor security compensation', () => {
  test('failed config write restores the prior secret when its applied revision is current', async () => {
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'old' } });
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      throw new Error('config failed');
    });
    await expect(configureSecret(state, config)).rejects.toThrow('config failed');
    expect(state.values.get('secret-plugin')?.value).toEqual({ token: 'old' });
  });

  test('failed config compensation surfaces storage errors while its revision is still current', async () => {
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'old' } });
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      throw new Error('config failed');
    });
    let writes = 0;
    const repository = {
      ...state.deps.repository,
      writePluginSecret(plugin: string, expectedRevision: number | null, value: unknown) {
        writes += 1;
        if (writes === 2) throw new Error('rollback storage failed');
        return state.deps.repository.writePluginSecret(plugin, expectedRevision, value);
      },
    };
    await expect(configureSecret(state, config, repository)).rejects.toThrow('rollback storage failed');
  });
});
