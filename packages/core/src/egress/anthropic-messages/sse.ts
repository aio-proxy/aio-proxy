import type { LanguageModelV2StreamPart, TextStreamPart, ToolSet } from "../../ai-sdk-bridge";
import type { ModelEgressContext } from "../../protocol/adapter";

import { createCancellableEgressStream } from "../cancellable-stream";
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
} from "./format";
import { createAnthropicThinkingStream } from "./sse-thinking";

type AnthropicMessagesStreamPart = LanguageModelV2StreamPart | TextStreamPart<ToolSet>;
type TextDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "text-delta" }>;
type ReasoningDeltaPart = Extract<AnthropicMessagesStreamPart, { type: "reasoning-delta" }>;
type FinishPart = Extract<AnthropicMessagesStreamPart, { type: "finish" }>;
type ActiveBlock = { readonly id: string; readonly index: number };

export function writeAnthropicMessagesSSE(
  stream: ReadableStream<AnthropicMessagesStreamPart>,
  context: ModelEgressContext,
): ReadableStream<Uint8Array> {
  const id = messageId();
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    let nextIndex = 0;
    let text: ActiveBlock | undefined;
    const texts = new Map<string, number>();
    const tools = new Map<string, number>();
    const openBlocks = new Set<number>();
    const thinking = createAnthropicThinkingStream({ enqueue, nextIndex: () => nextIndex++ });
    const closeText = () => {
      if (text !== undefined && openBlocks.delete(text.index)) enqueue(contentBlockStop(text.index));
      text = undefined;
    };

    enqueue(
      event({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
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

    for await (const part of parts) {
      switch (part.type) {
        case "reasoning-start": {
          closeText();
          thinking.start(part.id, reasoningSignature(part));
          break;
        }
        case "reasoning-delta": {
          closeText();
          thinking.delta(part.id, reasoningDelta(part), reasoningSignature(part));
          break;
        }
        case "reasoning-end":
          thinking.end(part.id, reasoningSignature(part));
          break;
        case "text-start":
          thinking.close();
          if (!texts.has(part.id)) {
            closeText();
            text = { id: part.id, index: nextIndex++ };
            texts.set(part.id, text.index);
            openBlocks.add(text.index);
            enqueue(textStart(text.index));
          }
          break;
        case "text-delta": {
          thinking.close();
          let index = texts.get(part.id);
          if (index === undefined) {
            closeText();
            text = { id: part.id, index: nextIndex++ };
            index = text.index;
            texts.set(part.id, index);
            openBlocks.add(index);
            enqueue(textStart(index));
          }
          if (openBlocks.has(index)) {
            enqueue(
              event({ type: "content_block_delta", index, delta: { type: "text_delta", text: textDelta(part) } }),
            );
          }
          break;
        }
        case "text-end": {
          const index = texts.get(part.id);
          if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
          if (text?.id === part.id) text = undefined;
          break;
        }
        case "tool-input-start": {
          thinking.close();
          closeText();
          const index = nextIndex++;
          tools.set(part.id, index);
          openBlocks.add(index);
          enqueue(
            event({
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: part.id,
                name: part.toolName,
                input: {},
                caller: { type: "direct" },
              },
            }),
          );
          break;
        }
        case "tool-input-delta": {
          const index = tools.get(part.id);
          if (index !== undefined && openBlocks.has(index)) {
            enqueue(
              event({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: part.delta },
              }),
            );
          }
          break;
        }
        case "tool-input-end": {
          const index = tools.get(part.id);
          if (index !== undefined && openBlocks.delete(index)) enqueue(contentBlockStop(index));
          break;
        }
        case "finish":
          thinking.close();
          for (const index of openBlocks) enqueue(contentBlockStop(index));
          openBlocks.clear();
          text = undefined;
          enqueue(
            event({
              type: "message_delta",
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

    thinking.close();
    for (const index of openBlocks) enqueue(contentBlockStop(index));
    enqueue(event({ type: "message_stop" }));
  });
}

function textDelta(part: TextDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function reasoningDelta(part: ReasoningDeltaPart): string {
  return "delta" in part ? part.delta : part.text;
}

function finishUsage(part: FinishPart): TokenUsage {
  return "usage" in part ? part.usage : part.totalUsage;
}
