import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginRegistry } from '@aio-proxy/core';
import { createPluginRegistryHost } from '@aio-proxy/core';
import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createSnapshotManager } from '../../plugin-snapshot';
import { oauthCapabilities } from '../../server-state/oauth-views';
import type { Snapshot } from '../../server-state/snapshot';
import { createDashboardRoutes } from '../config';
import { dashboardOAuthCapabilities } from './oauth-capabilities';

const source = { default: 'Example Tool', 'zh-Hans': '示例工具' };

function registryWith(detect?: NonNullable<OAuthAdapter['localSignIn']>['detect']) {
  const host = createPluginRegistryHost();
  const staging = host.stage('@example/oauth');
  const read = mock(async () => {
    throw new Error('host credentials must not be read by detection');
  });
  const write = mock(async () => {});
  staging.api.oauth.register({
    id: 'default',
    displayName: 'Example OAuth',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    ...(detect === undefined ? {} : { localSignIn: { source, detect, read, write } }),
    async login() {
      throw new Error('login must not run');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        throw new Error('catalog must not run');
      },
    },
    async createRuntime() {
      throw new Error('runtime must not run');
    },
  });
  staging.seal();
  staging.commit();
  return { registry: host.registry, read, write };
}

test.each([
  ['absent', undefined],
  ['false', async () => false],
  [
    'throws',
    () => {
      throw new Error('private plugin failure');
    },
  ],
  [
    'rejects',
    async () => {
      throw new Error('private plugin failure');
    },
  ],
] as const)('capabilities omit localSignIn when detection is %s', async (_label, detect) => {
  const fixture = registryWith(detect);
  const capabilities = await dashboardOAuthCapabilities(fixture.registry);
  expect(capabilities).toHaveLength(1);
  expect(capabilities[0]).not.toHaveProperty('localSignIn');
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.write).not.toHaveBeenCalled();
});

test('capabilities include only localSignIn.source when detection is true', async () => {
  const detect = mock(async ({ signal }: { signal: AbortSignal }) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    return true;
  });
  const fixture = registryWith(detect);
  const capabilities = await dashboardOAuthCapabilities(fixture.registry);
  expect(capabilities[0]).toMatchObject({ localSignIn: { source } });
  expect(Object.keys(capabilities[0]!.localSignIn!)).toEqual(['source']);
  expect(detect).toHaveBeenCalledTimes(1);
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.write).not.toHaveBeenCalled();
});

test('capabilities time out concurrent detections that ignore their matching abort signals', async () => {
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  const signals: AbortSignal[] = [];
  const one = registryWith(({ signal }) => {
    signals.push(signal);
    return first.promise;
  });
  const two = registryWith(({ signal }) => {
    signals.push(signal);
    return second.promise;
  });
  const registry: PluginRegistry = {
    ...one.registry,
    oauthCapabilities: () => [
      ...one.registry.oauthCapabilities(),
      ...two.registry.oauthCapabilities().map((entry) => ({ ...entry, plugin: '@example/second' })),
    ],
  };
  const started = performance.now();
  try {
    const capabilities = await dashboardOAuthCapabilities(registry);
    const elapsed = performance.now() - started;
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_500);
    expect(capabilities).toHaveLength(2);
    expect(capabilities.every((capability) => !Object.hasOwn(capability, 'localSignIn'))).toBe(true);
    // Late success/rejection cannot alter the response or leak an unhandled rejection.
    first.resolve(true);
    second.reject(new Error('late private plugin failure'));
    await Promise.resolve();
    expect(capabilities.every((capability) => !Object.hasOwn(capability, 'localSignIn'))).toBe(true);
  } finally {
    first.resolve(false);
    second.resolve(false);
  }
});

test.each(['success', 'rejection'] as const)(
  'the snapshot lease is held until detection settles with %s',
  async (outcome) => {
    const detection = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    const fixture = registryWith(() => {
      entered.resolve();
      return detection.promise;
    });
    const snapshot = { providers: [], plugins: { registry: fixture.registry } } as unknown as Snapshot;
    const manager = createSnapshotManager(snapshot);
    const pending = oauthCapabilities(manager);
    const retired = manager.swap({ ...snapshot });
    let drained = false;
    void retired.whenDrained.then(() => {
      drained = true;
    });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      await entered.promise;
      if (outcome === 'success') detection.resolve(true);
      else detection.reject(new Error('private plugin failure'));
      const capabilities = await pending;
      await retired.whenDrained;
      expect(drained).toBe(true);
      if (outcome === 'success') expect(capabilities[0]).toMatchObject({ localSignIn: { source } });
      else expect(capabilities[0]).not.toHaveProperty('localSignIn');
    } finally {
      detection.resolve(false);
      await pending;
    }
  },
);

test('the dashboard capabilities route awaits detection before returning JSON', async () => {
  const detection = Promise.withResolvers<boolean>();
  const fixture = registryWith(() => detection.promise);
  const route = createDashboardRoutes(
    {
      oauthCapabilities: () => dashboardOAuthCapabilities(fixture.registry),
    } as never,
    {} as never,
  );
  try {
    const response = route.request('/oauth/capabilities');
    detection.resolve(true);
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ capabilities: [{ localSignIn: { source } }] });
  } finally {
    detection.resolve(false);
  }
});

test('GET /oauth/capabilities returns loaded OAuth adapters without schemas or secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-oauth-capabilities-'));
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: 'default',
      displayName: { default: 'Example OAuth', 'zh-Hans': '示例 OAuth' },
      description: 'Example account',
      account: {
        options: {
          schema: zod.object({ deployment: zod.string().default('public'), token: zod.string().optional() }),
          form: [
            { type: 'text', key: 'deployment', label: 'Deployment', defaultValue: 'public' },
            {
              type: 'select',
              key: 'region',
              label: 'Region',
              defaultValue: 'eu',
              options: [
                { value: 'us', label: 'US' },
                { value: 'eu', label: 'EU' },
              ],
            },
            { type: 'secret', key: 'token', label: 'Token' },
          ],
        },
      },
      credentials: zod.object({ accessToken: zod.string() }),
      async login() {
        return { fingerprint: 'person', suggestedKey: 'person', credentials: { accessToken: 'hidden' } };
      },
      catalog: {
        policy: { kind: 'static' },
        async discover() {
          return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
        },
      },
      async createRuntime() {
        throw new Error('not used');
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({ plugins: ['@example/oauth'], providers: {} }),
    dbHome: dir,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });

  try {
    const response = await createDashboardRoutes(state, disabledDashboardAuthentication).request('/oauth/capabilities');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      capabilities: [
        {
          plugin: '@example/oauth',
          capability: 'default',
          displayName: { default: 'Example OAuth', 'zh-Hans': '示例 OAuth' },
          description: 'Example account',
          defaults: { deployment: 'public', region: 'eu' },
          form: [
            { type: 'text', key: 'deployment', label: 'Deployment', defaultValue: 'public' },
            {
              type: 'select',
              key: 'region',
              label: 'Region',
              defaultValue: 'eu',
              options: [
                { value: 'us', label: 'US' },
                { value: 'eu', label: 'EU' },
              ],
            },
            { type: 'secret', key: 'token', label: 'Token', configured: false },
          ],
        },
      ],
    });
    expect(payload.capabilities[0]).toMatchObject({
      displayName: { default: 'Example OAuth', 'zh-Hans': '示例 OAuth' },
    });
    expect(payload.capabilities[0]).not.toHaveProperty('icon');
    expect(JSON.stringify(payload)).not.toMatch(/hidden|schema|accessToken/u);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
