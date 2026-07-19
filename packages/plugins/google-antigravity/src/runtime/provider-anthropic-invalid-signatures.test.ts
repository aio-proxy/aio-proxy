import { expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import {
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from "../../../../core/src/egress/anthropic-messages";
import { createAntigravityProviderV4 } from "./provider";
import { bridgeLateReasoningSignatures } from "./reasoning-signature-stream";
import type { CcaTransport } from "./transport";

const MODEL = "claude-opus-4-6-thinking";
const VALID_SIGNATURE = "valid-late-signature-".repeat(3);
const INVALID_SIGNATURES = ["short", "skip_thought_signature_validator", "x".repeat(49)] as const;

test.each(
  INVALID_SIGNATURES.flatMap((signature) => [
    { preserveRaw: false, signature },
    { preserveRaw: true, signature },
  ]),
)("strips invalid inline signature '$signature' with preserveRaw=$preserveRaw", async ({ preserveRaw, signature }) => {
  const events = [response([{ text: "reasoning", thought: true, thoughtSignature: signature }]), finish()];
  const model = provider(events).languageModel(MODEL);

  const jsonResult = await model.doStream(callOptions(preserveRaw));
  const json = await writeAnthropicMessagesResponse(jsonResult.stream as never, { modelId: MODEL });
  expect(json.content).toEqual([]);

  const sseResult = await model.doStream(callOptions(preserveRaw));
  const sse = await collectBytes(writeAnthropicMessagesSSE(sseResult.stream as never, { modelId: MODEL }));
  expect(sse).not.toContain('"type":"thinking"');
  expect(sse).not.toContain("thinking_delta");
  expect(sse).not.toContain("signature_delta");

  const directResult = await model.doStream(callOptions(preserveRaw));
  const parts = await collectParts(directResult.stream);
  expect(parts.filter(isReasoningPart).map(providerSignature)).toEqual([undefined, undefined, undefined]);
  expect(parts.some((part) => part.type === "raw")).toBe(preserveRaw);
});

test.each([
  false,
  true,
])("uses one valid late signature after invalid inline metadata with preserveRaw=%s", async (preserveRaw) => {
  const events = [
    response([{ text: "reasoning", thought: true, thoughtSignature: "short" }]),
    response([{ text: "", thought: true, thoughtSignature: VALID_SIGNATURE }]),
    finish(),
  ];
  const model = provider(events).languageModel(MODEL);

  const jsonResult = await model.doStream(callOptions(preserveRaw));
  const json = await writeAnthropicMessagesResponse(jsonResult.stream as never, { modelId: MODEL });
  expect(json.content).toEqual([{ type: "thinking", thinking: "reasoning", signature: VALID_SIGNATURE }]);

  const sseResult = await model.doStream(callOptions(preserveRaw));
  const contentEvents = parseEvents(
    await collectBytes(writeAnthropicMessagesSSE(sseResult.stream as never, { modelId: MODEL })),
  ).filter((event) => String(event.type).startsWith("content_block_"));
  expect(contentEvents).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "reasoning" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: VALID_SIGNATURE },
    },
    { type: "content_block_stop", index: 0 },
  ]);
});

test("removes only the invalid Google signature field from every reasoning lifecycle part", async () => {
  const metadata = {
    anthropic: { retained: "anthropic" },
    google: { thoughtSignature: "short", retained: "google" },
    vertex: { retained: "vertex" },
  };
  const source = parts([
    { type: "reasoning-start", id: "reasoning", providerMetadata: metadata },
    { type: "reasoning-delta", id: "reasoning", delta: "exact text", providerMetadata: metadata },
    { type: "reasoning-end", id: "reasoning", providerMetadata: metadata },
  ] as LanguageModelV4StreamPart[]);

  expect(await collectParts(bridgeLateReasoningSignatures(source, MODEL, false))).toEqual([
    { type: "reasoning-start", id: "reasoning", providerMetadata: sanitizedMetadata() },
    {
      type: "reasoning-delta",
      id: "reasoning",
      delta: "exact text",
      providerMetadata: sanitizedMetadata(),
    },
    { type: "reasoning-end", id: "reasoning", providerMetadata: sanitizedMetadata() },
  ]);
});

function sanitizedMetadata() {
  return {
    anthropic: { retained: "anthropic" },
    google: { retained: "google" },
    vertex: { retained: "vertex" },
  };
}

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

function response(values: readonly Record<string, unknown>[]) {
  return { candidates: [{ content: { role: "model", parts: values } }] };
}

function finish() {
  return { candidates: [{ finishReason: "STOP" }] };
}

function callOptions(includeRawChunks: boolean) {
  return {
    ...(includeRawChunks ? { includeRawChunks: true } : {}),
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: {
      aioProxy: {
        logicalRequest: {
          requestId: crypto.randomUUID(),
          session: { key: "sha256:invalid-inline", source: "transcript" },
        },
      },
    },
  } as never;
}

function isReasoningPart(part: LanguageModelV4StreamPart): boolean {
  return part.type.startsWith("reasoning-");
}

function providerSignature(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return undefined;
  const metadata = Reflect.get(part, "providerMetadata");
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const google = Reflect.get(metadata, "google");
  return typeof google === "object" && google !== null ? Reflect.get(google, "thoughtSignature") : undefined;
}

function parts(values: readonly LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
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
