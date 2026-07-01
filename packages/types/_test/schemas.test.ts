import { describe, expect, test } from "bun:test";
import {
  type AioModelMessage,
  type AioStreamPart,
  ConfigSchema,
  TraceEventSchema,
} from "../src/index";

const apiProvider = {
  kind: "api",
  name: "OpenAI",
  vendor: "openai-native",
  protocol: "openai-responses",
  apiKey: "sk-test",
  models: ["gpt-5-mini"],
};

function expectIssuePath(input: unknown, path: (string | number)[]) {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
  }
}

describe("ConfigSchema", () => {
  test("accepts api provider config", () => {
    expect(ConfigSchema.parse({ providers: [apiProvider] })).toEqual({
      server: { host: "127.0.0.1", port: 22078, dashboardPort: 22079 },
      providers: [apiProvider],
    });
  });

  test("accepts subscription provider config", () => {
    const provider = {
      kind: "subscription",
      id: "copilot",
      vendor: "github-copilot",
      models: ["gpt-5-mini"],
    };

    expect(ConfigSchema.parse({ server: {}, providers: [provider] })).toEqual({
      server: { host: "127.0.0.1", port: 22078, dashboardPort: 22079 },
      providers: [provider],
    });
  });

  test("accepts ai-sdk provider config", () => {
    const provider = {
      kind: "ai-sdk",
      id: "google",
      packageName: "@ai-sdk/google",
      providerName: "google",
      models: ["gemini-2.5-flash"],
    };

    expect(ConfigSchema.parse({ providers: [provider] })).toEqual({
      server: { host: "127.0.0.1", port: 22078, dashboardPort: 22079 },
      providers: [provider],
    });
  });

  test("Given openai-compatible ai-sdk config without packageName When parsed Then default package and options are preserved", () => {
    // Given
    const provider = {
      kind: "ai-sdk",
      id: "compatible",
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      headers: { "x-test": "yes" },
      parseReasoningContent: true,
      models: ["custom-reasoner"],
    };

    // When
    const config = ConfigSchema.parse({ providers: [provider] });

    // Then
    expect(config.providers).toEqual([
      {
        ...provider,
        packageName: "@ai-sdk/openai-compatible",
      },
    ]);
  });

  test("accepts mixed provider config", () => {
    const providers = [
      apiProvider,
      { kind: "subscription", id: "copilot", vendor: "github-copilot" },
      { kind: "ai-sdk", id: "anthropic", packageName: "@ai-sdk/anthropic" },
    ];

    expect(
      ConfigSchema.parse({
        server: { host: "0.0.0.0", port: 3000, dashboardPort: 3001 },
        providers,
      }),
    ).toEqual({
      server: { host: "0.0.0.0", port: 3000, dashboardPort: 3001 },
      providers,
    });
  });

  test("rejects invalid server port at server.port", () => {
    expectIssuePath({ server: { port: 0 }, providers: [apiProvider] }, [
      "server",
      "port",
    ]);
  });

  test("rejects missing providers at providers", () => {
    expectIssuePath({ server: {} }, ["providers"]);
  });

  test("rejects unknown provider kind at providers.0.kind", () => {
    expectIssuePath({ server: {}, providers: [{ kind: "unknown" }] }, [
      "providers",
      0,
      "kind",
    ]);
  });

  test("rejects invalid api vendor at providers.0.vendor", () => {
    expectIssuePath(
      { server: {}, providers: [{ ...apiProvider, vendor: "bad-vendor" }] },
      ["providers", 0, "vendor"],
    );
  });

  test("rejects invalid api protocol at providers.0.protocol", () => {
    expectIssuePath(
      { server: {}, providers: [{ ...apiProvider, protocol: "bad-protocol" }] },
      ["providers", 0, "protocol"],
    );
  });

  test("rejects invalid subscription vendor at providers.0.vendor", () => {
    expectIssuePath(
      {
        server: {},
        providers: [{ kind: "subscription", id: "x", vendor: "github" }],
      },
      ["providers", 0, "vendor"],
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

const _message: AioModelMessage = { role: "user", content: "hello" };
const _part: AioStreamPart = { type: "text-delta", textDelta: "hi" };
void _message;
void _part;
