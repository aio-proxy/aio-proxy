import { afterEach, describe, expect, test } from 'bun:test';

import {
  AccountCleanupPendingError,
  OAuthProxyUnsupportedError,
  ProviderAccountAlreadyExistsError,
  ProviderFingerprintMismatchError,
  ProviderIdCollisionError,
} from '@aio-proxy/core';

import { ProviderCapabilityMismatchError, ProviderCapabilityNotFoundError, providerLogin } from './index';
import { createProviderLoginTestScope } from './test-support';

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe('provider login safe presentation', () => {
  test('uses localized capability and target errors with safe identifiers', async () => {
    expect(new ProviderCapabilityNotFoundError('missing').message).toBe('OAuth capability missing was not found');
    expect(new ProviderCapabilityMismatchError('@a/one#unique', '@b/two#default').message).toBe(
      'Requested capability @a/one#unique does not match provider capability @b/two#default',
    );
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new AccountCleanupPendingError('target');
      },
    };
    await expect(providerLogin('unique', {}, state.deps)).rejects.toThrow('Provider target is pending account cleanup');
  });

  test('localizes exhausted Provider ID collisions with the safe candidate', async () => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderIdCollisionError('person-deadbeef');
      },
    };
    await expect(providerLogin('unique', {}, state.deps)).rejects.toThrow(
      'Unable to allocate a unique provider ID for person-deadbeef',
    );
  });

  test('duplicate account rebuilds canonical guidance without printing it early', async () => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderAccountAlreadyExistsError('existing');
      },
    };
    await expect(providerLogin('unique', {}, state.deps)).rejects.toThrow(
      'An account is already configured as provider existing. Run aio-proxy provider login --provider existing to re-login',
    );
    expect(state.printed).toEqual([]);
  });

  test('does not print a mutable suggested command before top-level safe rendering', async () => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        const error = new ProviderAccountAlreadyExistsError('existing');
        Object.defineProperty(error, 'suggestedCommand', { value: 'secret extension command' });
        throw error;
      },
    };
    await expect(providerLogin('unique', {}, state.deps)).rejects.toBeInstanceOf(Error);
    expect(state.printed).toEqual([]);
  });

  test('fingerprint mismatch is localized while the account service owns rollback', async () => {
    const state = scope.fixture({ kind: 'oauth', plugin: '@a/one', capability: 'unique', enabled: true });
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderFingerprintMismatchError('target');
      },
    };
    await expect(providerLogin(undefined, { provider: 'target' }, state.deps)).rejects.toThrow(
      'The authenticated account does not match provider target',
    );
    expect(state.printed).toEqual([]);
  });

  test('localizes proxy rejection without exposing a proxy URL', async () => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new OAuthProxyUnsupportedError('@a/one', 'unique');
      },
    };

    await expect(providerLogin('unique', {}, state.deps)).rejects.toThrow(
      'OAuth capability @a/one#unique does not support the configured proxy',
    );
  });
});
