import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { npmPackageCacheDir } from '@aio-proxy/core';
import { getLocale, setLocale } from '@aio-proxy/i18n';
import { definePlugin } from '@aio-proxy/plugin-sdk';

import { pluginList } from './index';
import { createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin list', () => {
  test('list includes built-ins and configured third parties without options or secrets', async () => {
    const secret = 'vault-secret-value';
    const { deps, lines, values } = scope.harness({
      providers: {},
      plugins: [['third-party-plugin', { endpoint: 'https://private.test' }]],
    });
    values.set('third-party-plugin', { revision: 1, value: { token: secret } });
    await pluginList({}, deps);
    const output = lines.join('\n');
    expect(output).toContain('@aio-proxy/plugin-github-copilot');
    expect(output).toContain('third-party-plugin');
    expect(output).not.toContain('private.test');
    expect(output).not.toContain(secret);
  });

  test('list resolves plugin metadata using the current locale while retaining canonical identity', async () => {
    const originalLocale = getLocale();
    const packageName = '@example/localized-list';
    const descriptor = definePlugin(() => {}, {
      label: { default: 'Localized plugin', 'zh-Hans': '本地化插件' },
      description: { default: 'English description', 'zh-Hans': '中文描述' },
    });
    const state = scope.harness({ providers: {}, plugins: [packageName] });
    try {
      await setLocale('zh-Hans');
      await pluginList(
        {},
        {
          ...state.deps,
          builtInNames: new Set([packageName]),
          builtIns: [{ packageName, version: 'built-in', descriptor }],
        },
      );
      expect(state.lines.join('\n')).toContain(`本地化插件 (${packageName})`);
      expect(state.lines.join('\n')).toContain('中文描述');
    } finally {
      await setLocale(originalLocale);
    }
  });

  test('production list imports a real cached ESM plugin from its file URL exactly once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-plugin-list-real-'));
    scope.trackHome(home);
    const packageName = `real-plugin-${crypto.randomUUID()}`;
    const previousHome = process.env.AIO_PROXY_HOME;
    const previousLog = console.log;
    const lines: string[] = [];
    process.env.AIO_PROXY_HOME = home;
    console.log = (line) => lines.push(String(line));
    try {
      writeFileSync(join(home, 'config.jsonc'), JSON.stringify({ providers: {}, plugins: [packageName] }));
      const packageDir = join(npmPackageCacheDir(packageName), 'node_modules', packageName);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }),
      );
      writeFileSync(
        join(packageDir, 'index.js'),
        'const brand = Symbol.for("@aio-proxy/plugin-sdk/descriptor/v1");\nexport default { [brand]: true, apiVersion: 1, metadata: {}, setup() {} };\n',
      );
      await pluginList({});
      expect(lines.join('\n')).toContain(`${packageName} configured`);
      expect(lines.join('\n')).not.toContain('failed');
    } finally {
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      console.log = previousLog;
    }
  });
});
