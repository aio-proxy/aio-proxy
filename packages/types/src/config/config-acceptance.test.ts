import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AiSdkProviderSchema, ConfigAuthoringSchema, ConfigSchema, OAuthProviderSchema } from "..";
import { apiProvider, providers } from "../../_test/schemas.test-support";

const defaultServer = {
  host: "127.0.0.1",
  port: 22_078,
  logging: { enabled: false, retentionDays: 14, level: "info" },
} as const;

describe("ConfigSchema", () => {
  test("accepts api provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...apiProvider, enabled: true, id: "openai" }],
      invalidProviders: [],
    });
  });

  test("accepts a provider proxy override and headers alongside an inherited top-level proxy", () => {
    const provider = {
      ...apiProvider,
      proxy: "http://provider-proxy.example:8080",
      headers: { "X-Tenant": "team-a" },
    };

    expect(ConfigSchema.parse({ proxy: "https://proxy.example:8443", providers: { openai: provider } })).toEqual({
      plugins: [],
      server: defaultServer,
      proxy: "https://proxy.example:8443",
      providers: [{ ...provider, enabled: true, id: "openai" }],
      invalidProviders: [],
    });
  });

  test("accepts disabled provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      plugins: [],
      server: defaultServer,
      providers: [{ ...apiProvider, enabled: false, id: "openai" }],
      invalidProviders: [],
    });
  });

  test("Given oauth provider config with openai-chatgpt vendor When parsed Then it is accepted", () => {
    const provider = {
      kind: "oauth",
      plugin: "@aio-proxy/plugin-openai-chatgpt",
      capability: "default",
    };

    expect(ConfigSchema.parse({ server: {}, providers: { chatgpt: provider } })).toEqual({
      plugins: [],
      server: defaultServer,
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
      server: defaultServer,
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
      server: { ...defaultServer, port: 3000 },
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
});
