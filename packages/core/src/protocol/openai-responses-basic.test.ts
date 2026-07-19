import { describe, expect, test } from "bun:test";
import { openAIResponsesAdapter, writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from "../index";

describe("openAIResponsesAdapter", () => {
  test("defaults to non-stream and exposes routing, tools, and current writers", async () => {
    const raw = new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "alias",
        input: "hello",
        tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
        reasoning: { effort: "high" },
      }),
    });

    const parsed = await openAIResponsesAdapter.parse(raw, {});

    expect(openAIResponsesAdapter.model(parsed, {})).toBe("alias");
    expect(openAIResponsesAdapter.variant(parsed, {})).toBe("high");
    expect(openAIResponsesAdapter.wantsStream(parsed, {})).toBe(false);
    const invocation = openAIResponsesAdapter.modelInvocation(parsed, {});
    expect(Object.keys(invocation.tools ?? {})).toEqual(["weather"]);
    expect(invocation.settings).toEqual({ reasoning: "high" });
    expect(await (await openAIResponsesAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toMatchObject({
      model: "upstream",
    });
    expect(openAIResponsesAdapter.modelJson).toBe(writeOpenAIResponsesResponse);
    expect(openAIResponsesAdapter.modelSse).toBe(writeOpenAIResponsesSSE);
  });

  test("wraps custom tools as metadata-carrying function tools", async () => {
    const parsed = await openAIResponsesAdapter.parse(
      new Request("https://proxy.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "alias", input: "hello", tools: [{ type: "custom", name: "emit_raw" }] }),
      }),
      {},
    );

    const customTool = Object.entries(openAIResponsesAdapter.modelInvocation(parsed, {}).tools ?? {}).find(
      ([name]) => name === "emit_raw",
    )?.[1];
    expect(customTool).toMatchObject({
      type: "function",
      metadata: {
        aioProxy: { openaiResponses: { protocol: "openai-responses", wireToolType: "custom" } },
      },
    });
  });

  test("clones the raw request when the resolved model is unchanged", async () => {
    const body = Bun.gzipSync(
      new TextEncoder().encode(JSON.stringify({ model: "same", input: "hello", beta_field: true })),
    );
    const raw = new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
        "x-sentinel": "preserved",
      },
      body,
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, "same", {});

    expect(forwarded).not.toBe(raw);
    expect(forwarded.headers.get("content-encoding")).toBe("gzip");
    expect(forwarded.headers.get("content-length")).toBe(String(body.byteLength));
    expect(forwarded.headers.get("x-sentinel")).toBe("preserved");
    expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(body);
  });
});
