import { afterEach, describe, expect, test } from 'bun:test';

import { ProviderCapabilityAmbiguousError, providerLogin } from './index';
import { createProviderLoginTestScope, registry } from './test-support';

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe('provider login capability resolution', () => {
  const builtIns = [
    '@aio-proxy/plugin-github-copilot',
    '@aio-proxy/plugin-openai-chatgpt',
    '@aio-proxy/plugin-google-antigravity',
    '@aio-proxy/plugin-kimi-code',
  ] as const;

  test('resolves an unambiguous short capability ID', async () => {
    const state = scope.fixture();
    await providerLogin('unique', {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@a/one', capability: 'unique' } });
  });

  test.each(builtIns)('resolves exact built-in package %s to its default capability', async (plugin) => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      registry: registry(builtIns.map((packageName) => [packageName, ['default']] as const)),
    };

    await providerLogin(plugin, {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin, capability: 'default' } });
  });

  test('uses the sole non-default capability for an exact package', async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, registry: registry([['@single/plugin', ['unique']]]) };

    await providerLogin('@single/plugin', {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@single/plugin', capability: 'unique' } });
  });

  test('prefers the default capability for an exact package', async () => {
    const state = scope.fixture();

    await providerLogin('@a/one', {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@a/one', capability: 'default' } });
  });

  test('keeps an exact package with multiple non-default capabilities explicit', async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, registry: registry([['@multi/plugin', ['alpha', 'beta']]]) };

    await expect(providerLogin('@multi/plugin', {}, state.deps)).rejects.toMatchObject({
      message: 'OAuth capability @multi/plugin is ambiguous. Choose one of: @multi/plugin#alpha, @multi/plugin#beta',
    });
  });

  test('limits interactive package selection to that package', async () => {
    const state = scope.fixture();
    let references: readonly string[] = [];
    state.deps = {
      ...state.deps,
      registry: registry([
        ['@multi/plugin', ['alpha', 'beta']],
        ['@other/plugin', ['alpha']],
      ]),
      isTTY: true,
      selectCapability: async (choices) => {
        references = choices.map(({ reference }) => reference);
        return '@multi/plugin#beta';
      },
    };

    await providerLogin('@multi/plugin', {}, state.deps);

    expect(references).toEqual(['@multi/plugin#alpha', '@multi/plugin#beta']);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@multi/plugin', capability: 'beta' } });
  });

  test('rejects an unknown exact package', async () => {
    const state = scope.fixture();

    await expect(providerLogin('@missing/plugin', {}, state.deps)).rejects.toMatchObject({
      message: 'OAuth capability @missing/plugin was not found',
    });
  });

  test('lists canonical ambiguity choices in non-interactive mode', async () => {
    const state = scope.fixture();
    await expect(providerLogin('default', {}, state.deps)).rejects.toMatchObject({
      name: 'ProviderLoginPresentationError',
      message: 'OAuth capability default is ambiguous. Choose one of: @a/one#default, @b/two#default',
    });
    expect(new ProviderCapabilityAmbiguousError('default', ['@a/one#default']).references).toEqual(['@a/one#default']);
  });

  test('uses interactive selection when omitted or ambiguous', async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, isTTY: true, selectCapability: async () => '@b/two#default' };
    await providerLogin(undefined, {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: '@b/two', capability: 'default' } });
  });
});
