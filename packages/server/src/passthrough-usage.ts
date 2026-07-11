import { ProviderProtocol, type UsageRow } from "@aio-proxy/types";

type ExtractedUsage = Omit<UsageRow, "providerId" | "modelId">;

export function extractPassthroughUsage(protocol: ProviderProtocol, bodyText: string): ExtractedUsage | undefined {
  const values = sseDataValues(bodyText);
  for (const value of [...values].reverse()) {
    const parsed = parseJson(value);
    if (parsed === undefined) {
      continue;
    }
    const usage = usageFromJson(protocol, parsed);
    if (usage !== undefined) {
      return usage;
    }
  }
  return undefined;
}

function sseDataValues(bodyText: string): readonly string[] {
  const frames = bodyText.split(/\r?\n\r?\n/u);
  const values = frames.flatMap((frame) => {
    const dataLines = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    return dataLines.length === 0 ? [frame] : [dataLines.join("\n")];
  });
  return values.map((value) => value.trim()).filter((value) => value !== "" && value !== "[DONE]");
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
  if (!isRecord(value) || !isRecord(value["usage"])) {
    return undefined;
  }
  const usage = value["usage"];
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
