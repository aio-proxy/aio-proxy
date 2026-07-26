import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtomicConfigCommitUncertainError, type AtomicConfigLockReleaseError } from '@aio-proxy/core';

import { configFacade, configureSecret, createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);
describe('plugin configure secret compensation', () => {
  test('failed config write compensates only its own secret revision', async () => {
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'old' } });
    const realWrite = state.deps.repository.writePluginSecret.bind(state.deps.repository);
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      realWrite('secret-plugin', 2, { token: 'concurrent' });
      throw new Error('config failed');
    });
    await expect(configureSecret(state, config)).rejects.toThrow('config failed');
    expect(state.values.get('secret-plugin')).toEqual({ revision: 3, value: { token: 'concurrent' } });
  });
  test('an uncertain committed config never compensates its applied secret', async () => {
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'old' } });
    const config = configFacade(state, async (mutate) => {
      const { next } = await mutate(await state.deps.config.read());
      writeFileSync(state.path, `${JSON.stringify(next, null, 2)}\n`);
      throw new AtomicConfigCommitUncertainError();
    });
    await expect(configureSecret(state, config)).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
    expect(state.values.get('secret-plugin')?.value).toEqual({ token: 'new' });
    expect(JSON.parse(readFileSync(state.path, 'utf8'))).toEqual({ providers: {}, plugins: ['secret-plugin'] });
  });
  test('a committed config with release cleanup failure keeps its applied secret', async () => {
    const state = scope.harness({ providers: {}, plugins: ['secret-plugin'] });
    state.values.set('secret-plugin', { revision: 1, value: { token: 'old' } });
    const home = dirname(state.path);
    const config = configFacade(state, (mutate) =>
      state.deps.config.transaction(mutate, {
        async verify() {
          chmodSync(home, 0o500);
        },
      }),
    );
    try {
      await expect(configureSecret(state, config)).rejects.toMatchObject({
        name: 'AtomicConfigLockReleaseError',
        cause: { code: 'EACCES' },
      } satisfies Partial<AtomicConfigLockReleaseError>);
      expect(state.values.get('secret-plugin')?.value).toEqual({ token: 'new' });
      expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual(['secret-plugin']);
    } finally {
      chmodSync(home, 0o700);
    }
  });
});
