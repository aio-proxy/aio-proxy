import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireProcessFileLock, AtomicConfigFile } from '@aio-proxy/core';

import { CliExit } from '../../exit';
import { inspectProxyKeys } from '../codex';
import {
  buildClaudeCodeSetupPlan,
  configureClaudeCode,
  configureClaudeCodeAgent,
  listClaudeCode,
  removeClaudeCode,
  resolveClaudeCodeLocation,
  type ClaudeCodeDeps,
} from './claude-code';
import { configureClaudeCodeSettings, removeClaudeCodeSettings } from './managed-settings';

const ENDPOINT = 'http://127.0.0.1:9317';
const PLACEHOLDER = 'aio-proxy-local';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ProxyKey = { readonly key: string; readonly label?: string };

async function fixture(
  options: {
    readonly settings?: unknown;
    readonly apiKeys?: readonly ProxyKey[];
    readonly check?: 'ok' | 'offline' | 'unauthorized';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'aio-claude-code-'));
  roots.push(root);
  const location = resolveClaudeCodeLocation({ CLAUDE_CONFIG_DIR: join(root, 'claude') });
  const proxyConfig = join(root, 'config.json');
  const setKeys = (apiKeys: readonly ProxyKey[]) =>
    Bun.write(proxyConfig, JSON.stringify({ providers: {}, server: { apiKeys } }));
  await setKeys(options.apiKeys ?? []);
  const write = async (settings: unknown): Promise<void> => {
    await mkdir(location.home, { recursive: true });
    await Bun.write(location.settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings));
  };
  if (options.settings !== undefined) await write(options.settings);
  const probed: string[] = [];
  const deps: ClaudeCodeDeps = {
    location,
    detected: () => true,
    resolveEndpoint: async () => ENDPOINT,
    // The real static-config credential rule, against a throwaway proxy config.
    inspectKeys: () =>
      inspectProxyKeys({
        file: new AtomicConfigFile(proxyConfig),
        loadEnvironment() {},
        readEnvironment: () => ({}),
        check: async () => options.check ?? 'ok',
      }),
    probe: async (_endpoint, token) => {
      probed.push(token);
      return 'ok';
    },
  };
  const read = async (): Promise<Record<string, unknown>> => JSON.parse(await Bun.file(location.settingsPath).text());
  const exists = (): Promise<boolean> => Bun.file(location.settingsPath).exists();
  return { location, deps, write, read, exists, setKeys, probed };
}

const noKey = async () => ({ kind: 'none' }) as const;
const firstKey = async (choices: readonly { readonly id: string }[]) =>
  ({ kind: 'existing', id: choices[0]!.id }) as const;

test('without proxy keys a placeholder token is written next to the endpoint', async () => {
  const f = await fixture();
  const result = await configureClaudeCodeAgent(f.deps);
  expect(result).toMatchObject({ status: 'configured', credential: 'placeholder', baseUrl: ENDPOINT });
  expect(await f.read()).toEqual({ env: { ANTHROPIC_BASE_URL: ENDPOINT, ANTHROPIC_AUTH_TOKEN: PLACEHOLDER } });
  expect((await stat(f.location.settingsPath)).mode & 0o777).toBe(0o600);
  expect(await listClaudeCode(false, ENDPOINT, f.deps)).toMatchObject({ status: 'managed', endpointMatches: true });
});

test('configure merges into existing settings and keeps unrelated keys and env entries', async () => {
  const settings = {
    permissions: { allow: ['Bash(git status)'] },
    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example' },
    model: 'opus',
  };
  const f = await fixture({ settings });
  await configureClaudeCode(noKey, f.deps);
  expect(await f.read()).toEqual({
    ...settings,
    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: ENDPOINT, ANTHROPIC_AUTH_TOKEN: PLACEHOLDER },
  });
  expect(Object.keys(await f.read())).toEqual(['permissions', 'env', 'model']);
  expect((await configureClaudeCode(noKey, f.deps)).status).toBe('unchanged');
});

