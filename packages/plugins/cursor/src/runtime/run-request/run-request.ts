import { Buffer } from 'node:buffer';

import { InvalidPromptError, type LanguageModelV4Prompt } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  type ConversationStateStructure,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  type SelectedImage,
  UserMessageActionSchema,
  UserMessageSchema,
} from '../../gen/agent_pb';
import { readCursorBlob, storeCursorBlob } from '../../store/blobs';
import {
  appendCursorRootHistory,
  applyMcpToolResults,
  buildConversationTurns,
  buildCursorSystemPromptJsons,
  buildRootPromptMessagesJson,
  createCursorUserMessage,
  extractV4UserText,
  hasMatchingPendingToolResult,
  v4UserHasImages,
} from '../history';

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
  const promptRootMessages = buildRootPromptMessagesJson(prompt, systemPromptIds, blobStore, historyActiveIndex);

  const cachedRootMessages = state.conversationState?.rootPromptMessagesJson ?? [];
  const cachedHead = cachedRootMessages.slice(0, systemPromptIds.length);
  const promptHeadMatches =
    cachedHead.length === systemPromptIds.length &&
    systemPromptIds.every((id, index) => Buffer.from(cachedHead[index]!).equals(id));
  const hasHistoricalImages = prompt.some(
    (message, index) => index !== historyActiveIndex && message.role === 'user' && v4UserHasImages(message.content),
  );
  const cachedTurns = state.conversationState?.turns ?? [];
  const hasHistoricalUsers = prompt.some((message, index) => index !== historyActiveIndex && message.role === 'user');
  const hasSerializedRootHistory = promptRootMessages.length > systemPromptIds.length;
  const hasInboundHistory = isPendingResume ? hasHistoricalUsers : hasHistoricalUsers || hasSerializedRootHistory;
  const promptHistoryMatches =
    !hasInboundHistory ||
    (cachedRootMessages.length === promptRootMessages.length &&
      promptRootMessages.every((id, index) => Buffer.from(cachedRootMessages[index]!).equals(id)) &&
      ((!hasHistoricalImages && turnsHaveImages(cachedTurns, blobStore) === false) ||
        turnImagesMatch(prompt, historyActiveIndex, cachedTurns, blobStore)));
  const reusableState =
    state.conversationState &&
    (isPendingResume
      ? !hasHistoricalUsers ||
        (!hasHistoricalImages && turnsHaveImages(cachedTurns, blobStore) === false) ||
        turnImagesMatch(prompt, historyActiveIndex, cachedTurns, blobStore)
      : promptHeadMatches && promptHistoryMatches)
      ? state.conversationState
      : undefined;
  const baseState =
    reusableState ?? create(ConversationStateStructureSchema, { rootPromptMessagesJson: systemPromptIds });
  const baseTurns = reusableState?.turns ?? promptTurns;
  const patched = isPendingResume
    ? applyMcpToolResults({ prompt, turns: baseTurns, pendingToolCalls, blobStore })
    : { turns: baseTurns, pendingToolCalls: new Map<string, string>() };
  // Cursor builds the model prompt from these JSON blobs, not the patched
  // display turns. A resumed tool result must reach this history as well.
  const hasFullToolHistory = promptTurns.length > 0;
  const rootPromptMessagesJson =
    isPendingResume && reusableState !== undefined
      ? hasFullToolHistory
        ? promptRootMessages
        : appendCursorRootHistory({
            rootPromptMessagesJson: reusableState.rootPromptMessagesJson,
            prompt,
            blobStore,
          })
      : (reusableState?.rootPromptMessagesJson ?? promptRootMessages);

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

function turnsHaveImages(
  turns: readonly Uint8Array[],
  blobStore: ReadonlyMap<string, Uint8Array>,
): boolean | undefined {
  const lists = agentTurnImageLists(turns, blobStore);
  return lists?.some((turn) => turn.images.length > 0);
}

function turnImagesMatch(
  prompt: LanguageModelV4Prompt,
  historyActiveIndex: number,
  cachedTurns: readonly Uint8Array[],
  blobStore: ReadonlyMap<string, Uint8Array>,
): boolean {
  const promptUsers = historicalUserSlots(prompt, historyActiveIndex);
  const cachedLists = agentTurnImageLists(cachedTurns, blobStore, promptUsers);
  if (cachedLists === undefined) return false;
  const promptLists = alignEmptyUserSlots(promptUsers, cachedLists);
  if (promptLists.length !== cachedLists.length) return false;
  return promptLists.every((promptTurn, index) => {
    const cachedTurn = cachedLists[index]!;
    if (promptTurn.text !== cachedTurn.text) return false;
    return imagesMatch(promptTurn.images, cachedTurn.images, blobStore);
  });
}

