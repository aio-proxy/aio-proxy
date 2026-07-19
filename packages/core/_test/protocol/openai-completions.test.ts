import { describe, expect, test } from "bun:test";

import { openAICompletionsAdapter, writeOpenAICompletionsResponse, writeOpenAICompletionsSSE } from "../../src/index";

describe("openAICompletionsAdapter", () => {
  test("parses routing metadata, transforms tools, and rewrites only the model", async () => {
    const raw = new Request("https://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "alias",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
        reasoning_effort: "high",
        beta_field: true,
      }),
    });

    const parsed = await openAICompletionsAdapter.parse(raw, {});

    expect(openAICompletionsAdapter.model(parsed, {})).toBe("alias");
    expect(openAICompletionsAdapter.variant(parsed, {})).toBe("high");
    const invocation = openAICompletionsAdapter.modelInvocation(parsed, {});
    expect(Object.keys(invocation.tools ?? {})).toEqual(["weather"]);
    expect(invocation.settings).toEqual({ reasoning: "high" });
    expect(await (await openAICompletionsAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toMatchObject({
      model: "upstream",
      beta_field: true,
    });
    expect(openAICompletionsAdapter.modelJson).toBe(writeOpenAICompletionsResponse);
    expect(openAICompletionsAdapter.modelSse).toBe(writeOpenAICompletionsSSE);
  });

  test("clones the raw request when the resolved model is unchanged", async () => {
    const raw = new Request("https://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "same", messages: [{ role: "user", content: "hello" }], beta_field: true }),
    });
    const parsed = await openAICompletionsAdapter.parse(raw, {});

    const forwarded = await openAICompletionsAdapter.rawRequest(raw, parsed, "same", {});

    expect(forwarded).not.toBe(raw);
    expect(await forwarded.json()).toEqual({
      model: "same",
      messages: [{ role: "user", content: "hello" }],
      beta_field: true,
    });
  });
});
