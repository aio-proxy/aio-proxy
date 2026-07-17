import { afterEach, describe, expect, test } from "bun:test";
import type { ApiProviderInstance } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { createTempHomes } from "../../_test/openai-responses.test-support";
import { createServer } from "../server";
import type { ServerLog } from "../server-log";

const homes = createTempHomes("aio-proxy-responses-raw-");
afterEach(homes.cleanup);

describe("OpenAI Responses raw HTTP integration", () => {
  test("raw-forwards opencode developer and function-tool history without loss", async () => {
    const bodiesSeen: unknown[] = [];
    const provider = {
      id: "responses",
      kind: "api",
      models: ["upstream-gpt"],
      alias: { "gpt-5.6-terra": { model: "upstream-gpt", preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(request) {
        bodiesSeen.push(await request.json());
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: homes.tempHome(),
      providerInstances: [provider],
    });
    const first = {
      model: "gpt-5.6-terra",
      input: [
        { role: "developer", content: "Use tools when needed." },
        { role: "user", content: [{ type: "input_text", text: "Look up the weather." }] },
      ],
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      opencode_extension: { retain: true },
    };
    const followup = {
      model: "gpt-5.6-terra",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque-state",
          summary: [{ type: "summary_text", text: "Used the weather tool." }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "lookup_weather",
          arguments: '{"city":"Paris"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "Sunny" },
        { role: "user", content: "Summarize the result." },
      ],
      opencode_extension: { retain: true },
    };

    for (const body of [first, followup]) {
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }

    expect(bodiesSeen).toEqual([
      { ...first, model: "upstream-gpt" },
      { ...followup, model: "upstream-gpt" },
    ]);
  });

  test("drops background before raw forwarding and logs one synchronous downgrade", async () => {
    const logs: ServerLog[] = [];
    let bodySeen: unknown;
    const provider = {
      id: "responses",
      kind: "api",
      models: ["gpt-5.6-terra"],
      alias: { "gpt-5.6-terra": { model: "gpt-5.6-terra", preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(request) {
        bodySeen = await request.json();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: homes.tempHome(),
      providerInstances: [provider],
      logger: (entry) => logs.push(entry),
    });

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello", background: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(bodySeen).toEqual({ model: "gpt-5.6-terra", input: "hello" });
    expect(logs).toEqual([
      {
        event: "request.feature_downgraded",
        requestId: expect.any(String),
        inboundProtocol: ProviderProtocol.OpenAIResponse,
        requestedModelId: "gpt-5.6-terra",
        path: "/v1/responses",
        feature: "background",
        action: "dropped",
        effectiveMode: "synchronous",
      },
    ]);
  });
});
