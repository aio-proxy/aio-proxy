import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import {
  anthropicTotalTokens,
  assertNever,
  fieldValue,
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
    case ProviderProtocol.GeminiInteractions:
      return interactionsUsage(value);
    case ProviderProtocol.OpenAIImage:
      return openAIImageUsage(value);
    default:
      return assertNever(protocol);
  }
}

function interactionsUsage(value: unknown): UsageExtraction {
  const root = isPlainObject(value) ? value : undefined;
  const interaction = isPlainObject(root?.['interaction']) ? root['interaction'] : root;
  if (!isPlainObject(interaction) || !isPlainObject(interaction['usage'])) return { kind: 'absent' };
  const usage = interaction['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'total_input_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'total_output_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    cacheReadTokens: numberField(usage, 'total_cached_tokens', 'cacheReadTokens'),
    reasoningTokens: numberField(usage, 'total_thought_tokens', 'reasoningTokens'),
  });
}

function openAIImageUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value)) return { kind: 'absent' };
  const imageCount = Array.isArray(value['data']) ? value['data'].length : 0;
  if (!isPlainObject(value['usage'])) {
    return imageCount > 0 ? { kind: 'valid', usage: { imageCount } } : { kind: 'absent' };
  }
  const tokens = tokenUsage({
    inputTokens: numberField(value['usage'], 'input_tokens', 'inputTokens'),
    outputTokens: numberField(value['usage'], 'output_tokens', 'outputTokens'),
    totalTokens: numberField(value['usage'], 'total_tokens', 'totalTokens'),
  });
  if (tokens.kind === 'invalid') return tokens;
  if (tokens.kind === 'absent' && imageCount === 0) return { kind: 'absent' };
  return {
    kind: 'valid',
    usage: {
      ...(tokens.kind === 'valid' ? tokens.usage : {}),
      ...(imageCount > 0 ? { imageCount } : {}),
    },
  };
}

function openAICompatibleUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value) || !isPlainObject(value['usage'])) {
    return { kind: 'absent' };
  }
  const usage = value['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'prompt_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'completion_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    cacheReadTokens: nestedNumberField(usage, 'prompt_tokens_details', 'cached_tokens', 'cacheReadTokens'),
    reasoningTokens: nestedNumberField(usage, 'completion_tokens_details', 'reasoning_tokens', 'reasoningTokens'),
    // Audio token counts are exposed only by the OpenAI Chat Completions usage object;
    // the Responses/Anthropic/Gemini usage objects have no audio breakdown.
    inputAudioTokens: nestedNumberField(usage, 'prompt_tokens_details', 'audio_tokens', 'inputAudioTokens'),
    outputAudioTokens: nestedNumberField(usage, 'completion_tokens_details', 'audio_tokens', 'outputAudioTokens'),
  });
}

function openAIResponsesUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value)) {
    return { kind: 'absent' };
  }
  const response = isPlainObject(value['response']) ? value['response'] : value;
  if (!isPlainObject(response['usage'])) {
    return { kind: 'absent' };
  }
  const usage = response['usage'];
  // No audio tokens: the Responses (and Anthropic/Gemini) usage objects expose no audio breakdown,
  // so audio extraction is intentionally OpenAI-compatible only.
  return tokenUsage({
    inputTokens: numberField(usage, 'input_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'output_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    cacheReadTokens: nestedNumberField(usage, 'input_tokens_details', 'cached_tokens', 'cacheReadTokens'),
    reasoningTokens: nestedNumberField(usage, 'output_tokens_details', 'reasoning_tokens', 'reasoningTokens'),
  });
}

function anthropicUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value)) {
    return { kind: 'absent' };
  }
  const container = isPlainObject(value['message']) ? value['message'] : value;
  if (!isPlainObject(container['usage'])) {
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
      if (isPlainObject(value[index]) && isPlainObject(value[index]['usageMetadata'])) {
        return geminiUsage(value[index]);
      }
    }
    return { kind: 'absent' };
  }
  if (!isPlainObject(value) || !isPlainObject(value['usageMetadata'])) {
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
