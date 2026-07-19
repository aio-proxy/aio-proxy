import type {
  MessageDeltaUsage,
  RawMessageStreamEvent,
  StopReason,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type { LanguageModelV2FinishReason } from "../../ai-sdk-bridge";

const encoder = new TextEncoder();

export type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
};

export function messageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

export function textStart(index: number): Uint8Array {
  return event({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });
}

export function thinkingStart(index: number): Uint8Array {
  return event({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
}

export function contentBlockStop(index: number): Uint8Array {
  return event({ type: "content_block_stop", index });
}

export function anthropicUsage(usage: TokenUsage): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

export function messageDeltaUsage(usage: TokenUsage): MessageDeltaUsage {
  return {
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? 0,
    output_tokens_details: null,
    server_tool_use: null,
  };
}

export function anthropicStopReason(finishReason: LanguageModelV2FinishReason): StopReason {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "refusal";
    case "error":
    case "stop":
    case "unknown":
    case "other":
      return "end_turn";
  }
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
}

export function reasoningSignature(part: unknown): string | undefined {
  const value = record(part);
  const containers = [
    record(Reflect.get(value ?? {}, "providerMetadata")),
    record(Reflect.get(value ?? {}, "providerOptions")),
  ];
  const anthropic = signatureFromContainers(containers, "anthropic", "signature");
  if (anthropic !== undefined) return anthropic;
  for (const namespace of ["google", "vertex"] as const) {
    const signature = signatureFromContainers(containers, namespace, "thoughtSignature");
    if (signature !== undefined) return signature;
  }
  return undefined;
}

function signatureFromContainers(
  containers: readonly (Readonly<Record<string, unknown>> | undefined)[],
  namespace: "anthropic" | "google" | "vertex",
  property: "signature" | "thoughtSignature",
): string | undefined {
  for (const container of containers) {
    const provider = record(Reflect.get(container ?? {}, namespace));
    const signature = Reflect.get(provider ?? {}, property);
    if (typeof signature === "string" && signature.length > 0) return signature;
  }
  return undefined;
}

export function event(value: RawMessageStreamEvent): Uint8Array {
  return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
