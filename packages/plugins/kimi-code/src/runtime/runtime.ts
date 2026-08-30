import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { OAuthRuntimeResult, ProtocolId, RuntimeContext } from '@aio-proxy/plugin-sdk';
import { createOpenAIStreamFetch } from '@aio-proxy/plugin-sdk/openai-stream';
import { isPlainObject } from 'es-toolkit/predicate';

import { kimiIdentityHeaders } from '../headers';
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from '../oauth';

type KimiProtocol = Extract<ProtocolId, 'openai-compatible' | 'anthropic'>;

const PLACEHOLDER = 'dynamic-credential';

export async function createKimiRuntime(
  context: RuntimeContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthRuntimeResult> {
  const fetch = dependencies.fetch ?? context.fetch;
  const dynamicFetch = createKimiDynamicFetch(context.credentials, { ...dependencies, fetch });
  const compatibleFetch = createOpenAIStreamFetch('openai-compatible', dynamicFetch, {
    rewriteToolImages: true,
  });
  const openai = createOpenAICompatible({
    name: 'kimi-code.openai-compatible',
    baseURL: 'https://api.kimi.com/coding/v1',
    apiKey: PLACEHOLDER,
    fetch: compatibleFetch,
  });
  const anthropic = createAnthropic({
    name: 'kimi-code.anthropic',
    baseURL: 'https://api.kimi.com/coding/v1',
    authToken: PLACEHOLDER,
    fetch: dynamicFetch,
  });
  const protocols = new Map(
    context.catalog.language.flatMap((model) => {
      const protocol = catalogProtocol(model.extra);
      return protocol === undefined ? [] : [[model.id, protocol] as const];
    }),
  );
  const modelIds = new Set(context.catalog.language.map((model) => model.id));

  return {
    provider: {
      specificationVersion: 'v4',
      languageModel(modelId) {
        const protocol = protocols.get(modelId);
        if (protocol === 'anthropic') return anthropic.languageModel(modelId);
        if (protocol === 'openai-compatible') return openai.languageModel(modelId);
        throw new Error(`Kimi Code model ${modelId} has no supported protocol metadata`);
      },
      embeddingModel: (modelId) => openai.embeddingModel(modelId),
      imageModel: (modelId) => openai.imageModel(modelId),
    },
    raw(input) {
      if (input.capability === 'embedding') return undefined;
      if (!modelIds.has(input.modelId)) return undefined;
      const protocol =
        input.protocol === 'anthropic' || input.protocol === 'openai-compatible' ? input.protocol : undefined;
      if (protocol === undefined) return undefined;
      if (input.requestPath !== undefined && !advertisedRawPath(protocol, input.requestPath)) {
        return undefined;
      }
      return {
        invoke: async (request) => {
          const upstream = rewriteRawRequest(request, protocol);
          return upstream === undefined ? unsupportedRawPath(protocol) : dynamicFetch(upstream);
        },
      };
    },
    tokenCount: {
      async countTokens(input) {
        if (input.protocol !== 'anthropic') {
          throw new Error(`Kimi token count does not support ${input.protocol}`);
        }
        const body: unknown = await input.request.json();
        if (!isPlainObject(body)) {
          throw new Error('Kimi token count request is invalid');
        }
        const response = await dynamicFetch('https://api.kimi.com/coding/v1/messages/count_tokens?beta=true', {
          method: 'POST',
          headers: input.request.headers,
          body: JSON.stringify({ ...body, model: input.modelId }),
          signal: input.request.signal,
        });
        if (!response.ok) throw new Error(`Kimi token count request failed with ${response.status}`);
        const result: unknown = await response.json();
        const inputTokens =
          typeof result === 'object' && result !== null ? Reflect.get(result, 'input_tokens') : undefined;
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
          throw new Error('Kimi token count response is invalid');
        }
        return { inputTokens };
      },
    },
  };
}

export function createKimiDynamicFetch(
  credentials: RuntimeContext<KimiCredential, Record<string, never>>['credentials'],
  dependencies: KimiOAuthDependencies = {},
) {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const fetchWithCredential = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const credential = await currentKimiCredential(credentials, {
      ...dependencies,
      fetch,
      signal: request.signal,
    });
    const headers = new Headers(request.headers);
    for (const key of [
      'authorization',
      'proxy-authorization',
      'cookie',
      'host',
      'x-api-key',
      'x-goog-api-key',
      'anthropic-api-key',
    ]) {
      headers.delete(key);
    }
    headers.set('authorization', `Bearer ${credential.accessToken}`);
    for (const [key, value] of Object.entries(kimiIdentityHeaders(credential.deviceId))) headers.set(key, value);
    return await fetch(request.url, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
      signal: request.signal,
      redirect: request.redirect,
    });
  };
  return Object.assign(fetchWithCredential, { preconnect: globalThis.fetch.preconnect });
}

// Undefined when the inbound endpoint has no Kimi Code counterpart. Kimi Code
// only serves Chat Completions and Anthropic Messages, so inbound endpoints such
// as legacy `/v1/completions` must not be guessed onto an upstream path.
function advertisedRawPath(protocol: KimiProtocol, pathname: string): boolean {
  return pathname === (protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
}

function rewriteRawRequest(request: Request, protocol: KimiProtocol): Request | undefined {
  const source = new URL(request.url);
  if (!advertisedRawPath(protocol, source.pathname)) return undefined;
  const expectedPath = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const target = new URL(`https://api.kimi.com/coding${expectedPath}`);
  target.search = source.search;
  return new Request(target, request);
}

// Declining raw as an upstream-shaped 501 keeps the inbound protocol's error
// contract and stays fallback-eligible, unlike a thrown error that the pipeline
// can only report as a generic 500. The message repeats no inbound detail.
function unsupportedRawPath(protocol: KimiProtocol): Response {
  const message = 'Kimi Code does not serve this endpoint';
  return protocol === 'anthropic'
    ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 501 })
    : Response.json(
        { error: { code: 'unsupported_endpoint', message, type: 'invalid_request_error' } },
        { status: 501 },
      );
}

function catalogProtocol(extra: unknown): KimiProtocol | undefined {
  if (!isPlainObject(extra)) return undefined;
  const value = Reflect.get(extra, 'protocol');
  return value === 'anthropic' || value === 'openai-compatible' ? value : undefined;
}
