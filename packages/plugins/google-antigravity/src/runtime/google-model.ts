import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { AntigravityThinkingOption } from '../protocol/thinking';
import { type AntigravityGoogleFetchContext, createAntigravityGoogleFetch } from './google-fetch';
import { takeAioProxyOptions } from './private-options';
import { bridgeLateReasoningSignatures } from './reasoning-signature-stream';

const PLACEHOLDER_CREDENTIAL = 'dynamic-oauth-credential';

export type AntigravityLanguageModelRuntime = {
  readonly call: (context: LogicalRequestContext) => AntigravityGoogleFetchContext;
};

export function createAntigravityLanguageModel(
  modelId: string,
  runtime: AntigravityLanguageModelRuntime,
): LanguageModelV4 {
  const shape = googleDelegate(modelId);
  return {
    specificationVersion: 'v4',
    provider: shape.provider,
    modelId: shape.modelId,
    supportedUrls: shape.supportedUrls,
    async doGenerate(options) {
      const split = takeAioProxyOptions(options.providerOptions);
      const thinking = synthesizeThinking(split.privateOptions.thinking, options.reasoning);
      return await googleDelegate(modelId, {
        ...runtime.call(split.context),
        ...(thinking === undefined ? {} : { thinking }),
      }).doGenerate({
        ...options,
        reasoning: 'provider-default',
        providerOptions: split.providerOptions,
      });
    },
    async doStream(options) {
      const split = takeAioProxyOptions(options.providerOptions);
      const thinking = synthesizeThinking(split.privateOptions.thinking, options.reasoning);
      const result = await googleDelegate(modelId, {
        ...runtime.call(split.context),
        ...(thinking === undefined ? {} : { thinking }),
      }).doStream({
        ...options,
        reasoning: 'provider-default',
        includeRawChunks: true,
        providerOptions: split.providerOptions,
      });
      return {
        ...result,
        stream: bridgeLateReasoningSignatures(result.stream, modelId, options.includeRawChunks === true),
      };
    },
  };
}

export function synthesizeThinking(
  existing: AntigravityThinkingOption | undefined,
  reasoning: unknown,
): AntigravityThinkingOption | undefined {
  if (existing !== undefined) return existing;
  if (typeof reasoning !== 'string' || reasoning === 'provider-default') return undefined;
  return reasoning === 'none' ? { mode: 'disabled' } : { mode: 'adaptive', effort: reasoning };
}

function googleDelegate(modelId: string, call?: AntigravityGoogleFetchContext): LanguageModelV4 {
  return createGoogleGenerativeAI({
    name: 'google-antigravity',
    apiKey: PLACEHOLDER_CREDENTIAL,
    ...(call === undefined ? {} : { fetch: createAntigravityGoogleFetch(call, modelId) }),
  }).languageModel(modelId);
}
