import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { definePlugin } from '@aio-proxy/plugin-sdk';

import { PluginSetupValidationError, pluginAdd, pluginConfig } from './index';
import { createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin descriptor security setup', () => {
  test('setup validation failure is safely reported before config or secrets are committed', async () => {
    const state = scope.harness();
    const descriptor = definePlugin(() => {
      throw new Error('setup contained secret-value');
    });
    const result = pluginAdd(
      'hanging-plugin',
      { yes: true },
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
      },
    );
    await expect(result).rejects.toBeInstanceOf(PluginSetupValidationError);
    await expect(result).rejects.not.toThrow('secret-value');
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([]);
    expect(state.values.size).toBe(0);
  });

  test.each(['add', 'config'] as const)(
    '%s isolates staged setup options from committed public and secret values',
    async (command) => {
      const sentinel = `${command}-setup-secret-sentinel`;
      const setupMutation = `${command}-setup-mutated-secret`;
      let setupCompleted = false;
      const descriptor = definePlugin(
        (_api, value) => {
          const options = value as { settings: { nested: { value: string } }; token: { value: string } };
          const capturedSecret = options.token.value;
          options.settings.nested.value = capturedSecret;
          Object.defineProperty(options.settings, 'toJSON', { value: () => capturedSecret });
          options.token.value = setupMutation;
          setupCompleted = true;
        },
        {
          options: {
            schema: {
              safeParse() {},
              async safeParseAsync(value: unknown) {
                const options = value as { settings: { nested: { value: string } }; token: string | { value: string } };
                return {
                  success: true,
                  data: {
                    settings: options.settings,
                    token: typeof options.token === 'string' ? { value: options.token } : options.token,
                  },
                };
              },
            } as never,
            form: [
              { type: 'json', key: 'settings', label: 'Settings' },
              { type: 'secret', key: 'token', label: 'Token' },
            ],
          },
        },
      );
      const packageName = `${command}-setup-isolation-plugin`;
      const state =
        command === 'add'
          ? scope.harness()
          : scope.harness({
              providers: {},
              plugins: [[packageName, { settings: { nested: { value: 'old-public' } } }]],
            });
      if (command === 'config') {
        state.values.set(packageName, { revision: 1, value: { token: { value: 'old-secret' } } });
      }
      const deps = {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => '{"nested":{"value":"safe-public"}}',
          password: async () => sentinel,
        },
      };
      if (command === 'add') await pluginAdd(packageName, { yes: true }, deps);
      else await pluginConfig(packageName, {}, deps);
      expect(setupCompleted).toBe(true);
      const configText = readFileSync(state.path, 'utf8');
      expect(configText).not.toContain(sentinel);
      expect(configText).not.toContain(setupMutation);
      expect(JSON.parse(configText).plugins).toEqual([
        [packageName, { settings: { nested: { value: 'safe-public' } } }],
      ]);
      expect(state.values.get(packageName)?.value).toEqual({ token: { value: sentinel } });
    },
  );
});
