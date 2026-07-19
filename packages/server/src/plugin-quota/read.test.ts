import type { OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";

import { afterEach, expect, test } from "bun:test";

import { OAuthQuotaCapabilityUnavailableError, OAuthQuotaReadError } from "./errors";
import { createOAuthQuotaReader } from "./read";
import {
  CAPABILITY,
  cleanupQuotaFixtures,
  createQuotaFixture,
  PLUGIN,
  PROVIDER_ID,
  type QuotaFixtureOptions,
} from "./test-support";

afterEach(cleanupQuotaFixtures);

async function capturedError(promise: Promise<unknown>): Promise<Error & { readonly code?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & { readonly code?: string };
  }
  throw new Error("expected operation to reject");
}

test("resolves the leased OAuth Provider ID and passes parsed account context with the exact signal", async () => {
  let credential: unknown;
  const raw: OAuthQuotaSnapshot = {
    items: [
      { id: "weekly", label: "Weekly" },
      { id: "five-hour", label: "Five hour" },
    ],
  };
  const fixture = createQuotaFixture({
    read: async (context) => {
      credential = await context.credentials.read();
      return raw;
    },
  });
  const signal = new AbortController().signal;

  const result = await createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, signal);

  expect(fixture.readCalls()).toBe(1);
  expect(fixture.contexts[0]).toMatchObject({
    options: { region: "us-east", clientSecret: "account-secret" },
  });
  expect(fixture.contexts[0]?.signal).toBe(signal);
  expect(credential).toMatchObject({ value: { token: "credential-secret" } });
  expect(result).not.toBe(raw);
  expect(result.items.map(({ id }) => id)).toEqual(["weekly", "five-hour"]);
});

test("maps malformed plugin snapshots to one stable redacted read failure", async () => {
  const fixture = createQuotaFixture({
    read: async () =>
      ({
        items: [{ id: "credential-secret account-secret plugin-secret", label: "Bad", remainingRatio: 2 }],
      }) as never,
  });

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(error).toMatchObject({
    name: "OAuthQuotaReadError",
    message: "OAuth quota read failed",
    code: "OAUTH_QUOTA_READ_FAILED",
  });
  expect(error).not.toHaveProperty("cause");
  expect(fixture.logs).toHaveLength(1);
  expect(fixture.logs[0]).toMatchObject({
    event: "plugin.quota.read.failed",
    code: "QUOTA_READ_FAILED",
    context: { plugin: PLUGIN, capability: CAPABILITY, providerId: PROVIDER_ID },
  });
  expect(JSON.stringify(fixture.logs)).not.toMatch(/credential-secret|account-secret|plugin-secret/u);
});

test("redacts credential, account, and plugin secrets without mutating routing or diagnostic state", async () => {
  const failure = new Error("credential-secret account-secret plugin-secret");
  failure.stack = "Error: credential-secret account-secret plugin-secret\n at quota";
  const fixture = createQuotaFixture({
    read: async () => {
      throw failure;
    },
  });
  fixture.repository.writeDiagnostic(PROVIDER_ID, {
    code: "AUTHORIZATION_FAILED",
    summary: "existing",
    retryable: false,
    occurredAt: new Date(0).toISOString(),
  });
  const { providerStates, providers, router } = fixture.snapshot;
  const beforeProviderStates = structuredClone([...(providerStates ?? [])]);
  const beforeProviders = providers.map(({ id, kind, enabled, models, plugin, capability }) => ({
    id,
    kind,
    enabled,
    models: models === undefined ? undefined : [...models],
    plugin,
    capability,
  }));
  const beforeRoutes = router.resolve("model").map(({ provider, modelId }) => ({ providerId: provider.id, modelId }));
  const beforeDiagnostics = fixture.repository.readDiagnostics(PROVIDER_ID);

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(error).not.toHaveProperty("cause");
  expect(fixture.logs).toHaveLength(1);
  expect(JSON.stringify(fixture.logs)).not.toMatch(/credential-secret|account-secret|plugin-secret/u);
  expect(fixture.snapshot.providerStates).toBe(providerStates);
  expect([...(fixture.snapshot.providerStates ?? [])]).toEqual(beforeProviderStates);
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
  ).toEqual(beforeProviders);
  expect(fixture.snapshot.router).toBe(router);
  expect(
    fixture.snapshot.router.resolve("model").map(({ provider, modelId }) => ({ providerId: provider.id, modelId })),
  ).toEqual(beforeRoutes);
  expect(fixture.repository.readDiagnostics(PROVIDER_ID)).toEqual(beforeDiagnostics);
  expect(fixture.changed()).toBe(0);
});

