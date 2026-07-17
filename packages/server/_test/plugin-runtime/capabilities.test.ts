import { afterEach, expect, test } from "bun:test";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { PluginRawResolverError, PluginRawTransportError, validatePluginProtocolMap } from "../../src/plugin-runtime";
import { createRuntimeProvider, rawCapability } from "../../src/plugin-runtime/capabilities";
import { catalog, cleanup, diagnostics, materializePluginProvider, runtimeFixture } from "./test-support";

afterEach(cleanup);

test("maps every internal provider protocol to the plugin SDK protocol", () => {
  expect(validatePluginProtocolMap()).toEqual({
    [ProviderProtocol.OpenAICompatible]: "openai-compatible",
    [ProviderProtocol.OpenAIResponse]: "openai-response",
    [ProviderProtocol.Anthropic]: "anthropic",
    [ProviderProtocol.Gemini]: "gemini",
  });
});

test("rejects an array runtime carrying a provider property", () => {
  const provider = {
    specificationVersion: "v4",
    languageModel() {
      throw new Error("not called");
    },
    imageModel() {
      throw new Error("not called");
    },
    embeddingModel() {
      throw new Error("not called");
    },
  };
  const runtime = Object.assign([], { provider });

  expect(() =>
    createRuntimeProvider(
      {
        id: "person",
        kind: ProviderKind.OAuth,
        enabled: true,
        plugin: "@example/oauth",
        capability: "default",
      },
      runtime,
      catalog,
    ),
  ).toThrow("Invalid ProviderV4 runtime");
});

test("rejects an array raw transport carrying an invoke property", () => {
  const transport = Object.assign([], { invoke: async () => new Response("ok") });
  const raw = rawCapability(() => transport as never, catalog);

  expect(() => raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "model" })).toThrow(
    PluginRawResolverError,
  );
});

test("plugin raw capability receives catalog metadata and rejects malformed transports", async () => {
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      catalog: { ...catalog, language: [{ id: "model", displayName: "Model", metadata: { region: "us" } }] },
      createRuntime: async () =>
        ({
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
          raw(input) {
            observed.push(input);
            if (input.modelId === "bad-resolver") return { invoke: "invalid" } as never;
            if (input.modelId === "bad-response") return { invoke: async () => ({}) } as never;
            return { invoke: async () => new Response("ok") };
          },
        }) as never,
    },
  );
  fixture.repository.writeCatalog(
    "person",
    {
      ...catalog,
      language: [
        { id: "model", displayName: "Model", metadata: { region: "us" } },
        { id: "bad-resolver" },
        { id: "bad-response" },
      ],
    },
    1_000,
  );
  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
      alias: { client: { model: "model", preserve: false } },
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  const transport = result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "model" });
  expect(await transport?.invoke(new Request("https://example.test"))).toBeInstanceOf(Response);
  expect(observed[0]).toEqual({ protocol: "openai-compatible", modelId: "model", metadata: { region: "us" } });
  expect(result.provider?.modelMetadata?.model).toEqual({ displayName: "Model" });
  expect(result.summary.clientModels).toEqual(["client", "bad-resolver", "bad-response"]);
  expect(() =>
    result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "bad-resolver" }),
  ).toThrow(PluginRawResolverError);
  const badResponse = result.provider?.raw?.resolve({
    protocol: ProviderProtocol.OpenAICompatible,
    modelId: "bad-response",
  });
  await expect(badResponse?.invoke(new Request("https://example.test"))).rejects.toBeInstanceOf(
    PluginRawTransportError,
  );
});
