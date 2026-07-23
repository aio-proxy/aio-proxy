import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import {
  anthropicMessagesAdapter,
  anthropicMessagesErrors,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from "../../index";

function request(body: object): Request {
  return new Request("https://proxy.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("anthropicMessagesAdapter", () => {
  test("preserves an ordered tool exchange, rewrites only the model, and exposes current boundaries", async () => {
    const body = {
      model: "alias",
      system: [
        {
          type: "text",
          text: "Use tools.",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_weather",
              name: "weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_weather",
              content: "Sunny",
            },
            { type: "text", text: "Summarize." },
          ],
        },
      ],
      beta_field: { enabled: true },
    };
    const raw = request(body);

    const parsed = await anthropicMessagesAdapter.parse(raw, {});
    const invocation = anthropicMessagesAdapter.modelInvocation(parsed, {});

    expect(anthropicMessagesAdapter.protocol).toBe(ProviderProtocol.Anthropic);
    expect(anthropicMessagesAdapter.model(parsed, {})).toBe("alias");
    expect(anthropicMessagesAdapter.variant(parsed, {})).toBeUndefined();
    expect(anthropicMessagesAdapter.wantsStream(parsed, {})).toBe(false);
    expect(invocation.messages[0]).toEqual({
      role: "system",
      content: "Use tools.",
      providerOptions: {
        anthropic: {
          system: [
            {
              type: "text",
              text: "Use tools.",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      },
    });
    expect(invocation.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_weather",
            toolName: "weather",
            input: { city: "Paris" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_weather",
            toolName: "weather",
            output: { type: "text", value: "Sunny" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Summarize." }] },
    ]);
    expect(await (await anthropicMessagesAdapter.rawRequest(raw, parsed, "upstream", {})).json()).toEqual({
      ...body,
      model: "upstream",
    });
    expect(anthropicMessagesAdapter.modelJson).toBe(writeAnthropicMessagesResponse);
    expect(anthropicMessagesAdapter.modelSse).toBe(writeAnthropicMessagesSSE);
    expect(anthropicMessagesAdapter.errors).toBe(anthropicMessagesErrors);
  });

  for (const [label, stream, wantsStream, settings] of [
    ["absent", undefined, false, {}],
    ["false", false, false, { stream: false }],
    ["true", true, true, { stream: true }],
  ] as const) {
    test(`handles stream ${label}`, async () => {
      const parsed = await anthropicMessagesAdapter.parse(
        request({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
          ...(stream === undefined ? {} : { stream }),
        }),
        {},
      );

      expect(anthropicMessagesAdapter.wantsStream(parsed, {})).toBe(wantsStream);
      expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).settings).toEqual(settings);
    });
  }

  test("clones the raw request when the resolved model is unchanged", async () => {
    const body = {
      model: "same",
      messages: [{ role: "user", content: "hello" }],
      beta_field: true,
    };
    const raw = request(body);
    const parsed = await anthropicMessagesAdapter.parse(raw, {});

    const forwarded = await anthropicMessagesAdapter.rawRequest(raw, parsed, "same", {});

    expect(forwarded).not.toBe(raw);
    expect(await forwarded.json()).toEqual(body);
  });

  test("preserves an empty user content array as an empty user message", async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [] }],
      }),
      {},
    );

    expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages).toEqual([{ role: "user", content: [] }]);
  });

  test("routes adaptive effort as the alias variant", async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32768,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      }),
      {},
    );

    expect(anthropicMessagesAdapter.variant(parsed, {})).toBe("medium");
  });
});
