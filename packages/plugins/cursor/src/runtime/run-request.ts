import { Buffer } from 'node:buffer';

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
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
  buildConversationTurns,
  buildCursorSystemPromptJsons,
  buildRootPromptMessagesJson,
  createCursorUserMessage,
  extractV4UserText,
  v4UserHasImages,
} from './history';

export type CursorRunState = {
  readonly conversationId: string;
  readonly blobStore: Map<string, Uint8Array>;
  readonly conversationState?: ConversationStateStructure;
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
}): { requestBytes: Uint8Array; conversationState: ConversationStateStructure } {
  const { prompt, state } = input;
  const blobStore = state.blobStore;
  const systemPromptIds = buildCursorSystemPromptJsons(prompt).map((json) =>
    storeCursorBlob(blobStore, new TextEncoder().encode(json)),
  );

  const activeIndex = prompt.length - 1;
  const active = prompt[activeIndex];
  const activeUserContent = active?.role === 'user' ? active.content : undefined;
  const activeText = activeUserContent ? extractV4UserText(activeUserContent) : '';
  const isUserAction = activeUserContent !== undefined && (activeText.length > 0 || v4UserHasImages(activeUserContent));

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
  const turns = buildConversationTurns(prompt, blobStore, historyActiveIndex);
  const rootPromptMessagesJson = buildRootPromptMessagesJson(prompt, systemPromptIds, blobStore, historyActiveIndex);

  const cachedHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
  const promptHeadMatches =
    cachedHead.length === systemPromptIds.length &&
    systemPromptIds.every((id, index) => Buffer.from(cachedHead[index]!).equals(id));
  const baseState =
    state.conversationState && promptHeadMatches
      ? state.conversationState
      : create(ConversationStateStructureSchema, { rootPromptMessagesJson: systemPromptIds });

  const conversationState = create(ConversationStateStructureSchema, {
    ...baseState,
    rootPromptMessagesJson,
    turns,
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
  return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), conversationState };
}