test('remove undoes only the managed keys and restores what they replaced', async () => {
  const settings = { env: { DISABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example' }, model: 'opus' };
  const f = await fixture({ settings });
  await configureClaudeCode(noKey, f.deps);
  // Claude Code and the user both keep writing this file after configure.
  await f.write({ ...(await f.read()), theme: 'dark' });
  expect(await removeClaudeCode(f.deps)).toMatchObject({ status: 'removed', preservedPaths: [] });
  expect(await f.read()).toEqual({ ...settings, theme: 'dark' });
  expect(await Bun.file(f.location.markerPath).exists()).toBe(false);
  expect((await listClaudeCode(false, ENDPOINT, f.deps)).status).toBe('absent');
  expect((await removeClaudeCode(f.deps)).status).toBe('absent');
});

test('remove drops an env block it created and leaves the rest of the file', async () => {
  const f = await fixture({ settings: { model: 'opus' } });
  await configureClaudeCode(noKey, f.deps);
  await removeClaudeCode(f.deps);
  expect(await f.read()).toEqual({ model: 'opus' });
});

test('ownership survives Claude Code rewriting the file in its own format', async () => {
  const f = await fixture({ settings: { model: 'opus' } });
  await configureClaudeCode(noKey, f.deps);
  const { env, ...rest } = await f.read();
  await f.write(JSON.stringify({ env, ...rest, alwaysThinkingEnabled: true }, null, 4));
  expect((await listClaudeCode(false, ENDPOINT, f.deps)).status).toBe('managed');
  await removeClaudeCode(f.deps);
  expect(await f.read()).toEqual({ model: 'opus', alwaysThinkingEnabled: true });
});

test('a managed key the user edited is neither overwritten by configure nor reverted by remove', async () => {
  const f = await fixture();
  await configureClaudeCode(noKey, f.deps);
  await f.write({ env: { ANTHROPIC_BASE_URL: ENDPOINT, ANTHROPIC_AUTH_TOKEN: 'my-own-token' } });
  expect(await listClaudeCode(false, ENDPOINT, f.deps)).toMatchObject({
    status: 'modified',
    changedPaths: ['env.ANTHROPIC_AUTH_TOKEN'],
  });
  await expect(configureClaudeCode(noKey, f.deps)).rejects.toThrow(
    'Claude Code managed fields changed: env.ANTHROPIC_AUTH_TOKEN',
  );
  expect(await removeClaudeCode(f.deps)).toMatchObject({
    status: 'partial',
    preservedPaths: ['env.ANTHROPIC_AUTH_TOKEN'],
  });
  expect(await f.read()).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: 'my-own-token' } });
});

test('a reconfigure interrupted before settings.json was written can be finished or removed', async () => {
  const original = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' }, model: 'opus' };
  const f = await fixture({ settings: original });
  await configureClaudeCode(noKey, f.deps);
  const configured = await f.read();
  const crash = () =>
    configureClaudeCodeSettings(
      f.location,
      { endpoint: 'http://127.0.0.1:9400', token: 'aio-proxy-other', credential: 'placeholder' },
      {
        afterMarker: async () => {
          throw new Error('crashed');
        },
      },
    );
  await expect(crash()).rejects.toThrow('crashed');
  expect(await f.read()).toEqual(configured);
  // The previous run's values are recognised as aio-proxy's own, not as user edits.
  expect((await configureClaudeCode(noKey, f.deps)).status).toBe('configured');
  expect(await f.read()).toEqual(configured);
  expect(await Bun.file(f.location.markerPath).text()).not.toContain('superseded');

  await expect(crash()).rejects.toThrow('crashed');
  expect(await removeClaudeCode(f.deps)).toMatchObject({ status: 'removed', preservedPaths: [] });
  expect(await f.read()).toEqual(original);
});

