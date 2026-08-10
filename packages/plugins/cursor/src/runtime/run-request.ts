import { Buffer } from 'node:buffer';

import { InvalidPromptError, type LanguageModelV4Prompt } from '@ai-sdk/provider';
import { create, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  type ConversationStateStructure,
  ConversationStateStructureSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  UserMessageActionSchema,
} from '../gen/agent_pb';
import { storeCursorBlob } from '../store/blobs';
import {
  applyMcpToolResults,
  buildConversationTurns,
  buildCursorSystemPromptJsons,
  buildRootPromptMessagesJson,
  createCursorUserMessage,
  extractV4UserText,
  hasMatchingPendingToolResult,
} from './history';

export type CursorRunState = {
  readonly conversationId: string;
  readonly blobStore: Map<string, Uint8Array>;
  readonly conversationState?: ConversationStateStructure;
  readonly pendingToolCalls?: ReadonlyMap<string, string>;
};

// Tools are NOT placed in the run request; Cursor requests them later via the
// requestContext exec handshake (Task 9/15). A trailing tool-role message
// (caller returned tool results) selects ResumeAction; a trailing user message
// selects UserMessageAction and is excluded from history (it rides in the action).
export function buildCursorRunRequestBytes(input: {
  readonly prompt: LanguageModelV4Prompt;
  readonly wireModelId: string;
  readonly displayModelId: string;
  readonly displayName: string;
  readonly maxMode: boolean;
  readonly state: CursorRunState;
}): {
  requestBytes: Uint8Array;
  conversationState: ConversationStateStructure;
  pendingToolCalls: Map<string, string>;
} {
  const { prompt, state } = input;
  validateFileParts(prompt);
  const blobStore = state.blobStore;
  const pendingToolCalls = state.pendingToolCalls ?? new Map();
  const isPendingResume = hasMatchingPendingToolResult(prompt, pendingToolCalls);
  const systemPromptIds = buildCursorSystemPromptJsons(prompt).map((json) =>
    storeCursorBlob(blobStore, new TextEncoder().encode(json)),
  );

  const activeIndex = prompt.length - 1;
  const active = prompt[activeIndex];
  const activeUserContent = active?.role === 'user' ? active.content : undefined;
  const activeText = activeUserContent ? extractV4UserText(activeUserContent) : '';
  const isUserAction = activeUserContent !== undefined;

  const action = create(ConversationActionSchema, {
    action: isUserAction
      ? {
          case: 'userMessageAction',
          value: create(UserMessageActionSchema, {
            userMessage: createCursorUserMessage(activeUserContent!, activeText),
          }),
        }
      : { case: 'resumeAction', value: create(ResumeActionSchema, {}) },
  });

  const historyActiveIndex = isUserAction ? activeIndex : -1;
  const promptTurns = buildConversationTurns(prompt, blobStore, historyActiveIndex);

  const cachedHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
  const promptHeadMatches =
    cachedHead.length === systemPromptIds.length &&
    systemPromptIds.every((id, index) => Buffer.from(cachedHead[index]!).equals(id));
  const reusableState =
    state.conversationState && (isPendingResume || promptHeadMatches) ? state.conversationState : undefined;
  const baseState =
    reusableState ?? create(ConversationStateStructureSchema, { rootPromptMessagesJson: systemPromptIds });
  const baseTurns = reusableState?.turns ?? promptTurns;
  const patched = isPendingResume
    ? applyMcpToolResults({ prompt, turns: baseTurns, pendingToolCalls, blobStore })
    : { turns: baseTurns, pendingToolCalls: new Map<string, string>() };
  const rootPromptMessagesJson =
    reusableState?.rootPromptMessagesJson ??
    buildRootPromptMessagesJson(prompt, systemPromptIds, blobStore, historyActiveIndex);

  const conversationState = create(ConversationStateStructureSchema, {
    ...baseState,
    rootPromptMessagesJson,
    turns: patched.turns,
  });
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId: input.wireModelId,
      displayModelId: input.displayModelId,
      displayName: input.displayName,
      ...(input.maxMode ? { maxMode: true } : {}),
    }),
    requestedModel: create(RequestedModelSchema, {
      modelId: input.wireModelId,
      maxMode: input.maxMode,
    }),
    conversationId: state.conversationId,
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'runRequest', value: runRequest },
  });
  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    conversationState,
    pendingToolCalls: patched.pendingToolCalls,
  };
}

function validateFileParts(prompt: LanguageModelV4Prompt): void {
  for (const message of prompt) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (
        part.type === 'file' &&
        (!(part.mediaType === 'image' || part.mediaType.startsWith('image/')) || part.data.type !== 'data')
      ) {
        throw new InvalidPromptError({
          prompt,
          message: 'Cursor only supports text and inline image data.',
        });
      }
    }
  }
}
