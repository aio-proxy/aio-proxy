import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AioModelMessage,
  type AioStreamPart,
  AiSdkProviderSchema,
  ApiProviderMutationBodySchema,
  CapabilityIdSchema,
  ConfigAuthoringSchema,
  ConfigSchema,
  DashboardEventSchema,
  DashboardPluginSummarySchema,
  DashboardPluginsResponseSchema,
  DashboardProviderSummarySchema,
  DashboardUsageOverviewResponseSchema,
  DiagnosticCodeSchema,
  type InvalidProviderConfig,
  OAuthPluginProviderSchema,
  OAuthProviderSchema,
  PluginPackageNameSchema,
  PluginStateSchema,
  ProviderKind,
  ProviderMutationBodySchema,
  ProviderProtocol,
  ProviderStateSchema,
  RequestOutcomeSchema,
  TraceEventSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
} from "../src/index";

const apiProvider = {
  kind: ProviderKind.Api,
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: "https://api.example.com",
};

const providers = (entries: Record<string, unknown>) => ({ providers: entries });

function expectIssuePath(input: unknown, path: (string | number)[]) {
  const result = ConfigAuthoringSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
  }
}

describe("ConfigSchema", () => {
  test("accepts api provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...apiProvider, enabled: true, id: "openai" }],
      invalidProviders: [],
    });
  });

  test("accepts disabled provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...apiProvider, enabled: false, id: "openai" }],
      invalidProviders: [],
    });
  });

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

  test("Given oauth provider config with openai-chatgpt vendor When parsed Then it is accepted", () => {
    const provider = {
      kind: "oauth",
      plugin: "@aio-proxy/plugin-openai-chatgpt",
      capability: "default",
    };

    expect(ConfigSchema.parse({ server: {}, providers: { chatgpt: provider } })).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...provider, enabled: true, id: "chatgpt" }],
      invalidProviders: [],
    });
  });

  test("Given oauth and ai-sdk provider schemas When parsed Then name is accepted", () => {
    expect(
      OAuthProviderSchema.parse({
        kind: "oauth",
        id: "x",
        plugin: "@example/oauth",
        capability: "default",
        name: "My Copilot",
      }),
    ).toEqual({
      kind: "oauth",
      id: "x",
      plugin: "@example/oauth",
      capability: "default",
      name: "My Copilot",
      enabled: true,
    });
    expect(AiSdkProviderSchema.parse({ kind: "ai-sdk", id: "y", name: "My SDK" })).toEqual({
      kind: "ai-sdk",
      id: "y",
      name: "My SDK",
      enabled: true,
      packageName: "@ai-sdk/openai-compatible",
    });
  });

  test("accepts ai-sdk provider config", () => {
    const provider = {
      kind: "ai-sdk",
      packageName: "@ai-sdk/google",
      options: { name: "google" },
      models: ["gemini-2.5-flash"],
    };

    expect(ConfigSchema.parse(providers({ google: provider }))).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...provider, enabled: true, id: "google" }],
      invalidProviders: [],
    });
  });

  test("Given openai-compatible ai-sdk config without packageName When parsed Then default package and options are preserved", () => {
    // Given
    const provider = {
      kind: "ai-sdk",
      options: {
        baseURL: "https://api.example.test/v1",
        apiKey: "sk-test",
        headers: { "x-test": "yes" },
        name: "compatible",
      },
      parseReasoningContent: true,
      models: ["custom-reasoner"],
    };

    // When
    const config = ConfigSchema.parse(providers({ compatible: provider }));

    // Then
    expect(config.providers).toEqual([
      {
        ...provider,
        enabled: true,
        id: "compatible",
        packageName: "@ai-sdk/openai-compatible",
      },
    ]);
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

  test("accepts mixed provider config", () => {
    const input = {
      openai: apiProvider,
      copilot: { kind: "oauth", plugin: "@aio-proxy/plugin-github-copilot", capability: "default" },
      anthropic: { kind: "ai-sdk", packageName: "@ai-sdk/anthropic" },
    };

    expect(
      ConfigSchema.parse({
        server: { host: "127.0.0.1", port: 3000 },
        providers: input,
      }),
    ).toEqual({
      plugins: [],
      server: { host: "127.0.0.1", port: 3000 },
      providers: [
        { ...apiProvider, enabled: true, id: "openai" },
        {
          kind: "oauth",
          enabled: true,
          id: "copilot",
          plugin: "@aio-proxy/plugin-github-copilot",
          capability: "default",
        },
        { kind: "ai-sdk", enabled: true, id: "anthropic", packageName: "@ai-sdk/anthropic" },
      ],
      invalidProviders: [],
    });
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

  test("sorts providers by descending weight and preserves key order for ties", () => {
    const config = ConfigSchema.parse(
      providers({
        first: { ...apiProvider, weight: 10 },
        second: { ...apiProvider, weight: 20 },
        third: { ...apiProvider, weight: 10 },
      }),
    );

    expect(config.providers.map((provider) => provider.id)).toEqual(["second", "first", "third"]);
    expect(config.providers.map((provider) => provider.weight)).toEqual([20, 10, 10]);
  });

  test("generates object-shaped provider input schema without value id", () => {
    const jsonSchema = z.toJSONSchema(ConfigAuthoringSchema, { io: "input" }) as {
      properties: {
        providers: {
          additionalProperties: { oneOf: { properties: Record<string, unknown> }[] };
          type: string;
        };
      };
    };

    expect(jsonSchema.properties.providers.type).toBe("object");
    for (const providerSchema of jsonSchema.properties.providers.additionalProperties.oneOf) {
      expect(providerSchema.properties).not.toHaveProperty("id");
    }
  });

  test("rejects invalid server port at server.port", () => {
    expectIssuePath({ server: { port: 0 }, providers: { openai: apiProvider } }, ["server", "port"]);
  });

  test("rejects missing providers at providers", () => {
    expectIssuePath({ server: {} }, ["providers"]);
  });

  test("rejects array providers at providers", () => {
    expectIssuePath({ server: {}, providers: [apiProvider] }, ["providers"]);
  });

  test("rejects unknown provider kind at providers.openai.kind", () => {
    expectIssuePath({ server: {}, providers: { openai: { kind: "unknown" } } }, ["providers", "openai", "kind"]);
  });

  test("rejects invalid api protocol at providers.openai.protocol", () => {
    expectIssuePath({ server: {}, providers: { openai: { ...apiProvider, protocol: "bad-protocol" } } }, [
      "providers",
      "openai",
      "protocol",
    ]);
  });

  test("rejects api provider without baseURL at providers.openai.baseURL", () => {
    const { baseURL: _baseURL, ...provider } = apiProvider;

    expectIssuePath({ server: {}, providers: { openai: provider } }, ["providers", "openai", "baseURL"]);
  });

  test("rejects removed api provider baseUrl spelling", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            kind: ProviderKind.Api,
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://api.example.com",
          },
        },
      },
      ["providers", "openai", "baseURL"],
    );
  });

  test("rejects invalid oauth vendor at providers.copilot.vendor", () => {
    expectIssuePath(
      {
        server: {},
        providers: { copilot: { kind: "oauth", vendor: "github" } },
      },
      ["providers", "copilot", "plugin"],
    );
  });

  test("unknown vendor rejected at providers.copilot.vendor", () => {
    expectIssuePath(
      {
        server: {},
        providers: { copilot: { kind: "oauth", vendor: "openai" } },
      },
      ["providers", "copilot", "plugin"],
    );
  });

  test("accepts provider alias config and normalizes variant shorthand", () => {
    const provider = {
      ...apiProvider,
      models: ["gemini-3.5-flash", "gemini-3.5-flash-medium", "gemini-3.5-flash-low"],
      alias: {
        "gemini-3-flash-agent": {
          model: "gemini-3.5-flash",
          preserve: true,
          variants: {
            medium: { model: "gemini-3.5-flash-medium", preserve: true },
            low: "gemini-3.5-flash-low",
          },
        },
        "gemini-3.5-flash": "gemini-3.5-flash",
      },
    };

    expect(ConfigSchema.parse(providers({ gemini: provider })).providers[0]).toEqual({
      ...provider,
      enabled: true,
      id: "gemini",
      alias: {
        "gemini-3-flash-agent": {
          model: "gemini-3.5-flash",
          preserve: false,
          variants: {
            medium: { model: "gemini-3.5-flash-medium", preserve: true },
            low: { model: "gemini-3.5-flash-low", preserve: false },
          },
        },
        "gemini-3.5-flash": { model: "gemini-3.5-flash", preserve: false },
      },
    });
  });

  test("accepts api provider mutation body", () => {
    expect(
      ProviderMutationBodySchema.parse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
      }),
    ).toMatchObject({ kind: "api", id: "openai" });
  });

  test("accepts ai-sdk provider mutation body", () => {
    expect(
      ProviderMutationBodySchema.parse({
        kind: "ai-sdk",
        id: "google",
        packageName: "@ai-sdk/google",
      }),
    ).toMatchObject({ kind: "ai-sdk", id: "google" });
  });

  test("rejects oauth kind in mutation body", () => {
    expect(() => ProviderMutationBodySchema.parse({ kind: "oauth", id: "x", vendor: "legacy-provider" })).toThrow();
  });

  test("requires id field", () => {
    expect(() =>
      ApiProviderMutationBodySchema.parse({
        kind: "api",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
      }),
    ).toThrow();
  });

  describe("ProviderMutationBodySchema alias", () => {
    test("Given api mutation body with alias When parsed Then alias is accepted and normalized", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: { mini: { model: "gpt-5-mini" } },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        kind: "api",
        id: "openai",
        alias: { mini: { model: "gpt-5-mini", preserve: false } },
      });
    });

    test("Given ai-sdk mutation body with alias When parsed Then alias is accepted and normalized", () => {
      // Given
      const body = {
        kind: "ai-sdk",
        id: "google",
        packageName: "@ai-sdk/google",
        models: ["gemini-2.5-flash"],
        alias: { flash: { model: "gemini-2.5-flash" } },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        kind: "ai-sdk",
        id: "google",
        alias: { flash: { model: "gemini-2.5-flash", preserve: false } },
      });
    });

    test("Given api mutation body with alias and variants When parsed Then variants are accepted and normalized", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini", "gpt-5-mini-low"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: { low: "gpt-5-mini-low" },
          },
        },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        alias: {
          mini: {
            model: "gpt-5-mini",
            preserve: false,
            variants: { low: { model: "gpt-5-mini-low", preserve: false } },
          },
        },
      });
    });

    test("Given padded alias and variant names When parsed Then keys are normalized", () => {
      const result = ProviderMutationBodySchema.parse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini", "gpt-5"],
        alias: {
          " mini ": {
            model: "gpt-5-mini",
            variants: { " HIGH ": { model: "gpt-5", preserve: false } },
          },
        },
      });

      expect(result.alias).toEqual({
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: false } },
        },
      });
    });

    test("Given api mutation body with alias target outside models When parsed Then rejects at alias.mini.model", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: { mini: { model: "missing-model" } },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "mini", "model"]);
      }
    });

    test("Given api mutation body with variant target outside models When parsed Then rejects at alias.mini.variants.low.model", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: { low: "missing-model" },
          },
        },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          "alias",
          "mini",
          "variants",
          "low",
          "model",
        ]);
      }
    });

    test("Given normalized duplicate variant keys When parsed Then rejects the duplicate", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: {
              High: "gpt-5-mini",
              " high ": "gpt-5-mini",
            },
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "mini", "variants", " high "]);
      }
    });

    test("Given normalized duplicate alias names When parsed Then rejects the duplicate", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: "gpt-5-mini",
          " mini ": "gpt-5-mini",
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", " mini "]);
      }
    });

    test("Given an explicit alias conflicting with a preserved model id When parsed Then rejects the alias", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-default", "gpt-raw"],
        alias: {
          "gpt-raw": { model: "gpt-default" },
          mini: { model: "gpt-raw", preserve: true },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "gpt-raw"]);
      }
    });

    test("Given repeated preserve declarations for one target When parsed Then accepts them", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-raw"],
        alias: {
          mini: { model: "gpt-raw", preserve: true },
          fast: { model: "gpt-raw", preserve: true },
        },
      });

      expect(result.success).toBe(true);
    });
  });

  test("Given ai-sdk mutation with a blank packageName When parsed Then it is rejected", () => {
    // Given
    const body = { kind: "ai-sdk", id: "blank-package", packageName: "   " };

    // When
    const result = ProviderMutationBodySchema.safeParse(body);

    // Then
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["packageName"]);
    }
  });

  test("rejects object model entries now that aliases are separate", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: [{ alias: "mini", id: "gpt-5-mini" }],
          },
        },
      },
      ["providers", "openai", "models", 0],
    );
  });

  test("rejects alias target outside configured models", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: ["gpt-5-mini"],
            alias: { mini: { model: "missing-model" } },
          },
        },
      },
      ["providers", "openai", "alias", "mini", "model"],
    );
  });

  test("rejects variant target outside configured models", () => {
    expectIssuePath(
      {
        server: {},
        providers: {
          openai: {
            ...apiProvider,
            models: ["gpt-5-mini"],
            alias: {
              mini: {
                model: "gpt-5-mini",
                variants: { low: "missing-model" },
              },
            },
          },
        },
      },
      ["providers", "openai", "alias", "mini", "variants", "low", "model"],
    );
  });
});

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

  test.each([
    { status: "ready" },
    { status: "failed", diagnostic: diagnostic("PLUGIN_LOAD_FAILED") },
  ] as const)("accepts plugin state $status", (state) => {
    expect(PluginStateSchema.parse(state)).toEqual(state);
  });

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