test('an overlapping configure that loses the settings race leaves the winner owning the file', async () => {
  const original = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' }, model: 'opus' };
  const f = await fixture({ settings: original });
  const input = (endpoint: string) => ({ endpoint, token: PLACEHOLDER, credential: 'placeholder' as const });
  // The second run starts after the first wrote its marker and finishes before the first writes settings.
  await expect(
    configureClaudeCodeSettings(f.location, input('http://127.0.0.1:9400'), {
      afterMarker: async () => {
        expect(await configureClaudeCodeSettings(f.location, input(ENDPOINT))).toBe('configured');
      },
    }),
  ).rejects.toThrow('changed during update');
  expect(await listClaudeCode(false, ENDPOINT, f.deps)).toMatchObject({ status: 'managed', endpointMatches: true });
  expect(await removeClaudeCode(f.deps)).toMatchObject({ status: 'removed' });
  expect(await f.read()).toEqual(original);
});

test('a configure that lands while remove is finishing keeps its ownership', async () => {
  const f = await fixture({ settings: { model: 'opus' } });
  await configureClaudeCode(noKey, f.deps);
  await removeClaudeCodeSettings(f.location, {
    afterSettings: async () => {
      expect((await configureClaudeCode(noKey, f.deps)).status).toBe('configured');
    },
  });
  expect(await listClaudeCode(false, ENDPOINT, f.deps)).toMatchObject({ status: 'managed' });
  await removeClaudeCode(f.deps);
  expect(await f.read()).toEqual({ model: 'opus' });
});

