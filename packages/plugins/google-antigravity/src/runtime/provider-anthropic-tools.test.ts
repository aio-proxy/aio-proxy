import { expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { writeAnthropicMessagesSSE } from "../../../../core/src/egress/anthropic-messages";
import { createAntigravityProviderV4 } from "./provider";
import { bridgeLateReasoningSignatures } from "./reasoning-signature-stream";
import type { CcaTransport } from "./transport";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "tool-signature-".repeat(4);
const THOUGHT = { text: "thinking", thought: true };
const SIGNATURE_PART = { text: "", thought: true, thoughtSignature: SIGNATURE };
const TOOL_CALL = { functionCall: { id: "call-1", name: "weather", args: { city: "Paris" } } };

test.each([
  ["same CCA frame", [response([THOUGHT, SIGNATURE_PART, TOOL_CALL])]],
  ["separate CCA frames", [response([THOUGHT]), response([SIGNATURE_PART, TOOL_CALL])]],
])("streams signed thinking before tool use for %s", async (_label, frames) => {
  const result = await provider([...frames, finish()])
    .languageModel(MODEL)
    .doStream(callOptions());
  const events = parseEvents(await collectBytes(writeAnthropicMessagesSSE(result.stream as never, { modelId: MODEL })));
  const contentEvents = events.filter((event) => String(event.type).startsWith("content_block_"));

  expect(contentEvents).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "thinking" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: SIGNATURE },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "call-1",
        name: "weather",
        input: {},
        caller: { type: "direct" },
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
    },
    { type: "content_block_stop", index: 1 },
  ]);
});

test("places a same-frame late signature on the earliest reasoning event", async () => {
  const result = await provider([response([THOUGHT, SIGNATURE_PART, TOOL_CALL]), finish()])
    .languageModel(MODEL)
    .doStream(callOptions(true));
  const reasoning = (await collectParts(result.stream)).filter(isReasoningPart);

  expect(reasoning.map((part) => [part.type, reasoningDelta(part), providerSignature(part)])).toEqual([
    ["reasoning-start", undefined, SIGNATURE],
    ["reasoning-delta", "thinking", undefined],
    ["reasoning-end", undefined, undefined],
  ]);
});

test("orders a raw late-signature frame before synthetic metadata and tool events", async () => {
  const result = await provider([response([THOUGHT]), response([SIGNATURE_PART, TOOL_CALL]), finish()])
    .languageModel(MODEL)
    .doStream(callOptions(true));
  const parts = await collectParts(result.stream);
  const rawIndex = parts.findIndex(isSignatureRawPart);
  const syntheticIndex = parts.findIndex(
    (part) => part.type === "reasoning-delta" && part.delta === "" && providerSignature(part) === SIGNATURE,
  );
  const toolIndex = parts.findIndex((part) => part.type === "tool-input-start");

  expect(rawIndex).toBeGreaterThanOrEqual(0);
  expect(rawIndex).toBeLessThan(syntheticIndex);
  expect(syntheticIndex).toBeLessThan(toolIndex);
  expect(
    parts
      .filter((part) => part.type === "reasoning-delta")
      .map((part) => part.delta)
      .join(""),
  ).toBe("thinking");
});

test("releases the upstream reader when the ProviderV4 stream errors", async () => {
  const failure = new Error("provider stream read failed");
  const source = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.error(failure);
    },
  });

  await expect(collectParts(bridgeLateReasoningSignatures(source, MODEL, false))).rejects.toBe(failure);
  expect(source.locked).toBe(false);
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

function finish() {
  return { candidates: [{ finishReason: "STOP" }] };
}

function callOptions(includeRawChunks = false) {
  return {
    ...(includeRawChunks ? { includeRawChunks: true } : {}),
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: {
      aioProxy: {
        logicalRequest: {
          requestId: "00000000-0000-4000-8000-000000000001",
          session: { key: "sha256:tools", source: "transcript" },
        },
      },
    },
  } as never;
}

function isReasoningPart(
  part: LanguageModelV4StreamPart,
): part is Extract<LanguageModelV4StreamPart, { type: `reasoning-${string}` }> {
  return part.type.startsWith("reasoning-");
}

function reasoningDelta(part: LanguageModelV4StreamPart): unknown {
  return part.type === "reasoning-delta" ? part.delta : undefined;
}

function isSignatureRawPart(part: LanguageModelV4StreamPart): boolean {
  if (part.type !== "raw" || typeof part.rawValue !== "object" || part.rawValue === null) return false;
  return JSON.stringify(part.rawValue).includes(SIGNATURE);
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
