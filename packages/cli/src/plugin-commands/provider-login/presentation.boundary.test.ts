import { afterEach, describe, expect, test } from 'bun:test';

import { createPluginRegistryHost, ProviderAccountAlreadyExistsError } from '@aio-proxy/core';

import { formatCliError } from '../../main';
import { LoopbackPortUnavailableError } from '../loopback';
import { isProviderLoginUserError, providerLogin } from './index';
import { adapter, createProviderLoginTestScope } from './test-support';

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe('provider login adapter boundary', () => {
  test('contains a forged core error thrown by the OAuth adapter boundary', async () => {
    const host = createPluginRegistryHost();
    const staging = host.stage('@evil/plugin');
    staging.api.oauth.register({
      ...adapter('default'),
      async login() {
        const error = new ProviderAccountAlreadyExistsError('existing');
        Object.defineProperties(error, {
          existingProviderId: { value: 'secret provider', configurable: true },
          suggestedCommand: { value: 'secret extension command', configurable: true },
        });
        error.message = 'secret extension message';
        throw error;
      },
    });
    staging.seal();
    staging.commit();
    const state = scope.fixture();
    const { login: _login, ...withoutInjectedLogin } = state.deps;
    state.deps = { ...withoutInjectedLogin, registry: host.registry };
    let thrown: unknown;
    try {
      await providerLogin('@evil/plugin#default', {}, state.deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'OAuthAuthorizationFailedError',
      message: 'AUTHORIZATION_FAILED',
      code: 'AUTHORIZATION_FAILED',
      reason: 'oauth_adapter',
    });
    expect(isProviderLoginUserError(thrown)).toBe(false);
    expect(state.printed).toEqual([]);
  });

  test('preserves a host loopback failure at the account-login boundary', async () => {
    const host = createPluginRegistryHost();
    const staging = host.stage('@host/login');
    staging.api.oauth.register({
      ...adapter('default'),
      async login(context) {
        try {
          await context.authorization.loopback({
            state: 'state',
            redirect: { hostname: '127.0.0.1', port: 1455, path: '/callback' },
            authorizationUrl: ({ redirectUri }) => `https://example.com/authorize?redirect_uri=${redirectUri}`,
            allowManualCallbackUrl: false,
          });
        } catch (error) {
          if (error instanceof Error) {
            error.name = 'ForgedHostError';
            error.message = 'forged host message';
          }
          throw error;
        }
        throw new Error('unreachable');
      },
    });
    staging.seal();
    staging.commit();
    const state = scope.fixture();
    const { login: _login, ...withoutInjectedLogin } = state.deps;
    state.deps = {
      ...withoutInjectedLogin,
      registry: host.registry,
      createAuthorization: () => ({
        async presentDeviceCode() {},
        async presentAuthorizeUrl() {},
        async loopback() {
          throw new LoopbackPortUnavailableError(1455);
        },
      }),
    };
    let thrown: unknown;
    try {
      await providerLogin('@host/login#default', {}, state.deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LoopbackPortUnavailableError);
    expect(thrown).toMatchObject({ port: 1455 });
    expect(formatCliError(thrown, 'en').message).toBe('The local callback listener could not use port 1455');
  });
});
