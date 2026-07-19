import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";

import { discoverKimiCatalog, KIMI_CATALOG_TTL_MS, staticKimiCatalog } from "./catalog";
import { type KimiCredential, type KimiOAuthDependencies, loginKimi } from "./oauth";
import { readKimiQuota } from "./quota";
import { createKimiRuntime } from "./runtime";

export type KimiCodePresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: KimiCodePresentationText = {
  pluginLabel: "Kimi Code",
  pluginDescription: "Use a Kimi Code account to access models",
  adapterLabel: "Login with Kimi Code",
  deviceInstructions: "Enter code",
  waitingForAuthorization: "Waiting for Kimi authorization",
};

export function createKimiCodePlugin(
  presentationText: KimiCodePresentationText = englishPresentationText,
  dependencies: KimiOAuthDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, KimiCredential> = {
    id: "default",
    label: presentationText.adapterLabel,
    icon: "moonshot",
    account: { options: accountOptions },
    credentials: zod.object({
      accessToken: zod.string().min(1),
      refreshToken: zod.string().min(1),
      expiresAt: zod.number().int(),
      deviceId: zod.string().min(1),
    }),
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginKimi(
        context,
        {
          instructions: presentationText.deviceInstructions,
          waiting: presentationText.waitingForAuthorization,
        },
        dependencies,
      );
    },
    catalog: {
      policy: { kind: "ttl", ttlMs: KIMI_CATALOG_TTL_MS },
      discover: (context) => discoverKimiCatalog(context, dependencies),
      initialFallback: (error) =>
        error instanceof DOMException && error.name === "AbortError" ? undefined : staticKimiCatalog(),
    },
    createRuntime: (context) => createKimiRuntime(context, dependencies),
    quota: { read: (context) => readKimiQuota(context, dependencies) },
  };

  return definePlugin((api) => api.oauth.register(adapter), {
    label: presentationText.pluginLabel ?? "Kimi Code",
    description: presentationText.pluginDescription ?? "Use a Kimi Code account to access models",
  });
}
