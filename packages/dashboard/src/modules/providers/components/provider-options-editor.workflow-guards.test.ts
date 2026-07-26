import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from '../hooks/use-provider-options-schema';

describe('provider options schema workflow generation guards', () => {
  test('async completions for an old package are ignored', () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: 'checking' as const,
      committedPackage: '@ai-sdk/google',
      commitGeneration: 1,
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 1,
        status: { trusted: true, state: 'installed' },
      }),
    ).toBe(current);
    expect(
      providerOptionsSchemaTransition(current, {
        type: 'install_failed',
        packageName: '@ai-sdk/openai',
        generation: 1,
        errorCode: 'install_failed',
      }),
    ).toBe(current);
  });

  test('same-package recommit increments generation and restarts status synchronization', () => {
    const committed = providerOptionsSchemaTransition(
      {
        ...initialProviderOptionsSchemaState,
        phase: 'ready',
        committedPackage: '@ai-sdk/openai',
        commitGeneration: 3,
        schemaPackage: '@ai-sdk/openai',
        schema: { type: 'object' },
      },
      { type: 'package_committed', packageName: '@ai-sdk/openai' },
    );

    expect(committed).toMatchObject({
      phase: 'checking',
      committedPackage: '@ai-sdk/openai',
      commitGeneration: 4,
      schemaResolution: 'ready',
    });
    expect(committed.schema).toBeDefined();
  });

  test('same-package completions from an older generation are ignored', () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: 'checking' as const,
      committedPackage: '@ai-sdk/openai',
      commitGeneration: 2,
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 1,
        status: { trusted: true, state: 'installed' },
      }),
    ).toBe(current);

    const installing = { ...current, phase: 'installing' as const };
    expect(
      providerOptionsSchemaTransition(installing, {
        type: 'install_succeeded',
        packageName: '@ai-sdk/openai',
        generation: 1,
      }),
    ).toBe(installing);
  });

  test('phase-inappropriate completions are ignored', () => {
    const current = {
      ...initialProviderOptionsSchemaState,
      phase: 'ready' as const,
      committedPackage: '@ai-sdk/openai',
      commitGeneration: 1,
      schemaPackage: '@ai-sdk/openai',
      schema: { type: 'object' },
    };

    expect(
      providerOptionsSchemaTransition(current, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 1,
        status: { trusted: true, state: 'missing' },
      }),
    ).toBe(current);
  });
});
