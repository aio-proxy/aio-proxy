import { expect, test } from "bun:test";

import type { TextStreamPart, ToolSet } from "../ai-sdk-bridge";

import { writeAnthropicMessagesResponse, writeAnthropicMessagesSSE } from "./anthropic-messages";

const SIGNATURE = "anthropic-signature-".repeat(3);
const OPTIONS_SIGNATURE = "options-signature-".repeat(4);

test("writes reasoning as an Anthropic thinking JSON block", async () => {
  const response = await writeAnthropicMessagesResponse(
    parts([
      { type: "reasoning-start", id: "reasoning", providerMetadata: metadata() },
      { type: "reasoning-delta", id: "reasoning", text: "reasoning text", providerMetadata: metadata() },
      { type: "reasoning-end", id: "reasoning", providerMetadata: metadata() },
    ]),
    { modelId: "claude-opus-4-6-thinking" },
  );

  expect(response.content).toEqual([{ type: "thinking", thinking: "reasoning text", signature: SIGNATURE }]);
  expect(JSON.stringify(response.content)).not.toContain("providerMetadata");
});

test("streams thinking, signature, and stop events in Anthropic order", async () => {
  const body = await collect(
    writeAnthropicMessagesSSE(
      parts([
        { type: "reasoning-start", id: "reasoning", providerMetadata: metadata() },
        { type: "reasoning-delta", id: "reasoning", text: "reasoning text", providerMetadata: metadata() },
        { type: "reasoning-end", id: "reasoning", providerMetadata: metadata() },
      ]),
      { modelId: "claude-opus-4-6-thinking" },
    ),
  );
  const events = body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "null") as Record<string, unknown>);
  const thinking = events.filter((event) =>
    ["content_block_start", "content_block_delta", "content_block_stop"].includes(String(event.type)),
  );

  expect(thinking).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "reasoning text" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: SIGNATURE },
    },
    { type: "content_block_stop", index: 0 },
  ]);
});

test("maps Google thought-signature metadata into an Anthropic thinking block", async () => {
  const response = await writeAnthropicMessagesResponse(
    parts([
      { type: "reasoning-start", id: "reasoning", providerMetadata: googleMetadata() },
      { type: "reasoning-delta", id: "reasoning", text: "reasoning text", providerMetadata: googleMetadata() },
      { type: "reasoning-end", id: "reasoning", providerMetadata: googleMetadata() },
    ]),
    { modelId: "claude-opus-4-6-thinking" },
  );

  expect(response.content).toEqual([{ type: "thinking", thinking: "reasoning text", signature: SIGNATURE }]);
});

test("does not stream an Anthropic thinking block without a signature", async () => {
  const body = await collect(
    writeAnthropicMessagesSSE(
      parts([
        { type: "reasoning-start", id: "reasoning" },
        { type: "reasoning-delta", id: "reasoning", text: "unsigned reasoning" },
        { type: "reasoning-end", id: "reasoning" },
      ]),
      { modelId: "unsigned-reasoner" },
    ),
  );

  expect(body).not.toContain("content_block_start");
  expect(body).not.toContain("thinking_delta");
  expect(body).not.toContain("signature_delta");
});

test("JSON falls back from non-signature metadata to an Anthropic provider-options signature", async () => {
  const response = await writeAnthropicMessagesResponse(
    parts([
      { type: "reasoning-start", id: "reasoning", ...fallbackContainers() },
      { type: "reasoning-delta", id: "reasoning", text: "reasoning text", ...fallbackContainers() },
      { type: "reasoning-end", id: "reasoning", ...fallbackContainers() },
    ]),
    { modelId: "claude-opus-4-6-thinking" },
  );

  expect(response.content).toEqual([{ type: "thinking", thinking: "reasoning text", signature: OPTIONS_SIGNATURE }]);
});

test("SSE falls back from non-signature metadata to an Anthropic provider-options signature", async () => {
  const body = await collect(
    writeAnthropicMessagesSSE(
      parts([
        { type: "reasoning-start", id: "reasoning", ...fallbackContainers() },
        { type: "reasoning-delta", id: "reasoning", text: "reasoning text", ...fallbackContainers() },
        { type: "reasoning-end", id: "reasoning", ...fallbackContainers() },
      ]),
      { modelId: "claude-opus-4-6-thinking" },
    ),
  );

  expect(body).toContain(`"type":"signature_delta","signature":"${OPTIONS_SIGNATURE}"`);
});

test("prefers the Anthropic namespace across containers before Google and Vertex", async () => {
  const response = await writeAnthropicMessagesResponse(
    parts([
      {
        type: "reasoning-delta",
        id: "reasoning",
        text: "reasoning text",
        providerMetadata: { google: { thoughtSignature: SIGNATURE } },
        providerOptions: { anthropic: { signature: OPTIONS_SIGNATURE } },
      },
    ]),
    { modelId: "claude-opus-4-6-thinking" },
  );

  expect(response.content).toEqual([{ type: "thinking", thinking: "reasoning text", signature: OPTIONS_SIGNATURE }]);
});

function metadata() {
  return { anthropic: { signature: SIGNATURE } };
}

function googleMetadata() {
  return { google: { thoughtSignature: SIGNATURE } };
}

function fallbackContainers() {
  return {
    providerMetadata: { google: { unrelated: true } },
    providerOptions: { anthropic: { signature: OPTIONS_SIGNATURE } },
  };
}

function parts(values: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}
