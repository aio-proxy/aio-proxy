import type { LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpRejectedSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolErrorSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  ToolCallSchema,
  UserMessageSchema,
} from '../../gen/agent_pb';
import { readCursorBlob, storeCursorBlob } from '../../store/blobs';
import { toWireName } from '../../tool-names';
import { createCursorUserMessage, extractV4UserText, v4UserHasImages } from './user-message';

// The active (latest) user message is excluded from history; it rides in the
// run action (Task 13). Assistant tool-call parts flatten to nothing and
// tool-result parts flatten to "[Tool Result]\n<text>" / "[Tool Error]\n<text>"
// assistant-side text for ordinary reconstructed history. Pending MCP results
// use applyMcpToolResults so their IDs and structured result remain intact.

export function findActiveUserMessageIndex(prompt: LanguageModelV4Prompt): number {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]!.role === 'user') return index;
  }
  return -1;
}

export function buildCursorSystemPromptJsons(prompt: LanguageModelV4Prompt): string[] {
  const systemPrompts = prompt
    .filter((message): message is Extract<LanguageModelV4Message, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  if (systemPrompts.length === 0) {
    return [JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' })];
  }
  return systemPrompts.map((content) => JSON.stringify({ role: 'system', content }));
}

export function buildRootPromptMessagesJson(
  prompt: LanguageModelV4Prompt,
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex = findActiveUserMessageIndex(prompt),
): Uint8Array[] {
  const entries: Uint8Array[] = [...systemPromptIds];
  const pushJson = (value: unknown) =>
    entries.push(storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(value))));
  for (let index = 0; index < prompt.length; index += 1) {
    if (index === activeUserMessageIndex) break;
    const message = prompt[index]!;
    if (message.role === 'user') {
      const text = extractV4UserText(message.content);
      if (text.length > 0) pushJson({ role: 'user', content: [{ type: 'text', text }] });
    } else if (message.role === 'assistant') {
      const text = assistantText(message.content);
      if (text.length > 0) pushJson({ role: 'assistant', content: [{ type: 'text', text }] });
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const text = toolResultText(part);
        if (text.length > 0) pushJson({ role: 'user', content: [{ type: 'text', text }] });
      }
    }
  }
  return entries;
}

export function buildConversationTurns(
  prompt: LanguageModelV4Prompt,
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex = findActiveUserMessageIndex(prompt),
): Uint8Array[] {
  const turns: Uint8Array[] = [];
  let index = 0;
  while (index < prompt.length) {
    const message = prompt[index]!;
    if (message.role !== 'user') {
      index += 1;
      continue;
    }
    if (index === activeUserMessageIndex) break;
    const text = extractV4UserText(message.content);
    if (text.length === 0 && !v4UserHasImages(message.content)) {
      index += 1;
      continue;
    }
    const userMessageBlobId = storeCursorBlob(
      blobStore,
      toBinary(UserMessageSchema, createCursorUserMessage(message.content, text)),
    );
    const stepBlobIds: Uint8Array[] = [];
    index += 1;
    while (index < prompt.length && prompt[index]!.role !== 'user') {
      const stepMessage = prompt[index]!;
      const stepText =
        stepMessage.role === 'assistant' ? assistantText(stepMessage.content) : toolMessageText(stepMessage);
      if (stepText.length > 0) {
        stepBlobIds.push(
          storeCursorBlob(
            blobStore,
            toBinary(
              ConversationStepSchema,
              create(ConversationStepSchema, {
                message: {
                  case: 'assistantMessage',
                  value: create(AssistantMessageSchema, { text: stepText }),
                },
              }),
            ),
          ),
        );
      }
      index += 1;
    }
    const turn = create(ConversationTurnStructureSchema, {
      turn: {
        case: 'agentConversationTurn',
        value: create(AgentConversationTurnStructureSchema, {
          userMessage: userMessageBlobId,
          steps: stepBlobIds,
        }),
      },
    });
    turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
  }
  return turns;
}

export function hasMatchingPendingToolResult(
  prompt: LanguageModelV4Prompt,
  pendingToolCalls: ReadonlyMap<string, string>,
): boolean {
  return toolResultParts(prompt).some((part) => pendingToolCalls.has(part.toolCallId));
}

export function applyMcpToolResults(input: {
  readonly prompt: LanguageModelV4Prompt;
  readonly turns: Uint8Array[];
  readonly pendingToolCalls: ReadonlyMap<string, string>;
  readonly blobStore: Map<string, Uint8Array>;
}): { turns: Uint8Array[]; pendingToolCalls: Map<string, string> } {
  const turns = [...input.turns];
  const pendingToolCalls = new Map(input.pendingToolCalls);
  for (const part of toolResultParts(input.prompt)) {
    const nestedToolCallId = pendingToolCalls.get(part.toolCallId);
    if (nestedToolCallId === undefined) continue;
    if (!patchMcpStep(turns, nestedToolCallId, part, input.blobStore)) {
      appendMcpStep(turns, nestedToolCallId, part, input.blobStore);
    }
    pendingToolCalls.delete(part.toolCallId);
  }
  return { turns, pendingToolCalls };
}

