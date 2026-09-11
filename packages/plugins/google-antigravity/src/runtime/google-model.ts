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
      const thinking = synthesizeThinking(
        split.privateOptions.thinking,
        split.privateOptions.effort,
        options.reasoning,
      );
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
      const thinking = synthesizeThinking(
        split.privateOptions.thinking,
        split.privateOptions.effort,
        options.reasoning,
      );
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
  effort: string | undefined,
  reasoning: unknown,
): AntigravityThinkingOption | undefined {
  if (existing !== undefined) return existing;
  // The host's canonical effort wins: it is already clamped to this wire's
  // advertised set and can carry a level the AI SDK union cannot express.
  const requested =
    effort ?? (typeof reasoning === 'string' && reasoning !== 'provider-default' ? reasoning : undefined);
  if (requested === undefined) return undefined;
  return requested === 'none' ? { mode: 'disabled' } : { mode: 'adaptive', effort: requested };
}

function googleDelegate(modelId: string, call?: AntigravityGoogleFetchContext): LanguageModelV4 {
  return createGoogleGenerativeAI({
    name: 'google-antigravity',
    apiKey: PLACEHOLDER_CREDENTIAL,
    ...(call === undefined ? {} : { fetch: createAntigravityGoogleFetch(call, modelId) }),
  }).languageModel(modelId);
}
