import type { ApiProviderInstance } from '@aio-proxy/core';
import type { DashboardProviderProbe, Provider, ProviderKind } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderProtocol } from '@aio-proxy/types';

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

const probeMaxOutputTokens = 1;
const openAIResponsesProbeMaxOutputTokens = 16;

export type ProviderProbeRequest = {
  readonly body?: unknown;
  /** A GET probe carries neither a body nor a content-type; omitted means POST. */
  readonly method?: 'GET' | 'POST';
  readonly path: string;
};

export async function probeApi(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  instance: ApiProviderInstance,
): Promise<DashboardProviderProbe> {
  try {
    const model = providerProbeModel(provider);
    // A provider with neither models nor alias exposes no route, so it stays FAIL
    // for every protocol — including openai-audio, whose probe ignores the model.
    if (model === undefined) {
      return 'FAIL';
    }
    const request = providerProbeRequest(provider, model);
    const signal = AbortSignal.timeout(10_000);
    const init: RequestInit =
      request.method === 'GET'
        ? { method: 'GET', signal }
        : {
            body: JSON.stringify(request.body),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
            signal,
          };
    const response = await instance.passthrough(new Request(new URL(request.path, 'http://probe.internal'), init), {
      upstreamStream: false,
    });
    if (response.body !== null) {
      await response.body.cancel();
    }
    return response.ok ? 'OK' : 'FAIL';
  } catch (error) {
    if (error instanceof Error) {
      return 'FAIL';
    }
    throw error;
  }
}

export function providerProbeRequest(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  model: string,
): ProviderProbeRequest {
  const primary = apiProviderEndpoints(provider)[0];
  switch (primary.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return {
        body: { max_tokens: probeMaxOutputTokens, messages: [{ role: 'user', content: 'ping' }], model },
        path: '/v1/chat/completions',
      };
    case ProviderProtocol.OpenAIResponse:
      return {
        body: { input: 'ping', max_output_tokens: openAIResponsesProbeMaxOutputTokens, model },
        path: '/v1/responses',
      };
    case ProviderProtocol.Anthropic:
      return {
        body: {
          max_tokens: probeMaxOutputTokens,
          messages: [{ role: 'user', content: 'ping' }],
          model,
        },
        path: '/v1/messages',
      };
    case ProviderProtocol.Gemini:
      return {
        body: {
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: probeMaxOutputTokens },
        },
        path: `/v1beta/models/${model}:generateContent`,
      };
    case ProviderProtocol.GeminiInteractions:
      return {
        body: { model, input: 'ping', store: false },
        path: '/v1beta/interactions',
      };
    case ProviderProtocol.OpenAIImage:
      return {
        body: { model, n: 1, prompt: 'ping' },
        path: '/v1/images/generations',
      };
    case ProviderProtocol.OpenAIAudio:
      // Verify connectivity and credentials only: a configured model may support
      // speech synthesis alone or transcription alone, so a capability request in
      // either direction would be rejected by the other kind of model and report a
      // false FAIL.
      return { method: 'GET', path: '/v1/models' };
    default:
      return assertNever(primary.protocol);
  }
}

export function providerProbeModel(provider: Extract<Provider, { kind: ProviderKind.Api }>): string | undefined {
  const aliasTarget = provider.alias === undefined ? undefined : Object.values(provider.alias)[0]?.model;
  return aliasTarget ?? provider.models?.[0];
}

export async function probeAiSdk(provider: {
  readonly ensureAvailable?: () => Promise<void>;
}): Promise<DashboardProviderProbe> {
  if (provider.ensureAvailable === undefined) {
    return 'OK';
  }

  try {
    await provider.ensureAvailable();
    return 'OK';
  } catch (error) {
    if (error instanceof Error) {
      return 'FAIL';
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
