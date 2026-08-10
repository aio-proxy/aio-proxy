import { createHash } from 'node:crypto';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  SharedV4Warning,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import { type CredentialPort, zod } from '@aio-proxy/plugin-sdk';
import { fromBinary, toBinary } from '@bufbuild/protobuf';

import { ConversationStateStructureSchema } from '../../gen/agent_pb';
import { currentCursorCredential, type CursorOAuthDependencies } from '../../oauth';
import type { CursorCredential } from '../../schema';
import { type CursorSessionState, type CursorSessionStore, sessionKey } from '../../store/session-store';
import type { CursorTransport } from '../../wire/transport';
import { runCursorTurn } from '../driver';
import { hasMatchingPendingToolResult } from '../history';
import { buildMcpToolDefinitions } from '../mcp-tools';
import { buildCursorRunRequestBytes, type CursorRunState } from '../run-request';

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

const routingContinuitySchema = zod.object({
  routedProviderId: zod.string().min(1),
  observedAffinity: zod
    .object({
      providerId: zod.string().min(1),
      revision: zod.number().int().nonnegative(),
      active: zod.boolean(),
    })
    .optional(),
  responseOwnerProviderId: zod.string().min(1).optional(),
  updatesAffinity: zod.boolean(),
});

type RoutingContinuity = zod.infer<typeof routingContinuitySchema>;

function logicalSessionKey(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
  const parsed = sessionKeySchema.safeParse(providerOptions?.['aioProxy']?.['logicalRequest']);
  return parsed.success ? parsed.data : undefined;
}

function routingContinuity(providerOptions: SharedV4ProviderOptions | undefined): RoutingContinuity | undefined {
  const parsed = routingContinuitySchema.safeParse(providerOptions?.['aioProxy']?.['routingContinuity']);
  return parsed.success ? parsed.data : undefined;
}

function canReuseCheckpoint(prior: CursorSessionState, routing: RoutingContinuity): boolean {
  const expected = prior.expectedAffinity;
  if (expected === undefined) {
    return routing.observedAffinity === undefined && routing.responseOwnerProviderId === routing.routedProviderId;
  }
  return (
    expected.providerId === routing.routedProviderId &&
    (routing.responseOwnerProviderId === undefined || routing.responseOwnerProviderId === routing.routedProviderId) &&
    routing.observedAffinity?.providerId === expected.providerId &&
    routing.observedAffinity.revision === expected.revision
  );
}

const unsupportedSettings = [
  'maxOutputTokens',
  'temperature',
  'stopSequences',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
] as const satisfies readonly (keyof LanguageModelV4CallOptions)[];

function unsupportedWarnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const feature of unsupportedSettings) {
    if (options[feature] !== undefined) warnings.push({ type: 'unsupported', feature });
  }
  if (options.responseFormat?.type === 'json') warnings.push({ type: 'unsupported', feature: 'responseFormat' });
  if (options.reasoning !== undefined && options.reasoning !== 'provider-default') {
    warnings.push({ type: 'unsupported', feature: 'reasoning' });
  }
  if (options.toolChoice?.type === 'required') {
    warnings.push({ type: 'unsupported', feature: 'toolChoice: required' });
  }
  return warnings;
}

