import type { Completion, CompletionUsage } from 'openai/resources/completions';

import type { ModelEgressContext, ModelSseStream } from '../../protocol/adapter';
import { createCancellableEgressStream } from '../cancellable-stream';
import {
  completionFinishUsage,
  completionTextDelta,
  generatedMetadata,
  openAICompletionUsage,
  type OpenAICompletionFinishReason,
  type OpenAICompletionMetadata,
  type OpenAICompletionStreamPart,
  upstreamMetadata,
} from '../openai-completion-metadata/index';

const encoder = new TextEncoder();
const COMPLETION_ID_PREFIX = 'cmpl-';

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
  stream: ReadableStream<OpenAICompletionStreamPart>,
  context: ModelEgressContext,
): ModelSseStream {
  const metadata = generatedMetadata(COMPLETION_ID_PREFIX, context.modelId);
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta':
          enqueue(frame(metadata, completionTextDelta(part)));
          break;
        case 'finish':
          // Legacy Completions streams omit usage unless the client opts in via
          // stream_options.include_usage, which this adapter rejects as 501.
          enqueue(frame(metadata, '', openAIFinishReason(part.finishReason)));
          break;
        default:
          break;
      }
    }

    enqueue(encoder.encode('data: [DONE]\n\n'));
  });
}

export async function writeOpenAITextCompletionResponse(
  stream: ReadableStream<OpenAICompletionStreamPart>,
  context: ModelEgressContext,
): Promise<Completion> {
  const text: string[] = [];
  let finishReason: CompletionFinishReason = 'stop';
  let usage: CompletionUsage | undefined;
  let metadata = generatedMetadata(COMPLETION_ID_PREFIX, context.modelId);

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        text.push(completionTextDelta(part));
        break;
      case 'finish-step':
        metadata = withCompletionId(upstreamMetadata(part, metadata), metadata.id);
        break;
      case 'finish':
        finishReason = openAIFinishReason(part.finishReason);
        usage = openAICompletionUsage(completionFinishUsage(part));
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

// Upstream model and timestamp are worth adopting, but the id is not: a
// cross-protocol candidate reports a `chatcmpl-` id, and the SSE writer never
// sees `finish-step`, so borrowing it would break both the `text_completion` id
// contract and the agreement between the two writers.
function withCompletionId(metadata: OpenAICompletionMetadata, generatedId: string): OpenAICompletionMetadata {
  return metadata.id.startsWith(COMPLETION_ID_PREFIX) ? metadata : { ...metadata, id: generatedId };
}

function frame(
  metadata: OpenAICompletionMetadata,
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

function openAIFinishReason(finishReason: OpenAICompletionFinishReason): CompletionFinishReason {
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
