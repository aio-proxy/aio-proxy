import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
} from "@aio-proxy/plugin-sdk";

import { defaultAntigravityAliases } from "./catalog/aliases";
import { discoverAntigravityCatalog } from "./catalog/discover";
import { CatalogDiscoveryError } from "./catalog/errors";
import { staticAntigravityCatalog } from "./catalog/snapshot";
import { buildGoogleAuthorizationUrl, exchangeAuthorizationCode } from "./oauth/flow";
import { initializeAntigravityProject, type ProjectInitializationDependencies } from "./oauth/project";
import { fetchGoogleEmail } from "./oauth/userinfo";
import { createGoogleAntigravityRuntime } from "./runtime/provider";
import {
  accountOptionsSchema,
  credentialSchema,
  type GoogleAntigravityAccountOptions,
  type GoogleAntigravityCredential,
} from "./schema";

export type GoogleAntigravityPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly baseURLLabel: LocalizedText;
  readonly baseURLPlaceholder?: LocalizedText;
};

export const englishPresentationText: GoogleAntigravityPresentationText = {
  pluginLabel: "Google Antigravity",
  pluginDescription: "Use a Google Antigravity account to access models",
  adapterLabel: "Login with Google Antigravity",
  baseURLLabel: "Custom Antigravity base URL",
  baseURLPlaceholder: "https://proxy.example.com",
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
        type: "text",
        key: "baseURL",
        label: presentationText.baseURLLabel,
        ...(presentationText.baseURLPlaceholder === undefined
          ? {}
          : { placeholder: presentationText.baseURLPlaceholder }),
      },
    ],
  } as const satisfies ConfigSpec<GoogleAntigravityAccountOptions>;

  const adapter: OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential> = {
    id: "default",
    label: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      const parsedOptions = await accountOptions.schema.parseAsync(options);
      const state = crypto.randomUUID();
      const callback = await context.authorization.loopback({
        state,
        redirect: { hostname: "localhost", port: 51121, path: "/oauth-callback" },
        authorizationUrl: ({ redirectUri }) => buildGoogleAuthorizationUrl(state, redirectUri),
        allowManualCallbackUrl: true,
      });
      if (callback.code.trim() === "") throw new Error("Google authorization code is missing");
      const token = await exchangeAuthorizationCode(callback.code, callback.redirectUri, {
        fetch: dependencies.fetch,
        now: dependencies.now,
        signal: context.signal,
      });
      if (token.refreshToken.trim() === "") throw new Error("Google token response is missing a refresh token");
      const email = await fetchGoogleEmail(token.accessToken, { fetch: dependencies.fetch, signal: context.signal });
      if (email.trim() === "") throw new Error("Google userinfo response is missing email");
      const projectId = await initializeAntigravityProject(token.accessToken, parsedOptions, {
        fetch: dependencies.fetch,
        sleep: dependencies.sleep,
        signal: context.signal,
      });
      if (projectId.trim() === "") throw new Error("Google Antigravity project identity is missing");
      return {
        fingerprint: email,
        suggestedKey: `antigravity-${email}`,
        label: email,
        credentials: { ...token, email, projectId },
        expiresAt: token.expiresAt,
      };
    },
    catalog: {
      policy: { kind: "ttl", ttlMs: 6 * 60 * 60 * 1_000 },
      discover: async (context) =>
        await discoverAntigravityCatalog(context, {
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
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
  };

  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      label: presentationText.pluginLabel ?? "Google Antigravity",
      description: presentationText.pluginDescription ?? "Use a Google Antigravity account to access models",
    },
  );
}
