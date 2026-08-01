import { createHash } from 'node:crypto';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { type CredentialPort, zod } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { ConversationStateStructureSchema } from '../gen/agent_pb';
import { currentCursorCredential, type CursorOAuthDependencies } from '../oauth';
import type { CursorCredential } from '../schema';
import { type CursorSessionState, type CursorSessionStore, sessionKey } from '../store/session-store';
import type { CursorTransport } from '../wire/transport';
import { runCursorTurn } from './driver';
import { buildMcpToolDefinitions } from './mcp-tools';
import { buildCursorRunRequestBytes, type CursorRunState } from './run-request';

export type CursorModelRuntime = {
  readonly transport: CursorTransport;
  readonly credentials: CredentialPort<CursorCredential>;
  readonly sessionStore: CursorSessionStore;
  readonly credentialOptions?: CursorOAuthDependencies;
  readonly model: {
    readonly wireModelId: string;
    readonly displayModelId: string;
    readonly displayName: string;
    readonly maxMode: boolean;
  };
  readonly baseUrl?: string;
  readonly now?: () => number;
};

// The AI SDK carries aio-proxy's logical-session key under providerOptions.aioProxy.
// It anchors multi-turn state to one Cursor conversation; a missing/invalid key
// means a stateless call (no session reuse, nothing persisted).
const sessionKeySchema = zod
  .object({ session: zod.object({ key: zod.string().startsWith('sha256:') }) })
  .transform((value) => value.session.key);

function logicalSessionKey(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
  const parsed = sessionKeySchema.safeParse(providerOptions?.['aioProxy']?.['logicalRequest']);
  return parsed.success ? parsed.data : undefined;
}

function functionTools(options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] {
  return (options.tools ?? []).filter((tool): tool is LanguageModelV4FunctionTool => tool.type === 'function');
}

export function createCursorLanguageModel(modelId: string, runtime: CursorModelRuntime): LanguageModelV4 {
  const doStream: LanguageModelV4['doStream'] = async (options) => {
    const credential = await currentCursorCredential(runtime.credentials, {
      ...runtime.credentialOptions,
      ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
    });
    // Identity scope keys session storage per account without ever touching the
    // raw token (JWT sub when present, else a short access-token hash).
    const identityScope =
      credential.subject ?? createHash('sha256').update(credential.accessToken).digest('hex').slice(0, 16);
    const logicalKey = logicalSessionKey(options.providerOptions);
    const storeKey =
      logicalKey === undefined ? undefined : sessionKey({ identityScope, logicalSessionKey: logicalKey });
    const prior = storeKey === undefined ? undefined : runtime.sessionStore.get(storeKey);
    const conversationId = prior?.conversationId ?? crypto.randomUUID();
    const blobStore = new Map(prior?.blobs ?? []);
    // Only reuse a checkpoint that ended a clean (tool-free) turn; a mid-tool
    // checkpoint would resume into a half-finished tool exchange.
    const priorState =
      prior?.checkpointUsable && prior.conversationState !== undefined
        ? fromBinary(ConversationStateStructureSchema, prior.conversationState)
        : undefined;
    const runState: CursorRunState = {
      conversationId,
      blobStore,
      ...(priorState === undefined ? {} : { conversationState: priorState }),
    };
    const { requestBytes } = buildCursorRunRequestBytes({
      prompt: options.prompt,
      wireModelId: runtime.model.wireModelId,
      displayModelId: runtime.model.displayModelId,
      displayName: runtime.model.displayName,
      maxMode: runtime.model.maxMode,
      state: runState,
    });
    const { stream, result } = runCursorTurn({
      transport: runtime.transport,
      accessToken: credential.accessToken,
      ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
      ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      requestBytes,
      initialConversationState: runState.conversationState ?? create(ConversationStateStructureSchema, {}),
      requestContextTools: buildMcpToolDefinitions(functionTools(options)),
      blobStore,
      heartbeatMs: 5_000,
    });
    void result
      .then((turn) => {
        if (storeKey === undefined) return;
        const next: CursorSessionState = {
          conversationId,
          conversationState: toBinary(ConversationStateStructureSchema, turn.conversationState),
          blobs: turn.blobStore,
          checkpointUsable: turn.checkpointUsable,
          pendingToolCalls: turn.pendingToolCalls,
        };
        runtime.sessionStore.set(storeKey, next);
      })
      .catch(() => {
        if (storeKey !== undefined) runtime.sessionStore.delete(storeKey);
      });
    return { stream };
  };
  return {
    specificationVersion: 'v4',
    provider: 'cursor-oauth',
    modelId,
    supportedUrls: {},
    doStream,
    doGenerate: async (options) => await drain(await doStream(options)),
  };
}

// doGenerate folds the streamed parts into a single generate result: one text
// content part, any completed tool calls, and the terminal finish usage/reason.
async function drain(streamResult: {
  stream: ReadableStream<LanguageModelV4StreamPart>;
}): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4GenerateResult['content'] = [];
  let text = '';
  let usage: LanguageModelV4GenerateResult['usage'] | undefined;
  let finishReason: LanguageModelV4GenerateResult['finishReason'] | undefined;
  const reader = streamResult.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'text-delta') text += value.delta;
    else if (value.type === 'tool-call') content.push(value);
    else if (value.type === 'finish') {
      usage = value.usage;
      finishReason = value.finishReason;
    }
  }
  if (text.length > 0) content.unshift({ type: 'text', text });
  return {
    content,
    usage: usage ?? emptyUsage(),
    finishReason: finishReason ?? { unified: 'stop', raw: undefined },
    warnings: [],
  };
}

function emptyUsage(): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}
