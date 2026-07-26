import { describe, expect, test } from '@rstest/core';

import {
  canConfirmProviderInstall,
  canRequestProviderInstall,
  isProviderOptionsObject,
  providerOptionsAreValid,
} from './provider-options-editor';

describe('provider options editor', () => {
  test('accepts only undefined or a plain object at the provider options root', () => {
    expect(isProviderOptionsObject(undefined)).toBe(true);
    expect(isProviderOptionsObject({})).toBe(true);
    expect(isProviderOptionsObject({ baseURL: 'https://example.com' })).toBe(true);
    expect(isProviderOptionsObject([])).toBe(false);
    expect(isProviderOptionsObject(null)).toBe(false);
    expect(isProviderOptionsObject(true)).toBe(false);
    expect(isProviderOptionsObject(42)).toBe(false);
    expect(isProviderOptionsObject('value')).toBe(false);
  });

  test('blocks pending schema workflow phases but allows warning and unavailable fallbacks', () => {
    const validNoSchema = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    const invalidNoSchema = { ...validNoSchema, valid: false };

    expect(providerOptionsAreValid(true, validNoSchema, 'idle', undefined, 'unknown')).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, 'checking', undefined, 'unknown')).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, 'installing', undefined, 'unavailable')).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, 'install_required', undefined, 'unavailable')).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, 'ready', undefined, 'ready')).toBe(false);
    expect(providerOptionsAreValid(true, validNoSchema, 'schema_unavailable', undefined, 'unavailable')).toBe(true);
    expect(providerOptionsAreValid(true, validNoSchema, 'install_error', undefined, 'unavailable')).toBe(true);
    expect(providerOptionsAreValid(false, validNoSchema, 'schema_unavailable', undefined, 'unavailable')).toBe(false);
    expect(providerOptionsAreValid(true, invalidNoSchema, 'schema_unavailable', undefined, 'unavailable')).toBe(false);
  });

  test('blocks ready until validation belongs to the loaded schema', () => {
    const schema = { type: 'object' };
    const oldValidation = { valid: true, syntaxValid: true, pending: false, markers: [], schema: undefined };
    const currentValidation = { ...oldValidation, schema };

    expect(providerOptionsAreValid(true, oldValidation, 'ready', schema, 'ready')).toBe(false);
    expect(providerOptionsAreValid(true, currentValidation, 'ready', schema, 'ready')).toBe(true);
  });

  test('blank options are invalid when the loaded schema requires root fields', () => {
    const schema = { type: 'object', required: ['name', 'baseURL'] };
    const optionalSchema = { type: 'object', required: [] };
    const validation = { valid: true, syntaxValid: true, pending: false, markers: [], schema };

    expect(providerOptionsAreValid(true, validation, 'ready', schema, 'ready', undefined)).toBe(false);
    expect(providerOptionsAreValid(true, validation, 'ready', schema, 'ready', {})).toBe(true);
    expect(
      providerOptionsAreValid(
        true,
        { ...validation, schema: optionalSchema },
        'ready',
        optionalSchema,
        'ready',
        undefined,
      ),
    ).toBe(true);
  });

  test('only confirms the install-required package currently bound to the dialog', () => {
    expect(canConfirmProviderInstall('community-provider', 'install_required', 'community-provider')).toBe(true);
    expect(canConfirmProviderInstall('old-provider', 'install_required', 'new-provider')).toBe(false);
    expect(canConfirmProviderInstall('community-provider', 'checking', 'community-provider')).toBe(false);
    expect(canConfirmProviderInstall(null, 'install_required', 'community-provider')).toBe(false);
  });

  test('deferred and failed installs expose an explicit retry action', () => {
    expect(canRequestProviderInstall('install_required')).toBe(true);
    expect(canRequestProviderInstall('install_deferred')).toBe(true);
    expect(canRequestProviderInstall('install_error')).toBe(true);
    expect(canRequestProviderInstall('installing')).toBe(false);
  });
});
