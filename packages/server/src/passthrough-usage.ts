import { ProviderProtocol, type UsageRow } from "@aio-proxy/types";
import { createParser } from "eventsource-parser";

type ExtractedUsage = Omit<UsageRow, "providerId" | "modelId">;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

export type PassthroughObservation = {
  readonly responseId?: string;
  readonly usage?: ExtractedUsage;
};

export type PassthroughSseUsageObserver = {
  readonly feed: (chunk: string) => void;
  readonly finish: () => PassthroughObservation;
};

export function extractPassthroughUsage(protocol: ProviderProtocol, bodyText: string): ExtractedUsage | undefined {
  return extractPassthroughObservation(protocol, bodyText).usage;
}

export function extractPassthroughObservation(protocol: ProviderProtocol, bodyText: string): PassthroughObservation {
  const parsed = parseJson(bodyText);
  if (parsed !== undefined) {
    return observationFromJson(protocol, parsed);
  }

  const observer = createPassthroughSseUsageObserver(protocol);
  observer.feed(bodyText);
  return observer.finish();
}

export function createPassthroughSseUsageObserver(protocol: ProviderProtocol): PassthroughSseUsageObserver {
  let active = true;
  let observed: ExtractedUsage | undefined;
  let responseId: string | undefined;
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onError(error) {
      if (error.type === "max-buffer-size-exceeded") {
        active = false;
      }
    },
    onEvent(event) {
      if (!active || event.data.length > MAX_SSE_BUFFER_CHARS) {
        active = false;
        return;
      }
      const parsed = parseJson(event.data);
      if (parsed === undefined) {
        return;
      }
      const next = observationFromJson(protocol, parsed);
      if (next.usage !== undefined) {
        observed = mergeObservedUsage(protocol, observed, next.usage);
      }
      responseId = next.responseId ?? responseId;
    },
  });

  return {
    feed(chunk) {
      if (!active || chunk === "") {
        return;
      }
      try {
        parser.feed(chunk);
      } catch {
        active = false;
      }
    },
    finish() {
      if (active) {
        try {
          parser.feed("\n\n");
          parser.reset();
        } catch {
          active = false;
        }
      }
      return active ? observation(observed, responseId) : {};
    },
  };
}

function observationFromJson(protocol: ProviderProtocol, value: unknown): PassthroughObservation {
  return observation(usageFromJson(protocol, value), completedResponseId(protocol, value));
}

function observation(usage: ExtractedUsage | undefined, responseId: string | undefined): PassthroughObservation {
  return {
    ...(responseId === undefined ? {} : { responseId }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function completedResponseId(protocol: ProviderProtocol, value: unknown): string | undefined {
  if (protocol !== ProviderProtocol.OpenAIResponse || !isRecord(value)) return undefined;
  const response = isRecord(value.response) ? value.response : value;
  const completed = value.type === "response.completed" || response.status === "completed";
  return completed && typeof response.id === "string" ? response.id : undefined;
}

function mergeObservedUsage(
  protocol: ProviderProtocol,
  current: ExtractedUsage | undefined,
  next: ExtractedUsage,
): ExtractedUsage {
  if (protocol !== ProviderProtocol.Anthropic) {
    return next;
  }
  const merged = { ...current, ...next };
  const total = totalTokens(merged.inputTokens, merged.outputTokens);
  return total === undefined ? merged : { ...merged, totalTokens: total };
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function usageFromJson(protocol: ProviderProtocol, value: unknown): ExtractedUsage | undefined {
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
      return openAICompatibleUsage(value);
    case ProviderProtocol.OpenAIResponse:
      return openAIResponsesUsage(value);
    case ProviderProtocol.Anthropic:
      return anthropicUsage(value);
    case ProviderProtocol.Gemini:
      return geminiUsage(value);
    default:
      return assertNever(protocol);
  }
}

function openAICompatibleUsage(value: unknown): ExtractedUsage | undefined {
  if (!isRecord(value) || !isRecord(value["usage"])) {
    return undefined;
  }
  const usage = value["usage"];
  return tokenUsage({
    inputTokens: numberField(usage, "prompt_tokens"),
    outputTokens: numberField(usage, "completion_tokens"),
    totalTokens: numberField(usage, "total_tokens"),
    cacheReadTokens: nestedNumberField(usage, "prompt_tokens_details", "cached_tokens"),
    reasoningTokens: nestedNumberField(usage, "completion_tokens_details", "reasoning_tokens"),
  });
}

function openAIResponsesUsage(value: unknown): ExtractedUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const response = isRecord(value["response"]) ? value["response"] : value;
  if (!isRecord(response["usage"])) {
    return undefined;
  }
  const usage = response["usage"];
  return tokenUsage({
    inputTokens: numberField(usage, "input_tokens"),
    outputTokens: numberField(usage, "output_tokens"),
    totalTokens: numberField(usage, "total_tokens"),
    cacheReadTokens: nestedNumberField(usage, "input_tokens_details", "cached_tokens"),
    reasoningTokens: nestedNumberField(usage, "output_tokens_details", "reasoning_tokens"),
  });
}

function anthropicUsage(value: unknown): ExtractedUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const container = isRecord(value["message"]) ? value["message"] : value;
  if (!isRecord(container["usage"])) {
    return undefined;
  }
  const usage = container["usage"];
  const inputTokens = numberField(usage, "input_tokens");
  const outputTokens = numberField(usage, "output_tokens");
  return tokenUsage({
    inputTokens,
    outputTokens,
    totalTokens: totalTokens(inputTokens, outputTokens),
    cacheReadTokens: numberField(usage, "cache_read_input_tokens"),
    cacheWriteTokens: numberField(usage, "cache_creation_input_tokens"),
  });
}

function geminiUsage(value: unknown): ExtractedUsage | undefined {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (isRecord(value[index]) && isRecord(value[index]["usageMetadata"])) {
        return geminiUsage(value[index]);
      }
    }
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value["usageMetadata"])) {
    return undefined;
  }
  const usage = value["usageMetadata"];
  return tokenUsage({
    inputTokens: numberField(usage, "promptTokenCount"),
    outputTokens: numberField(usage, "candidatesTokenCount"),
    totalTokens: numberField(usage, "totalTokenCount"),
    cacheReadTokens: numberField(usage, "cachedContentTokenCount"),
    reasoningTokens: numberField(usage, "thoughtsTokenCount"),
  });
}

function tokenUsage(usage: ExtractedUsage): ExtractedUsage | undefined {
  const compact = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length === 0 ? undefined : compact;
}

function totalTokens(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return inputTokens + outputTokens;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nestedNumberField(record: Record<string, unknown>, parent: string, field: string): number | undefined {
  const value = record[parent];
  return isRecord(value) ? numberField(value, field) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported passthrough usage protocol: ${String(value)}`);
}
