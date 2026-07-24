import { ProviderProtocol } from "@aio-proxy/types";
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
    expect(invocation.settings).toEqual({
      providerOptions: { openai: { store: false } },
      reasoning: "high",
    });
    expect(await (await openAIResponsesAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toMatchObject({
      model: "upstream",
    });
    expect(openAIResponsesAdapter.modelJson).toBe(writeOpenAIResponsesResponse);
    expect(openAIResponsesAdapter.modelSse).toBe(writeOpenAIResponsesSSE);
  });

  test("keeps custom tools portable outside the OpenAI Responses target", async () => {
    const base = await customInvocation();
    const portableMessage = base.messages[0];
    const portableTool = base.tools?.emit_raw;

    expect(base.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "emit_raw", input: { input: "pwd" } }],
    });
    expect(portableTool).toMatchObject({ type: "function" });
    expect(openAIResponsesAdapter.modelInvocationForTarget(base, ProviderProtocol.Anthropic)).toBe(base);

    const specialized = openAIResponsesAdapter.modelInvocationForTarget(base, ProviderProtocol.OpenAIResponse);

    expect(specialized).not.toBe(base);
    expect(specialized.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "emit_raw", input: "pwd" }],
    });
    expect(base.messages[0]).toBe(portableMessage);
    expect(base.tools?.emit_raw).toBe(portableTool);
  });

  test("leaves noncanonical custom input portable during target materialization", async () => {
    const base = await customInvocation();
    const assistant = base.messages[0];
    if (assistant?.role !== "assistant" || typeof assistant.content === "string") {
      throw new TypeError("Expected custom tool-call history");
    }
    const malformed = {
      ...base,
      messages: [
        {
          ...assistant,
          content: assistant.content.map((part) =>
            part.type === "tool-call" ? { ...part, input: { input: 42 } } : part,
          ),
        },
        ...base.messages.slice(1),
      ],
    };

    const specialized = openAIResponsesAdapter.modelInvocationForTarget(malformed, ProviderProtocol.OpenAIResponse);

    expect(specialized.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", input: { input: 42 } }],
    });
  });

  test("clones the raw request when the resolved model is unchanged", async () => {
    const body = Bun.zstdCompressSync(
      new TextEncoder().encode(JSON.stringify({ model: "same", input: "hello", beta_field: true })),
    );
    const raw = new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
        "x-sentinel": "preserved",
      },
      body,
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, "same", {});

    expect(forwarded).not.toBe(raw);
    expect(forwarded.headers.get("content-encoding")).toBe("zstd");
    expect(forwarded.headers.get("content-length")).toBe(String(body.byteLength));
    expect(forwarded.headers.get("x-sentinel")).toBe("preserved");
    expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(body);
  });
});

async function customInvocation() {
  const parsed = await openAIResponsesAdapter.parse(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "alias",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "emit_raw", input: "pwd" },
          { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
        ],
        tools: [{ type: "custom", name: "emit_raw" }],
      }),
    }),
    {},
  );
  return openAIResponsesAdapter.modelInvocation(parsed, {});
}
