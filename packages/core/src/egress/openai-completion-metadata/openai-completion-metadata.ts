import type { CompletionUsage } from 'openai/resources/completions';

import type {
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  TextStreamPart,
  ToolSet,
} from '../../ai-sdk-bridge';

// Both OpenAI completion egresses consume the same stream shape: the AI SDK v2
// language-model parts plus the higher-level `streamText` parts.
export type OpenAICompletionStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;

type TextDeltaPart = Extract<OpenAICompletionStreamPart, { type: 'text-delta' }>;
type FinishPart = Extract<OpenAICompletionStreamPart, { type: 'finish' }>;
type FinishStepPart = Extract<OpenAICompletionStreamPart, { type: 'finish-step' }>;

export type OpenAICompletionFinishReason = FinishPart['finishReason'] | LanguageModelV2FinishReason;

export type OpenAICompletionTokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};

// The `id`/`model`/`created` triple every OpenAI completion payload repeats,
// held once per response so JSON and SSE frames stay internally consistent.
export type OpenAICompletionMetadata = {
  readonly id: string;
  readonly model: string;
  readonly created: number;
};

export function generatedMetadata(idPrefix: string, model: string): OpenAICompletionMetadata {
  return { id: `${idPrefix}${crypto.randomUUID()}`, model, created: Math.floor(Date.now() / 1000) };
}

export function upstreamMetadata(part: FinishStepPart, fallback: OpenAICompletionMetadata): OpenAICompletionMetadata {
  if (!('response' in part)) return fallback;
  return {
    id: part.response.id,
    model: part.response.modelId,
    created: Math.floor(part.response.timestamp.getTime() / 1000),
  };
}

export function completionTextDelta(part: TextDeltaPart): string {
  return 'delta' in part ? part.delta : part.text;
}

export function completionFinishUsage(part: FinishPart): OpenAICompletionTokenUsage {
  return 'usage' in part ? part.usage : part.totalUsage;
}

export function openAICompletionUsage(usage: OpenAICompletionTokenUsage): CompletionUsage | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined) {
    return undefined;
  }
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
  };
}
