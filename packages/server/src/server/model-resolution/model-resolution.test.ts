import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import { resolveDisplayName, resolveEnabledModels } from './model-resolution';

const provider = {
  id: 'p1',
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: { 'gpt-5': { model: 'gpt-5.6-sol', preserve: false } },
  modelMetadata: { 'gpt-5.6-sol': { displayName: 'Vendor Name' } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(catalog: unknown): ServerState {
  return {
    acquireProviderSnapshot: () => ({
      snapshot: { providers: [provider] },
      release() {},
    }),
    modelsDevCatalog: async () => catalog,
  } as unknown as ServerState;
}

test('resolveEnabledModels de-dupes by slug and attaches alias-first metadata', async () => {
  const catalog = {
    metadata: (id: string) => (id === 'gpt-5' ? { maxTokens: 100 } : { maxTokens: 999 }),
  };
  const resolved = await resolveEnabledModels(fakeState(catalog));
  expect(resolved).toEqual([{ slug: 'gpt-5', modelId: 'gpt-5.6-sol', provider, metadata: { maxTokens: 100 } }]);
});

test('resolveDisplayName prefers OAuth vendor name for the upstream modelId', () => {
  expect(resolveDisplayName(provider, 'gpt-5.6-sol', 'gpt-5', undefined)).toBe('Vendor Name');
});
