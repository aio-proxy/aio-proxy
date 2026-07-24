import { expect, test } from "bun:test";

import { parseAnthropicMessages } from "../ingress/anthropic-messages/index";
import { anthropicMessagesToModelMessages } from "../transform/anthropic-messages/index";
import { anthropicThinkingOption } from "./anthropic-thinking";

test.each([
  [{ thinking: { type: "disabled" }, max_tokens: 8192 }, { mode: "disabled" }],
  [
    { thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 8192 },
    { mode: "fixed", budgetTokens: 2048 },
  ],
  [
    { thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 32768 },
    { mode: "adaptive", effort: "high" },
  ],
])("maps Anthropic thinking %#", (input, expected) => {
  expect(anthropicThinkingOption(input as never)).toEqual(expected);
});

test("returns no option when thinking and effort are absent", () => {
  expect(anthropicThinkingOption({ max_tokens: 8192 } as never)).toBeUndefined();
});

test.each([
  [{ type: "enabled", budget_tokens: 1023 }, 8192, undefined],
  [{ type: "enabled", budget_tokens: 8192 }, 8192, undefined],
  [{ type: "enabled" }, 8192, undefined],
  [{ type: "enabled", budget_tokens: 2048 }, undefined, undefined],
  [{ type: "adaptive" }, 8192, undefined],
  [{ type: "disabled" }, 8192, "high"],
  [undefined, 8192, "high"],
])("rejects invalid fixed/adaptive settings %#", (thinking, maxTokens, effort) => {
  expect(() =>
    anthropicThinkingOption({
      thinking,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(effort === undefined ? {} : { output_config: { effort } }),
    } as never),
  ).toThrow();
});

test.each(["unknown", { type: "enabled", budget_tokens: 2048.5 }])(
  "rejects unknown or malformed thinking input %# through ingress",
  (thinking) => {
    expect(() =>
      parseAnthropicMessages({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 8192,
        thinking,
      }),
    ).toThrow();
  },
);

test("merges thinking into aioProxy provider options", () => {
  const request = parseAnthropicMessages({
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 2048 },
  });

  expect(anthropicMessagesToModelMessages(request).settings.providerOptions).toEqual({
    aioProxy: { thinking: { mode: "fixed", budgetTokens: 2048 } },
  });
});
