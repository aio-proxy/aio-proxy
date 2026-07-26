import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultPluginLifecycleDeps,
  createPluginConfirmation,
  PluginConfirmationRequiredError,
  type PluginLifecycleDeps,
  pluginAdd,
} from './index';
import { createPluginTestScope } from './test-support';

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe('plugin add', () => {
  test('default plugin lifecycle dependencies bind embedded built-ins', () => {
    const deps = createDefaultPluginLifecycleDeps();
    try {
      expect(deps.builtIns?.map(({ packageName }) => packageName).sort()).toEqual([
        '@aio-proxy/plugin-github-copilot',
        '@aio-proxy/plugin-google-antigravity',
        '@aio-proxy/plugin-kimi-code',
        '@aio-proxy/plugin-openai-chatgpt',
        '@aio-proxy/plugin-xai-grok',
      ]);
    } finally {
      deps.close?.();
    }
  });

  test('plugin trust and destructive confirmation defaults to no', async () => {
    let observed: { readonly message: string; readonly default?: boolean } | undefined;
    const confirm = createPluginConfirmation(async (config) => {
      observed = config;
      return false;
    });
    await expect(confirm('Trust this plugin?')).resolves.toBe(false);
    expect(observed).toEqual({ message: 'Trust this plugin?', default: false });
  });

  test('non-interactive refusal and built-in add do not create config, database, or package cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-plugin-cli-'));
    scope.trackHome(home);
    let defaultDeps: PluginLifecycleDeps | undefined;
    const previousHome = process.env.AIO_PROXY_HOME;
    const previousLog = console.log;
    process.env.AIO_PROXY_HOME = home;
    console.log = () => {};
    try {
      defaultDeps = createDefaultPluginLifecycleDeps();
      const nonInteractiveDeps = { ...defaultDeps, isTTY: false };
      await expect(pluginAdd('third-party-plugin', {}, nonInteractiveDeps)).rejects.toBeInstanceOf(
        PluginConfirmationRequiredError,
      );
      expect(existsSync(join(home, 'aio-proxy.db'))).toBe(false);
      expect(existsSync(join(home, 'config.jsonc'))).toBe(false);
      expect(existsSync(join(home, 'packages'))).toBe(false);
      await pluginAdd('@aio-proxy/plugin-github-copilot', {}, nonInteractiveDeps);
      expect(existsSync(join(home, 'aio-proxy.db'))).toBe(false);
      expect(existsSync(join(home, 'config.jsonc'))).toBe(false);
      expect(existsSync(join(home, 'packages'))).toBe(false);
    } finally {
      defaultDeps?.close?.();
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      console.log = previousLog;
    }
  });

  test('add refuses non-TTY without --yes and built-ins are npm-free no-ops', async () => {
    const { deps, lines } = scope.harness();
    await expect(pluginAdd('third-party-plugin', {}, { ...deps, isTTY: false })).rejects.toBeInstanceOf(
      PluginConfirmationRequiredError,
    );
    let npmCalls = 0;
    await pluginAdd(
      '@aio-proxy/plugin-github-copilot',
      {},
      {
        ...deps,
        npmAdd: async () => {
          npmCalls += 1;
          throw new Error('must not install');
        },
      },
    );
    expect(npmCalls).toBe(0);
    expect(lines.join('\n')).toContain('already built in');
  });
});
