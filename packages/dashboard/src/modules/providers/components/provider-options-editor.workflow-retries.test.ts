import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from '../hooks/use-provider-options-schema';

describe('provider options schema workflow retries', () => {
  test('retrying a deferred trusted install starts a fresh automatic attempt', () => {
    const initialCommit = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai',
      allowAutomaticInstall: false,
    });
    const deferred = providerOptionsSchemaTransition(initialCommit, {
      type: 'status_loaded',
      packageName: '@ai-sdk/openai',
      generation: 1,
      status: { trusted: true, state: 'missing' },
    });
    const retry = providerOptionsSchemaTransition(deferred, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai',
      allowAutomaticInstall: true,
    });

    expect(retry).toMatchObject({
      phase: 'checking',
      committedPackage: '@ai-sdk/openai',
      commitGeneration: 2,
    });
    expect(
      providerOptionsSchemaTransition(retry, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 2,
        status: { trusted: true, state: 'missing' },
      }),
    ).toMatchObject({ phase: 'installing', effect: { type: 'install', confirmed: false } });
  });

  test('retrying a failed untrusted install returns to confirmation before reinstalling', () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: 'community-provider',
    });
    const required = providerOptionsSchemaTransition(committed, {
      type: 'status_loaded',
      packageName: 'community-provider',
      generation: 1,
      status: { trusted: false, state: 'missing' },
    });
    const installing = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(required, { type: 'install_confirmed' }),
      { type: 'install_started' },
    );
    const failed = providerOptionsSchemaTransition(installing, {
      type: 'install_failed',
      packageName: 'community-provider',
      generation: 1,
      errorCode: 'install_failed',
    });
    const retry = providerOptionsSchemaTransition(failed, {
      type: 'package_committed',
      packageName: 'community-provider',
      allowAutomaticInstall: true,
    });
    const retryRequired = providerOptionsSchemaTransition(retry, {
      type: 'status_loaded',
      packageName: 'community-provider',
      generation: 2,
      status: { trusted: false, state: 'missing' },
    });

    expect(retry).toMatchObject({ phase: 'checking', commitGeneration: 2 });
    expect(retryRequired).toMatchObject({ phase: 'install_required', effect: undefined });
    expect(providerOptionsSchemaTransition(retryRequired, { type: 'install_confirmed' })).toMatchObject({
      phase: 'installing',
      effect: { type: 'install', confirmed: true },
    });
  });

  test('retry ignores completions from the previous install generation', () => {
    const retry = providerOptionsSchemaTransition(
      {
        ...initialProviderOptionsSchemaState,
        phase: 'install_error',
        committedPackage: '@ai-sdk/openai',
        commitGeneration: 1,
        errorCode: 'install_failed',
      },
      { type: 'package_committed', packageName: '@ai-sdk/openai', allowAutomaticInstall: true },
    );

    expect(
      providerOptionsSchemaTransition(retry, {
        type: 'install_succeeded',
        packageName: '@ai-sdk/openai',
        generation: 1,
      }),
    ).toBe(retry);
  });
});
