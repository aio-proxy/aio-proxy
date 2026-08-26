import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions/completions';
import type { CompletionUsage } from 'openai/resources/completions';

import type { ModelEgressContext, ModelSseStream } from '../protocol/adapter';
import { createCancellableEgressStream } from './cancellable-stream';
import {
  completionFinishUsage,
  completionTextDelta,
  generatedMetadata,
  openAICompletionUsage,
  type OpenAICompletionFinishReason,
  type OpenAICompletionMetadata,
  type OpenAICompletionStreamPart,
  upstreamMetadata,
} from './openai-completion-metadata/index';

const encoder = new TextEncoder();
const CHAT_COMPLETION_ID_PREFIX = 'chatcmpl-';

type ToolState = {
  readonly index: number;
  readonly id: string;
  readonly toolName: string;
  arguments: string;
};

export function writeOpenAICompletionsSSE(
  stream: ReadableStream<OpenAICompletionStreamPart>,
  context: ModelEgressContext,
): ModelSseStream {
  const metadata = generatedMetadata(CHAT_COMPLETION_ID_PREFIX, context.modelId);
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const tools = new Map<string, ToolState>();

    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta':
          enqueue(frame(metadata, { content: completionTextDelta(part) }));
          break;
        case 'tool-input-start': {
          const tool = { index: tools.size, id: part.id, toolName: part.toolName, arguments: '' };
          tools.set(part.id, tool);
          enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          break;
        }
        case 'tool-input-delta': {
          const tool = tools.get(part.id);
          if (tool !== undefined) {
            tool.arguments += part.delta;
            enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          }
          break;
        }
        case 'tool-input-end': {
          const tool = tools.get(part.id);
          if (tool !== undefined) enqueue(frame(metadata, { tool_calls: [toolDelta(tool)] }));
          break;
        }
        case 'finish':
          enqueue(
            frame(
              metadata,
              {},
              openAIFinishReason(part.finishReason),
              openAICompletionUsage(completionFinishUsage(part)),
            ),
          );
          break;
        default:
          break;
      }
    }

    enqueue(encoder.encode('data: [DONE]\n\n'));
  });
}

export async function writeOpenAICompletionsResponse(
  stream: ReadableStream<OpenAICompletionStreamPart>,
  context: ModelEgressContext,
): Promise<ChatCompletion> {
  const text: string[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason: ChatCompletion.Choice['finish_reason'] = 'stop';
  let usage: CompletionUsage | undefined;
  let metadata = generatedMetadata(CHAT_COMPLETION_ID_PREFIX, context.modelId);

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        text.push(completionTextDelta(part));
        break;
      case 'tool-input-start':
        tools.set(part.id, { index: tools.size, id: part.id, toolName: part.toolName, arguments: '' });
        break;
      case 'tool-input-delta': {
        const tool = tools.get(part.id);
        if (tool !== undefined) tool.arguments += part.delta;
        break;
      }
      case 'finish-step':
        metadata = upstreamMetadata(part, metadata);
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
    object: 'chat.completion',
    created: metadata.created,
    model: metadata.model,
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        logprobs: null,
        message: {
          role: 'assistant',
          content: text.length === 0 && tools.size > 0 ? null : text.join(''),
          refusal: null,
          ...(tools.size === 0 ? {} : { tool_calls: [...tools.values()].map(messageToolCall) }),
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function frame(
  metadata: OpenAICompletionMetadata,
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice['finish_reason'] = null,
  usage?: CompletionUsage,
): Uint8Array {
  const chunk: ChatCompletionChunk = {
    id: metadata.id,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [{ delta, index: 0, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function toolDelta(tool: ToolState): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    index: tool.index,
    id: tool.id,
    type: 'function',
    function: { name: tool.toolName, arguments: tool.arguments },
  };
}

function messageToolCall(tool: ToolState): ChatCompletionMessageToolCall {
  return {
    id: tool.id,
    type: 'function',
    function: { name: tool.toolName, arguments: tool.arguments },
  };
}

function openAIFinishReason(finishReason: OpenAICompletionFinishReason): ChatCompletion.Choice['finish_reason'] {
  switch (finishReason) {
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'stop':
    case 'error':
    case 'other':
    case 'unknown':
      return 'stop';
  }
}
