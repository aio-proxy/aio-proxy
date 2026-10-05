import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CredentialPort, OAuthAdapter, PluginDescriptor, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import openAIChatGPTPlugin from '..';
import type { ChatGPTPluginOptions } from '../plugin-options';
import type { ChatGPTCredential } from '../schema';
import { createOpenAIChatGPTPlugin, englishPresentationText } from './plugin';

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

test('Guardian strategy is a plugin setting, outside account options', async () => {
  const descriptor = createOpenAIChatGPTPlugin(englishPresentationText);
  const saved = await descriptor.metadata.options?.schema.parseAsync({
    guardianStrategy: 'systemOne',
    guardianProviderId: 'evaluation',
    guardianModelId: 'system-one',
  });
  expect(saved).toMatchObject({
    guardianStrategy: 'systemOne',
    guardianProviderId: 'evaluation',
    guardianModelId: 'system-one',
  });
  const adapter = await adapterFrom(descriptor);
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.account.options.schema.parse({ guardianStrategy: 'systemOne' })).toEqual({});
});

test('registers local Codex sign-in with injectable localized source and browser login identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aio-codex-adapter-'));
  const originalHome = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = home;
  try {
    const source = { default: 'Codex', 'zh-Hans': 'Codex' };
    const adapter = await adapterFrom(createOpenAIChatGPTPlugin({ ...englishPresentationText, source }));
    const localSignIn = adapter.localSignIn;
    expect(localSignIn).toBeDefined();
    if (localSignIn === undefined) throw new Error('Codex local sign-in was not registered');
    expect(localSignIn.source).toEqual(source);
    const accessToken = jwt({ exp: 1_800_000_000, chatgpt_account_id: 'account' });
    const idToken = jwt({ email: 'Person@Example.test' });
    await Bun.write(
      join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: accessToken, refresh_token: 'synthetic-refresh', id_token: idToken },
      }),
    );
    const signal = new AbortController().signal;
    expect(await localSignIn.detect({ signal })).toBe(true);
    const local = await localSignIn.read({ progress() {}, signal }, {});
    const browser = await adapter.login(
      {
        progress() {},
        signal,
        authorization: {
          presentDeviceCode: async () => {},
          presentAuthorizeUrl: async () => {},
          loopback: async () => ({ code: 'synthetic-code', redirectUri: 'http://localhost:1455/auth/callback' }),
        },
        fetch: async () =>
          Response.json({
            access_token: accessToken,
            id_token: idToken,
            refresh_token: 'synthetic-refresh',
          }),
      },
      {},
    );
    expect(local.fingerprint).toBe(browser.fingerprint);
    expect(local.suggestedKey).toBe(browser.suggestedKey);
    expect(local.accountLabel).toBe(browser.accountLabel);
    expect(adapter.credentials.parse(local.credentials).idToken).toBe(idToken);
    const defaultAdapter = await adapterFrom(openAIChatGPTPlugin);
    expect(defaultAdapter.localSignIn?.source).toBe('Codex');
  } finally {
    if (originalHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('manual refresh retains the previous id_token when the response omits it', async () => {
  const adapter = await adapterFrom(openAIChatGPTPlugin);
  const idToken = jwt({ chatgpt_account_id: 'account', email: 'person@example.test' });
  const refreshed = await adapter.refreshCredential!({
    credential: {
      accessToken: 'synthetic-old-access',
      accountId: 'account',
      expiresAt: Number.MAX_SAFE_INTEGER,
      refreshToken: 'synthetic-refresh',
      idToken,
    },
    options: {},
    signal: new AbortController().signal,
    fetch: async () => Response.json({ access_token: jwt({ chatgpt_account_id: 'account' }) }),
  });
  expect(refreshed.value.idToken).toBe(idToken);
});

function jwt(payload: object) {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}
