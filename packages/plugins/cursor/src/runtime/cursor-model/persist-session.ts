import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { Logger } from '@aio-proxy/plugin-sdk';
import { create, toBinary } from '@bufbuild/protobuf';
import { isPlainObject } from 'es-toolkit/predicate';

import { ConversationStateStructureSchema, type ConversationStateStructure } from '../../gen/agent_pb';
import type { CursorSessionState, CursorSessionStore } from '../../store/session-store';
import { appendCursorRootHistory } from '../history';
import type { CursorCompletedToolCall } from '../mcp-call';

export type PersistCursorSessionInput = {
  readonly sessionStore: CursorSessionStore;
  readonly storeKey: string;
  readonly prior: CursorSessionState | undefined;
  readonly conversationId: string;
  readonly requestPendingToolCalls: ReadonlyMap<string, string>;
  readonly conversationState: ConversationStateStructure;
  readonly routing?: {
    readonly routedProviderId: string;
    readonly observedAffinity?: { readonly revision: number };
    readonly updatesAffinity: boolean;
  };
  readonly prompt: LanguageModelV4Prompt;
  readonly turn: {
    readonly conversationState: ConversationStateStructure;
    readonly checkpointUsable: boolean;
    readonly pendingToolCalls: ReadonlyMap<string, string>;
    readonly toolCalls: readonly CursorCompletedToolCall[];
    readonly assistantText: string;
    readonly blobStore: Map<string, Uint8Array>;
  };
  readonly logger?: Logger;
  readonly requestId: string;
  readonly modelId: string;
};

const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

function parseStructuredToolInput(input: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(input);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function expectedAffinity(
  routing: PersistCursorSessionInput['routing'],
  prior: CursorSessionState | undefined,
): CursorSessionState['expectedAffinity'] {
  if (routing?.updatesAffinity === true) {
    return {
      providerId: routing.routedProviderId,
      revision: (routing.observedAffinity?.revision ?? 0) + 1,
    };
  }
  return prior?.expectedAffinity;
}

function warnPersist(
  logger: Logger | undefined,
  fields: {
    requestId: string;
    modelId: string;
    skippedCount: number;
    pendingCount: number;
    persistFailed?: boolean;
  },
): void {
  if (logger === undefined) return;
  const props: Record<string, unknown> = {};
  const requestId = safeLabel(fields.requestId);
  const modelId = safeLabel(fields.modelId);
  if (requestId !== undefined) props['requestId'] = requestId;
  if (modelId !== undefined) props['modelId'] = modelId;
  if (Number.isFinite(fields.skippedCount) && fields.skippedCount >= 0) props['skippedCount'] = fields.skippedCount;
  if (Number.isFinite(fields.pendingCount) && fields.pendingCount >= 0) props['pendingCount'] = fields.pendingCount;
  if (fields.persistFailed === true) props['persistFailed'] = true;
  try {
    logger.warn('Cursor session persist', props);
  } catch {
    // Logging must not change persist.
  }
}

function commitSession(input: PersistCursorSessionInput, next: CursorSessionState): void {
  if (input.sessionStore.get(input.storeKey) !== input.prior) return;
  input.sessionStore.set(input.storeKey, next);
}

function sessionWithRoot(
  input: PersistCursorSessionInput,
  nextPendingToolCalls: Map<string, string>,
  affinity: CursorSessionState['expectedAffinity'],
  conversationState: ConversationStateStructure,
  rootPromptMessagesJson: Uint8Array[],
  checkpointUsable: boolean,
): CursorSessionState {
  const cachedConversationState = create(ConversationStateStructureSchema, {
    ...conversationState,
    rootPromptMessagesJson,
  });
  return {
    conversationId: input.conversationId,
    conversationState: toBinary(ConversationStateStructureSchema, cachedConversationState),
    blobs: input.turn.blobStore,
    checkpointUsable,
    ...(affinity === undefined ? {} : { expectedAffinity: affinity }),
    pendingToolCalls: nextPendingToolCalls,
  };
}

function sessionPendingOnly(
  input: PersistCursorSessionInput,
  nextPendingToolCalls: Map<string, string>,
  affinity: CursorSessionState['expectedAffinity'],
): CursorSessionState {
  return {
    conversationId: input.conversationId,
    ...(input.prior?.conversationState === undefined ? {} : { conversationState: input.prior.conversationState }),
    blobs: input.turn.blobStore,
    checkpointUsable: false,
    ...(affinity === undefined ? {} : { expectedAffinity: affinity }),
    pendingToolCalls: nextPendingToolCalls,
  };
}

export function persistCursorSession(input: PersistCursorSessionInput): void {
  const nextPendingToolCalls = new Map(input.requestPendingToolCalls);
  for (const [outerCallId, nestedToolCallId] of input.turn.pendingToolCalls) {
    nextPendingToolCalls.set(outerCallId, nestedToolCallId);
  }
  const structuredCalls: Array<{
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }> = [];
  let skippedCount = 0;
  for (const call of input.turn.toolCalls) {
    const parsed = parseStructuredToolInput(call.input);
    if (parsed === undefined) {
      skippedCount += 1;
      continue;
    }
    structuredCalls.push({
      type: 'tool-call',
      toolCallId: call.outerCallId,
      toolName: call.toolName,
      input: parsed,
    });
  }
  const affinity = expectedAffinity(input.routing, input.prior);
  let persistFailed = false;
  try {
    const active = input.prompt.at(-1);
    const tail: LanguageModelV4Prompt = [
      ...(active?.role === 'user' ? [active] : []),
      {
        role: 'assistant',
        content: [
          ...(input.turn.assistantText ? [{ type: 'text' as const, text: input.turn.assistantText }] : []),
          ...structuredCalls,
        ],
      },
    ];
    const rootPromptMessagesJson = appendCursorRootHistory({
      rootPromptMessagesJson: input.conversationState.rootPromptMessagesJson,
      prompt: tail,
      blobStore: input.turn.blobStore,
    });
    commitSession(
      input,
      sessionWithRoot(
        input,
        nextPendingToolCalls,
        affinity,
        input.turn.conversationState,
        rootPromptMessagesJson,
        input.turn.checkpointUsable && nextPendingToolCalls.size === 0,
      ),
    );
  } catch {
    persistFailed = true;
    try {
      commitSession(input, sessionPendingOnly(input, nextPendingToolCalls, affinity));
    } catch {
      // Last-resort write already failed; the warn below is the remaining signal.
    }
  }
  if (skippedCount > 0 || persistFailed) {
    warnPersist(input.logger, {
      requestId: input.requestId,
      modelId: input.modelId,
      skippedCount,
      pendingCount: nextPendingToolCalls.size,
      ...(persistFailed ? { persistFailed: true } : {}),
    });
  }
}
