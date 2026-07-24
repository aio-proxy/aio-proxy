import type { AiSdkProviderInstance, ApiProviderInstance, ProviderFetch } from "@aio-proxy/core";

import { ConfigSchema, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { withAttemptLogContext, withRequestLogContext } from "../request-logging";
import { materializeProviders } from "./materialize";

test("materialized provider fetches observe final upstream requests only inside debug attempts", async () => {
  const config = ConfigSchema.parse({
    proxy: "http://global.proxy.test:8080",
    providers: {
      api: {
        baseURL: "https://api.provider.test",
        kind: ProviderKind.Api,
        models: ["api-model"],
        protocol: ProviderProtocol.OpenAICompatible,
      },
      sdk: {
        kind: ProviderKind.AiSdk,
        models: ["sdk-model"],
        packageName: "@ai-sdk/openai-compatible",
        proxy: "http://sdk.proxy.test:9090",
      },
    },
  });
  const logs: ServerLog[] = [];
  const proxies: (string | undefined)[] = [];
  const delegated: { readonly proxy: string | undefined; readonly url: string }[] = [];
  let apiFetch: ProviderFetch | undefined;
  let bridgeFetch: ProviderFetch | undefined;
  let aiSdkFetch: ProviderFetch | undefined;

  const runtime = materializeProviders(config, {
    createProxyFetch(proxy) {
      proxies.push(proxy);
      return (async (input, init) => {
        delegated.push({ proxy, url: new Request(input, init).url });
        return new Response(null, { status: 204 });
      }) as ProviderFetch;
    },
    createApiProvider(provider, options) {
      apiFetch = options.fetch;
      return {
        ...provider,
        passthrough: (request) => apiFetch!(request),
      } satisfies ApiProviderInstance;
    },
    bridgeApiProvider(provider, options) {
      bridgeFetch = options.fetch;
      return {
        enabled: true,
        id: `${provider.id}:bridge`,
        invoke: () => new ReadableStream(),
        kind: ProviderKind.AiSdk,
      } satisfies AiSdkProviderInstance;
    },
    createAiSdkProvider(provider, options) {
      aiSdkFetch = options.fetch;
      return {
        enabled: true,
        ensureAvailable: async () => {
          await aiSdkFetch!("https://sdk.provider.test/probe");
        },
        id: provider.id,
        invoke: () => new ReadableStream(),
        kind: ProviderKind.AiSdk,
      } satisfies AiSdkProviderInstance;
    },
  });

  expect(proxies).toEqual(["http://global.proxy.test:8080", "http://sdk.proxy.test:9090"]);
  expect(apiFetch).toBe(bridgeFetch);

  expect(await Promise.all([...runtime.probes.values()].map((probe) => probe()))).toEqual(["OK", "OK"]);
  expect(delegated).toHaveLength(2);
  expect(logs).toEqual([]);

  await withRequestLogContext(
    { requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) },
    async () => {
      await withAttemptLogContext({ attemptIndex: 0, providerId: "api", modelId: "api-model" }, () =>
        apiFetch!("https://final-api.test/v1/responses?api_key=api-query-secret", {
          body: JSON.stringify({ apiKey: "api-body-secret", model: "api-model", prompt: "api-prompt-secret" }),
          headers: {
            "content-type": "application/json",
            "user-agent": "api-generated-agent",
            "x-api-key": "api-header-secret",
          },
          method: "POST",
        }),
      );
      await withAttemptLogContext({ attemptIndex: 1, providerId: "sdk", modelId: "sdk-model" }, () =>
        aiSdkFetch!("https://final-sdk.test/v1/chat/completions?token=sdk-query-secret", {
          body: JSON.stringify({ messages: [{ content: "sdk-content-secret", role: "user" }], model: "sdk-model" }),
          headers: {
            accept: "application/json",
            authorization: "Bearer sdk-header-secret",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
    },
  );

  const snapshots = logs.filter((entry) => entry.event === "request.upstream_snapshot");
  expect(snapshots).toHaveLength(2);
  expect(snapshots).toEqual([
    expect.objectContaining({
      attemptIndex: 0,
      providerId: "api",
      modelId: "api-model",
      method: "POST",
      url: "https://final-api.test/v1/responses?api_key=%5BREDACTED%5D",
      headers: {
        "content-type": "application/json",
        "user-agent": "api-generated-agent",
        "x-api-key": "[REDACTED]",
      },
      body: expect.objectContaining({
        json: {
          apiKey: expect.objectContaining({ kind: "redacted" }),
          model: "api-model",
          prompt: expect.objectContaining({ kind: "payload" }),
        },
      }),
    }),
    expect.objectContaining({
      attemptIndex: 1,
      providerId: "sdk",
      modelId: "sdk-model",
      method: "POST",
      url: "https://final-sdk.test/v1/chat/completions?token=%5BREDACTED%5D",
      headers: {
        accept: "application/json",
        authorization: "[REDACTED]",
        "content-type": "application/json",
      },
      body: expect.objectContaining({
        json: {
          messages: [{ content: expect.objectContaining({ kind: "payload" }), role: "user" }],
          model: "sdk-model",
        },
      }),
    }),
  ]);
  expect(JSON.stringify(logs)).not.toContain("secret");
  expect(delegated).toHaveLength(4);
});
