import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod, type OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

const SNAPSHOT: OAuthQuotaSnapshot = {
  items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }],
  plan: 'Allegro',
};

async function createQuotaFixture(
  options: {
    read?: () => Promise<OAuthQuotaSnapshot>;
    breakRuntime?: boolean;
    breakCredential?: boolean;
    refreshable?: boolean;
  } = {},
) {
  const { read, breakRuntime = false, breakCredential = false, refreshable = false } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-provider-quota-'));
  const input = {
    plugins: ['@example/oauth'],
    providers: {
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', options: { tenant: 'work' } },
      plain: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com' },
    },
  };
  const handle = openDb({ home: dir });
  const repository = createPluginRepository(handle.sqlite);
  const pending = repository.stageAccountOperation({
    kind: 'create',
    targetDigest: 'seed',
    account: {
      providerId: 'person',
      plugin: '@example/oauth',
      capability: 'default',
      fingerprint: 'person@example.com',
      options: { tenant: 'work' },
      secrets: {},
      credential: { accessToken: 'stored-credential' },
      label: 'person@example.com',
      catalog: {
        kind: 'replace',
        value: {
          refreshedAt: Date.now(),
          catalog: {
            language: [{ id: 'model-1' }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
        },
      },
    },
  });
  repository.completeAccountOperation(pending.operationId);
  let reads = 0;
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: { options: { schema: zod.object({ tenant: zod.string() }), form: [] } },
      credentials: breakCredential
        ? zod.object({ accessToken: zod.number() })
        : zod.object({ accessToken: zod.string() }),
      async login() {
        throw new Error('not used');
      },
      catalog: {
        policy: { kind: 'static' },
        async discover() {
          throw new Error('not used');
        },
      },
      quota: {
        read: async () => {
          reads += 1;
          return read === undefined ? SNAPSHOT : await read();
        },
      },
      ...(refreshable ? { refreshCredential: async () => ({ value: { accessToken: 'rotated-credential' } }) } : {}),
      async createRuntime() {
        if (breakRuntime) throw new Error('runtime is broken');
        return {
          provider: {
            specificationVersion: 'v4',
            languageModel() {
              throw new Error('not called');
            },
            imageModel() {
              throw new Error('not called');
            },
            embeddingModel() {
              throw new Error('not called');
            },
          },
        } as never;
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    state,
    reads: () => reads,
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const quota = (routes: Awaited<ReturnType<typeof createQuotaFixture>>['routes'], id: string, body: unknown = {}) =>
  routes.request(`/providers/${id}/quota`, {
    method: 'QUERY',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('serves a quota snapshot once and reuses it until an explicit refresh', async () => {
  const fixture = await createQuotaFixture();
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.snapshot).toEqual(SNAPSHOT);
    expect(payload.stale).toBe(false);
    expect(payload.sampledAt).toBeGreaterThan(0);

    await quota(fixture.routes, 'person');
    expect(fixture.reads()).toBe(1);

    await quota(fixture.routes, 'person', { refresh: true });
    expect(fixture.reads()).toBe(2);
  } finally {
    fixture.cleanup();
  }
});

test('reports the quota capability on the provider summary', async () => {
  const fixture = await createQuotaFixture();
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.hasQuota).toBe(true);
    expect(providers.find((provider: { id: string }) => provider.id === 'plain')?.hasQuota).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('keeps reporting the quota capability when the provider runtime is unavailable', async () => {
  const fixture = await createQuotaFixture({ breakRuntime: true });
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    const person = providers.find((provider: { id: string }) => provider.id === 'person');
    expect(person?.state.status).toBe('unavailable');
    expect(person?.hasQuota).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test('reports the credential refresh capability on the provider summary', async () => {
  const fixture = await createQuotaFixture({ refreshable: true });
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.canRefreshCredential).toBe(true);
    expect(providers.find((provider: { id: string }) => provider.id === 'plain')?.canRefreshCredential).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('reports no credential refresh capability when the plugin does not declare one', async () => {
  const fixture = await createQuotaFixture();
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.canRefreshCredential).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('answers 404 for an unknown provider and for one without a quota capability', async () => {
  const fixture = await createQuotaFixture();
  try {
    expect((await quota(fixture.routes, 'missing')).status).toBe(404);
    expect((await quota(fixture.routes, 'plain')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('a quota read blocked by a bad credential stays retryable rather than a permanent 404', async () => {
  // Preparation failures wear the same opaque error as a plugin with no quota capability, so the
  // route must gate the 404 on the permanent flag. A 404 here would tell the card to stop asking,
  // and the ring would never come back after the user reauthenticates.
  const fixture = await createQuotaFixture({ breakCredential: true });
  try {
    expect((await quota(fixture.routes, 'person')).status).toBe(502);
  } finally {
    fixture.cleanup();
  }
});

test('reports an unreadable quota as 502 rather than an empty snapshot', async () => {
  const fixture = await createQuotaFixture({
    read: async () => {
      throw new Error('upstream down');
    },
  });
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAuth quota read failed' });
  } finally {
    fixture.cleanup();
  }
});

const HOUR = 60 * 60 * 1000;

test('attaches local API-equivalent estimates for any OAuth plugin, not ChatGPT', async () => {
  const fixture = await createQuotaFixture({
    read: async () => ({
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: Date.now() + 4 * HOUR,
          windowMinutes: 300,
        },
        { id: 'unrated', displayName: 'Unrated', resetsAt: Date.now() + 4 * HOUR, windowMinutes: 300 },
      ],
    }),
  });
  try {
    fixture.state.traceStore.startRoot({
      traceId: 'a'.repeat(32),
      spanId: 'a'.repeat(16),
      requestId: 'priced',
      inboundProtocol: 'openai-compatible',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt: new Date(Date.now() - HOUR),
      statusCode: 0,
      attributes: {
        'aio_proxy.request.id': 'priced',
        'aio_proxy.protocol.inbound': 'openai-compatible',
        'aio_proxy.route.final_provider_id': 'person',
        'gen_ai.usage.estimated_cost_usd': 0.1,
      },
      events: [],
      links: [],
    });
    fixture.state.traceStore.complete({
      traceId: 'a'.repeat(32),
      rootSpanId: 'a'.repeat(16),
      spans: [
        {
          traceId: 'a'.repeat(32),
          spanId: 'a'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: new Date(Date.now() - HOUR),
          endedAt: new Date(),
          statusCode: 0,
          attributes: {
            'aio_proxy.request.id': 'priced',
            'aio_proxy.protocol.inbound': 'openai-compatible',
            'aio_proxy.route.final_provider_id': 'person',
            'gen_ai.usage.estimated_cost_usd': 0.1,
          },
          events: [],
          links: [],
        },
      ],
      summary: {
        finalProviderId: 'person',
        finalModelId: 'codex-auto-review',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.1 },
      },
    });

    const payload = await (await quota(fixture.routes, 'person')).json();
    expect(payload.estimates).toEqual([
      { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a later trace does not enter estimates until the next quota sample', async () => {
  const now = spyOn(Date, 'now');
  const sampledAt = Date.parse('2026-01-10T12:00:00.000Z');
  now.mockReturnValue(sampledAt);
  let fixture: Awaited<ReturnType<typeof createQuotaFixture>> | undefined;
  try {
    fixture = await createQuotaFixture({
      read: async () => ({
        items: [
          {
            id: 'five-hour',
            displayName: 'Five hour',
            remainingRatio: 0.5,
            resetsAt: sampledAt + 4 * HOUR,
            windowMinutes: 300,
          },
        ],
      }),
    });
    try {
      fixture.state.traceStore.startRoot({
        traceId: 'a'.repeat(32),
        spanId: 'a'.repeat(16),
        requestId: 'before',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: new Date(sampledAt - HOUR),
        statusCode: 0,
        attributes: {
          'aio_proxy.request.id': 'before',
          'aio_proxy.protocol.inbound': 'openai-compatible',
          'aio_proxy.route.final_provider_id': 'person',
          'gen_ai.usage.estimated_cost_usd': 0.1,
        },
        events: [],
        links: [],
      });
      fixture.state.traceStore.complete({
        traceId: 'a'.repeat(32),
        rootSpanId: 'a'.repeat(16),
        spans: [
          {
            traceId: 'a'.repeat(32),
            spanId: 'a'.repeat(16),
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: new Date(sampledAt - HOUR),
            endedAt: new Date(sampledAt - 1),
            statusCode: 0,
            attributes: {
              'aio_proxy.request.id': 'before',
              'aio_proxy.protocol.inbound': 'openai-compatible',
              'aio_proxy.route.final_provider_id': 'person',
              'gen_ai.usage.estimated_cost_usd': 0.1,
            },
            events: [],
            links: [],
          },
        ],
        summary: {
          finalProviderId: 'person',
          finalModelId: 'codex-auto-review',
          finalHttpStatus: 200,
          usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.1 },
        },
      });

      const first = await (await quota(fixture.routes, 'person')).json();
      expect(first.sampledAt).toBe(sampledAt);
      expect(first.estimates).toEqual([
        { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
      ]);

      now.mockReturnValue(sampledAt + HOUR);
      fixture.state.traceStore.startRoot({
        traceId: 'b'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'after',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: new Date(sampledAt + 1),
        statusCode: 0,
        attributes: {
          'aio_proxy.request.id': 'after',
          'aio_proxy.protocol.inbound': 'openai-compatible',
          'aio_proxy.route.final_provider_id': 'person',
          'gen_ai.usage.estimated_cost_usd': 0.4,
        },
        events: [],
        links: [],
      });
      fixture.state.traceStore.complete({
        traceId: 'b'.repeat(32),
        rootSpanId: 'b'.repeat(16),
        spans: [
          {
            traceId: 'b'.repeat(32),
            spanId: 'b'.repeat(16),
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: new Date(sampledAt + 1),
            endedAt: new Date(sampledAt + 1),
            statusCode: 0,
            attributes: {
              'aio_proxy.request.id': 'after',
              'aio_proxy.protocol.inbound': 'openai-compatible',
              'aio_proxy.route.final_provider_id': 'person',
              'gen_ai.usage.estimated_cost_usd': 0.4,
            },
            events: [],
            links: [],
          },
        ],
        summary: {
          finalProviderId: 'person',
          finalModelId: 'gpt-5',
          finalHttpStatus: 200,
          usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.4 },
        },
      });

      const cached = await (await quota(fixture.routes, 'person')).json();
      expect(cached.sampledAt).toBe(sampledAt);
      expect(cached.estimates).toEqual([
        { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
      ]);

      const refreshed = await (await quota(fixture.routes, 'person', { refresh: true })).json();
      expect(refreshed.sampledAt).toBe(sampledAt + HOUR);
      expect(refreshed.estimates).toEqual([
        { itemId: 'five-hour', usedNanoUsd: '500000000', basis: 'local-api-equivalent' },
      ]);
    } finally {
      fixture?.cleanup();
    }
  } finally {
    now.mockRestore();
  }
});

test('a throwing cost query still returns the quota snapshot', async () => {
  const fixture = await createQuotaFixture({
    read: async () => ({
      items: [
        {
          id: 'five-hour',
          displayName: 'Five hour',
          remainingRatio: 0.5,
          resetsAt: Date.now() + 4 * HOUR,
          windowMinutes: 300,
        },
      ],
    }),
  });
  const cost = spyOn(fixture.state.traceStore, 'providerWindowCost').mockImplementation(() => {
    throw new Error('sqlite exploded');
  });
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.snapshot.items[0]?.id).toBe('five-hour');
    expect(payload.estimates).toBeUndefined();
    expect(cost).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  } finally {
    cost.mockRestore();
    logged.mockRestore();
    fixture.cleanup();
  }
});
