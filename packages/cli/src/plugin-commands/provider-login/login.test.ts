import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AccountCleanupPendingError,
  type AtomicConfigFile,
  createPluginRegistryHost,
  createPluginRepository,
  OAuthLocalSignInStaleError,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { setLocale } from '@aio-proxy/i18n';
import { type OAuthAdapter, zod } from '@aio-proxy/plugin-sdk';

import { buildProgram, formatCliError } from '../../main';
import { PromptRequiresTtyError, type CommandSession, type PluginFormPrompts } from '../../ui';
import * as providerLoginDeps from './deps';
import { createProviderLoginDefaultDeps, isProviderLoginUserError, providerLogin } from './index';
import { adapter, createProviderLoginTestScope } from './test-support';

const scope = createProviderLoginTestScope();
const stores: { root: string; handle: ReturnType<typeof openDb> }[] = [];
beforeEach(() => setLocale('en'));
afterEach(scope.cleanup);
afterEach(() => {
  for (const { root, handle } of stores.splice(0)) {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function localFixture(detected = true, visibleFields = false) {
  const state = scope.fixture();
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-local-sign-in-'));
  const handle = openDb({ home: root });
  stores.push({ root, handle });
  const path = join(root, 'host-sign-in.json');
  writeFileSync(path, JSON.stringify({ token: 'temporary-host-token' }), { mode: 0o600 });
  const detect = mock(async () => detected && existsSync(path));
  const read = mock(async () => ({
    fingerprint: 'local-person',
    suggestedKey: 'local-person',
    credentials: JSON.parse(readFileSync(path, 'utf8')) as { token: string },
  }));
  const login = mock(async () => ({
    fingerprint: 'browser-person',
    suggestedKey: 'browser-person',
    credentials: { token: 'temporary-browser-token' },
  }));
  const localAdapter: OAuthAdapter = {
    ...adapter('default'),
    account: {
      options: {
        schema: visibleFields ? zod.object({ deployment: zod.string() }) : zod.object({}),
        form: visibleFields ? [{ type: 'text', key: 'deployment', label: 'Deployment' }] : [],
      },
    },
    localSignIn: { source: { default: 'Example tool', 'zh-Hans': '示例工具' }, detect, read },
    login,
  };
  const host = createPluginRegistryHost();
  const staging = host.stage('@local/tool');
  staging.api.oauth.register(localAdapter);
  staging.seal();
  staging.commit();
  const { login: _login, ...deps } = state.deps;
  const selectMethod = mock(async (): Promise<'local' | 'browser'> => 'local');
  const renderAccountOptions = mock(deps.renderAccountOptions);
  const createAuthorization = mock(deps.createAuthorization);
  state.deps = {
    ...deps,
    registry: host.registry,
    repository: createPluginRepository(handle.sqlite),
    selectMethod,
    renderAccountOptions,
    createAuthorization,
  };
  return { state, detect, read, login, selectMethod, renderAccountOptions, createAuthorization };
}

describe('provider login orchestration', () => {
  test('accepts canonical references and persists canonical plugin/capability', async () => {
    const state = scope.fixture();
    await providerLogin('@a/one#unique', {}, state.deps);
    expect(state.calls[0]).toBe('recover');
    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@a/one', capability: 'unique' } });
    expect(state.printed).toEqual(['created']);
  });

  test('--provider infers the structured canonical capability and explicit mismatch fails', async () => {
    const provider = { kind: 'oauth', plugin: '@a/one', capability: 'unique', enabled: true };
    const state = scope.fixture(provider);
    await providerLogin(undefined, { provider: 'target' }, state.deps);
    expect(state.calls[1]).toMatchObject({
      targetProviderId: 'target',
      capability: { plugin: '@a/one', capability: 'unique' },
    });
    await expect(providerLogin('@b/two#default', { provider: 'target' }, state.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'Requested capability @b/two#default does not match provider capability @a/one#unique',
    });
  });

  test('distinguishes missing, invalid, and cleanup-pending provider targets', async () => {
    const state = scope.fixture();
    await expect(providerLogin(undefined, { provider: 'target' }, state.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'OAuth provider target was not found',
    });
    const invalid = scope.fixture({ kind: 'api', protocol: 'openai-compatible' });
    await expect(providerLogin(undefined, { provider: 'target' }, invalid.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'Provider target is not a valid OAuth provider',
    });
    const pending = scope.fixture({ kind: 'oauth', plugin: '@a/one', capability: 'unique', enabled: true });
    pending.deps = {
      ...pending.deps,
      login: async () => {
        throw new AccountCleanupPendingError('target');
      },
    };
    await expect(providerLogin(undefined, { provider: 'target' }, pending.deps)).rejects.toThrow(
      'Provider target is pending account cleanup',
    );
    await expect(providerLogin('@missing/pkg#default', {}, state.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'OAuth capability @missing/pkg#default was not found',
    });
    const unavailable = scope.fixture({ kind: 'oauth', plugin: '@missing/pkg', capability: 'default', enabled: true });
    await expect(providerLogin(undefined, { provider: 'target' }, unavailable.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'OAuth capability @missing/pkg#default was not found',
    });
  });

  test('default dependency creation closes SQLite when registry loading fails', async () => {
    let closes = 0;
    await expect(
      createProviderLoginDefaultDeps({
        config: { read: async () => ({ plugins: [], providers: {} }) } as AtomicConfigFile,
        openDatabase: () => ({ sqlite: {}, close: () => (closes += 1) }) as never,
        createRepository: () => ({ readPluginSecret: () => null }) as never,
        loadRegistry: async () => {
          throw new Error('setup failed');
        },
      }),
    ).rejects.toThrow('setup failed');
    expect(closes).toBe(1);
  });
});

describe('provider login local sign-in', () => {
  test('--local-sign-in is parsed alongside the existing Provider ID option', () => {
    const program = buildProgram();
    const command = program.commands
      .find((entry) => entry.name() === 'provider')
      ?.commands.find((entry) => entry.name() === 'login');
    expect(command).toBeDefined();
    command!.parseOptions(['--local-sign-in', '--provider', 'target']);
    expect(command!.opts()).toMatchObject({ localSignIn: true, provider: 'target' });
  });

  test('--local-sign-in links without creating authorization and skips the method question', async () => {
    const f = localFixture();
    f.state.deps = { ...f.state.deps, isTTY: true };
    await providerLogin('@local/tool#default', { localSignIn: true }, f.state.deps);
    expect(f.state.printed).toEqual(['local-person']);
    expect(f.state.deps.repository.readAccount('local-person')).toMatchObject({ localSignIn: {} });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.login).not.toHaveBeenCalled();
    expect(f.createAuthorization).not.toHaveBeenCalled();
    expect(f.selectMethod).not.toHaveBeenCalled();
    // Core performs its own availability check; CLI must not add another one for the flag.
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.renderAccountOptions).toHaveBeenCalledTimes(1);
  });

  test('TTY method prompt appears only when detect is true', async () => {
    for (const detected of [true, false]) {
      const f = localFixture(detected);
      f.state.deps = { ...f.state.deps, isTTY: true };
      await providerLogin('@local/tool#default', {}, f.state.deps);
      expect(f.selectMethod).toHaveBeenCalledTimes(detected ? 1 : 0);
      expect(f.read).toHaveBeenCalledTimes(detected ? 1 : 0);
      expect(f.login).toHaveBeenCalledTimes(detected ? 0 : 1);
      expect(f.detect).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
      expect(f.state.printed).toEqual([detected ? 'local-person' : 'browser-person']);
    }
  });

  test('choosing browser never reads the local sign-in', async () => {
    const f = localFixture();
    f.selectMethod.mockImplementation(async () => 'browser');
    f.state.deps = { ...f.state.deps, isTTY: true };
    await providerLogin('@local/tool#default', {}, f.state.deps);
    expect(f.selectMethod).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.login).toHaveBeenCalledTimes(1);
    expect(f.state.printed).toEqual(['browser-person']);
  });

  test('non-TTY without the flag never calls detect', async () => {
    const f = localFixture();
    await providerLogin('@local/tool#default', {}, f.state.deps);
    expect(f.detect).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.selectMethod).not.toHaveBeenCalled();
    expect(f.login).toHaveBeenCalledTimes(1);
  });

  test('TTY adapters without local sign-in keep browser login without a method prompt', async () => {
    const state = scope.fixture();
    const selectMethod = mock(async (): Promise<'browser'> => 'browser');
    state.deps = { ...state.deps, isTTY: true, selectMethod };
    await providerLogin('@a/one#unique', {}, state.deps);
    expect(selectMethod).not.toHaveBeenCalled();
    expect(state.printed).toEqual(['created']);
  });

  test('the method selector renders localized copy and uses the session prompts', async () => {
    await setLocale('zh-Hans');
    const f = localFixture();
    const select = mock(async () => 'local') as unknown as PluginFormPrompts['select'];
    f.state.deps = {
      ...f.state.deps,
      isTTY: true,
      openSession: () =>
        ({ prompts: { select }, finish: mock(() => true), close: mock(() => {}) }) as unknown as CommandSession,
    };
    await providerLogin('@local/tool#default', {}, f.state.deps);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '你想如何登录？',
        choices: expect.arrayContaining([
          { value: 'local', label: '使用本机上的 示例工具 登录' },
          { value: 'browser', label: '通过浏览器登录' },
        ]),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(f.selectMethod).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  test('default method selector displays the required English copy', async () => {
    const prompt = mock(async (): Promise<'local'> => 'local') as unknown as PluginFormPrompts['select'];
    const signal = new AbortController().signal;
    expect(await providerLoginDeps.createProviderLoginMethodSelector(prompt)('Example tool', signal)).toBe('local');
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'How do you want to sign in?',
        choices: expect.arrayContaining([
          { value: 'local', label: 'Use the Example tool sign-in on this machine' },
          { value: 'browser', label: 'Sign in with the browser' },
        ]),
      }),
      { signal },
    );
  });

  test('nothing detected prints the localized unavailable error', async () => {
    const f = localFixture(false);
    let failure: unknown;
    try {
      await providerLogin('@local/tool#default', { localSignIn: true }, f.state.deps);
    } catch (error) {
      failure = error;
    }
    expect(isProviderLoginUserError(failure)).toBe(true);
    expect(formatCliError(failure, 'en').message).toBe('No Example tool sign-in was found on this machine.');
    expect(f.read).not.toHaveBeenCalled();
    expect(f.createAuthorization).not.toHaveBeenCalled();
  });

  test('unavailable local sign-in without adapter support uses the generic message', async () => {
    const state = scope.fixture();
    const { login: _login, ...deps } = state.deps;
    await expect(providerLogin('@a/one#unique', { localSignIn: true }, deps)).rejects.toThrow(
      'No local sign-in was found on this machine.',
    );
  });

  test('invalid local sign-in is localized without exposing the adapter error', async () => {
    const f = localFixture();
    f.read.mockImplementation(async () => {
      throw new Error('temporary-secret-must-not-be-displayed');
    });
    let failure: unknown;
    try {
      await providerLogin('@local/tool#default', { localSignIn: true }, f.state.deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'The sign-in on this machine is invalid or incomplete. Sign in again in the vendor tool, then retry.',
    });
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).stack).not.toContain('temporary-secret-must-not-be-displayed');
  });

  test('stale local sign-in tells the user the next refresh repairs the vendor tool', async () => {
    const f = localFixture();
    f.state.deps = {
      ...f.state.deps,
      login: async () => {
        throw new OAuthLocalSignInStaleError();
      },
    };
    await expect(providerLogin('@local/tool#default', { localSignIn: true }, f.state.deps)).rejects.toThrow(
      'aio-proxy already holds a newer sign-in for this Provider; it will update the vendor tool on its next refresh.',
    );
  });

  test('--local-sign-in still requires a TTY for visible account fields', async () => {
    const f = localFixture(true, true);
    const deps = await createProviderLoginDefaultDeps({
      config: f.state.deps.config,
      openDatabase: () => ({ sqlite: {}, close: () => {} }) as never,
      createRepository: () => f.state.deps.repository,
      loadRegistry: async () => ({ registry: f.state.deps.registry }) as never,
    });
    try {
      expect(deps.isTTY).toBe(false);
      await expect(providerLogin('@local/tool#default', { localSignIn: true }, deps)).rejects.toBeInstanceOf(
        PromptRequiresTtyError,
      );
      expect(f.read).not.toHaveBeenCalled();
      expect(f.login).not.toHaveBeenCalled();
    } finally {
      deps.close?.();
    }
  });

  test('--local-sign-in can finish without a TTY when the account form is empty', async () => {
    const f = localFixture();
    await providerLogin('@local/tool#default', { localSignIn: true }, f.state.deps);
    expect(f.state.printed).toEqual(['local-person']);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.createAuthorization).not.toHaveBeenCalled();
  });
});
