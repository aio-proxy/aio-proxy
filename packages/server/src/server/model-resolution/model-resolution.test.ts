import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import { resolveEnabledModels } from './model-resolution';

const oauthProvider = {
  id: 'p1',
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: { 'gpt-5': { model: 'gpt-5.6-sol', preserve: false } },
  modelMetadata: { 'gpt-5.6-sol': { displayName: 'Vendor Name' } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

const aliasOnlyProvider = {
  id: 'p2',
  kind: ProviderKind.Api,
  enabled: true,
  alias: { 'my-alias': { model: 'gpt-5.6-sol', preserve: false } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(providers: readonly RuntimeProviderInstance[], catalog: unknown): ServerState {
  return {
    acquireProviderSnapshot: () => ({
      snapshot: { providers },
      release() {},
    }),
    modelsDevCatalog: async () => catalog,
  } as unknown as ServerState;
}

test('resolveEnabledModels reads metadata only from the alias slug, never the upstream modelId', async () => {
  // alias "my-alias" has no catalog entry; upstream "gpt-5.6-sol" does. The upstream
  // entry must NOT leak into the alias's public view.
  const catalog = {
    metadata: (id: string) => (id === 'gpt-5.6-sol' ? { displayName: 'Upstream Name', maxTokens: 999 } : undefined),
  };
  const resolved = await resolveEnabledModels(fakeState([aliasOnlyProvider], catalog));
  expect(resolved).toEqual([
    {
      slug: 'my-alias',
      modelId: 'gpt-5.6-sol',
      provider: aliasOnlyProvider,
      metadata: undefined,
      displayName: 'my-alias',
    },
  ]);
});

test('resolveEnabledModels de-dupes by slug and uses alias-slug catalog metadata', async () => {
  const catalog = {
    metadata: (id: string) => (id === 'gpt-5' ? { maxTokens: 100 } : { maxTokens: 999 }),
  };
  const resolved = await resolveEnabledModels(fakeState([oauthProvider], catalog));
  expect(resolved).toEqual([
    {
      slug: 'gpt-5',
      modelId: 'gpt-5.6-sol',
      provider: oauthProvider,
      metadata: { maxTokens: 100 },
      displayName: 'Vendor Name',
    },
  ]);
});

test('displayName prefers the OAuth provider self-reported name for the upstream modelId', async () => {
  const resolved = await resolveEnabledModels(fakeState([oauthProvider], { metadata: () => undefined }));
  expect(resolved[0]?.displayName).toBe('Vendor Name');
});