export function createCursorLanguageModel(modelId: string, runtime: CursorModelRuntime): LanguageModelV4 {
  const doStream: LanguageModelV4['doStream'] = async (options) => {
    const warnings = unsupportedWarnings(options);
    const requestContextTools = buildMcpToolDefinitions(options.tools, options.toolChoice);
    const credential = await currentCursorCredential(runtime.credentials, {
      ...runtime.credentialOptions,
      ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
    });
    // Identity scope keys session storage per account without ever touching the
    // raw token (JWT sub when present, else a short access-token hash).
    const identityScope =
      credential.subject ?? createHash('sha256').update(credential.accessToken).digest('hex').slice(0, 16);
    const logicalKey = logicalSessionKey(options.providerOptions);
    const routing = routingContinuity(options.providerOptions);
    const storeKey =
      logicalKey === undefined ? undefined : sessionKey({ identityScope, logicalSessionKey: logicalKey });
    const cachedPrior = storeKey === undefined ? undefined : runtime.sessionStore.get(storeKey);
    const prior =
      cachedPrior === undefined || routing === undefined || canReuseCheckpoint(cachedPrior, routing)
        ? cachedPrior
        : undefined;
    if (storeKey !== undefined && cachedPrior !== undefined && prior === undefined)
      runtime.sessionStore.delete(storeKey);
    const conversationId = prior?.conversationId ?? crypto.randomUUID();
    const blobStore = new Map(prior?.blobs ?? []);
    const isPendingResume = prior !== undefined && hasMatchingPendingToolResult(options.prompt, prior.pendingToolCalls);
    const priorState =
      prior?.conversationState !== undefined && (prior.checkpointUsable || isPendingResume)
        ? fromBinary(ConversationStateStructureSchema, prior.conversationState)
        : undefined;
    const runState: CursorRunState = {
      conversationId,
      blobStore,
      ...(priorState === undefined ? {} : { conversationState: priorState }),
      ...(isPendingResume ? { pendingToolCalls: prior!.pendingToolCalls } : {}),
    };
    const { requestBytes, conversationState, pendingToolCalls } = buildCursorRunRequestBytes({
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
      initialConversationState: conversationState,
      requestContextTools,
      blobStore,
      heartbeatMs: 5_000,
    });
    void result
      .then((turn) => {
        if (storeKey === undefined) return;
        const nextPendingToolCalls = new Map(pendingToolCalls);
        for (const [outerCallId, nestedToolCallId] of turn.pendingToolCalls) {
          nextPendingToolCalls.set(outerCallId, nestedToolCallId);
        }
        const next: CursorSessionState = {
          conversationId,
          conversationState: toBinary(ConversationStateStructureSchema, turn.conversationState),
          blobs: turn.blobStore,
          checkpointUsable: turn.checkpointUsable && nextPendingToolCalls.size === 0,
          ...(routing?.updatesAffinity === true
            ? {
                expectedAffinity: {
                  providerId: routing.routedProviderId,
                  revision: (routing.observedAffinity?.revision ?? 0) + 1,
                },
              }
            : prior?.expectedAffinity === undefined
              ? {}
              : { expectedAffinity: prior.expectedAffinity }),
          pendingToolCalls: nextPendingToolCalls,
        };
        if (runtime.sessionStore.get(storeKey) !== prior) {
          runtime.sessionStore.delete(storeKey);
          return;
        }
        runtime.sessionStore.set(storeKey, next);
      })
      .catch(() => {});
    return {
      stream: stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          start: (controller) => controller.enqueue({ type: 'stream-start', warnings }),
        }),
      ),
    };
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

// doGenerate folds the stream into ordered text/reasoning segments, completed
// tool calls, and the terminal finish usage/reason.
async function drain(streamResult: {
  stream: ReadableStream<LanguageModelV4StreamPart>;
}): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4GenerateResult['content'] = [];
  let text = '';
  let reasoning = '';
  let usage: LanguageModelV4GenerateResult['usage'] | undefined;
  let finishReason: LanguageModelV4GenerateResult['finishReason'] | undefined;
  let warnings: LanguageModelV4GenerateResult['warnings'] = [];
  const flushText = () => {
    if (text.length > 0) content.push({ type: 'text', text });
    text = '';
  };
  const flushReasoning = () => {
    if (reasoning.length > 0) content.push({ type: 'reasoning', text: reasoning });
    reasoning = '';
  };
  const reader = streamResult.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'stream-start') warnings = value.warnings;
    else if (value.type === 'text-delta') {
      flushReasoning();
      text += value.delta;
    } else if (value.type === 'text-end') flushText();
    else if (value.type === 'reasoning-delta') {
      flushText();
      reasoning += value.delta;
    } else if (value.type === 'reasoning-end') flushReasoning();
    else if (value.type === 'tool-call') content.push(value);
    else if (value.type === 'finish') {
      usage = value.usage;
      finishReason = value.finishReason;
    }
  }
  flushText();
  flushReasoning();
  return {
    content,
    usage: usage ?? emptyUsage(),
    finishReason: finishReason ?? { unified: 'stop', raw: undefined },
    warnings,
  };
}

function emptyUsage(): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}