test('concurrent configure runs are serialized so the marker always matches the settings', async () => {
  const original = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' }, model: 'opus' };
  const f = await fixture({ settings: original });
  const other = { ...f.deps, resolveEndpoint: async () => 'http://127.0.0.1:9400' };
  const results = await Promise.allSettled([configureClaudeCode(noKey, f.deps), configureClaudeCode(noKey, other)]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const settings = await f.read();
  const listed = await listClaudeCode(
    false,
    String((settings['env'] as Record<string, unknown>)['ANTHROPIC_BASE_URL']),
    f.deps,
  );
  expect(listed).toMatchObject({ status: 'managed', endpointMatches: true });
  expect(await removeClaudeCode(f.deps)).toMatchObject({ status: 'removed' });
  expect(await f.read()).toEqual(original);
  expect(await Bun.file(join(f.location.home, '.aio-proxy.lock')).exists()).toBe(false);
});

test('removing an integration that was never configured creates nothing', async () => {
  const f = await fixture();
  expect((await removeClaudeCode(f.deps)).status).toBe('absent');
  expect(await stat(f.location.home).catch(() => undefined)).toBeUndefined();
});

test('configure writes nothing if the proxy address changed while the key was being chosen', async () => {
  const f = await fixture({ settings: { model: 'opus' } });
  const endpoints = [ENDPOINT, 'http://127.0.0.1:9400'];
  const moved = { ...f.deps, resolveEndpoint: async () => endpoints.shift() ?? ENDPOINT };
  await expect(configureClaudeCode(noKey, moved)).rejects.toThrow('CLAUDE_CODE_ENDPOINT_CHANGED');
  expect(await f.read()).toEqual({ model: 'opus' });
  expect(await Bun.file(f.location.markerPath).exists()).toBe(false);
});

test('a key removed while configure waits for the settings lock is not written', async () => {
  const f = await fixture({ apiKeys: [{ key: 'sk-old' }] });
  const lock = await acquireProcessFileLock(join(f.location.home, '.aio-proxy.lock'));
  const pending = configureClaudeCode(firstKey, f.deps);
  // The choice is made; the key list then changes before the write can start.
  await Bun.sleep(50);
  await f.setKeys([{ key: 'sk-new' }]);
  await lock.release();
  await expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_SELECTION_STALE' });
  expect(await f.exists()).toBe(false);
});

test('with proxy keys and no way to choose one, configure fails instead of writing a bare endpoint', async () => {
  const f = await fixture({ settings: { model: 'opus' }, apiKeys: [{ key: 'sk-live', label: 'Laptop' }] });
  // bun test has no TTY, so the terminal entry cannot ask.
  await expect(configureClaudeCodeAgent(f.deps)).rejects.toBeInstanceOf(CliExit);
  await expect(configureClaudeCode(noKey, f.deps)).rejects.toMatchObject({ code: 'CREDENTIAL_NO_SELECTION' });
  expect(await f.read()).toEqual({ model: 'opus' });
  expect(await Bun.file(f.location.markerPath).exists()).toBe(false);
});

test('a chosen proxy key is written privately as the token and never copied into the sidecar or the list', async () => {
  const f = await fixture({ settings: {}, apiKeys: [{ key: 'sk-live-secret', label: 'Laptop' }] });
  await chmod(f.location.settingsPath, 0o644);
  expect(await buildClaudeCodeSetupPlan(f.deps)).toMatchObject({ keyChoices: [{ label: 'Laptop' }] });
  const result = await configureClaudeCode(firstKey, f.deps);
  expect(result).toMatchObject({ credential: 'existing', connection: 'ok' });
  expect(await f.read()).toEqual({ env: { ANTHROPIC_BASE_URL: ENDPOINT, ANTHROPIC_AUTH_TOKEN: 'sk-live-secret' } });
  expect((await stat(f.location.settingsPath)).mode & 0o777).toBe(0o600);
  const listed = await listClaudeCode(true, ENDPOINT, f.deps);
  expect(listed).toMatchObject({ status: 'managed', credential: 'existing', connection: 'ok' });
  expect(f.probed).toEqual(['sk-live-secret']);
  expect(`${JSON.stringify([result, listed])}${await Bun.file(f.location.markerPath).text()}`).not.toContain(
    'sk-live-secret',
  );
});

test('a key the proxy rejects is not saved', async () => {
  const f = await fixture({ apiKeys: [{ key: 'sk-revoked' }], check: 'unauthorized' });
  await expect(configureClaudeCode(firstKey, f.deps)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAUTHORIZED' });
  expect(await f.exists()).toBe(false);
});

test('a key list that changed after the choice was offered invalidates the choice', async () => {
  const f = await fixture({ apiKeys: [{ key: 'sk-old' }] });
  const stale = async (choices: readonly { readonly id: string }[]) => {
    await f.setKeys([{ key: 'sk-new' }]);
    return firstKey(choices);
  };
  await expect(configureClaudeCode(stale, f.deps)).rejects.toMatchObject({ code: 'CREDENTIAL_SELECTION_STALE' });
  expect(await f.exists()).toBe(false);
});

test('configure refuses a missing host, unparseable settings, and a symlinked settings file', async () => {
  const missing = await fixture();
  await expect(configureClaudeCode(noKey, { ...missing.deps, detected: () => false })).rejects.toThrow(
    'claude-code is not installed',
  );
  expect(await missing.exists()).toBe(false);

  const broken = await fixture({ settings: '{ "model": "opus", // comment\n}' });
  await expect(configureClaudeCode(noKey, broken.deps)).rejects.toThrow();
  expect(await Bun.file(broken.location.settingsPath).text()).toContain('// comment');

  const linked = await fixture();
  const dotfiles = join(linked.location.home, '..', 'dotfiles-settings.json');
  await Bun.write(dotfiles, '{"model":"opus"}');
  await mkdir(linked.location.home, { recursive: true });
  await symlink(dotfiles, linked.location.settingsPath);
  await expect(configureClaudeCode(noKey, linked.deps)).rejects.toMatchObject({ code: 'ELOOP' });
  expect(await Bun.file(dotfiles).text()).toBe('{"model":"opus"}');
});

test('the location is the global Claude Code config directory', () => {
  expect(resolveClaudeCodeLocation({}, '/home/u').settingsPath).toBe('/home/u/.claude/settings.json');
  expect(resolveClaudeCodeLocation({ CLAUDE_CONFIG_DIR: '~/cc' }, '/home/u').settingsPath).toBe(
    '/home/u/cc/settings.json',
  );
  expect(() => resolveClaudeCodeLocation({ CLAUDE_CONFIG_DIR: 'relative/dir' }, '/home/u')).toThrow();
});
