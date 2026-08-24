import { describe, expect, test } from 'bun:test';

import { digestProviderEntry, parseRuntimeConfig } from '@aio-proxy/core';
import type { ModelCatalog } from '@aio-proxy/plugin-sdk';
import {
  type Config,
  type DashboardProviderSummary,
  DashboardRoutingModelsResponseSchema,
  type ProviderState,
} from '@aio-proxy/types';

import { assembleRoutingInventory } from './inventory';

const unavailable: ProviderState = {
  status: 'unavailable',
  diagnostic: {
    code: 'CATALOG_UNAVAILABLE',
    summary: 'Catalog unavailable',
    retryable: true,
    occurredAt: '2026-08-22T00:00:00.000Z',
  },
};

function languageCatalog(...ids: string[]): ModelCatalog {
  return {
    language: ids.map((id) => ({ id })),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

const authoredRecord = {
  providers: {
    'disabled-api': {
      kind: 'api',
      enabled: false,
      protocol: 'openai-compatible',
      baseURL: 'https://api.example.test/v1',
      models: ['api-direct'],
      alias: { 'api-alias': { model: 'api-direct', preserve: true } },
      weight: 1.6,
    },
    'disabled-sdk': {
      kind: 'ai-sdk',
      enabled: false,
      packageName: '@ai-sdk/openai-compatible',
      models: ['sdk-direct'],
      alias: { 'sdk-alias': { model: 'sdk-direct' } },
      weight: 0,
    },
    'disabled-oauth': {
      kind: 'oauth',
      enabled: false,
      plugin: '@example/oauth',
      capability: 'default',
      alias: { 'oauth-alias': { model: 'oauth-kept', preserve: true } },
    },
    'unavailable-oauth': {
      kind: 'oauth',
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
      alias: { 'stale-alias': { model: 'gone-model' } },
    },
    'broken-oauth': {
      kind: 'oauth',
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
      alias: { 'broken-alias': { model: 'broken-target' } },
    },
    high: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://high.example.test/v1',
      models: ['shared'],
      priority: 20,
      weight: 3,
    },
    peer: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://peer.example.test/v1',
      models: ['shared'],
      priority: 20,
      weight: 1,
    },
    zero: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://zero.example.test/v1',
      models: ['shared', 'zero-only'],
      weight: 0,
    },
  },
  router: {
    models: {
      'api-alias': {
        providers: {
          'disabled-api': { priority: 30 },
          ghost: { weight: 5 },
        },
      },
      shared: {
        providers: {
          high: { weight: 3 },
          ghost: { priority: 99 },
        },
      },
      'unknown-model': {
        providers: { 'disabled-api': { priority: 1 } },
      },
    },
  },
} as const;

function summariesFrom(config: Config, states: Readonly<Record<string, ProviderState>>): DashboardProviderSummary[] {
  return config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    ...(provider.name === undefined ? {} : { name: provider.name }),
    priority: provider.priority,
    weight: provider.weight,
    clientModels: [],
    state: states[provider.id] ?? { status: 'ready' as const },
  }));
}

function catalogRepository() {
  return {
    readAccount(providerId: string) {
      if (providerId !== 'disabled-oauth') return null;
      return {
        providerId,
        plugin: '@example/oauth',
        capability: 'default',
        fingerprint: 'octocat@example.com',
        options: {},
        secrets: {},
        credential: {},
        revision: 1,
        runtimeRevision: 1,
        label: 'octocat',
        updatedAt: 1,
      };
    },
    readCatalog(providerId: string) {
      if (providerId === 'broken-oauth') throw new Error('catalog read failed');
      if (providerId === 'invalid-oauth') {
        return { catalog: { language: 'invalid' } as never, refreshedAt: 1 };
      }
      if (providerId === 'disabled-oauth') {
        return { catalog: languageCatalog('oauth-kept'), refreshedAt: 1 };
      }
      if (providerId === 'unavailable-oauth') {
        return { catalog: languageCatalog('oauth-current'), refreshedAt: 1 };
      }
      return null;
    },
  };
}

async function inventory(overrides: { readonly writable?: boolean } = {}) {
  const rawRecord = structuredClone(authoredRecord) as Record<string, unknown>;
  const config = parseRuntimeConfig(rawRecord);
  return assembleRoutingInventory({
    rawRecord,
    config,
    summaries: summariesFrom(config, {
      'unavailable-oauth': unavailable,
      'broken-oauth': unavailable,
    }),
    repository: catalogRepository(),
    writable: overrides.writable ?? true,
  });
}

function model(response: Awaited<ReturnType<typeof inventory>>, modelId: string) {
  const found = response.models.find((entry) => entry.modelId === modelId);
  expect(found).toBeDefined();
  return found!;
}

function provider(response: Awaited<ReturnType<typeof inventory>>, modelId: string, providerId: string) {
  const found = model(response, modelId).providers.find((entry) => entry.id === providerId);
  expect(found).toBeDefined();
  return found!;
}

