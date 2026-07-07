import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AioModelMessage,
  type AioStreamPart,
  ConfigSchema,
  DashboardEventSchema,
  OAuthVendor,
  TraceEventSchema,
} from "../src/index";

const apiProvider = {
  kind: "api",
  name: "OpenAI",
  protocol: "openai-response",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  models: ["gpt-5-mini"],
};

const providers = (entries: Record<string, unknown>) => ({ providers: entries });

function expectIssuePath(input: unknown, path: (string | number)[]) {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
  }
}

describe("ConfigSchema", () => {
  test("accepts api provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...apiProvider, enabled: true, id: "openai" }],
    });
  });

  test("accepts disabled provider config", () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...apiProvider, enabled: false, id: "openai" }],
    });
  });

  test("Given oauth provider input with a models key When parsed Then the output omits models", () => {
    // Given
    const provider = {
      kind: "oauth",
      vendor: OAuthVendor.GitHubCopilot,
      models: ["gpt-5-mini"],
    };

    // When
    const config = ConfigSchema.parse({ server: {}, providers: { copilot: provider } });

    // Then
    expect(config).toEqual({
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ kind: "oauth", vendor: OAuthVendor.GitHubCopilot, enabled: true, id: "copilot" }],
    });
    expect(config.providers[0]).not.toHaveProperty("models");
  });

  test("Given oauth provider with alias but no models When parsed Then it passes without a models validation error", () => {
    // Given
    const provider = {
      kind: "oauth",
      vendor: OAuthVendor.GitHubCopilot,
      alias: { mini: { model: "gpt-5-mini" } },
    };

    // When
    const config = ConfigSchema.parse({ server: {}, providers: { copilot: provider } });

    // Then
    expect(config.providers[0]).toEqual({
      kind: "oauth",
      vendor: OAuthVendor.GitHubCopilot,
      enabled: true,
      id: "copilot",
      alias: { mini: { model: "gpt-5-mini", preserve: false } },
    });
    expect(config.providers[0]).not.toHaveProperty("models");
  });

  test("Given oauth provider config with openai-chatgpt vendor When parsed Then it is accepted", () => {
    const provider = {
      kind: "oauth",
      vendor: OAuthVendor.OpenAIChatGPT,
    };

    expect(ConfigSchema.parse({ server: {}, providers: { chatgpt: provider } })).toEqual({
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...provider, enabled: true, id: "chatgpt" }],
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
      server: { host: "127.0.0.1", port: 22078 },
      providers: [{ ...provider, enabled: true, id: "google" }],
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
      copilot: { kind: "oauth", vendor: OAuthVendor.GitHubCopilot },
      anthropic: { kind: "ai-sdk", packageName: "@ai-sdk/anthropic" },
    };

    expect(
      ConfigSchema.parse({
        server: { host: "0.0.0.0", port: 3000 },
        providers: input,
      }),
    ).toEqual({
      server: { host: "0.0.0.0", port: 3000 },
      providers: [
        { ...apiProvider, enabled: true, id: "openai" },
        { kind: "oauth", enabled: true, id: "copilot", vendor: OAuthVendor.GitHubCopilot },
        { kind: "ai-sdk", enabled: true, id: "anthropic", packageName: "@ai-sdk/anthropic" },
      ],
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
    const jsonSchema = z.toJSONSchema(ConfigSchema, { io: "input" }) as {
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

  test("rejects api provider without baseUrl at providers.openai.baseUrl", () => {
    const { baseUrl: _baseUrl, ...provider } = apiProvider;

    expectIssuePath({ server: {}, providers: { openai: provider } }, ["providers", "openai", "baseUrl"]);
  });

  test("rejects invalid oauth vendor at providers.copilot.vendor", () => {
    expectIssuePath(
      {
        server: {},
        providers: { copilot: { kind: "oauth", vendor: "github" } },
      },
      ["providers", "copilot", "vendor"],
    );
  });

  test("unknown vendor rejected at providers.copilot.vendor", () => {
    expectIssuePath(
      {
        server: {},
        providers: { copilot: { kind: "oauth", vendor: "openai" } },
      },
      ["providers", "copilot", "vendor"],
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

const _message: AioModelMessage = { role: "user", content: "hello" };
const _part: AioStreamPart = { type: "text-delta", textDelta: "hi" };
void _message;
void _part;
