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
  expect(catalog.image.map(({ id }) => id)).toEqual(['gpt-image-2']);
  // The capability index derives `image` from these ids, so the output modality
  // must be declared here or /v1/images/* rejects the model.
  expect(catalog.image[0]?.modelMetadata?.capabilities?.modalities?.output).toContain('image');
});
