import { zod } from "@aio-proxy/plugin-sdk";
import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  OAuthQuotaReadError,
  OAuthQuotaResetError,
  OAuthQuotaResetUnavailableError,
  OAuthQuotaResetUnsupportedError,
} from "./errors";
import { createOAuthQuotaResetter } from "./reset";
import {
  availableQuotaSnapshot,
  capturedQuotaError,
  cleanupQuotaFixtures,
  createQuotaFixture,
  PROVIDER_ID,
  quotaSignal,
} from "./test-support";

afterEach(cleanupQuotaFixtures);

test("redacts a refreshed credential observed during mutation from the mutation failure", async () => {
  const refreshedSecret = "reset-refreshed-credential-secret";
  const fixture = createQuotaFixture({
    read: async () => availableQuotaSnapshot,
    reset: async ({ credentials }) => {
      const current = await credentials.read();
      await credentials.refresh(current.revision, async () => ({ value: { token: refreshedSecret } }));
      throw new Error(`credential-secret account-secret plugin-secret ${refreshedSecret}`);
    },
  });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetError);
  expect(error).not.toHaveProperty("cause");
  expect(fixture.logs).toHaveLength(1);
  expect(JSON.stringify(fixture.logs)).not.toMatch(
    /credential-secret|account-secret|plugin-secret|reset-refreshed-credential-secret/u,
  );
  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: refreshedSecret });
});

test("retains a refreshed credential discovered in preflight for later mutation failure redaction", async () => {
  const refreshedSecret = "preflight-refreshed-credential-secret";
  const fixture = createQuotaFixture({
    read: async ({ credentials }) => {
      const current = await credentials.read();
      await credentials.refresh(current.revision, async () => ({ value: { token: refreshedSecret } }));
      return availableQuotaSnapshot;
    },
    reset: async () => {
      throw new Error(refreshedSecret);
    },
  });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetError);
  expect(fixture.logs).toHaveLength(1);
  expect(JSON.stringify(fixture.logs)).not.toContain(refreshedSecret);
  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: refreshedSecret });
});

test("redacts a secret derived by account option parsing from reset failures", async () => {
  const derivedSecret = Buffer.from("account-secret").toString("base64");
  const fixture = createQuotaFixture({
    accountOptions: {
      schema: zod
        .object({ region: zod.string(), clientSecret: zod.string() })
        .transform(({ clientSecret }) => ({ authorization: Buffer.from(clientSecret).toString("base64") })),
      form: [{ type: "secret", key: "clientSecret", label: "Client secret" }],
    },
    read: async () => availableQuotaSnapshot,
    reset: async ({ options }) => {
      expect(options).toEqual({ authorization: derivedSecret });
      throw new Error(`quota reset rejected ${derivedSecret}`);
    },
  });

  await capturedQuotaError(createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()));

  expect(JSON.stringify(fixture.logs)).not.toContain(derivedSecret);
});

test("preserves the stable reset error when the mutation failure logger throws", async () => {
  const fixture = createQuotaFixture({
    loggerFailure: true,
    read: async () => availableQuotaSnapshot,
    reset: async () => {
      throw new Error("plugin failed");
    },
  });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetError);
  expect(error).toMatchObject({
    name: "OAuthQuotaResetError",
    message: "OAuth quota reset failed",
    code: "OAUTH_QUOTA_RESET_FAILED",
  });
  expect(error).not.toHaveProperty("cause");
});

test.each([
  ["unsupported", {}, OAuthQuotaResetUnsupportedError],
  ["unavailable", { read: async () => ({ items: [] }), reset: async () => {} }, OAuthQuotaResetUnavailableError],
  [
    "preflight",
    { read: async () => Promise.reject(new Error("preflight failed")), reset: async () => {} },
    OAuthQuotaReadError,
  ],
  [
    "mutation",
    {
      read: async () => availableQuotaSnapshot,
      reset: async () => Promise.reject(new Error("mutation failed")),
    },
    OAuthQuotaResetError,
  ],
] as const)(
  "leaves routing and persistent diagnostics unchanged for a %s failure",
  async (_name, options, ErrorType) => {
    const fixture = createQuotaFixture(options);
    fixture.repository.writeDiagnostic(PROVIDER_ID, {
      code: "AUTHORIZATION_FAILED",
      summary: "existing",
      retryable: false,
      occurredAt: new Date(0).toISOString(),
    });
    const { providerStates, providers, router } = fixture.snapshot;
    const statesBefore = structuredClone([...(providerStates ?? [])]);
    const providersBefore = providers.map(({ id, kind, enabled, models, plugin, capability }) => ({
      id,
      kind,
      enabled,
      models: models === undefined ? undefined : [...models],
      plugin,
      capability,
    }));
    const routesBefore = router.resolve("model").map(({ provider, modelId }) => ({ providerId: provider.id, modelId }));
    const diagnosticsBefore = fixture.repository.readDiagnostics(PROVIDER_ID);

    const error = await capturedQuotaError(
      createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
    );

    expect(error).toBeInstanceOf(ErrorType);
    expect(fixture.snapshot.providerStates).toBe(providerStates);
    expect([...(fixture.snapshot.providerStates ?? [])]).toEqual(statesBefore);
    expect(fixture.snapshot.providers).toBe(providers);
    expect(
      fixture.snapshot.providers.map(({ id, kind, enabled, models, plugin, capability }) => ({
        id,
        kind,
        enabled,
        models: models === undefined ? undefined : [...models],
        plugin,
        capability,
      })),
    ).toEqual(providersBefore);
    expect(fixture.snapshot.router).toBe(router);
    expect(
      fixture.snapshot.router.resolve("model").map(({ provider, modelId }) => ({ providerId: provider.id, modelId })),
    ).toEqual(routesBefore);
    expect(fixture.repository.readDiagnostics(PROVIDER_ID)).toEqual(diagnosticsBefore);
    expect(fixture.changed()).toBe(0);
  },
);
