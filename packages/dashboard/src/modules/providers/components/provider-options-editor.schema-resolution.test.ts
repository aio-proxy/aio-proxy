import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from '../hooks/use-provider-options-schema';
import { providerOptionsAreValid } from './provider-options-editor';

describe('provider options editor schema resolution', () => {
  test('commits resolve the local catalog schema immediately', () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai-compatible',
    });
    expect(committed).toMatchObject({
      phase: 'checking',
      schemaResolution: 'ready',
      schemaPackage: '@ai-sdk/openai-compatible',
    });
    expect(committed.schema).toBeDefined();

    const unknown = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@vendor/custom-provider',
    });
    expect(unknown).toMatchObject({
      phase: 'checking',
      schemaResolution: 'unavailable',
      schema: undefined,
      schemaPackage: null,
    });
  });

  test('keeps embedded schema resolution independent from a failed trusted install', () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai-compatible',
    });
    expect(committed).toMatchObject({ phase: 'checking', schemaResolution: 'ready' });
    expect(committed.schema).toBeDefined();

    const missing = providerOptionsSchemaTransition(committed, {
      type: 'status_loaded',
      packageName: '@ai-sdk/openai-compatible',
      generation: 1,
      status: { trusted: true, state: 'missing' },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: 'install_started' });
    const failed = providerOptionsSchemaTransition(installing, {
      type: 'install_failed',
      packageName: '@ai-sdk/openai-compatible',
      generation: 1,
      errorCode: 'install_failed',
    });

    expect(failed).toMatchObject({ phase: 'install_error', schemaResolution: 'ready', errorCode: 'install_failed' });
    expect(failed.schema).toBeDefined();

    const schemaError = {
      valid: false,
      syntaxValid: true,
      pending: false,
      markers: [{ severity: 'error' as const }],
      schema: failed.schema,
    };
    const schemaValid = { ...schemaError, valid: true, markers: [] };

    expect(providerOptionsAreValid(true, schemaError, failed.phase, failed.schema, failed.schemaResolution)).toBe(
      false,
    );
    expect(providerOptionsAreValid(true, schemaValid, failed.phase, failed.schema, failed.schemaResolution, {})).toBe(
      true,
    );
  });

  test('blocks status failures including invalid package names', () => {
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    for (const errorCode of ['request_failed', 'invalid_package_name']) {
      const packageName = errorCode === 'invalid_package_name' ? '../bad' : '@ai-sdk/example';
      const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
        type: 'package_committed',
        packageName,
      });
      const failed = providerOptionsSchemaTransition(committed, {
        type: 'status_failed',
        packageName,
        generation: 1,
        errorCode,
      });

      expect(failed).toMatchObject({ phase: 'status_error', schemaResolution: 'error', errorCode });
      expect(providerOptionsAreValid(true, validNoSchema, failed.phase, failed.schema, failed.schemaResolution)).toBe(
        false,
      );
    }
  });

  test('allows schema-less fallback after a failed install only once unavailability is explicit', () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@vendor/custom-provider',
    });
    expect(committed).toMatchObject({ phase: 'checking', schemaResolution: 'unavailable', schema: undefined });

    const missing = providerOptionsSchemaTransition(committed, {
      type: 'status_loaded',
      packageName: '@vendor/custom-provider',
      generation: 1,
      status: { trusted: true, state: 'missing' },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: 'install_started' });
    const failed = providerOptionsSchemaTransition(installing, {
      type: 'install_failed',
      packageName: '@vendor/custom-provider',
      generation: 1,
      errorCode: 'install_failed',
    });
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };

    expect(failed).toMatchObject({
      phase: 'install_error',
      schemaResolution: 'unavailable',
      errorCode: 'install_failed',
    });
    expect(providerOptionsAreValid(true, validNoSchema, failed.phase, failed.schema, failed.schemaResolution)).toBe(
      true,
    );
  });
});
