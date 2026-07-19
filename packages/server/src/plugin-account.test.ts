import type { PluginLogSink, PluginRepository, StoredAccount } from "@aio-proxy/core";

import { zod } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";

import {
  OAuthPluginAccountPreparationError,
  type PreparedOAuthPluginAccount,
  prepareOAuthPluginAccount,
} from "./plugin-account";
import { catalog, cleanup, diagnostics, runtimeFixture } from "./plugin-runtime/test-support";

afterEach(cleanup);

const config = {
  id: "person",
  kind: ProviderKind.OAuth,
  enabled: true,
  plugin: "@example/oauth",
  capability: "default",
} as const;

function replaceAccount(
  repository: PluginRepository,
  overrides: Partial<Pick<StoredAccount, "options" | "secrets" | "credential" | "label" | "expiresAt">>,
): StoredAccount {
  const current = repository.readAccount(config.id);
  if (current === null) throw new Error("account fixture missing");
  const operation = repository.stageAccountOperation({
    kind: "update",
    targetDigest: crypto.randomUUID(),
    expectedRuntimeRevision: current.runtimeRevision,
    account: {
      providerId: current.providerId,
      plugin: current.plugin,
      capability: current.capability,
      fingerprint: current.fingerprint,
      options: overrides.options ?? current.options,
      secrets: overrides.secrets ?? current.secrets,
      credential: overrides.credential ?? current.credential,
      ...(overrides.label === undefined ? {} : { label: overrides.label }),
      ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
      catalog: { kind: "replace", value: { catalog, refreshedAt: 1_000 } },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  const updated = repository.readAccount(config.id);
  if (updated === null) throw new Error("updated account fixture missing");
  return updated;
}

function options(overrides: Record<string, unknown> = {}) {
  const fixture = runtimeFixture({ kind: "static" });
  return {
    fixture,
    input: {
      config,
      plugins: fixture.plugins,
      repository: fixture.repository,
      diagnostics,
      logger: (() => {}) as PluginLogSink,
      onDiagnosticChanged: () => {},
      ...overrides,
    },
  };
}

function withAdapter(
  plugins: ReturnType<typeof runtimeFixture>["plugins"],
  change: (adapter: NonNullable<ReturnType<typeof plugins.registry.resolveOAuth>>) => unknown,
) {
  const adapter = plugins.registry.resolveOAuth(config.plugin, config.capability);
  if (adapter === undefined) throw new Error("adapter fixture missing");
  return {
    ...plugins,
    registry: {
      resolveOAuth: () => change(adapter),
      oauthCapabilities: () => [],
    },
  } as never;
}

async function expectPreparationError(
  input: Parameters<typeof prepareOAuthPluginAccount>[0],
): Promise<OAuthPluginAccountPreparationError> {
  try {
    await prepareOAuthPluginAccount(input);
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthPluginAccountPreparationError);
    return error as OAuthPluginAccountPreparationError;
  }
  throw new Error("expected account preparation to fail");
}

test("parses merged public and stored secret options and returns stored credentials", async () => {
  const { fixture, input } = options();
  const account = replaceAccount(fixture.repository, {
    options: { ignored: "stored-public" },
    secrets: { clientSecret: "stored-secret" },
    label: "Primary account",
    expiresAt: 123_456,
  });
  const plugins = withAdapter(fixture.plugins, (adapter) => ({
    ...adapter,
    account: {
      options: {
        schema: zod.object({ region: zod.string(), clientSecret: zod.string() }),
        form: [{ type: "secret", key: "clientSecret", label: "Client secret" }],
      },
    },
  }));

  const prepared = await prepareOAuthPluginAccount({
    ...input,
    config: { ...config, options: { region: "public" } },
    plugins,
  });

  expect(prepared.accountOptions).toEqual({ region: "public", clientSecret: "stored-secret" });
  expect(prepared.accountOptionsIdentity).toEqual({
    public: { region: "public" },
    secret: { clientSecret: "stored-secret" },
  });
  expect(prepared.account).toEqual(account);
  expect(prepared.accountSummary).toEqual({ accountLabel: "Primary account", expiresAt: 123_456 });
  expect(await prepared.createCredentials().read()).toEqual({ value: { token: "secret" }, revision: account.revision });
  expect(prepared.createCredentials()).not.toBe(prepared.createCredentials());
});

test.each([
  ["missing account", () => null],
  ["plugin mismatch", (account: StoredAccount) => ({ ...account, plugin: "@example/other" })],
  ["capability mismatch", (account: StoredAccount) => ({ ...account, capability: "other" })],
])("maps %s to invalid credentials without login guidance", async (_name, readAccount) => {
  const { fixture, input } = options();
  const account = fixture.repository.readAccount(config.id);
  if (account === null) throw new Error("account fixture missing");
  const error = await expectPreparationError({
    ...input,
    repository: { ...fixture.repository, readAccount: () => readAccount(account) } as PluginRepository,
  });
  expect({ code: error.code, summary: error.accountSummary, suggestLogin: error.suggestLogin }).toEqual({
    code: "CREDENTIALS_MISSING_OR_INVALID",
    summary: {},
    suggestLogin: false,
  });
});

test("maps invalid account options to login guidance with account summary", async () => {
  const { fixture, input } = options();
  replaceAccount(fixture.repository, { label: "Primary", expiresAt: 42 });
  const error = await expectPreparationError({ ...input, config: { ...config, options: [] } as never });
  expect(error).toMatchObject({
    code: "ACCOUNT_OPTIONS_INVALID",
    accountSummary: { accountLabel: "Primary", expiresAt: 42 },
    suggestLogin: true,
  });
});

test("rejects class instances as non-plain public account options", async () => {
  class PublicOptions {}
  const { input } = options();
  const error = await expectPreparationError({
    ...input,
    config: { ...config, options: new PublicOptions() } as never,
  });
  expect(error).toMatchObject({ code: "ACCOUNT_OPTIONS_INVALID", suggestLogin: true });
});

test("maps invalid credentials to login guidance with account summary", async () => {
  const { fixture, input } = options();
  replaceAccount(fixture.repository, { label: "Primary", expiresAt: 42 });
  const plugins = withAdapter(fixture.plugins, (adapter) => ({
    ...adapter,
    credentials: zod.object({ token: zod.number() }),
  }));
  const error = await expectPreparationError({ ...input, plugins });
  expect(error).toMatchObject({
    code: "CREDENTIALS_MISSING_OR_INVALID",
    accountSummary: { accountLabel: "Primary", expiresAt: 42 },
    suggestLogin: true,
  });
});

test("maps credential schema contract errors without login guidance", async () => {
  const { fixture, input } = options();
  replaceAccount(fixture.repository, { label: "Primary", expiresAt: 42 });
  const plugins = withAdapter(fixture.plugins, (adapter) => ({
    ...adapter,
    credentials: {
      safeParse() {},
      async safeParseAsync() {
        return { success: "yes" };
      },
    },
  }));
  const error = await expectPreparationError({ ...input, plugins });
  expect(error).toMatchObject({
    code: "PLUGIN_LOAD_FAILED",
    accountSummary: { accountLabel: "Primary", expiresAt: 42 },
    suggestLogin: false,
  });
});

test.each([
  ["missing plugin", "PLUGIN_NOT_INSTALLED", undefined],
  ["failed plugin", "PLUGIN_LOAD_FAILED", "failed"],
  ["missing capability", "CAPABILITY_MISSING", "capability"],
])("preserves the %s diagnostic", async (_name, code, state) => {
  const { fixture, input } = options();
  const plugins =
    state === "failed"
      ? {
          ...fixture.plugins,
          plugins: new Map([
            [
              config.plugin,
              {
                packageName: config.plugin,
                version: "1.0.0",
                builtIn: false,
                state: {
                  status: "failed",
                  diagnostic: diagnostics("PLUGIN_LOAD_FAILED", { retryable: false }),
                },
              },
            ],
          ]),
        }
      : state === "capability"
        ? { ...fixture.plugins, registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] } }
        : { ...fixture.plugins, plugins: new Map() };
  const error = await expectPreparationError({ ...input, plugins: plugins as never });
  expect(error).toMatchObject({ code, accountSummary: {}, suggestLogin: false });
});

test("forwards diagnostic callbacks and plugin secrets to each credential port", async () => {
  const logs: Parameters<PluginLogSink>[0][] = [];
  let changed = 0;
  const { input } = options({
    logger: (entry: Parameters<PluginLogSink>[0]) => logs.push(entry),
    onDiagnosticChanged: () => changed++,
    pluginSecrets: { clientSecret: "plugin-secret" },
  });
  const prepared: PreparedOAuthPluginAccount = await prepareOAuthPluginAccount(input);
  try {
    await prepared.createCredentials().refresh(prepared.account.revision, async () => {
      throw new Error("leaked plugin-secret");
    });
  } catch {}
  expect(changed).toBe(1);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.error.message).toBe("leaked [REDACTED]");
});

test("propagates unexpected preparation exceptions", async () => {
  const { fixture, input } = options();
  const unexpected = new Error("registry unavailable");
  await expect(
    prepareOAuthPluginAccount({
      ...input,
      plugins: {
        ...fixture.plugins,
        registry: {
          resolveOAuth: () => {
            throw unexpected;
          },
        },
      } as never,
    }),
  ).rejects.toBe(unexpected);
});
