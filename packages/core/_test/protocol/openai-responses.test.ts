import { describe, expect, test } from "bun:test";
import {
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesAdapter,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "../../src/index";

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
        beta_field: true,
      }),
    });

    const parsed = await openAIResponsesAdapter.parse(raw, {});

    expect(openAIResponsesAdapter.model(parsed, {})).toBe("alias");
    expect(openAIResponsesAdapter.variant(parsed, {})).toBe("high");
    expect(openAIResponsesAdapter.wantsStream(parsed, {})).toBe(false);
    expect(Object.keys(openAIResponsesAdapter.modelInvocation(parsed, {}).tools ?? {})).toEqual(["weather"]);
    expect(await (await openAIResponsesAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toMatchObject({
      model: "upstream",
      beta_field: true,
    });
    expect(openAIResponsesAdapter.modelJson).toBe(writeOpenAIResponsesResponse);
    expect(openAIResponsesAdapter.modelSse).toBe(writeOpenAIResponsesSSE);
  });

  test("rejects custom tools with the typed unsupported-feature error", async () => {
    const parsed = await openAIResponsesAdapter.parse(
      new Request("https://proxy.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "alias",
          input: "hello",
          tools: [{ type: "custom", name: "emit_raw" }],
        }),
      }),
      {},
    );

    expect(() => openAIResponsesAdapter.modelInvocation(parsed, {})).toThrow(OpenAIResponsesUnsupportedFeatureError);
  });

  test("clones the raw request when the resolved model is unchanged", async () => {
    const raw = new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "same", input: "hello", beta_field: true }),
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, "same", {});

    expect(forwarded).not.toBe(raw);
    expect(await forwarded.json()).toEqual({ model: "same", input: "hello", beta_field: true });
  });
});
