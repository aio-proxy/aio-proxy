import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import type { ModelEgressContext } from '../../protocol/adapter';
import { createCancellableEgressStream } from '../cancellable-stream';
import {
  assertSuccessfulFinish,
  customInput,
  ensureOutput,
  finishUsage,
  messageItem,
  type OpenAIResponsesStreamPart,
  openAIUsage,
  outputIndex,
  reasoningDelta,
  reasoningItem,
  responseObject,
  type ResponseState,
  responseState,
  startTool,
  textDelta,
  toolItem,
} from './state';

const encoder = new TextEncoder();

type SseContext = {
  readonly state: ResponseState;
  seq: number;
  readonly enqueue: (value: Uint8Array) => void;
};

export function writeOpenAIResponsesSSE(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const ctx: SseContext = { state: responseState(context.modelId), seq: 0, enqueue };

    send(ctx, {
      type: 'response.created',
      sequence_number: ctx.seq,
      response: responseObject('in_progress', ctx.state),
    });

    for await (const part of parts) handleStreamPart(ctx, part);

    const response = responseObject('completed', ctx.state);
    send(ctx, { type: 'response.completed', sequence_number: ctx.seq, response });
    context.onResponseId?.(response.id);
  });
}

function send(ctx: SseContext, value: ResponseStreamEvent): void {
  ctx.enqueue(frame(value));
  ctx.seq += 1;
}

function handleStreamPart(ctx: SseContext, part: OpenAIResponsesStreamPart): void {
  switch (part.type) {
    case 'reasoning-delta':
      emitReasoningDelta(ctx, part);
      break;
    case 'text-delta':
      emitTextDelta(ctx, part);
      break;
    case 'tool-input-start':
      emitToolStart(ctx, part);
      break;
    case 'tool-input-delta':
      emitToolDelta(ctx, part);
      break;
    case 'tool-input-end':
      emitToolEnd(ctx, part);
      break;
    case 'error':
      throw part.error;
    case 'finish-step':
      assertSuccessfulFinish(part);
      break;
    case 'finish': {
      assertSuccessfulFinish(part);
      const usage = openAIUsage(finishUsage(part));
      if (usage !== undefined) ctx.state.usage = usage;
      break;
    }
    default:
      break;
  }
}

function emitReasoningDelta(ctx: SseContext, part: Extract<OpenAIResponsesStreamPart, { type: 'reasoning-delta' }>) {
  const { state } = ctx;
  const output = ensureOutput(state, { type: 'reasoning' });
  if (output.added) {
    send(ctx, {
      type: 'response.output_item.added',
      sequence_number: ctx.seq,
      output_index: output.index,
      item: reasoningItem(state, 'in_progress'),
    });
  }
  const delta = reasoningDelta(part);
  state.reasoning.push(delta);
  send(ctx, {
    type: 'response.reasoning_summary_text.delta',
    sequence_number: ctx.seq,
    item_id: state.metadata.reasoningId,
    output_index: output.index,
    summary_index: 0,
    delta,
  });
}

function emitTextDelta(ctx: SseContext, part: Extract<OpenAIResponsesStreamPart, { type: 'text-delta' }>) {
  const { state } = ctx;
  const output = ensureOutput(state, { type: 'message' });
  if (output.added) {
    send(ctx, {
      type: 'response.output_item.added',
      sequence_number: ctx.seq,
      output_index: output.index,
      item: messageItem(state, 'in_progress'),
    });
  }
  const delta = textDelta(part);
  state.text.push(delta);
  send(ctx, {
    type: 'response.output_text.delta',
    sequence_number: ctx.seq,
    item_id: state.metadata.messageId,
    output_index: output.index,
    content_index: 0,
    delta,
    logprobs: [],
  });
}

function emitToolStart(ctx: SseContext, part: Extract<OpenAIResponsesStreamPart, { type: 'tool-input-start' }>) {
  const { state } = ctx;
  if (state.tools.has(part.id)) return;
  const tool = startTool(part);
  state.tools.set(part.id, tool);
  const output = ensureOutput(state, { type: 'tool', callId: part.id });
  send(ctx, {
    type: 'response.output_item.added',
    sequence_number: ctx.seq,
    output_index: output.index,
    item: toolItem(tool, 'in_progress'),
  });
}

function emitToolDelta(ctx: SseContext, part: Extract<OpenAIResponsesStreamPart, { type: 'tool-input-delta' }>) {
  const tool = ctx.state.tools.get(part.id);
  if (tool === undefined || tool.completed) return;
  tool.input += part.delta;
  if (tool.wireType === 'function') {
    send(ctx, {
      type: 'response.function_call_arguments.delta',
      sequence_number: ctx.seq,
      item_id: tool.id,
      output_index: outputIndex(ctx.state, { type: 'tool', callId: part.id }),
      delta: part.delta,
    });
  }
}

function emitToolEnd(ctx: SseContext, part: Extract<OpenAIResponsesStreamPart, { type: 'tool-input-end' }>) {
  const { state } = ctx;
  const tool = state.tools.get(part.id);
  if (tool === undefined || tool.completed) return;
  tool.completed = true;
  const index = outputIndex(state, { type: 'tool', callId: part.id });
  if (tool.wireType === 'custom') {
    const input = customInput(tool.input);
    send(ctx, {
      type: 'response.custom_tool_call_input.delta',
      sequence_number: ctx.seq,
      item_id: tool.id,
      output_index: index,
      delta: input,
    });
    send(ctx, {
      type: 'response.custom_tool_call_input.done',
      sequence_number: ctx.seq,
      item_id: tool.id,
      output_index: index,
      input,
    });
  } else {
    send(ctx, {
      type: 'response.function_call_arguments.done',
      sequence_number: ctx.seq,
      item_id: tool.id,
      output_index: index,
      name: tool.name,
      arguments: tool.input,
    });
  }
  send(ctx, {
    type: 'response.output_item.done',
    sequence_number: ctx.seq,
    output_index: index,
    item: toolItem(tool, 'completed'),
  });
}

function frame(value: ResponseStreamEvent): Uint8Array {
  return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
