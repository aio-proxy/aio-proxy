import type { RawResolver } from "@aio-proxy/plugin-sdk";

import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";

import { PluginRawResolverError, PluginRawTransportError, validatePluginProtocolMap } from "./index";
import { catalog, cleanup, diagnostics, materializePluginProvider, runtimeFixture } from "./test-support";

afterEach(cleanup);

const providerConfig = {
  id: "person",
  kind: ProviderKind.OAuth,
  enabled: true,
  plugin: "@example/oauth",
  capability: "default",
} as const;

const providerV4 = () => ({
  specificationVersion: "v4" as const,
  languageModel() {
    throw new Error("not called");
  },
  imageModel() {
    throw new Error("not called");
  },
  embeddingModel() {
    throw new Error("not called");
  },
});

const materializeFixture = (fixture: ReturnType<typeof runtimeFixture>) =>
  materializePluginProvider({
    config: providerConfig,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

test("maps every internal provider protocol to the plugin SDK protocol", () => {
  expect(validatePluginProtocolMap()).toEqual({
    [ProviderProtocol.OpenAICompatible]: "openai-compatible",
    [ProviderProtocol.OpenAIResponse]: "openai-response",
    [ProviderProtocol.Anthropic]: "anthropic",
    [ProviderProtocol.Gemini]: "gemini",
  });
});

test("rejects an array runtime carrying a provider property", async () => {
  const runtime = Object.assign([], { provider: providerV4() });
  const fixture = runtimeFixture({ kind: "static" }, { createRuntime: async () => runtime as never });

  const result = await materializeFixture(fixture);

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: "unavailable", diagnostic: { code: "RUNTIME_CREATE_FAILED" } });
});

test("rejects an array raw transport carrying an invoke property", async () => {
  const transport = Object.assign([], { invoke: async () => new Response("ok") });
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      createRuntime: async () => ({ provider: providerV4(), raw: () => transport as never }),
    },
  );

  const result = await materializeFixture(fixture);

  expect(() =>
    result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "model" }),
  ).toThrow(PluginRawResolverError);
});

test("plugin raw capability receives catalog metadata and rejects malformed transports", async () => {
  const modelId = "model";
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      catalog: { ...catalog, language: [{ id: "model", displayName: "Model", metadata: { region: "us" } }] },
      createRuntime: async () =>
        ({
          provider: providerV4(),
          raw(input: Parameters<RawResolver>[0]) {
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
  expect(result.provider?.modelMetadata?.[modelId]).toEqual({ displayName: "Model" });
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

test("materializes an optional plugin token-count capability", async () => {
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      createRuntime: async () => ({
        provider: providerV4(),
        tokenCount: { countTokens: async () => ({ inputTokens: 13 }) },
      }),
    },
  );

  const result = await materializeFixture(fixture);
  const input = {
    protocol: "anthropic" as const,
    modelId: "model",
    request: new Request("https://proxy.test/v1/messages/count_tokens"),
    context: { requestId: "request", session: { key: "sha256:test" as const, source: "transcript" as const } },
    invocation: { messages: [{ role: "user" as const, content: "hello" }] },
  };

  expect(await result.provider?.tokenCount?.countTokens(input)).toEqual({ inputTokens: 13 });
});
