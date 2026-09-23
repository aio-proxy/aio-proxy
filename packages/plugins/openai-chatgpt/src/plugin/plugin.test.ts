import { expect, test } from 'bun:test';

import type { CredentialPort, OAuthAdapter, PluginDescriptor, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import openAIChatGPTPlugin from '..';
import type { ChatGPTPluginOptions } from '../plugin-options';
import type { ChatGPTCredential } from '../schema';

async function adapterFrom(
  descriptor: PluginDescriptor<ChatGPTPluginOptions>,
): Promise<OAuthAdapter<Record<string, unknown>, ChatGPTCredential>> {
  let registered: OAuthAdapter<Record<string, unknown>, ChatGPTCredential> | undefined;
  const options = descriptor.metadata.options?.schema.parse({});
  if (options === undefined) throw new Error('ChatGPT plugin options are missing');
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, unknown>, ChatGPTCredential>;
        },
      },
    },
    options,
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

test('discovery exposes ChatGPT image models alongside the language catalog', async () => {
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
  // Each assertion below protects a user-visible contract: live language discovery
  // must not clobber the hardcoded image catalog (membership is what grants the
  // routable `image` capability), and `modalities` must survive to the descriptor
  // because `input` reaches users as /v1/models `capabilities.image_input`.
  // Deliberately not a whole-object `toEqual`: that also pinned `displayName` and
  // the absence of `extra`, neither of which has a contract to protect.
  expect(catalog.image.map(({ id }) => id)).toEqual(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
  for (const model of catalog.image) {
    expect(model.modelMetadata?.capabilities?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['image'],
    });
  }
});
