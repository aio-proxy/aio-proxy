import { describe, expect, test } from "bun:test";

import {
  CapabilityIdSchema,
  ConfigSchema,
  DashboardPluginSummarySchema,
  DashboardPluginsResponseSchema,
  DashboardProviderSummarySchema,
  DiagnosticCodeSchema,
  type InvalidProviderConfig,
  OAuthPluginProviderSchema,
  OAuthProviderSchema,
  PluginPackageNameSchema,
  PluginStateSchema,
  ProviderKind,
  ProviderStateSchema,
} from "./index";

const diagnosticCodes = [
  "PLUGIN_NOT_INSTALLED",
  "PLUGIN_API_INCOMPATIBLE",
  "PLUGIN_LOAD_FAILED",
  "PLUGIN_OPTIONS_INVALID",
  "PROVIDER_CONFIG_INVALID",
  "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
  "CAPABILITY_MISSING",
  "ACCOUNT_OPTIONS_INVALID",
  "CREDENTIALS_MISSING_OR_INVALID",
  "CREDENTIAL_REFRESH_FAILED",
  "AUTHORIZATION_FAILED",
  "CATALOG_UNAVAILABLE",
  "RUNTIME_CREATE_FAILED",
] as const;

const diagnostic = (code: (typeof diagnosticCodes)[number]) => ({
  code,
  summary: `Diagnostic ${code}`,
  retryable: false,
  occurredAt: "2026-07-14T00:00:00.000Z",
});

describe("plugin and provider diagnostics", () => {
  test("accepts safe dashboard plugin summaries", () => {
    const failedPlugin = {
      packageName: "@example/broken",
      label: { default: "Broken plugin", "zh-Hans": "损坏的插件" },
      description: { default: "Example description", en: "Example description" },
      builtIn: false,
      version: "1.2.3",
      state: {
        status: "failed",
        diagnostic: {
          code: "PLUGIN_LOAD_FAILED",
          summary: "Plugin setup failed.",
          retryable: true,
          occurredAt: "2026-07-14T00:00:00.000Z",
          suggestedCommand: "aio-proxy plugin config @example/broken",
        },
      },
    } as const;

    expect(DashboardPluginSummarySchema.parse(failedPlugin)).toEqual(failedPlugin);
    expect(DashboardPluginsResponseSchema.parse({ plugins: [failedPlugin] })).toEqual({ plugins: [failedPlugin] });
  });

  test("accepts provider availability and safe OAuth account metadata", () => {
    const provider = {
      id: "copilot-octocat",
      kind: "oauth",
      enabled: true,
      passthrough: false,
      last_status: "unknown",
      last_latency: null,
      clientModels: ["gpt-4o"],
      state: { status: "ready", catalog: "stale" },
      plugin: "@aio-proxy/plugin-github-copilot",
      capability: "default",
      accountLabel: "octocat",
      expiresAt: 1_900_000_000_000,
      catalogLastSuccessAt: "2026-07-14T00:00:00.000Z",
    } as const;

    expect(DashboardProviderSummarySchema.parse(provider)).toEqual(provider);
  });

  test("allows dashboard-only invalid provider rows without widening routed provider kinds", () => {
    const provider = {
      id: "broken",
      kind: "invalid",
      enabled: false,
      passthrough: false,
      last_status: "unknown",
      last_latency: null,
      clientModels: [],
      state: { status: "unavailable", diagnostic: diagnostic("PROVIDER_CONFIG_INVALID") },
    } as const;

    expect(DashboardProviderSummarySchema.parse(provider)).toEqual(provider);
  });

  test.each(diagnosticCodes)("accepts diagnostic code %s", (code) => {
    expect(DiagnosticCodeSchema.parse(code)).toBe(code);
  });

  test.each([{ status: "ready" }, { status: "failed", diagnostic: diagnostic("PLUGIN_LOAD_FAILED") }] as const)(
    "accepts plugin state $status",
    (state) => {
      expect(PluginStateSchema.parse(state)).toEqual(state);
    },
  );

  test.each([
    ["ready", { status: "ready", catalog: "fresh" }],
    ["unavailable", { status: "unavailable", diagnostic: diagnostic("CREDENTIALS_MISSING_OR_INVALID") }],
  ] as const)("accepts provider state %s", (_status, state) => {
    expect(ProviderStateSchema.parse(state)).toEqual(state);
  });

  test("does not synthesize catalog freshness for API or AI SDK ready states", () => {
    expect(ProviderStateSchema.parse({ status: "ready" })).toEqual({ status: "ready" });
  });

  test("keeps invalid provider diagnostics free of raw provider values", () => {
    const invalidProvider: InvalidProviderConfig = {
      id: "broken-provider",
      kind: ProviderKind.OAuth,
      code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
      issuePaths: [["providers", "broken-provider", "vendor"]],
    };

    expect(invalidProvider).toEqual({
      id: "broken-provider",
      kind: ProviderKind.OAuth,
      code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
      issuePaths: [["providers", "broken-provider", "vendor"]],
    });
    expect(Object.keys(invalidProvider).sort()).toEqual(["code", "id", "issuePaths", "kind"]);
    expect(invalidProvider).not.toHaveProperty("raw");
  });
});

