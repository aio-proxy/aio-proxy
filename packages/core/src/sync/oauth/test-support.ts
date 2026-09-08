import { type OAuthAdapter, zod } from '@aio-proxy/plugin-sdk';

import type { LiveAccount } from './protocol';

const catalog = { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] } as const;

export function oauthAdapterFixture(overrides: Partial<OAuthAdapter> = {}): OAuthAdapter {
  return {
    id: 'test-capability',
    displayName: 'Test OAuth',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error('fixture login must not be called');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        return catalog;
      },
    },
    async createRuntime() {
      throw new Error('fixture runtime must not be called');
    },
    ...overrides,
  };
}

export function liveAccountFixture(overrides: Partial<LiveAccount> = {}): LiveAccount {
  return {
    protocol: 1,
    objectId: '00000000-0000-4000-8000-000000000001',
    epoch: 0,
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    pluginVersion: '1.0.0',
    formatVersion: 1,
    generation: 0,
    phase: 'ready',
    payload: { credential: { token: 'old' }, options: {}, secrets: {}, fingerprint: 'fixture' },
    claim: null,
    lastCompletedOperationId: null,
    ...overrides,
  };
}
