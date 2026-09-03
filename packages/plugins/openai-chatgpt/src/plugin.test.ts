import { expect, test } from 'bun:test';

import type { CredentialPort, OAuthAdapter, PluginDescriptor, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import openAIChatGPTPlugin from '.';
import type { ChatGPTCredential } from './schema';

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, ChatGPTCredential>> {
  let registered: OAuthAdapter<Record<string, never>, ChatGPTCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, ChatGPTCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('OpenAI ChatGPT OAuth adapter was not registered');
  return registered;
}

function staticCredentialPort(): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: {
        accessToken: 'access-token',
        accountId: 'acct-123',
        expiresAt: Date.now() + 60_000,
        refreshToken: 'refresh-token',
      },
    }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

test('discovery exposes gpt-image-2 as an image model alongside the language catalog', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const catalog = await adapter.catalog.discover({
    credentials: staticCredentialPort(),
    options: {},
    signal: new AbortController().signal,
    fetch: (async () =>
      Response.json({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 12, supported_in_api: true, visibility: 'list' },
        ],
      })) as unknown as RuntimeFetch,
  });

  expect(catalog.language.map(({ id }) => id)).toEqual(['gpt-5.5']);
  // `extra.protocol` is pinned as a literal because the host reads it into
  // RuntimeModelMetadata.protocol and the raw resolver dispatches on it, so a typo
  // here is invisible until an image request picks the wrong transport. Membership
  // in `catalog.image` is what grants the routable `image` capability; the
  // modalities serve /v1/models `image_input` and suppress the models.dev fallback.
  expect(catalog.image).toEqual([
    {
      id: 'gpt-image-2',
      displayName: 'GPT Image 2',
      extra: { protocol: 'openai-image' },
      modelMetadata: {
        capabilities: { modalities: { input: ['text', 'image'], output: ['image'] } },
      },
    },
  ]);
});