function historicalUserSlots(
  prompt: LanguageModelV4Prompt,
  historyActiveIndex: number,
): readonly { readonly text: string; readonly images: readonly SelectedImage[] }[] {
  return prompt.flatMap((message, index) => {
    if (index === historyActiveIndex || message.role !== 'user') return [];
    const text = extractV4UserText(message.content);
    const images = createCursorUserMessage(message.content, text).selectedContext?.selectedImages ?? [];
    return [{ text, images }];
  });
}

function alignEmptyUserSlots(
  promptUsers: readonly { readonly text: string; readonly images: readonly SelectedImage[] }[],
  cachedLists: readonly { readonly text: string; readonly images: readonly SelectedImage[] }[],
): readonly { readonly text: string; readonly images: readonly SelectedImage[] }[] {
  const remaining = [...promptUsers];
  const slots: { text: string; images: readonly SelectedImage[] }[] = [];
  while (remaining.length > 0) {
    const next = remaining.shift()!;
    const laterHasContent = remaining.some((slot) => slot.text.length > 0 || slot.images.length > 0);
    const cached = cachedLists[slots.length];
    const cachedIsEmpty = cached !== undefined && cached.text.length === 0 && cached.images.length === 0;
    if (next.text.length === 0 && next.images.length === 0 && !(laterHasContent && cachedIsEmpty)) continue;
    slots.push(next);
  }
  return slots;
}

function agentTurnImageLists(
  turns: readonly Uint8Array[],
  blobStore: ReadonlyMap<string, Uint8Array>,
  promptUsers: readonly { readonly text: string; readonly images: readonly SelectedImage[] }[] = [],
): readonly { readonly text: string; readonly images: readonly SelectedImage[] }[] | undefined {
  try {
    const lists: { text: string; images: readonly SelectedImage[] }[] = [];
    const remainingPrompt = [...promptUsers];
    for (const turnId of turns) {
      const turnBytes = readCursorBlob(blobStore, turnId);
      if (turnBytes === undefined) return undefined;
      const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
      if (turn.turn.case !== 'agentConversationTurn') {
        if (turn.turn.case === undefined) return undefined;
        continue;
      }
      const userMessageBytes = readCursorBlob(blobStore, turn.turn.value.userMessage);
      if (userMessageBytes === undefined) return undefined;
      const userMessage = fromBinary(UserMessageSchema, userMessageBytes);
      if (userMessage.isSimulatedMsg === true) continue;
      const images = userMessage.selectedContext?.selectedImages ?? [];
      const empty = userMessage.text.length === 0 && images.length === 0;
      if (empty) {
        const laterPromptContent = remainingPrompt.some((slot) => slot.text.length > 0 || slot.images.length > 0);
        if (!laterPromptContent) continue;
      } else {
        remainingPrompt.shift();
      }
      lists.push({ text: userMessage.text, images });
    }
    return lists;
  } catch {
    return undefined;
  }
}

function imagesMatch(
  promptImages: readonly SelectedImage[],
  cachedImages: readonly SelectedImage[],
  blobStore: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (promptImages.length !== cachedImages.length) return false;
  return promptImages.every((image, imageIndex) => {
    const cachedImage = cachedImages[imageIndex]!;
    const data = imageData(image, blobStore);
    const cachedData = imageData(cachedImage, blobStore);
    return (
      image.mimeType === cachedImage.mimeType &&
      data !== undefined &&
      cachedData !== undefined &&
      Buffer.from(data).equals(cachedData)
    );
  });
}

function imageData(image: SelectedImage, blobStore: ReadonlyMap<string, Uint8Array>): Uint8Array | undefined {
  if (image.dataOrBlobId.case === 'data') return image.dataOrBlobId.value;
  if (image.dataOrBlobId.case === 'blobId') return readCursorBlob(blobStore, image.dataOrBlobId.value);
  if (image.dataOrBlobId.case === 'blobIdWithData') return image.dataOrBlobId.value.data;
  return undefined;
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
