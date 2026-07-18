import { afterEach, describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { createTempHomes, recorded, textStream } from "../../_test/openai-responses.test-support";
import { createServer } from "../server";

const homes = createTempHomes("aio-proxy-responses-fallback-");
afterEach(homes.cleanup);

const rawOnlyFeatures = [
  {
    name: "stored response",
    body: { model: "gpt-5.6-terra", input: "hello", store: true },
  },
  {
    name: "previous response reference",
    body: { model: "gpt-5.6-terra", input: "hello", previous_response_id: "resp_1" },
  },
  {
    name: "item reference",
    body: { model: "gpt-5.6-terra", input: [{ type: "item_reference", id: "item_1" }] },
  },
  {
    name: "unknown semantic item",
    body: { model: "gpt-5.6-terra", input: [{ type: "future_semantic_item", id: "item_1" }] },
  },
  {
    name: "unknown top-level field",
    body: { model: "gpt-5.6-terra", input: "hello", future_semantics: true },
  },
] as const;

describe("OpenAI Responses fallback HTTP integration", () => {
  for (const scenario of rawOnlyFeatures) {
    test(`skips a model-only candidate for ${scenario.name} and falls back to raw`, async () => {
      let modelInvoked = false;
      let rawBody: unknown;
      const model = {
        id: "model",
        kind: "ai-sdk",
        models: ["gpt-5.6-terra"],
        alias: { "gpt-5.6-terra": { model: "gpt-5.6-terra", preserve: false } },
        invoke() {
          modelInvoked = true;
          return textStream([]);
        },
      } satisfies AiSdkProviderInstance;
      const raw = {
        id: "raw",
        kind: "api",
        models: ["gpt-5.6-terra"],
        alias: { "gpt-5.6-terra": { model: "gpt-5.6-terra", preserve: false } },
        protocol: ProviderProtocol.OpenAIResponse,
        async passthrough(request) {
          rawBody = await request.json();
          return Response.json({ fallback: true });
        },
      } satisfies ApiProviderInstance;
      const dbHome = homes.tempHome();
      const app = await createServer({
        config: { providers: {} },
        dbHome,
        providerInstances: [model, raw],
      });

      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenario.body),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ fallback: true });
      expect(modelInvoked).toBe(false);
      expect(rawBody).toEqual(scenario.body);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            outcome: "success",
            attempts: [
              expect.objectContaining({
                index: 0,
                providerId: "model",
                outcome: "failure",
                statusCode: 501,
                errorCode: "unsupported_feature",
              }),
              expect.objectContaining({ index: 1, providerId: "raw", outcome: "success", statusCode: 200 }),
            ],
          }),
        ],
        usages: [],
      });
    });
  }
});
