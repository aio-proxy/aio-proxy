import { expect, test } from "bun:test";
import { parseAnthropicMessages } from "../ingress/anthropic-messages";
import { anthropicMessagesAdapter } from "./anthropic-messages";

const webSearchTypes = ["web_search_20250305", "web_search_20260209", "web_search_20260318"] as const;

test.each(webSearchTypes)("parses Anthropic %s as a provider-executed tool", (type) => {
  const request = parseAnthropicMessages(
    messagesWithTool({
      type,
      name: "web_search",
      max_uses: 8,
      allowed_domains: ["example.com"],
      blocked_domains: [],
    }),
  );

  expect(anthropicMessagesAdapter.modelInvocation(request, {}).providerTools).toEqual([
    {
      type: "web-search",
      name: "web_search",
      maxUses: 8,
      allowedDomains: ["example.com"],
    },
  ]);
});

test.each(webSearchTypes)("normalizes nullable Anthropic %s options as absent", (type) => {
  const request = parseAnthropicMessages(
    messagesWithTool({
      type,
      name: "web_search",
      max_uses: null,
      allowed_domains: null,
      blocked_domains: null,
    }),
  );

  expect(anthropicMessagesAdapter.modelInvocation(request, {}).providerTools).toEqual([
    { type: "web-search", name: "web_search" },
  ]);
});

test.each(webSearchTypes)("rejects Anthropic %s with non-empty allowed and blocked domains", (type) => {
  expect(() =>
    parseAnthropicMessages(
      messagesWithTool({
        type,
        name: "web_search",
        allowed_domains: ["allowed.example"],
        blocked_domains: ["blocked.example"],
      }),
    ),
  ).toThrow();
});

test("normalizes empty Anthropic web-search domain arrays as absent", () => {
  const request = parseAnthropicMessages(
    messagesWithTool({
      type: "web_search_20260318",
      name: "web_search",
      allowed_domains: [],
      blocked_domains: [],
    }),
  );

  expect(anthropicMessagesAdapter.modelInvocation(request, {}).providerTools).toEqual([
    { type: "web-search", name: "web_search" },
  ]);
});

test("partitions function tools from provider-executed tools and keeps non-empty blocked domains", () => {
  const request = parseAnthropicMessages({
    ...messagesWithTool({
      type: "web_search_20260318",
      name: "web_search",
      blocked_domains: ["blocked.example"],
    }),
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
      {
        type: "web_search_20260318",
        name: "web_search",
        blocked_domains: ["blocked.example"],
      },
    ],
  });

  const invocation = anthropicMessagesAdapter.modelInvocation(request, {});

  expect(Object.keys(invocation.tools ?? {})).toEqual(["lookup"]);
  expect(invocation.providerTools).toEqual([
    {
      type: "web-search",
      name: "web_search",
      blockedDomains: ["blocked.example"],
    },
  ]);
});

test("rejects arbitrary Anthropic typed tools", () => {
  expect(() =>
    parseAnthropicMessages(
      messagesWithTool({
        type: "computer_20250124",
        name: "computer",
      }),
    ),
  ).toThrow();
});

function messagesWithTool(tool: unknown) {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Search the web" }],
    max_tokens: 256,
    tools: [tool],
  };
}