describe('model routing inventory', () => {
  test('lists inactive API, AI SDK, and OAuth routes without runtime Providers', async () => {
    const response = DashboardRoutingModelsResponseSchema.parse(await inventory());
    const modelIds = response.models.map((entry) => entry.modelId);

    expect(modelIds).toContain('api-alias');
    expect(modelIds).toContain('api-direct');
    expect(modelIds).toContain('sdk-alias');
    expect(modelIds).not.toContain('sdk-direct');
    expect(modelIds).toContain('oauth-alias');
    expect(modelIds).toContain('oauth-kept');
    expect(modelIds).toContain('stale-alias');
    expect(modelIds).toContain('oauth-current');
    expect(modelIds).toContain('broken-alias');
    expect(modelIds).not.toContain('unknown-model');
    expect(modelIds).not.toContain('gone-model');

    expect(provider(response, 'api-alias', 'disabled-api')).toMatchObject({
      id: 'disabled-api',
      kind: 'api',
      enabled: false,
      state: { status: 'ready' },
      defaults: {
        priority: { effective: 0, wasNormalized: false },
        weight: { authored: 1.6, effective: 2, wasNormalized: true },
      },
      override: { priority: { authored: 30, effective: 30, wasNormalized: false } },
      effective: {
        priority: 30,
        weight: 2,
        prioritySource: 'model',
        weightSource: 'provider',
        eligible: false,
        share: null,
      },
    });
    expect(provider(response, 'api-alias', 'disabled-api').override).not.toHaveProperty('weight');
    expect(model(response, 'api-alias').providers.map((entry) => entry.id)).not.toContain('ghost');

    expect(provider(response, 'sdk-alias', 'disabled-sdk')).toMatchObject({
      enabled: false,
      defaults: { weight: { authored: 0, effective: 0, wasNormalized: false } },
      effective: { eligible: false, share: null, weight: 0 },
    });

    expect(provider(response, 'oauth-alias', 'disabled-oauth')).toMatchObject({
      kind: 'oauth',
      enabled: false,
      effective: { eligible: false, share: null },
    });
    expect(provider(response, 'stale-alias', 'unavailable-oauth')).toMatchObject({
      enabled: true,
      state: unavailable,
      effective: { eligible: false },
    });
    expect(provider(response, 'oauth-current', 'unavailable-oauth').effective.eligible).toBe(false);
    expect(provider(response, 'broken-alias', 'broken-oauth')).toMatchObject({
      state: unavailable,
    });
  });

  test('computes eligible tiers, shares, baseline ids, and the raw policy revision', async () => {
    const response = await inventory();
    const shared = model(response, 'shared');
    const zeroOnly = model(response, 'zero-only');

    expect(shared.baselineProviderIds).toEqual(['high', 'peer', 'zero']);
    expect(shared.providerCount).toBe(3);
    expect(shared.eligibleProviderCount).toBe(2);
    expect(shared.hasOverrides).toBe(true);
    expect(shared.revision).toBe(digestProviderEntry(authoredRecord.router.models.shared));
    expect(shared.tiers).toEqual([
      {
        priority: 20,
        providers: [
          { providerId: 'high', weight: 3, share: 0.75 },
          { providerId: 'peer', weight: 1, share: 0.25 },
        ],
      },
    ]);
    expect(provider(response, 'shared', 'high').effective).toMatchObject({
      eligible: true,
      share: 0.75,
      weightSource: 'model',
    });
    expect(provider(response, 'shared', 'zero').effective).toEqual({
      priority: 0,
      weight: 0,
      prioritySource: 'provider',
      weightSource: 'provider',
      eligible: false,
      share: null,
    });
    expect(shared.providers.map((entry) => entry.id)).not.toContain('ghost');

    expect(zeroOnly.eligibleProviderCount).toBe(0);
    expect(zeroOnly.tiers).toEqual([]);
    expect(provider(response, 'zero-only', 'zero').effective.eligible).toBe(false);
  });

  test('keeps remaining models when one OAuth catalog is unreadable', async () => {
    const rawRecord = structuredClone(authoredRecord) as Record<string, unknown>;
    const providers = rawRecord['providers'] as Record<string, unknown>;
    providers['invalid-oauth'] = {
      kind: 'oauth',
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
      alias: { 'invalid-alias': { model: 'invalid-target' } },
    };
    const config = parseRuntimeConfig(rawRecord);
    const response = await assembleRoutingInventory({
      rawRecord,
      config,
      summaries: summariesFrom(config, { 'invalid-oauth': unavailable, 'broken-oauth': unavailable }),
      repository: catalogRepository(),
      writable: true,
    });

    expect(response.models.map((entry) => entry.modelId)).toEqual(
      expect.arrayContaining(['invalid-alias', 'broken-alias', 'api-alias', 'shared']),
    );
    expect(provider(response, 'invalid-alias', 'invalid-oauth').state).toEqual(unavailable);
  });

  test('uses the OAuth account label as the routing Provider name', async () => {
    const response = await inventory();
    expect(provider(response, 'oauth-alias', 'disabled-oauth').name).toBe('octocat');
  });

  test('returns a read-only inventory when the config path is missing', async () => {
    const response = await inventory({ writable: false });
    expect(response.writable).toBe(false);
    expect(response.models.length).toBeGreaterThan(0);
  });

  test('read-only inventory omits authored numbers for omitted, defaulted, and clamped values', async () => {
    const response = await inventory({ writable: false });
    const api = provider(response, 'api-alias', 'disabled-api');
    const oauth = provider(response, 'oauth-alias', 'disabled-oauth');

    expect(api.defaults.priority).toEqual({ effective: 0, wasNormalized: false });
    expect(api.defaults.weight).toEqual({ effective: 2, wasNormalized: false });
    expect(api.override?.priority).toEqual({ effective: 30, wasNormalized: false });
    expect(api.override).not.toHaveProperty('weight');
    expect(api.effective).toMatchObject({ prioritySource: 'model', weightSource: 'provider', priority: 30, weight: 2 });
    expect(oauth.defaults.priority).toEqual({ effective: 0, wasNormalized: false });
    expect(oauth.defaults.weight).toEqual({ effective: 1, wasNormalized: false });
    expect(oauth.override).toBeUndefined();
  });
});
