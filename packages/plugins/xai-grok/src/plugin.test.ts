import { expect, test } from "bun:test";
import type { OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import xaiGrokPlugin, { createXAIGrokPlugin, XAI_GROK_PLUGIN_VERSION } from ".";
import type { XAIGrokCredential } from "./schema";

test("exports a versioned xAI Grok OAuth descriptor", async () => {
  const adapter = await adapterFrom(xaiGrokPlugin);
  expect(adapter.id).toBe("default");
  expect(adapter.label).toBe("Login with xAI Grok");
  expect(adapter.icon).toBe("xai");
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60_000 });
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(XAI_GROK_PLUGIN_VERSION).toBe(packageJson.version);
});

test("accepts localized copy without adding account options", async () => {
  const adapter = await adapterFrom(
    createXAIGrokPlugin({
      pluginLabel: "xAI Grok",
      pluginDescription: "Compte Grok",
      adapterLabel: "Connexion Grok",
      deviceInstructions: "Saisissez le code",
      waitingForAuthorization: "Autorisation xAI en attente",
    }),
  );
  expect(adapter.label).toBe("Connexion Grok");
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, XAIGrokCredential>> {
  let registered: OAuthAdapter<Record<string, never>, XAIGrokCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, XAIGrokCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error("xAI Grok OAuth adapter was not registered");
  return registered;
}
