import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import type { ModelEgressContext } from '../../protocol/adapter';
import { createCancellableEgressStream } from '../cancellable-stream';
import {
  anthropicStopReason,
  anthropicUsage,
  contentBlockStop,
  event,
  messageDeltaUsage,
  messageId,
  reasoningSignature,
  type TokenUsage,
  textStart,
} from './format';
import { type AnthropicThinkingStream, createAnthropicThinkingStream } from './sse-thinking';

type AnthropicMessagesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: 'text-delta' }>;
type ReasoningDeltaPart = Extract<AnthropicMessagesStreamPart, { type: 'reasoning-delta' }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: 'finish' }>;
type ActiveBlock = { readonly id: string; readonly index: number };

type BlockState = {
  nextIndex: number;
  text: ActiveBlock | undefined;
  readonly texts: Map<string, number>;
  readonly tools: Map<string, number>;
  readonly openBlocks: Set<number>;
  readonly thinking: AnthropicThinkingStream;
  readonly enqueue: (value: Uint8Array) => void;
};

export function writeAnthropicMessagesSSE(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  const id = messageId();
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const state: BlockState = {
      nextIndex: 0,
      text: undefined,
      texts: new Map(),
      tools: new Map(),
      openBlocks: new Set(),
      enqueue,
      thinking: createAnthropicThinkingStream({ enqueue, nextIndex: () => state.nextIndex++ }),
    };

    enqueue(
      event({
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          container: null,
          content: [],
          model: context.modelId,
          stop_details: null,
          stop_reason: null,
          stop_sequence: null,
          usage: anthropicUsage({}),
        },
      }),
    );

    for await (const part of parts) handleStreamPart(state, part);

    state.thinking.close();
    for (const index of state.openBlocks) enqueue(contentBlockStop(index));
    enqueue(event({ type: 'message_stop' }));
  });
}

function closeText(state: BlockState): void {
  if (state.text !== undefined && state.openBlocks.delete(state.text.index))
    state.enqueue(contentBlockStop(state.text.index));
  state.text = undefined;
}

function handleStreamPart(state: BlockState, part: AnthropicMessagesStreamPart): void {
  const { thinking, openBlocks, texts, tools, enqueue } = state;
  switch (part.type) {
    case 'reasoning-start': {
      closeText(state);
      thinking.start(part.id, reasoningSignature(part));
      break;
    }
    case 'reasoning-delta': {
      closeText(state);
      thinking.delta(part.id, reasoningDelta(part), reasoningSignature(part));
      break;
    }
    case 'reasoning-end':
      thinking.end(part.id, reasoningSignature(part));
      break;
    case 'text-start':
      thinking.close();
      if (!texts.has(part.id)) {
        closeText(state);
        state.text = { id: part.id, index: state.nextIndex++ };
        texts.set(part.id, state.text.index);
        openBlocks.add(state.text.index);
        enqueue(textStart(state.text.index));
      }
      break;
    case 'text-delta': {
      thinking.close();
      let index = texts.get(part.id);
      if (index === undefined) {
        closeText(state);
        state.text = { id: part.id, index: state.nextIndex++ };
        index = state.text.index;
        texts.set(part.id, index);
        openBlocks.add(index);
        enqueue(textStart(index));
      }
      if (openBlocks.has(index)) {
        enqueue(event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: textDelta(part) } }));
      }
      break;
    }
    case 'text-end': {
      const index = texts.get(part.id);
      if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
      if (state.text?.id === part.id) state.text = undefined;
      break;
    }
    case 'tool-input-start': {
      thinking.close();
      closeText(state);
      const index = state.nextIndex++;
      tools.set(part.id, index);
      openBlocks.add(index);
      enqueue(
        event({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: part.id,
            name: part.toolName,
            input: {},
            caller: { type: 'direct' },
          },
        }),
      );
      break;
    }
    case 'tool-input-delta': {
      const index = tools.get(part.id);
      if (index !== undefined && openBlocks.has(index)) {
        enqueue(
          event({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: part.delta },
          }),
        );
      }
      break;
    }
    case 'tool-input-end': {
      const index = tools.get(part.id);
      if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
      break;
    }
    case 'finish':
      thinking.close();
      for (const index of openBlocks) enqueue(contentBlockStop(index));
      openBlocks.clear();
      state.text = undefined;
      enqueue(
        event({
          type: 'message_delta',
          delta: {
            container: null,
            stop_details: null,
            stop_reason: anthropicStopReason(part.finishReason),
            stop_sequence: null,
          },
          usage: messageDeltaUsage(finishUsage(part)),
        }),
      );
      break;
    default:
      break;
  }
}

function textDelta(part: TextDeltaPart): string {
  return 'delta' in part ? part.delta : part.text;
}

function reasoningDelta(part: ReasoningDeltaPart): string {
  return 'delta' in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return 'usage' in part ? part.usage : part.totalUsage;
}
