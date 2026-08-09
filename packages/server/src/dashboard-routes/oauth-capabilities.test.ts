import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { disabledDashboardAuthentication } from '../dashboard-auth/test-support';
import { createServerState } from '../server-state';
import { createDashboardRoutes } from './config';

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
            { type: 'text', key: 'deployment', label: 'Deployment' },
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
          defaults: {},
          form: [
            { type: 'text', key: 'deployment', label: 'Deployment' },
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
