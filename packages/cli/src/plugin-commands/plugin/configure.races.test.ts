import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  PluginDescriptorInvalidError,
  type PluginLifecycleDeps,
  PluginNotConfiguredError,
  pluginConfig,
} from './index';
import { createPluginTestScope, textDescriptor } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);
describe('plugin configure races', () => {
  test('config times out a hanging import, releases its lifecycle lock, and observes late rejection', async () => {
    const state = scope.harness({ providers: {}, plugins: ['hanging-config-plugin'] });
    let rejectImport!: (error: unknown) => void;
    const imported = new Promise<unknown>((_resolve, reject) => {
      rejectImport = reject;
    });
    let released = false;
    const command = pluginConfig('hanging-config-plugin', {}, {
      ...state.deps,
      importTimeoutMs: 20,
      importPackage: async () => imported,
      withNpmPackageLifecycle: async (_packageName, use) => {
        try {
          return await use(async () => {});
        } finally {
          released = true;
        }
      },
    } as PluginLifecycleDeps);
    const outcome = await Promise.race([
      command.then(
        () => 'resolved' as const,
        (error: unknown) => error,
      ),
      Bun.sleep(100).then(() => 'still-pending' as const),
    ]);
    const releasedBeforeLateRejection = released;
    const configBeforeLateRejection = JSON.parse(readFileSync(state.path, 'utf8'));
    const secretsBeforeLateRejection = state.values.size;
    rejectImport(new Error('late import rejection'));
    await command.catch(() => {});
    await Bun.sleep(0);
    expect(outcome).toBeInstanceOf(PluginDescriptorInvalidError);
    expect(releasedBeforeLateRejection).toBe(true);
    expect(configBeforeLateRejection.plugins).toEqual(['hanging-config-plugin']);
    expect(secretsBeforeLateRejection).toBe(0);
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual(['hanging-config-plugin']);
    expect(state.values.size).toBe(0);
  });
  test('config never revives a plugin removed while its prompt is open', async () => {
    const state = scope.harness({ providers: {}, plugins: [['racing-plugin', { endpoint: 'old' }]] });
    await expect(
      pluginConfig(
        'racing-plugin',
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: textDescriptor() }),
          prompts: {
            ...state.deps.prompts,
            input: async () => {
              await state.config.replace((current) => ({ ...current, plugins: [] }));
              return 'new';
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotConfiguredError);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([]);
  });
  test('config holds the installed package generation across import, prompt, staging, and commit', async () => {
    const state = scope.harness({ providers: {}, plugins: [['aba-plugin', { endpoint: 'old' }]] });
    let generation = 1;
    let tail = Promise.resolve();
    const lifecycle: NonNullable<PluginLifecycleDeps['withNpmPackageLifecycle']> = async (_packageName, use) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      try {
        return await use(async () => {});
      } finally {
        release();
      }
    };
    let replacement: Promise<void> | undefined;
    await pluginConfig(
      'aba-plugin',
      {},
      {
        ...state.deps,
        withNpmPackageLifecycle: lifecycle,
        findInstalledNpmPackage: async () => ({ version: '1', entrypoint: `/tmp/generation-${generation}.js` }),
        importPackage: async ({ entrypoint }) => {
          expect(entrypoint).toContain('generation-1.js');
          return { default: textDescriptor() };
        },
        prompts: {
          ...state.deps.prompts,
          input: async () => {
            replacement = lifecycle('aba-plugin', async () => {
              generation = 2;
              await state.config.replace((current) => ({ ...current, plugins: [] }));
              await state.config.replace((current) => ({ ...current, plugins: [['aba-plugin', { endpoint: 'old' }]] }));
            });
            await Bun.sleep(25);
            return 'stale-prompt-value';
          },
        },
      },
    );
    await replacement;
    expect(generation).toBe(2);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([['aba-plugin', { endpoint: 'old' }]]);
  });
});