function toolResultParts(prompt: LanguageModelV4Prompt): LanguageModelV4ToolResultPart[] {
  const parts: LanguageModelV4ToolResultPart[] = [];
  for (const message of prompt) {
    if (message.role !== 'assistant' && message.role !== 'tool') continue;
    for (const part of message.content) if (part.type === 'tool-result') parts.push(part);
  }
  return parts;
}

function patchMcpStep(
  turns: Uint8Array[],
  nestedToolCallId: string,
  part: LanguageModelV4ToolResultPart,
  blobStore: Map<string, Uint8Array>,
): boolean {
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turnBytes = readCursorBlob(blobStore, turns[turnIndex]!);
    if (turnBytes === undefined) continue;
    const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
    if (turn.turn.case !== 'agentConversationTurn') continue;
    for (let stepIndex = 0; stepIndex < turn.turn.value.steps.length; stepIndex += 1) {
      const stepBytes = readCursorBlob(blobStore, turn.turn.value.steps[stepIndex]!);
      if (stepBytes === undefined) continue;
      const step = fromBinary(ConversationStepSchema, stepBytes);
      if (
        step.message.case !== 'toolCall' ||
        step.message.value.tool.case !== 'mcpToolCall' ||
        step.message.value.tool.value.args?.toolCallId !== nestedToolCallId
      ) {
        continue;
      }
      step.message.value.tool.value.result = encodeMcpResult(part);
      turn.turn.value.steps[stepIndex] = storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step));
      turns[turnIndex] = storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn));
      return true;
    }
  }
  return false;
}

function appendMcpStep(
  turns: Uint8Array[],
  nestedToolCallId: string,
  part: LanguageModelV4ToolResultPart,
  blobStore: Map<string, Uint8Array>,
): void {
  const stepId = storeCursorBlob(blobStore, toBinary(ConversationStepSchema, createMcpStep(nestedToolCallId, part)));
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turnBytes = readCursorBlob(blobStore, turns[turnIndex]!);
    if (turnBytes === undefined) continue;
    const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
    if (turn.turn.case !== 'agentConversationTurn') continue;
    turn.turn.value.steps.push(stepId);
    turns[turnIndex] = storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn));
    return;
  }
  const userMessage = storeCursorBlob(blobStore, toBinary(UserMessageSchema, create(UserMessageSchema, {})));
  turns.push(
    storeCursorBlob(
      blobStore,
      toBinary(
        ConversationTurnStructureSchema,
        create(ConversationTurnStructureSchema, {
          turn: {
            case: 'agentConversationTurn',
            value: create(AgentConversationTurnStructureSchema, { userMessage, steps: [stepId] }),
          },
        }),
      ),
    ),
  );
}

function createMcpStep(nestedToolCallId: string, part: LanguageModelV4ToolResultPart) {
  return create(ConversationStepSchema, {
    message: {
      case: 'toolCall',
      value: create(ToolCallSchema, {
        tool: {
          case: 'mcpToolCall',
          value: create(McpToolCallSchema, {
            args: create(McpArgsSchema, {
              name: toWireName(part.toolName),
              toolName: toWireName(part.toolName),
              toolCallId: nestedToolCallId,
            }),
            result: encodeMcpResult(part),
          }),
        },
      }),
    },
  });
}

function encodeMcpResult(part: LanguageModelV4ToolResultPart) {
  const output = part.output;
  if (output.type === 'execution-denied') {
    return create(McpToolResultSchema, {
      result: { case: 'rejected', value: create(McpRejectedSchema, { reason: output.reason ?? '' }) },
    });
  }
  if (output.type === 'error-text' || output.type === 'error-json') {
    return create(McpToolResultSchema, {
      result: {
        case: 'error',
        value: create(McpToolErrorSchema, {
          error: output.type === 'error-text' ? output.value : JSON.stringify(output.value),
        }),
      },
    });
  }
  const texts =
    output.type === 'text'
      ? [output.value]
      : output.type === 'json'
        ? [JSON.stringify(output.value)]
        : output.value.map((entry) => (entry.type === 'text' ? entry.text : `[${entry.type}]`));
  return create(McpToolResultSchema, {
    result: {
      case: 'success',
      value: create(McpSuccessSchema, {
        content: texts.map((text) =>
          create(McpToolResultContentItemSchema, {
            content: { case: 'text', value: create(McpTextContentSchema, { text }) },
          }),
        ),
      }),
    },
  });
}

function assistantText(content: Extract<LanguageModelV4Message, { role: 'assistant' }>['content']): string {
  return content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function toolMessageText(message: LanguageModelV4Message): string {
  if (message.role !== 'tool') return '';
  return message.content
    .filter((part): part is LanguageModelV4ToolResultPart => part.type === 'tool-result')
    .map(toolResultText)
    .filter((text) => text.length > 0)
    .join('\n');
}

function toolResultText(part: LanguageModelV4ToolResultPart): string {
  const output = part.output;
  const body =
    output.type === 'text' || output.type === 'error-text'
      ? output.value
      : output.type === 'json' || output.type === 'error-json'
        ? JSON.stringify(output.value)
        : output.type === 'content'
          ? output.value.map((entry) => (entry.type === 'text' ? entry.text : `[${entry.type}]`)).join('\n')
          : '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  const prefix = output.type === 'error-text' || output.type === 'error-json' ? '[Tool Error]' : '[Tool Result]';
  return `${prefix}\n${trimmed}`;
}
