import { describe, test } from "bun:test";
import { ProviderKind, ProviderProtocol } from "../src/index";
import { apiProvider, expectIssuePath } from "./schemas.test-support";

describe("ConfigSchema", () => {
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