describe("TraceEventSchema", () => {
  test("roundtrips delta trace events", () => {
    const event = {
      type: "delta",
      traceId: "trace-1",
      timestamp: "2026-06-30T00:00:00.000Z",
      textDelta: "hello",
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips end trace events with usage", () => {
    const event = {
      type: "end",
      traceId: "trace-1",
      timestamp: "2026-06-30T00:00:01.000Z",
      usage: {
        providerId: "openai",
        modelId: "gpt-5-mini",
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
      },
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips usage rows with price and optional token dimensions", () => {
    const event = {
      type: "end",
      traceId: "trace-1",
      timestamp: "2026-07-09T00:00:01.000Z",
      usage: {
        providerId: "openrouter",
        modelId: "gpt-5.5",
        inputTokens: 1000,
        outputTokens: 2000,
        totalTokens: 3000,
        cacheReadTokens: 500,
        cacheWriteTokens: 250,
        reasoningTokens: 100,
        priceModelId: "openai/gpt-5.5",
        estimatedCostUsd: 0.0123,
      },
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });
});

describe("DashboardEventSchema", () => {
  test("roundtrips trace start dashboard events", () => {
    const event = {
      event: "trace.start",
      data: {
        trace_id: "trace-1",
        providerId: "openai",
        modelId: "gpt-5-mini",
      },
    };

    expect(DashboardEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips trace end dashboard events with usage", () => {
    const event = {
      event: "trace.end",
      data: {
        trace_id: "trace-1",
        usage: {
          providerId: "openai",
          modelId: "gpt-5-mini",
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
        },
      },
    };

    expect(DashboardEventSchema.parse(event)).toEqual(event);
  });
});

test("parses usage overview controls and request outcomes", () => {
  expect(UsageOverviewRangeSchema.parse("24h")).toBe("24h");
  expect(UsageOverviewMetricSchema.parse("cost")).toBe("cost");
  expect(UsageOverviewGroupBySchema.parse("model")).toBe("model");
  expect(RequestOutcomeSchema.parse("cancelled")).toBe("cancelled");
});

test("roundtrips the usage overview response", () => {
  const response = {
    range: "24h",
    metric: "cost",
    groupBy: "model",
    rangeStart: "2026-07-10T08:00:00.000Z",
    rangeEnd: "2026-07-11T08:00:00.000Z",
    bucketUnit: "hour",
    summary: {
      estimatedCostUsd: 1.25,
      pricingCoverage: 0.8,
      pricedRequestCount: 8,
      usageRequestCount: 10,
      requestCount: 12,
      successCount: 10,
      failureCount: 1,
      cancelledCount: 1,
      successRate: 10 / 11,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      averageRpm: 12 / 1440,
      averageTpm: 150 / 1440,
    },
    series: [
      { key: "openai/gpt-5", kind: "dimension" },
      { key: "__other__", kind: "other" },
    ],
    buckets: [
      {
        key: "2026-07-11 08:00",
        values: { "openai/gpt-5": 1.25, __other__: 0 },
      },
    ],
  } as const;

  expect(DashboardUsageOverviewResponseSchema.parse(response)).toEqual(response);
});

const _message: AioModelMessage = { role: "user", content: "hello" };
const _part: AioStreamPart = { type: "text-delta", textDelta: "hi" };
void _message;
void _part;
