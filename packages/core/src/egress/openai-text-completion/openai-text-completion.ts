import type { Completion, CompletionUsage } from 'openai/resources/completions';

import type {
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  TextStreamPart,
  ToolSet,
} from '../../ai-sdk-bridge';
import type { ModelEgressContext, ModelSseStream } from '../../protocol/adapter';
import { createCancellableEgressStream } from '../cancellable-stream';

const encoder = new TextEncoder();

type OpenAITextCompletionStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<OpenAITextCompletionStreamPart, { type: 'text-delta' }>;
type FinishPart = Extract<OpenAITextCompletionStreamPart, { type: 'finish' }>;
type FinishStepPart = Extract<OpenAITextCompletionStreamPart, { type: 'finish-step' }>;
type FinishReason = FinishPart['finishReason'] | LanguageModelV2FinishReason;
type TokenUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};
type ResponseMetadata = {
  readonly id: string;
  readonly model: string;
  readonly created: number;
};
type CompletionFinishReason = Completion['choices'][number]['finish_reason'];
type TextCompletionChunk = Omit<Completion, 'choices'> & {
  choices: Array<{
    text: string;
    index: number;
    logprobs: null;
    finish_reason: CompletionFinishReason | null;
  }>;
};

export function writeOpenAITextCompletionSSE(
  stream: ReadableStream<OpenAITextCompletionStreamPart>,
  context: ModelEgressContext,
): ModelSseStream {
  const metadata = fallbackMetadata(context.modelId);
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta':
          enqueue(frame(metadata, textDelta(part)));
          break;
        case 'finish':
          enqueue(frame(metadata, '', openAIFinishReason(part.finishReason), openAIUsage(finishUsage(part))));
          break;
        default:
          break;
      }
    }

    enqueue(encoder.encode('data: [DONE]\n\n'));
  });
}

export async function writeOpenAITextCompletionResponse(
  stream: ReadableStream<OpenAITextCompletionStreamPart>,
  context: ModelEgressContext,
): Promise<Completion> {
  const text: string[] = [];
  let finishReason: CompletionFinishReason = 'stop';
  let usage: CompletionUsage | undefined;
  let metadata = fallbackMetadata(context.modelId);

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        text.push(textDelta(part));
        break;
      case 'finish-step':
        metadata = upstreamMetadata(part, metadata);
        break;
      case 'finish':
        finishReason = openAIFinishReason(part.finishReason);
        usage = openAIUsage(finishUsage(part));
        break;
      default:
        break;
    }
  }

  return {
    id: metadata.id,
    object: 'text_completion',
    created: metadata.created,
    model: metadata.model,
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        logprobs: null,
        text: text.join(''),
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function fallbackMetadata(model: string): ResponseMetadata {
  return { id: completionId(), model, created: Math.floor(Date.now() / 1000) };
}

function upstreamMetadata(part: FinishStepPart, fallback: ResponseMetadata): ResponseMetadata {
  if (!('response' in part)) return fallback;
  return {
    id: part.response.id,
    model: part.response.modelId,
    created: Math.floor(part.response.timestamp.getTime() / 1000),
  };
}

function textDelta(part: TextDeltaPart): string {
  return 'delta' in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return 'usage' in part ? part.usage : part.totalUsage;
}

function frame(
  metadata: ResponseMetadata,
  text: string,
  finishReason: CompletionFinishReason | null = null,
  usage?: CompletionUsage,
): Uint8Array {
  const chunk: TextCompletionChunk = {
    id: metadata.id,
    object: 'text_completion',
    created: metadata.created,
    model: metadata.model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function completionId(): string {
  return `cmpl-${crypto.randomUUID()}`;
}

function openAIFinishReason(finishReason: FinishReason): CompletionFinishReason {
  switch (finishReason) {
    case 'content-filter':
      return 'content_filter';
    case 'length':
      return 'length';
    case 'stop':
    case 'tool-calls':
    case 'error':
    case 'other':
    case 'unknown':
      return 'stop';
  }
}

function openAIUsage(usage: TokenUsage): CompletionUsage | undefined {
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
