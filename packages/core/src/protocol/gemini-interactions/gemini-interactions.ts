import { ProviderProtocol } from '@aio-proxy/types';
import { z } from 'zod';

import type { AiSdkCallSettings } from '../../ai-sdk-bridge';
import { writeGeminiInteractionsResponse, writeGeminiInteractionsSSE } from '../../egress/gemini-interactions';
import { type GeminiInteractionsRequest, parseGeminiInteractions } from '../../ingress/gemini-interactions/index';
import {
  type GeminiInteractionsTransformSettings,
  geminiInteractionsDimensions,
  geminiInteractionsToModelMessages,
} from '../../transform/gemini-interactions/index';
import { defineProtocolAdapter, type EmptyProtocolContext } from '../adapter';
import { geminiInteractionsErrors } from '../errors';
import { clampSdkReasoning } from '../reasoning-effort/index';
import { readJsonRequest, readRequestText } from '../request';
import { functionToolSet } from '../tools';

const rawBodySchema = z.object({}).catchall(z.unknown());

export const geminiInteractionsAdapter = defineProtocolAdapter<GeminiInteractionsRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.GeminiInteractions,
  async parse(raw) {
    return parseGeminiInteractions(await readJsonRequest(raw));
  },
  model: (request) => request.routingId,
  dimensions: (request) => geminiInteractionsDimensions(request),
  wantsStream: (request) => request.body.stream === true,
  async rawRequest(raw, request, resolvedModel) {
    const bodyText = await readRequestText(raw);
    const body = rawBodySchema.parse(JSON.parse(bodyText));
    const rewritten = rewriteAuthoredId(body, request.idField, resolvedModel);
    const headers = new Headers(raw.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    const url = new URL(raw.url);
    url.pathname = '/v1beta/interactions';
    return new Request(url, {
      method: raw.method,
      headers,
      body: rewritten === body ? bodyText : JSON.stringify(rewritten),
      signal: raw.signal,
    });
  },
  modelInvocation(request) {
    const transformed = geminiInteractionsToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: aiSdkSettings(transformed.settings),
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return clampSdkReasoning(invocation, supportedEfforts);
  },
  modelJson: writeGeminiInteractionsResponse,
  modelSse: writeGeminiInteractionsSSE,
  errors: geminiInteractionsErrors,
});

function rewriteAuthoredId(
  body: Record<string, unknown>,
  idField: GeminiInteractionsRequest['idField'],
  resolvedModel: string,
): Record<string, unknown> {
  if (idField === 'model' && body['model'] !== resolvedModel) {
    return { ...body, model: resolvedModel };
  }
  if (idField === 'agent' && body['agent'] !== resolvedModel) {
    return { ...body, agent: resolvedModel };
  }
  return body;
}

function aiSdkSettings(settings: GeminiInteractionsTransformSettings): AiSdkCallSettings {
  return {
    ...(settings.maxOutputTokens === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens }),
    ...(settings.seed === undefined ? {} : { seed: settings.seed }),
    ...(settings.stopSequences === undefined ? {} : { stopSequences: settings.stopSequences }),
    ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
    ...(settings.toolChoice === undefined ? {} : { toolChoice: settings.toolChoice }),
  };
}
