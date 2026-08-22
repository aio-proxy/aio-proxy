import { describe, expect, test } from 'bun:test';

import type { ZodType } from 'zod';

import * as dashboard from '../index';

const schema = (name: string): ZodType => {
  expect(dashboard).toHaveProperty(name);
  return Reflect.get(dashboard, name) as ZodType;
};

const routingNumber = { authored: 1.6, effective: 2, wasNormalized: true } as const;
const inheritedNumber = { effective: 1, wasNormalized: false } as const;

const readyProvider = {
  id: 'primary',
  name: 'Primary',
  kind: 'api',
  enabled: true,
  state: { status: 'ready' },
  defaults: {
    priority: { effective: 0, wasNormalized: false },
    weight: routingNumber,
  },
  override: { priority: { authored: 30, effective: 30, wasNormalized: false } },
  effective: {
    priority: 30,
    weight: 2,
    prioritySource: 'model',
    weightSource: 'provider',
    eligible: true,
    share: 1,
  },
} as const;

const model = {
  modelId: 'openai/gpt-5',
  revision: 'rev-1',
  baselineProviderIds: ['primary'],
  providerCount: 1,
  eligibleProviderCount: 1,
  hasOverrides: true,
  tiers: [{ priority: 30, providers: [{ providerId: 'primary', weight: 2, share: 1 }] }],
  providers: [readyProvider],
} as const;

describe('dashboard routing contracts', () => {
  test('parses a complete routing models response', () => {
    const response = schema('DashboardRoutingModelsResponseSchema');
    const value = { writable: true, models: [model] };

    expect(response.parse(value)).toEqual(value);
    expect(schema('DashboardRoutingNumberSchema').parse(inheritedNumber)).toEqual(inheritedNumber);
  });

  test('normalizes mutation overrides and requires unique baseline ids', () => {
    const mutation = schema('DashboardRoutingModelMutationSchema');
    const input = {
      modelId: 'openai/gpt-5',
      revision: 'rev-1',
      baselineProviderIds: ['primary', 'missing'],
      providers: {
        primary: { priority: 30 },
        missing: { weight: 0.6 },
      },
    };

    expect(mutation.parse(input)).toEqual({
      ...input,
      providers: { primary: { priority: 30 }, missing: { weight: 1 } },
    });
  });

  test('rejects empty overrides, duplicate baseline ids, and invalid routing numbers', () => {
    const mutation = schema('DashboardRoutingModelMutationSchema');
    const base = {
      modelId: 'openai/gpt-5',
      revision: 'rev-1',
      baselineProviderIds: ['primary'],
      providers: { primary: { priority: 30 } },
    };

    expect(mutation.safeParse({ ...base, providers: { primary: {} } }).success).toBe(false);
    expect(mutation.safeParse({ ...base, baselineProviderIds: ['primary', 'primary'] }).success).toBe(false);
    expect(mutation.safeParse({ ...base, providers: { primary: { priority: 1.5 } } }).success).toBe(false);
    expect(mutation.safeParse({ ...base, providers: { primary: { weight: '2' } } }).success).toBe(false);
  });

  test('enumerates routing mutation error codes', () => {
    const errorCode = schema('DashboardRoutingMutationErrorCodeSchema');

    expect(errorCode.parse('config_unavailable')).toBe('config_unavailable');
    expect(errorCode.parse('stale_revision')).toBe('stale_revision');
    expect(errorCode.parse('validation_failed')).toBe('validation_failed');
    expect(errorCode.safeParse('unknown').success).toBe(false);
  });
});
