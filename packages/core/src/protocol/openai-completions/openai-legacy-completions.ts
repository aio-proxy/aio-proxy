import { ProviderProtocol } from '@aio-proxy/types';

import { writeOpenAITextCompletionResponse, writeOpenAITextCompletionSSE } from '../../egress/openai-text-completion';
import { OpenAICompletionsUnsupportedFeatureError } from '../../error';
import {
  type OpenAILegacyCompletionsRequest,
  parseOpenAILegacyCompletions,
} from '../../ingress/openai-legacy-completions';
import { defineProtocolAdapter, type EmptyProtocolContext } from '../adapter';
import { openAICompletionsErrors } from '../errors';
import { readJsonRequest } from '../request';
import type { SessionCandidate } from '../session';
import { rewriteOpenAICompletionsRaw } from './completions-raw';

export const openAILegacyCompletionsAdapter = defineProtocolAdapter<
  OpenAILegacyCompletionsRequest,
  EmptyProtocolContext
>({
  protocol: ProviderProtocol.OpenAICompatible,
  async parse(raw) {
    return parseOpenAILegacyCompletions(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  session: (request) => ({
    candidates: [
      candidate('openai-prompt-cache', request.prompt_cache_key),
      candidate('body-session', request.metadata?.session_id),
      candidate('body-conversation', request.metadata?.conversation_id),
      candidate('body-session', request.session_id),
      candidate('body-conversation', request.conversation_id),
    ].filter(isCandidate),
    transcript: request.prompt,
  }),
  wantsStream: (request) => request.stream === true,
  async rawRequest(raw, _request, resolvedModel, supportedEfforts) {
    return rewriteOpenAICompletionsRaw(raw, resolvedModel, supportedEfforts);
  },
  modelInvocation(request) {
    const content = legacyPromptText(request.prompt);
    if (request.n != null && request.n !== 1) {
      throw new OpenAICompletionsUnsupportedFeatureError('n', 'n');
    }
    if (request.stop != null) {
      throw new OpenAICompletionsUnsupportedFeatureError('stop', 'stop');
    }
    if (request.echo === true) {
      throw new OpenAICompletionsUnsupportedFeatureError('echo', 'echo');
    }
    if (request.suffix != null && request.suffix !== '') {
      throw new OpenAICompletionsUnsupportedFeatureError('suffix', 'suffix');
    }
    if (request.logprobs != null) {
      throw new OpenAICompletionsUnsupportedFeatureError('logprobs', 'logprobs');
    }
    if (request.best_of != null && request.best_of !== 1) {
      throw new OpenAICompletionsUnsupportedFeatureError('best_of', 'best_of');
    }
    if (request.logit_bias != null && Object.keys(request.logit_bias).length > 0) {
      throw new OpenAICompletionsUnsupportedFeatureError('logit_bias', 'logit_bias');
    }
    if (request.stream_options != null) {
      throw new OpenAICompletionsUnsupportedFeatureError('stream_options', 'stream_options');
    }

    return {
      messages: [{ role: 'user', content }],
      settings: {
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.top_p != null ? { top_p: request.top_p } : {}),
        ...(request.max_tokens != null ? { maxTokens: request.max_tokens } : {}),
        ...(request.seed != null ? { seed: request.seed } : {}),
        ...(request.presence_penalty != null ? { presencePenalty: request.presence_penalty } : {}),
        ...(request.frequency_penalty != null ? { frequencyPenalty: request.frequency_penalty } : {}),
      },
    };
  },
  modelJson: writeOpenAITextCompletionResponse,
  modelSse: writeOpenAITextCompletionSSE,
  errors: openAICompletionsErrors,
});

function legacyPromptText(prompt: OpenAILegacyCompletionsRequest['prompt']): string {
  if (prompt == null) {
    throw new OpenAICompletionsUnsupportedFeatureError('prompt_omitted', 'prompt');
  }
  if (typeof prompt === 'string') {
    return prompt;
  }
  if (isStringPromptArray(prompt)) {
    if (prompt.length === 1) {
      const [text] = prompt;
      if (text !== undefined) {
        return text;
      }
    }
    throw new OpenAICompletionsUnsupportedFeatureError('prompt_array', 'prompt');
  }
  throw new OpenAICompletionsUnsupportedFeatureError('prompt_tokens', 'prompt');
}

function isStringPromptArray(
  prompt: Exclude<NonNullable<OpenAILegacyCompletionsRequest['prompt']>, string>,
): prompt is string[] {
  return prompt.every((item): item is string => typeof item === 'string');
}

function candidate(source: SessionCandidate['source'], value: string | null | undefined): SessionCandidate | undefined {
  return value == null ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}
