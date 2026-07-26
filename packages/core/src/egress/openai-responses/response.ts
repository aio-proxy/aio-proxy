import type { Response } from 'openai/resources/responses/responses';

import type { ModelEgressContext } from '../../protocol/adapter';
import {
  assertSuccessfulFinish,
  ensureOutput,
  finishUsage,
  type OpenAIResponsesStreamPart,
  openAIUsage,
  reasoningDelta,
  responseObject,
  responseState,
  startTool,
  textDelta,
  upstreamMetadata,
} from './state';

export type OpenAIResponsesResponse = Response;

export async function writeOpenAIResponsesResponse(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): Promise<Response> {
  const state = responseState(context.modelId);
  for await (const part of stream) {
    switch (part.type) {
      case 'reasoning-delta':
        ensureOutput(state, { type: 'reasoning' });
        state.reasoning.push(reasoningDelta(part));
        break;
      case 'text-delta':
        ensureOutput(state, { type: 'message' });
        state.text.push(textDelta(part));
        break;
      case 'tool-input-start':
        if (!state.tools.has(part.id)) {
          state.tools.set(part.id, startTool(part));
          ensureOutput(state, { type: 'tool', callId: part.id });
        }
        break;
      case 'tool-input-delta': {
        const tool = state.tools.get(part.id);
        if (tool !== undefined && !tool.completed) tool.input += part.delta;
        break;
      }
      case 'tool-input-end': {
        const tool = state.tools.get(part.id);
        if (tool !== undefined) tool.completed = true;
        break;
      }
      case 'error':
        throw part.error;
      case 'finish-step':
        assertSuccessfulFinish(part);
        state.metadata = upstreamMetadata(part, state.metadata);
        break;
      case 'finish': {
        assertSuccessfulFinish(part);
        const usage = openAIUsage(finishUsage(part));
        if (usage !== undefined) state.usage = usage;
        break;
      }
      default:
        break;
    }
  }
  const response = responseObject('completed', state);
  context.onResponseId?.(response.id);
  return response;
}