describe("plugin identifiers and staged OAuth provider schema", () => {
  test("accepts valid package and capability identifiers", () => {
    expect(PluginPackageNameSchema.parse(" @example/enterprise ")).toBe("@example/enterprise");
    expect(CapabilityIdSchema.parse("default")).toBe("default");
  });

  test("accepts a structured OAuth plugin provider without activating it in the legacy schema", () => {
    const provider = {
      id: "copilot-12345",
      kind: "oauth",
      plugin: "@aio-proxy/plugin-github-copilot",
      capability: "default",
      options: { deploymentType: "github.com" },
    } as const;

    expect(OAuthPluginProviderSchema.parse(provider)).toEqual({ ...provider, enabled: true });
    expect(OAuthProviderSchema.safeParse(provider).success).toBe(true);
  });
});

const providers = (entries: Record<string, unknown>) => ({ providers: entries });

describe("OAuth plugin config schema", () => {
  test("Given oauth provider input with a models key When parsed Then the output omits models", () => {
    // Given
    const provider = {
      kind: "oauth",
      plugin: "@aio-proxy/plugin-github-copilot",
      capability: "default",
      models: ["gpt-5-mini"],
    };

    // When
    const config = ConfigSchema.parse({ server: {}, providers: { copilot: provider } });

    // Then
    expect(config).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 22078 },
      providers: [
        {
          kind: "oauth",
          plugin: "@aio-proxy/plugin-github-copilot",
          capability: "default",
          enabled: true,
          id: "copilot",
        },
      ],
      invalidProviders: [],
    });
    expect(config.providers[0]).not.toHaveProperty("models");
  });

  test("Given oauth provider with alias but no models When parsed Then it passes without a models validation error", () => {
    // Given
    const provider = {
      kind: "oauth",
      plugin: "@aio-proxy/plugin-github-copilot",
      capability: "default",
      alias: { mini: { model: "gpt-5-mini" } },
    };

    // When
    const config = ConfigSchema.parse({ server: {}, providers: { copilot: provider } });

    // Then
    expect(config.providers[0]).toEqual({
      kind: "oauth",
      plugin: "@aio-proxy/plugin-github-copilot",
      capability: "default",
      enabled: true,
      id: "copilot",
      alias: { mini: { model: "gpt-5-mini", preserve: false } },
    });
    expect(config.providers[0]).not.toHaveProperty("models");
  });

  test("Given ai-sdk config with a blank packageName When parsed Then it is degraded", () => {
    // Given
    const config = providers({ blank: { kind: "ai-sdk", packageName: "   " } });

    // When
    const result = ConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.invalidProviders[0]?.issuePaths).toContainEqual(["packageName"]);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["providers", "blank", "packageName"]);
    }
  });

  test.each([
    ["blank package name", ["   "]],
    ["uppercase package name", ["@Example/plugin"]],
    ["missing scoped package name", ["@example/"]],
    ["object entry", [{ packageName: "@example/plugin" }]],
    ["tuple without options", [["@example/plugin"]]],
  ])("rejects malformed plugins: %s", (_caseName, plugins) => {
    expect(ConfigSchema.safeParse({ plugins, providers: {} }).success).toBe(false);
  });
});
