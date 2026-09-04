import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { defaultAntigravityAliases } from './catalog/aliases';
import { discoverAntigravityCatalog } from './catalog/discover';
import { CatalogDiscoveryError } from './catalog/errors';
import { staticAntigravityCatalog } from './catalog/snapshot';
import { buildGoogleAuthorizationUrl, exchangeAuthorizationCode } from './oauth/flow';
import { initializeAntigravityProject, type ProjectInitializationDependencies } from './oauth/project';
import { exchangeGoogleRefreshToken } from './oauth/refresh';
import { fetchGoogleEmail } from './oauth/userinfo';
import { readGoogleAntigravityQuota } from './quota/index';
import { createGoogleAntigravityRuntime } from './runtime/provider';
import {
  accountOptionsSchema,
  credentialSchema,
  type GoogleAntigravityAccountOptions,
  type GoogleAntigravityCredential,
} from './schema';

const cpaAntigravitySchema = zod
  .object({
    type: zod.literal('antigravity'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    email: zod.email(),
    project_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
    timestamp: zod.number().finite().optional(),
    expires_in: zod.number().finite().nonnegative().optional(),
    token_type: zod.string().trim().min(1).optional(),
    scope: zod.string().trim().min(1).optional(),
  })
  .loose();

function normalizeAntigravityEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}
function antigravityExpiry(source: zod.infer<typeof cpaAntigravitySchema>): number {
  const parsed = typeof source.expired === 'string' ? Date.parse(source.expired) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (source.timestamp !== undefined && source.expires_in !== undefined) {
    const fallback = source.timestamp + source.expires_in * 1_000;
    return Number.isFinite(fallback) ? fallback : 0;
  }
  return 0;
}

export type GoogleAntigravityPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly baseURLLabel: LocalizedText;
  readonly baseURLPlaceholder?: LocalizedText;
};

export const englishPresentationText: GoogleAntigravityPresentationText = {
  pluginLabel: 'Google Antigravity',
  pluginDescription: 'Use a Google Antigravity account to access models',
  adapterLabel: 'Login with Google Antigravity',
  baseURLLabel: 'Custom Antigravity base URL',
  baseURLPlaceholder: 'https://proxy.example.com',
};

export type GoogleAntigravityPluginDependencies = ProjectInitializationDependencies & {
  readonly now?: (() => number) | undefined;
};

export function createGoogleAntigravityPlugin(
  presentationText: GoogleAntigravityPresentationText = englishPresentationText,
  dependencies: GoogleAntigravityPluginDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: accountOptionsSchema,
    form: [
      {
        type: 'text',
        key: 'baseURL',
        label: presentationText.baseURLLabel,
        ...(presentationText.baseURLPlaceholder === undefined
          ? {}
          : { placeholder: presentationText.baseURLPlaceholder }),
      },
    ],
  } as const satisfies ConfigSpec<GoogleAntigravityAccountOptions>;

  const adapter: OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      const parsedOptions = await accountOptions.schema.parseAsync(options);
      const state = crypto.randomUUID();
      const callback = await context.authorization.loopback({
        state,
        redirect: { hostname: 'localhost', port: 51121, path: '/oauth-callback' },
        authorizationUrl: ({ redirectUri }) => buildGoogleAuthorizationUrl(state, redirectUri),
        allowManualCallbackUrl: true,
      });
      if (callback.code.trim() === '') throw new Error('Google authorization code is missing');
      const token = await exchangeAuthorizationCode(callback.code, callback.redirectUri, {
        fetch: dependencies.fetch ?? context.fetch,
        now: dependencies.now,
        signal: context.signal,
      });
      if (token.refreshToken.trim() === '') throw new Error('Google token response is missing a refresh token');
      const email = await fetchGoogleEmail(token.accessToken, {
        fetch: dependencies.fetch ?? context.fetch,
        signal: context.signal,
      });
      if (email.trim() === '') throw new Error('Google userinfo response is missing email');
      const projectId = await initializeAntigravityProject(token.accessToken, parsedOptions, {
        fetch: dependencies.fetch ?? context.fetch,
        sleep: dependencies.sleep,
        signal: context.signal,
        now: dependencies.now,
      });
      if (projectId.trim() === '') throw new Error('Google Antigravity project identity is missing');
      const identityEmail = email.trim();
      const presentationEmail = normalizeAntigravityEmail(identityEmail) ?? identityEmail;
      return {
        fingerprint: identityEmail,
        suggestedKey: `antigravity-${identityEmail}`,
        accountLabel: presentationEmail,
        credentials: { ...token, email: presentationEmail, projectId },
        expiresAt: token.expiresAt,
      };
    },
    credentialImports: {
      cpa: {
        types: ['antigravity'],
        async import(context, options, raw) {
          const parsedOptions = await accountOptions.schema.parseAsync(options);
          const source = cpaAntigravitySchema.parse(raw);
          const now = dependencies.now ?? Date.now;
          let token = {
            accessToken: source.access_token,
            refreshToken: source.refresh_token,
            expiresAt: antigravityExpiry(source),
            ...(source.token_type === undefined ? {} : { tokenType: source.token_type }),
            ...(source.scope === undefined ? {} : { scope: source.scope }),
          };
          if (source.project_id === undefined && token.expiresAt <= now()) {
            token = await exchangeGoogleRefreshToken(token, {
              fetch: dependencies.fetch ?? context.fetch,
              now: dependencies.now,
              signal: context.signal,
            });
          }
          const projectId =
            source.project_id ??
            (await initializeAntigravityProject(token.accessToken, parsedOptions, {
              fetch: dependencies.fetch ?? context.fetch,
              sleep: dependencies.sleep,
              signal: context.signal,
              now: dependencies.now,
            }));
          const identityEmail = source.email;
          const presentationEmail = normalizeAntigravityEmail(identityEmail) ?? identityEmail;
          return {
            fingerprint: identityEmail,
            suggestedKey: `antigravity-${identityEmail}`,
            accountLabel: presentationEmail,
            credentials: { ...token, email: presentationEmail, projectId },
            expiresAt: token.expiresAt,
          };
        },
      },
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: 6 * 60 * 60 * 1_000 },
      discover: async (context) =>
        await discoverAntigravityCatalog(context, {
          ...((dependencies.fetch ?? context.fetch) === undefined
            ? {}
            : { fetch: dependencies.fetch ?? context.fetch }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        }),
      initialFallback: (error) =>
        error instanceof CatalogDiscoveryError && error.snapshotEligible ? staticAntigravityCatalog() : undefined,
      defaultAliases: defaultAntigravityAliases,
    },
    createRuntime: async (context) =>
      createGoogleAntigravityRuntime(context, {
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
      }),
    quota: {
      read: async (context) => await readGoogleAntigravityQuota(context, dependencies.fetch ?? context.fetch),
    },
  };

  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'Google Antigravity',
      description: presentationText.pluginDescription ?? 'Use a Google Antigravity account to access models',
      icon: 'antigravity-color',
    },
  );
}
