import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
  providerStatusRefetchEvent,
} from '../hooks/use-provider-options-schema';
import { ProviderPackageRequestError } from '../services/provider-options-schema-service';

describe('provider options schema workflow install flow', () => {
  test('fresh status errors win over cached status data', () => {
    expect(
      providerStatusRefetchEvent('@ai-sdk/openai', 2, {
        data: { npm: '@ai-sdk/openai', trusted: true, state: 'installed' },
        error: new ProviderPackageRequestError(502, 'status_upstream_failed'),
      }),
    ).toEqual({
      type: 'status_failed',
      packageName: '@ai-sdk/openai',
      generation: 2,
      errorCode: 'status_upstream_failed',
    });
  });

  test('package change clears schema before the next commit', () => {
    expect(
      providerOptionsSchemaTransition(
        {
          ...initialProviderOptionsSchemaState,
          phase: 'ready',
          committedPackage: '@ai-sdk/openai',
          schemaPackage: '@ai-sdk/openai',
          schema: { type: 'object' },
          commitGeneration: 1,
        },
        { type: 'package_changed', packageName: '@ai-sdk/google' },
      ),
    ).toMatchObject({ phase: 'idle', committedPackage: null, schemaPackage: null, schema: undefined });
  });

  test('trusted missing packages request automatic install', () => {
    expect(
      providerOptionsSchemaTransition(
        {
          ...initialProviderOptionsSchemaState,
          phase: 'checking',
          committedPackage: '@ai-sdk/google',
          allowAutomaticInstall: true,
        },
        {
          type: 'status_loaded',
          packageName: '@ai-sdk/google',
          generation: 0,
          status: { trusted: true, state: 'missing' },
        },
      ),
    ).toMatchObject({ phase: 'installing', effect: { type: 'install', confirmed: false } });
  });

  test('untrusted missing packages wait for an explicit install request', () => {
    const required = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: 'package_committed',
        packageName: 'community-provider',
      }),
      {
        type: 'status_loaded',
        packageName: 'community-provider',
        generation: 1,
        status: { trusted: false, state: 'missing' },
      },
    );

    expect(required).toMatchObject({ phase: 'install_required', effect: undefined });
    const confirmed = providerOptionsSchemaTransition(required, {
      type: 'install_requested',
      registry: 'https://registry.corp.example/',
    });
    expect(confirmed).toMatchObject({
      phase: 'installing',
      commitGeneration: 2,
      effect: { type: 'install', confirmed: true, registry: 'https://registry.corp.example/' },
    });
    expect(providerOptionsSchemaTransition(confirmed, { type: 'install_started' })).toMatchObject({
      effect: undefined,
      automaticInstallAttempted: false,
    });
  });

  test('schema availability is independent of package install state', () => {
    const installedWithSchema = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: 'package_committed',
        packageName: '@ai-sdk/openai-compatible',
      }),
      {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai-compatible',
        generation: 1,
        status: { trusted: false, state: 'installed' },
      },
    );
    const installedWithoutSchema = providerOptionsSchemaTransition(
      providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: 'package_committed',
        packageName: '@vendor/custom-provider',
      }),
      {
        type: 'status_loaded',
        packageName: '@vendor/custom-provider',
        generation: 1,
        status: { trusted: true, state: 'installed' },
      },
    );

    expect(installedWithSchema.phase).toBe('ready');
    expect(installedWithoutSchema.phase).toBe('schema_unavailable');
  });
});
