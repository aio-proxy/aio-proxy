import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { definePlugin } from '@aio-proxy/plugin-sdk';

import { PluginDescriptorInvalidError, type PluginLifecycleDeps, pluginAdd } from './index';
import { createPluginTestScope, descriptorWithForm } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin add forms', () => {
  test('add orders trust before npm/import and failed import leaves plugins unchanged', async () => {
    const { deps, path } = scope.harness();
    const events: string[] = [];
    await expect(
      pluginAdd(
        'third-party-plugin',
        {},
        {
          ...deps,
          confirm: async () => {
            events.push('trust');
            return true;
          },
          npmAdd: async () => {
            events.push('npm');
            return { version: '1.0.0', entrypoint: '/tmp/plugin.js' };
          },
          importPackage: async () => {
            events.push('import');
            throw new Error('bad import');
          },
        },
      ),
    ).rejects.toThrow('bad import');
    expect(events).toEqual(['trust', 'npm', 'import']);
    expect(JSON.parse(readFileSync(path, 'utf8')).plugins).toEqual([]);
  });

  test('add times out a hanging import, releases its lifecycle lock, and ignores late resolution', async () => {
    const state = scope.harness();
    let resolveImport!: (value: unknown) => void;
    const imported = new Promise<unknown>((resolve) => {
      resolveImport = resolve;
    });
    let released = false;
    const command = pluginAdd('hanging-add-plugin', { yes: true }, {
      ...state.deps,
      importTimeoutMs: 20,
      importPackage: async () => imported,
      withInstalledNpmPackage: async (_packageName, _registry, use) => {
        try {
          return await use({ version: '1.0.0', entrypoint: '/tmp/plugin.js' }, async () => {});
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
    const releasedBeforeLateResolution = released;
    const configBeforeLateResolution = JSON.parse(readFileSync(state.path, 'utf8'));
    const secretsBeforeLateResolution = state.values.size;
    resolveImport({ default: definePlugin(() => {}) });
    await command.catch(() => {});
    await Bun.sleep(0);
    expect(outcome).toBeInstanceOf(PluginDescriptorInvalidError);
    expect(releasedBeforeLateResolution).toBe(true);
    expect(configBeforeLateResolution.plugins).toEqual([]);
    expect(secretsBeforeLateResolution).toBe(0);
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([]);
    expect(state.values.size).toBe(0);
  });

  test('add maps a malformed descriptor ConfigSpec to a localized descriptor error', async () => {
    const state = scope.harness();
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: { safeParse() {}, async safeParseAsync() {} } as never,
        form: [{ type: 'text', key: '', label: 'Invalid' }],
      },
    });
    await expect(
      pluginAdd(
        'invalid-config-plugin',
        { yes: true },
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
        },
      ),
    ).rejects.toBeInstanceOf(PluginDescriptorInvalidError);
    expect(JSON.parse(readFileSync(state.path, 'utf8')).plugins).toEqual([]);
  });

  test('add writes string form without options and tuple form with public options', async () => {
    const empty = scope.harness();
    await pluginAdd('empty-plugin', { yes: true }, empty.deps);
    expect(JSON.parse(readFileSync(empty.path, 'utf8')).plugins).toEqual(['empty-plugin']);
    const configured = scope.harness();
    const descriptor = descriptorWithForm([{ type: 'text', key: 'endpoint', label: 'Endpoint' }]);
    await pluginAdd(
      'configured-plugin',
      { yes: true },
      {
        ...configured.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...configured.deps.prompts, input: async () => 'https://example.test' },
      },
    );
    expect(JSON.parse(readFileSync(configured.path, 'utf8')).plugins).toEqual([
      ['configured-plugin', { endpoint: 'https://example.test' }],
    ]);
  });
});
