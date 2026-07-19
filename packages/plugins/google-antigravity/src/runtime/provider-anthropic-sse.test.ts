import { expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { writeAnthropicMessagesSSE } from "../../../../core/src/egress/anthropic-messages";
import { createAntigravityProviderV4 } from "./provider";
import type { CcaTransport } from "./transport";

const MODEL = "claude-opus-4-6-thinking";
const FIRST_SIGNATURE = "first-signature-".repeat(4);
const INLINE_SIGNATURE = "inline-signature-".repeat(4);
const LAST_SIGNATURE = "last-signature-".repeat(4);

test("bridges a late CCA thought signature through ProviderV4 into Anthropic SSE", async () => {
  const model = provider([
    response([
      { text: "first ", thought: true },
      { text: "second", thought: true },
      { text: "", thought: true, thoughtSignature: FIRST_SIGNATURE },
    ]),
    { candidates: [{ finishReason: "STOP" }] },
  ]).languageModel(MODEL);

  const result = await model.doStream(callOptions());
  const body = await collectBytes(writeAnthropicMessagesSSE(result.stream as never, { modelId: MODEL }));
  const thinking = parseEvents(body).filter((event) =>
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
      delta: { type: "thinking_delta", thinking: "first " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "second" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: FIRST_SIGNATURE },
    },
    { type: "content_block_stop", index: 0 },
  ]);
  expect(
    thinking
      .filter(isThinkingDelta)
      .map((event) => event.delta.thinking)
      .join(""),
  ).toBe("first second");
});

test("pairs late signatures with multiple reasoning blocks without duplicating inline metadata", async () => {
  const model = provider([
    response([
      { text: "alpha", thought: true },
      { text: "", thought: true, thoughtSignature: FIRST_SIGNATURE },
      { text: "visible" },
      { text: "beta", thought: true, thoughtSignature: INLINE_SIGNATURE },
      { text: "visible again" },
      { text: "gamma", thought: true },
      { text: "", thought: true, thoughtSignature: LAST_SIGNATURE },
    ]),
    { candidates: [{ finishReason: "STOP" }] },
  ]).languageModel(MODEL);

  const result = await model.doStream(callOptions());
  const parts = await collectParts(result.stream);
  const reasoning = parts.filter((part) => part.type.startsWith("reasoning-"));
  const starts = reasoning.filter((part) => part.type === "reasoning-start");
  const ends = reasoning.filter((part) => part.type === "reasoning-end");
  const inlineDelta = reasoning.find(
    (part) => part.type === "reasoning-delta" && "delta" in part && part.delta === "beta",
  );

  expect(parts.some((part) => part.type === "raw")).toBe(false);
  expect(starts.map(providerSignature)).toEqual([FIRST_SIGNATURE, INLINE_SIGNATURE, LAST_SIGNATURE]);
  expect(ends.map(providerSignature)).toEqual([undefined, undefined, undefined]);
  expect(providerSignature(inlineDelta)).toBe(INLINE_SIGNATURE);
});

test("does not promote an invalid late thought signature", async () => {
  const model = provider([
    response([{ text: "reasoning", thought: true }]),
    response([{ text: "", thought: true, thoughtSignature: "too-short" }]),
    { candidates: [{ finishReason: "STOP" }] },
  ]).languageModel(MODEL);

  const result = await model.doStream(callOptions());
  const parts = await collectParts(result.stream);
  const end = parts.find((part) => part.type === "reasoning-end");

  expect(providerSignature(end)).toBeUndefined();
});

test("preserves raw Google chunks only when the caller requests them", async () => {
  const event = response([{ text: "reasoning", thought: true }]);
  const model = provider([event, { candidates: [{ finishReason: "STOP" }] }]).languageModel(MODEL);

  const hidden = await model.doStream(callOptions());
  const visible = await model.doStream(callOptions(true));

  expect((await collectParts(hidden.stream)).some((part) => part.type === "raw")).toBe(false);
  expect((await collectParts(visible.stream)).filter((part) => part.type === "raw")).toEqual([
    { type: "raw", rawValue: event },
    { type: "raw", rawValue: { candidates: [{ finishReason: "STOP" }] } },
  ]);
});

test("propagates ProviderV4 stream cancellation through the signature bridge", async () => {
  const reason = { kind: "provider-stream-cancel" };
  let cancelled: unknown;
  const model = createAntigravityProviderV4({
    call: (context: LogicalRequestContext) => ({
      context,
      transport: {
        async execute() {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ response: response([{ text: "reasoning", thought: true }]) })}\n\n`,
                  ),
                );
              },
              cancel(value) {
                cancelled = value;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    }),
  }).languageModel(MODEL);
  const result = await model.doStream(callOptions());
  const reader = result.stream.getReader();
  await reader.read();
  await reader.read();

  await reader.cancel(reason);

  expect(cancelled).toBe(reason);
});

function provider(events: readonly unknown[]) {
  const transport: CcaTransport = {
    async execute() {
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const event of events) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: event })}\n\n`));
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  };
  return createAntigravityProviderV4({ call: (context: LogicalRequestContext) => ({ context, transport }) });
}

function response(parts: readonly Record<string, unknown>[]) {
  return { candidates: [{ content: { role: "model", parts } }] };
}

function callOptions(includeRawChunks = false) {
  return {
    ...(includeRawChunks ? { includeRawChunks: true } : {}),
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: {
      aioProxy: {
        logicalRequest: {
          requestId: "00000000-0000-4000-8000-000000000001",
          session: { key: "sha256:abc", source: "transcript" },
        },
      },
    },
  } as never;
}

function providerSignature(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return undefined;
  const metadata = Reflect.get(part, "providerMetadata");
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const google = Reflect.get(metadata, "google");
  return typeof google === "object" && google !== null ? Reflect.get(google, "thoughtSignature") : undefined;
}

function parseEvents(body: string): Record<string, unknown>[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "null") as Record<string, unknown>);
}

function isThinkingDelta(
  event: Record<string, unknown>,
): event is Record<string, unknown> & { delta: { type: "thinking_delta"; thinking: string } } {
  const delta = event.delta;
  return typeof delta === "object" && delta !== null && Reflect.get(delta, "type") === "thinking_delta";
}

async function collectParts<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<string> {
  const values: Uint8Array[] = [];
  for await (const value of stream) values.push(value);
  return new TextDecoder().decode(Buffer.concat(values));
}
