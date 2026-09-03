import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { CHATGPT_CATALOG_TTL_MS, discoverOpenAIChatGPTModels } from './catalog';
import { extractAccountId, extractEmail, normalizeChatGPTEmail } from './jwt';
import { ChatGPTAccountIdMissingError, CHATGPT_CLIENT_ID, exchangeCodeForTokens } from './oauth-flow';
import { generatePKCE, generateState } from './pkce';
import { createOpenAIChatGPTRuntime } from './runtime/index';
import type { ChatGPTCredential } from './schema';

const CHATGPT_AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/oauth/authorize' as const;
const CHATGPT_SCOPE = 'openid profile email offline_access' as const;
const CHATGPT_ORIGINATOR = 'codex_cli_rs' as const;

const cpaCodexSchema = zod
  .object({
    type: zod.literal('codex'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    account_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
    email: zod.string().optional(),
    id_token: zod.string().optional(),
  })
  .loose();

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export type OpenAIChatGPTPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
};

export const englishPresentationText: OpenAIChatGPTPresentationText = {
  pluginLabel: 'OpenAI ChatGPT',
  pluginDescription: 'Use a ChatGPT Plus or Pro account to access models',
  adapterLabel: 'Login with ChatGPT (Plus/Pro)',
};

export function createOpenAIChatGPTPlugin(
  presentationText: OpenAIChatGPTPresentationText,
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;

  const adapter: OAuthAdapter<Record<string, never>, ChatGPTCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: zod.object({
      accessToken: zod.string(),
      accountId: zod.string(),
      expiresAt: zod.number(),
      refreshToken: zod.string(),
      email: zod.string().optional(),
    }),
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      const pkce = await generatePKCE();
      const state = generateState();
      const { code, redirectUri } = await context.authorization.loopback({
        state,
        redirect: {
          hostname: 'localhost',
          port: 1455,
          path: '/auth/callback',
        },
        authorizationUrl: ({ redirectUri: selectedRedirectUri }) =>
          buildAuthorizationUrl({ challenge: pkce.challenge, redirectUri: selectedRedirectUri, state }),
        allowManualCallbackUrl: true,
      });
      const token = await exchangeCodeForTokens(code, pkce.verifier, {
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        redirectUri,
        signal: context.signal,
      });
      return {
        fingerprint: token.accountId,
        suggestedKey: `chatgpt-${token.accountId}`,
        accountLabel: token.email ?? token.accountId,
        credentials: token,
        expiresAt: token.expiresAt,
      };
    },
    credentialImports: {
      cpa: {
        types: ['codex'],
        async import(_context, options, raw) {
          await accountOptions.schema.parseAsync(options);
          const source = cpaCodexSchema.parse(raw);
          const accountId = source.account_id ?? extractAccountId(source.access_token);
          if (accountId === undefined) throw new ChatGPTAccountIdMissingError();
          const expiresAt = cpaExpiresAt(source.expired);
          const email =
            normalizeChatGPTEmail(source.email) ??
            (source.id_token === undefined ? undefined : extractEmail(source.id_token)) ??
            extractEmail(source.access_token);
          return {
            fingerprint: accountId,
            suggestedKey: `chatgpt-${accountId}`,
            accountLabel: email ?? accountId,
            credentials: {
              accessToken: source.access_token,
              accountId,
              expiresAt,
              refreshToken: source.refresh_token,
              ...(email === undefined ? {} : { email }),
            },
            expiresAt,
          };
        },
      },
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: CHATGPT_CATALOG_TTL_MS },
      discover: async ({ credentials, fetch, signal }) => ({
        language: await discoverOpenAIChatGPTModels(credentials, signal, fetch),
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      }),
    },
    createRuntime: createOpenAIChatGPTRuntime,
  };

  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'OpenAI ChatGPT',
      description: presentationText.pluginDescription ?? 'Use a ChatGPT Plus or Pro account to access models',
      icon: 'openai',
    },
  );
}

function buildAuthorizationUrl(input: {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const authUrl = new URL(CHATGPT_AUTHORIZATION_ENDPOINT);
  authUrl.searchParams.set('client_id', CHATGPT_CLIENT_ID);
  authUrl.searchParams.set('code_challenge', input.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('originator', CHATGPT_ORIGINATOR);
  authUrl.searchParams.set('redirect_uri', input.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', CHATGPT_SCOPE);
  authUrl.searchParams.set('state', input.state);
  return authUrl.toString();
}
