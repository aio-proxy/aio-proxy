import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';

import { PluginSecretPurgeConflictError, pluginRemove } from './index';
import { createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin remove and purge confirmation', () => {
  test('remove preserves secrets by default and purge uses a second confirmation after config success', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'keep' } });
    await pluginRemove('third-party-plugin', { yes: true }, state.deps);
    expect(state.values.get('third-party-plugin')?.value).toEqual({ token: 'keep' });
    writeFileSync(state.path, JSON.stringify({ providers: {}, plugins: ['third-party-plugin'] }));
    let confirmations = 0;
    await pluginRemove(
      'third-party-plugin',
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          return true;
        },
      },
    );
    expect(confirmations).toBe(2);
    expect(state.values.has('third-party-plugin')).toBe(false);
  });

  test('declining the post-remove purge keeps secrets and reports retention', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'keep' } });
    let confirmations = 0;
    await pluginRemove(
      'third-party-plugin',
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          if (confirmations === 2) {
            expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([]);
            return false;
          }
          return true;
        },
      },
    );
    expect(state.values.get('third-party-plugin')?.value).toEqual({ token: 'keep' });
    expect(state.lines.join('\n')).toContain('retained');
  });

  test('purge snapshots the secret revision only after the second confirmation', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'old' } });
    let confirmations = 0;
    await pluginRemove(
      'third-party-plugin',
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          if (confirmations === 2) {
            state.values.set('third-party-plugin', { revision: 2, value: { token: 'new' } });
          }
          return true;
        },
      },
    );
    expect(state.values.has('third-party-plugin')).toBe(false);
  });

  test('purge preserves credentials when the plugin is re-added during the second confirmation', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'old' } });
    let confirmations = 0;
    await expect(
      pluginRemove(
        'third-party-plugin',
        { purgeSecrets: true },
        {
          ...state.deps,
          confirm: async () => {
            confirmations += 1;
            if (confirmations === 2) {
              writeFileSync(state.path, JSON.stringify({ providers: {}, plugins: ['third-party-plugin'] }));
              state.values.set('third-party-plugin', { revision: 2, value: { token: 're-added' } });
            }
            return true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginSecretPurgeConflictError);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual(['third-party-plugin']);
    expect(state.values.get('third-party-plugin')?.value).toEqual({ token: 're-added' });
  });
});
