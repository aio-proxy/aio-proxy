import { ProviderProtocol } from '@aio-proxy/types';

import {
  anthropicTotalTokens,
  assertNever,
  fieldValue,
  isRecord,
  nestedNumberField,
  numberField,
  tokenUsage,
  type UsageExtraction,
  usageNumber,
} from './shared';

export function usageFromJson(protocol: ProviderProtocol, value: unknown): UsageExtraction {
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

function openAICompatibleUsage(value: unknown): UsageExtraction {
  if (!isRecord(value) || !isRecord(value['usage'])) {
    return { kind: 'absent' };
  }
  const usage = value['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'prompt_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'completion_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    cacheReadTokens: nestedNumberField(usage, 'prompt_tokens_details', 'cached_tokens', 'cacheReadTokens'),
    reasoningTokens: nestedNumberField(usage, 'completion_tokens_details', 'reasoning_tokens', 'reasoningTokens'),
  });
}

function openAIResponsesUsage(value: unknown): UsageExtraction {
  if (!isRecord(value)) {
    return { kind: 'absent' };
  }
  const response = isRecord(value['response']) ? value['response'] : value;
  if (!isRecord(response['usage'])) {
    return { kind: 'absent' };
  }
  const usage = response['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'input_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'output_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    cacheReadTokens: nestedNumberField(usage, 'input_tokens_details', 'cached_tokens', 'cacheReadTokens'),
    reasoningTokens: nestedNumberField(usage, 'output_tokens_details', 'reasoning_tokens', 'reasoningTokens'),
  });
}

function anthropicUsage(value: unknown): UsageExtraction {
  if (!isRecord(value)) {
    return { kind: 'absent' };
  }
  const container = isRecord(value['message']) ? value['message'] : value;
  if (!isRecord(container['usage'])) {
    return { kind: 'absent' };
  }
  const usage = container['usage'];
  const inputTokens = usageNumber(usage['input_tokens'] ?? undefined, 'inputTokens');
  const outputTokens = numberField(usage, 'output_tokens', 'outputTokens');
  const cacheReadTokens = usageNumber(usage['cache_read_input_tokens'] ?? undefined, 'cacheReadTokens');
  const cacheWriteTokens = usageNumber(usage['cache_creation_input_tokens'] ?? undefined, 'cacheWriteTokens');
  return tokenUsage({
    inputTokens,
    outputTokens,
    totalTokens: usageNumber(
      anthropicTotalTokens(
        fieldValue(inputTokens),
        fieldValue(outputTokens),
        fieldValue(cacheWriteTokens),
        fieldValue(cacheReadTokens),
      ),
      'totalTokens',
    ),
    cacheReadTokens,
    cacheWriteTokens,
  });
}

function geminiUsage(value: unknown): UsageExtraction {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (isRecord(value[index]) && isRecord(value[index]['usageMetadata'])) {
        return geminiUsage(value[index]);
      }
    }
    return { kind: 'absent' };
  }
  if (!isRecord(value) || !isRecord(value['usageMetadata'])) {
    return { kind: 'absent' };
  }
  const usage = value['usageMetadata'];
  return tokenUsage({
    inputTokens: numberField(usage, 'promptTokenCount', 'inputTokens'),
    outputTokens: numberField(usage, 'candidatesTokenCount', 'outputTokens'),
    totalTokens: numberField(usage, 'totalTokenCount', 'totalTokens'),
    cacheReadTokens: numberField(usage, 'cachedContentTokenCount', 'cacheReadTokens'),
    reasoningTokens: numberField(usage, 'thoughtsTokenCount', 'reasoningTokens'),
  });
}
