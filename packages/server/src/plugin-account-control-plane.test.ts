import { collectSecretStrings, type PluginLogSink } from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";

import { type PrepareOAuthPluginAccountOptions, prepareOAuthPluginAccount } from "./plugin-account";
import { cleanup, diagnostics, runtimeFixture } from "./plugin-runtime/test-support";

afterEach(cleanup);

const config = {
  id: "person",
  kind: ProviderKind.OAuth,
  enabled: true,
  plugin: "@example/oauth",
  capability: "default",
} as const;

function input(logger: PluginLogSink = () => {}) {
  const fixture = runtimeFixture({ kind: "static" });
  return {
    config,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger,
    onDiagnosticChanged: () => {},
  };
}

test("control-plane preparation exposes only collected plugin secret values to its credential port", async () => {
  const logs: Parameters<PluginLogSink>[0][] = [];
  const rawPluginSecrets = { nested: { clientSecret: "plugin-alpha-9384" } };
  const controlPlaneInput = {
    ...input((entry) => logs.push(entry)),
    credentialMode: "control-plane",
    pluginSecretValues: collectSecretStrings(rawPluginSecrets),
  } satisfies PrepareOAuthPluginAccountOptions;
  const prepared = await prepareOAuthPluginAccount(controlPlaneInput);

  expect(prepared.credentialMode).toBe("control-plane");
  expect(prepared).not.toHaveProperty("account");
  expect(prepared).not.toHaveProperty("accountOptionsIdentity");
  expect(prepared).not.toHaveProperty("pluginSecrets");
  expect(prepared.secretValues).toContain("plugin-alpha-9384");
  rawPluginSecrets.nested.clientSecret = "late-beta-7291";
  const credentials = prepared.createCredentials();
  const current = await credentials.read();
  await expect(
    credentials.refresh(current.revision, async () => {
      throw new Error("plugin-alpha-9384 late-beta-7291");
    }),
  ).rejects.toThrow("plugin-alpha-9384 late-beta-7291");

  expect(logs).toHaveLength(1);
  expect(logs[0]?.error.message).toBe("[REDACTED] late-beta-7291");
});

test("control-plane preparation rejects raw plugin secret objects at the type seam", () => {
  // @ts-expect-error control-plane preparation accepts collected strings, never the raw plugin secret object
  const invalid: PrepareOAuthPluginAccountOptions = {
    ...input(),
    credentialMode: "control-plane",
    pluginSecrets: { clientSecret: "raw-plugin-secret" },
  };
  expect(invalid.credentialMode).toBe("control-plane");
});
