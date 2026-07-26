import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from '../hooks/use-provider-options-schema';
import { commitProviderPackageOnce } from './provider-form-fields-ai-sdk';

describe('provider options editor package commits', () => {
  test('routine package commits ignore StrictMode and Enter-then-blur repeats', () => {
    const committed = { current: null as string | null };
    const packages: string[] = [];
    const commit = (packageName: string) => packages.push(packageName);

    expect(commitProviderPackageOnce('@ai-sdk/openai', committed, commit)).toBe(true);
    expect(commitProviderPackageOnce('@ai-sdk/openai', committed, commit)).toBe(false);
    expect(packages).toEqual(['@ai-sdk/openai']);

    committed.current = null;
    expect(commitProviderPackageOnce('@ai-sdk/openai', committed, commit)).toBe(true);
    expect(packages).toEqual(['@ai-sdk/openai', '@ai-sdk/openai']);
  });

  test('initial package synchronization checks without authorizing trusted auto-install', () => {
    const initialCommit = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai',
      allowAutomaticInstall: false,
    });
    const initialMissing = providerOptionsSchemaTransition(initialCommit, {
      type: 'status_loaded',
      packageName: '@ai-sdk/openai',
      generation: 1,
      status: { trusted: true, state: 'missing' },
    });

    expect(initialMissing).toMatchObject({ phase: 'install_deferred', effect: undefined });

    const userCommit = providerOptionsSchemaTransition(initialMissing, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai',
      allowAutomaticInstall: true,
    });
    expect(
      providerOptionsSchemaTransition(userCommit, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 2,
        status: { trusted: true, state: 'missing' },
      }),
    ).toMatchObject({ phase: 'installing', effect: { type: 'install', confirmed: false } });
  });
});
