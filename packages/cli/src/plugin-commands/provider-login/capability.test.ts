import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@aio-proxy/i18n';

import { createCapabilitySelector, createManualOnlyConfirmation, providerLogin } from './index';
import { createProviderLoginTestScope } from './test-support';

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe('provider login capability prompts', () => {
  test('uses localized capability prompt copy', async () => {
    let message: string | undefined;
    const selectCapability = createCapabilitySelector(async (config) => {
      message = config.message;
      return config.choices[0]?.value ?? '';
    });
    await expect(selectCapability([{ reference: '@a/one#default', displayName: 'First account' }])).resolves.toBe(
      '@a/one#default',
    );
    expect(message).toBe('Select an OAuth capability');
  });

  test('uses localized capability display names for TTY choice names and canonical references for values', async () => {
    await setLocale('zh-Hans');
    let choices: readonly { readonly name: string; readonly value: string }[] = [];
    const selectCapability = createCapabilitySelector(async (config) => {
      choices = config.choices;
      return config.choices[0]?.value ?? '';
    });
    await expect(
      selectCapability([
        {
          reference: '@a/one#default',
          displayName: { default: 'Localized capability name', 'zh-Hans': '本地化功能名称' },
        },
      ] as never),
    ).resolves.toBe('@a/one#default');
    expect(choices).toEqual([{ name: '本地化功能名称', value: '@a/one#default' }]);
  });

  test('manual-only confirmation uses the login signal', async () => {
    const controller = new AbortController();
    let observedConfig: { readonly message: string; readonly default?: boolean } | undefined;
    let observedSignal: AbortSignal | undefined;
    const confirmManualOnly = createManualOnlyConfirmation(controller.signal, async (config, context) => {
      observedConfig = config;
      observedSignal = context?.signal;
      return true;
    });
    await expect(confirmManualOnly('http://127.0.0.1/callback')).resolves.toBe(true);
    expect(observedSignal).toBe(controller.signal);
    expect(observedConfig).toEqual({ message: 'http://127.0.0.1/callback', default: false });
  });

  test('resolves localized progress copy before printing', async () => {
    await setLocale('zh-Hans');
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        options.progress?.({ default: 'Waiting', 'zh-Hans': '等待中' });
        return { providerId: 'created' };
      },
    };
    await providerLogin('unique', {}, state.deps);
    expect(state.printed).toEqual(['等待中', 'created']);
  });

  test('contains malformed, accessor-backed, and throwing runtime progress copy', async () => {
    await setLocale('zh-Hans');
    let reads = 0;
    const accessor = { default: 'Default' };
    Object.defineProperty(accessor, 'zh-Hans', {
      enumerable: true,
      get() {
        reads += 1;
        return 'must not print';
      },
    });
    const throwing = new Proxy(
      { default: 'Default' },
      {
        get() {
          throw new Error('plugin getter failure');
        },
        getOwnPropertyDescriptor() {
          throw new Error('plugin descriptor failure');
        },
      },
    );
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        for (const value of [{ 'zh-Hans': 'missing default' }, accessor, throwing]) options.progress?.(value as never);
        return { providerId: 'created' };
      },
    };
    await expect(providerLogin('unique', {}, state.deps)).resolves.toBeUndefined();
    expect(state.printed).toEqual(['created']);
    expect(reads).toBe(0);
  });
});
