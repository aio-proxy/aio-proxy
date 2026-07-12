import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import {
  anthropicMessagesAdapter,
  anthropicMessagesErrors,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from "../../src/index";

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

  test("flushes user content on kind changes and preserves part provider options", async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Check both tools.", signature: "sig-123" },
              {
                type: "text",
                text: "Calling tools.",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
              {
                type: "tool_use",
                id: "toolu_weather",
                name: "weather",
                input: { city: "Paris" },
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
              {
                type: "tool_use",
                id: "toolu_clock",
                name: "clock",
                input: { zone: "UTC" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Before ",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
              { type: "text", text: "results." },
              {
                type: "tool_result",
                tool_use_id: "toolu_weather",
                content: "Sunny",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_clock",
                content: [{ type: "text", text: "12:00" }],
              },
              { type: "text", text: "After." },
            ],
          },
        ],
      }),
      {},
    );

    expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Check both tools.",
            providerOptions: { anthropic: { signature: "sig-123" } },
          },
          {
            type: "text",
            text: "Calling tools.",
            providerOptions: { anthropic: { cache_control: { type: "ephemeral", ttl: "1h" } } },
          },
          {
            type: "tool-call",
            toolCallId: "toolu_weather",
            toolName: "weather",
            input: { city: "Paris" },
            providerOptions: { anthropic: { cache_control: { type: "ephemeral", ttl: "5m" } } },
          },
          {
            type: "tool-call",
            toolCallId: "toolu_clock",
            toolName: "clock",
            input: { zone: "UTC" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Before ",
            providerOptions: { anthropic: { cache_control: { type: "ephemeral", ttl: "5m" } } },
          },
          { type: "text", text: "results." },
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
            providerOptions: { anthropic: { cache_control: { type: "ephemeral", ttl: "1h" } } },
          },
          {
            type: "tool-result",
            toolCallId: "toolu_clock",
            toolName: "clock",
            output: { type: "content", value: [{ type: "text", text: "12:00" }] },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "After." }] },
    ]);
  });

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
});
