import { afterEach, describe, expect, test } from 'bun:test';

import { BuiltInPluginRemovalError, PluginSecretPurgeConflictError, pluginPrune, pluginRemove } from './index';
import { createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin prune and non-interactive purge', () => {
  test('--yes permits non-interactive secret purge', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'remove' } });
    await pluginRemove('third-party-plugin', { purgeSecrets: true, yes: true }, { ...state.deps, isTTY: false });
    expect(state.values.has('third-party-plugin')).toBe(false);
  });

  test('purge reports a conflict when a concurrent secret update wins', async () => {
    const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
    state.values.set('third-party-plugin', { revision: 1, value: { token: 'old' } });
    await expect(
      pluginRemove(
        'third-party-plugin',
        { purgeSecrets: true, yes: true },
        {
          ...state.deps,
          repository: {
            ...state.deps.repository,
            deletePluginSecret(plugin, expectedRevision) {
              state.values.set(plugin, { revision: expectedRevision + 1, value: { token: 'new' } });
              return false;
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginSecretPurgeConflictError);
    expect(state.values.get('third-party-plugin')?.value).toEqual({ token: 'new' });
    expect(state.lines.join('\n')).not.toContain('purged');
  });

  test('built-ins cannot be removed', async () => {
    const { deps } = scope.harness();
    await expect(pluginRemove('@aio-proxy/plugin-github-copilot', { yes: true }, deps)).rejects.toBeInstanceOf(
      BuiltInPluginRemovalError,
    );
  });

  test('prune conservatively keeps plugin and raw ai-sdk package names', async () => {
    const { deps } = scope.harness({
      plugins: ['@aio-proxy/plugin-github-copilot', ['used-plugin', { anything: true }]],
      providers: {
        broken: { kind: 'ai-sdk', package: 'used-provider', options: 'malformed-but-package-still-counts' },
        legacyUpper: { kind: 'ai-sdk', package: 'Legacy-Provider' },
        invalidName: { kind: 'ai-sdk', packageName: '../malformed' },
        api: { kind: 'api', package: 'not-an-ai-sdk-package' },
      },
    });
    const removed: string[] = [];
    const packages = [
      'used-plugin',
      '@aio-proxy/plugin-github-copilot',
      'used-provider',
      'Legacy-Provider',
      '../malformed',
      'not-an-ai-sdk-package',
      'unused-package',
    ];
    await pluginPrune(
      { yes: true },
      {
        ...deps,
        listInstalledNpmPackages: async () =>
          packages.map((packageName) => ({
            packageName,
            version: '1',
            entrypoint: '/tmp/x',
            cacheDir: `/tmp/${packageName}`,
          })),
        removeNpmPackageCache: async (packageName) => {
          removed.push(packageName);
          return true;
        },
      },
    );
    expect(removed).toEqual([
      '@aio-proxy/plugin-github-copilot',
      '../malformed',
      'not-an-ai-sdk-package',
      'unused-package',
    ]);
  });

  test('prune rechecks config under the package lifecycle lock before removal', async () => {
    const state = scope.harness({ providers: {}, plugins: [] });
    let removed = false;
    await pluginPrune(
      { yes: true },
      {
        ...state.deps,
        listInstalledNpmPackages: async () => [
          { packageName: 'racing-plugin', version: '1.0.0', entrypoint: '/tmp/racing.js', cacheDir: '/tmp/cache' },
        ],
        removeNpmPackageCache: async (_packageName, canRemove) => {
          await state.config.replace((current) => ({ ...current, plugins: ['racing-plugin'] }));
          removed = (await canRemove?.()) ?? true;
          return removed;
        },
      },
    );
    expect(removed).toBe(false);
  });
});
