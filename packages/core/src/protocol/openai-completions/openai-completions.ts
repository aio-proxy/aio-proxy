import { type AliasDimensions, canonicalEffort, ProviderProtocol } from '@aio-proxy/types';

import { writeOpenAICompletionsResponse, writeOpenAICompletionsSSE } from '../../egress/openai-completions';
import { type OpenAICompletionsRequest, parseOpenAICompletions } from '../../ingress/openai-completions';
import { openAICompletionsToModelMessages } from '../../transform/openai-completions/index';
import { defineProtocolAdapter, type EmptyProtocolContext } from '../adapter';
import { openAICompletionsErrors } from '../errors';
import { clampSdkReasoning } from '../reasoning-effort/index';
import { readJsonRequest } from '../request';
import type { SessionCandidate } from '../session';
import { functionToolSet } from '../tools';
import { rewriteOpenAICompletionsRaw } from './completions-raw';

export const openAICompletionsAdapter = defineProtocolAdapter<OpenAICompletionsRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAICompatible,
  async parse(raw) {
    return parseOpenAICompletions(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  dimensions: (request) => {
    const speed = speedFromServiceTier(request.service_tier);
    return {
      ...(request.reasoning_effort === undefined ? {} : { effort: canonicalEffort(request.reasoning_effort) }),
      ...(speed === undefined ? {} : { speed }),
    };
  },
  session: (request) => ({
    candidates: [
      candidate('openai-prompt-cache', request.prompt_cache_key),
      candidate('body-session', request.metadata?.session_id),
      candidate('body-conversation', request.metadata?.conversation_id),
      candidate('body-session', request.session_id),
      candidate('body-conversation', request.conversation_id),
    ].filter(isCandidate),
    transcript: request.messages,
  }),
  wantsStream: (request) => request.stream === true,
  async rawRequest(raw, _request, resolvedModel, supportedEfforts) {
    return rewriteOpenAICompletionsRaw(raw, resolvedModel, supportedEfforts);
  },
  modelInvocation(request) {
    const transformed = openAICompletionsToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return clampSdkReasoning(invocation, supportedEfforts);
  },
  modelJson: writeOpenAICompletionsResponse,
  modelSse: writeOpenAICompletionsSSE,
  errors: openAICompletionsErrors,
});

function candidate(source: SessionCandidate['source'], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}

function speedFromServiceTier(value: string | undefined): AliasDimensions['speed'] {
  if (value === undefined) return undefined;
  const tier = value.trim().toLowerCase();
  if (tier === 'priority' || tier === 'fast') return 'fast';
  if (tier === 'flex') return 'flex';
  return undefined;
}
