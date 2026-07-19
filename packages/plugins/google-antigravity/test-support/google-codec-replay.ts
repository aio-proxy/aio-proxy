import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { createGoogle } from "@ai-sdk/google";

import type { ReasoningReplay } from "../src/protocol/replay-cache";

import { ReasoningReplayCache } from "../src/protocol/replay-cache";
import { captureReasoningReplay } from "../src/runtime/session-state";

export const TEST_MODEL = "claude-opus-4-6-thinking";

export async function codecCalls(events: readonly Record<string, unknown>[]) {
  let generatedId = 0;
  const google = createGoogle({
    apiKey: "test-key",
    baseURL: "https://example.test",
    generateId: () => `generated-${generatedId++}`,
    fetch: async () => googleSseResponse(events),
  });
  const result = await google.languageModel(TEST_MODEL).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "use tools" }] }],
  });
  const parts = await collectParts(result.stream);
  return parts.flatMap((part) => {
    if (part.type !== "tool-call" || part.providerExecuted === true) return [];
    return [{ id: part.toolCallId, name: part.toolName, args: canonicalCodecInput(part.input) }];
  });
}

export async function capturedReplay(
  events: readonly Record<string, unknown>[],
  marker: string,
): Promise<ReasoningReplay | undefined> {
  const cache = new ReasoningReplayCache();
  const scope = cache.begin(TEST_MODEL, `sha256:${marker}`, `request-${marker}`);
  const response = await captureReasoningReplay(ccaSseResponse(events), TEST_MODEL, scope, cache);
  await response.text();
  return cache.read(scope.key);
}

function canonicalCodecInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function googleSseResponse(events: readonly Record<string, unknown>[]): Response {
  return sseResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`));
}

function ccaSseResponse(events: readonly Record<string, unknown>[]): Response {
  return sseResponse(events.map((event) => `data: ${JSON.stringify({ response: event })}\n\n`));
}

function sseResponse(frames: readonly string[]): Response {
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function collectParts(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}
