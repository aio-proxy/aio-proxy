import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { disabledDashboardAuthentication } from '../src/dashboard-auth/test-support';
import { createDashboardRoutes } from '../src/dashboard-routes/config';
import { createServerState } from '../src/server-state';

describe('dashboard static routes', () => {
  test('plugin and provider diagnostics never serialize stored secrets or original error stacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-diagnostics-'));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    repository.writePluginSecret('@example/broken', null, { token: 'plugin-secret-sentinel' });
    const operation = repository.stageAccountOperation({
      kind: 'create',
      targetDigest: 'create',
      account: {
        providerId: 'broken-account',
        plugin: '@example/broken',
        capability: 'default',
        fingerprint: 'fingerprint-sentinel',
        options: { privateOption: 'account-option-sentinel' },
        secrets: { clientSecret: 'account-secret-sentinel' },
        credential: { accessToken: 'credential-json-sentinel' },
        label: 'octocat',
        expiresAt: 1_900_000_000_000,
        catalog: {
          kind: 'missing',
          diagnostic: {
            code: 'CATALOG_UNAVAILABLE',
            summary: 'Catalog unavailable.',
            retryable: true,
            occurredAt: '2026-07-14T00:00:00.000Z',
          },
        },
      },
    });
    repository.completeAccountOperation(operation.operationId);
    const descriptor = definePlugin(
      () => {
        const error = new Error('plugin-secret-sentinel original setup failure');
        error.stack = 'original-error-stack-sentinel';
        throw error;
      },
      {
        displayName: { default: 'Broken plugin', 'zh-Hans': '损坏的插件' },
        description: { default: 'Broken plugin description', 'zh-Hans': '损坏插件描述' },
        options: {
          schema: zod.object({ token: zod.string() }),
          form: [{ type: 'secret', key: 'token', label: 'Token' }],
        },
      },
    );
    const state = await createServerState({
      config: ConfigSchema.parse({
        plugins: ['@example/broken'],
        providers: {
          'broken-account': {
            kind: 'oauth',
            plugin: '@example/broken',
            capability: 'default',
          },
        },
      }),
      dbHome: dir,
      pluginRepository: repository,
      builtIns: [{ packageName: '@example/broken', version: '1.2.3', descriptor }],
      pluginLogger: () => {},
    });
    const routes = createDashboardRoutes(state, disabledDashboardAuthentication);

    try {
      const plugins = await routes.request('/plugins');
      const capabilities = await routes.request('/oauth/capabilities');
      const providers = await routes.request('/providers');
      const serialized = JSON.stringify({
        plugins: await plugins.json(),
        capabilities: await capabilities.json(),
        providers: await providers.json(),
      });

      expect(plugins.status).toBe(200);
      expect(capabilities.status).toBe(200);
      expect(providers.status).toBe(200);
      expect(serialized).toContain('PLUGIN_LOAD_FAILED');
      expect(serialized).toContain('"capabilities":[]');
      expect(serialized).toContain('broken-account');
      expect(serialized).not.toContain('plugin-secret-sentinel');
      expect(serialized).not.toContain('account-option-sentinel');
      expect(serialized).not.toContain('account-secret-sentinel');
      expect(serialized).not.toContain('credential-json-sentinel');
      expect(serialized).not.toContain('fingerprint-sentinel');
      expect(serialized).not.toContain('original-error-stack-sentinel');
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