const unavailableCases: readonly [string, QuotaFixtureOptions][] = [
  ["missing provider", { provider: "missing" }],
  ["non-OAuth provider", { provider: "api" }],
  ["missing plugin", { pluginState: "missing" }],
  ["failed plugin", { pluginState: "failed" }],
  ["missing capability", { capability: "missing" }],
  ["failed capability resolution", { capability: "throw" }],
  ["missing account", { account: "missing" }],
  ["mismatched account", { account: "mismatch" }],
  ["invalid account options", { account: "invalid-options" }],
  ["invalid credential", { account: "invalid-credential" }],
  ["failed plugin secret read", { pluginSecretFailure: true }],
  ["absent quota capability", { quota: false }],
];

test.each(unavailableCases)(
  "rejects %s as a stable capability-unavailable error without plugin invocation",
  async (_name, options) => {
    const fixture = createQuotaFixture(options);

    const error = await capturedError(
      createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
    );

    expect(error).toBeInstanceOf(OAuthQuotaCapabilityUnavailableError);
    expect(error).toMatchObject({
      name: "OAuthQuotaCapabilityUnavailableError",
      message: "OAuth quota capability is unavailable",
      code: "OAUTH_QUOTA_CAPABILITY_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(fixture.readCalls()).toBe(0);
    expect(fixture.logs).toHaveLength(0);
  },
);

test("holds the old snapshot lease through plugin settlement and ignores a concurrent swap", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const old = createQuotaFixture({
    itemId: "old",
    read: async () => {
      started.resolve();
      await release.promise;
      return { items: [{ id: "old", label: "Old" }] };
    },
  });
  const next = createQuotaFixture({ itemId: "new", region: "next-region" });
  const pending = createOAuthQuotaReader(old.dependencies).read(PROVIDER_ID, new AbortController().signal);
  await started.promise;
  const retired = old.manager.swap(next.snapshot);
  let drained = false;
  void retired.whenDrained.then(() => {
    drained = true;
  });
  await Promise.resolve();

  expect(drained).toBe(false);
  expect(next.readCalls()).toBe(0);
  release.resolve();
  expect((await pending).items.map(({ id }) => id)).toEqual(["old"]);
  expect(old.contexts[0]?.options).toMatchObject({ region: "us-east" });
  await retired.whenDrained;
  expect(drained).toBe(true);
  expect(next.readCalls()).toBe(0);
});

test("intentionally invokes the plugin twice for simultaneous reads of one Provider ID", async () => {
  const release = Promise.withResolvers<void>();
  const fixture = createQuotaFixture({
    read: async () => {
      await release.promise;
      return { items: [{ id: "direct", label: "Direct" }] };
    },
  });
  const reader = createOAuthQuotaReader(fixture.dependencies);
  const signal = new AbortController().signal;
  const reads = Promise.all([reader.read(PROVIDER_ID, signal), reader.read(PROVIDER_ID, signal)]);
  for (let index = 0; index < 20 && fixture.readCalls() < 2; index++) {
    await Promise.resolve();
  }

  expect(fixture.readCalls()).toBe(2);
  release.resolve();
  expect(await reads).toHaveLength(2);
});
