import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

const PLACEHOLDER_CREDENTIAL = 'dynamic-credential';

export async function createOpenRouterRuntime(
  context: RuntimeContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const fetch = options.fetch ?? context.fetch ?? globalThis.fetch;
  const openrouter = createOpenRouter({
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: createOpenRouterDynamicFetch(context.credentials, { ...options, fetch }),
    compatibility: 'strict',
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: ((modelId: string) =>
        openrouter.chat(modelId)) as unknown as OAuthRuntimeResult['provider']['languageModel'],
      embeddingModel: ((modelId: string) =>
        openrouter.textEmbeddingModel(modelId)) as unknown as OAuthRuntimeResult['provider']['embeddingModel'],
      imageModel: ((modelId: string) =>
        openrouter.imageModel(modelId)) as unknown as OAuthRuntimeResult['provider']['imageModel'],
    },
  };
}

export function createOpenRouterDynamicFetch(
  credentials: CredentialPort<OpenRouterCredential>,
  options: OpenRouterOAuthOptions & { readonly fetch?: RuntimeFetch } = {},
): RuntimeFetch {
  const fetch = options.fetch ?? globalThis.fetch;
  const dynamicFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { value } = await credentials.read();
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${value.apiKey}`);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : request.signal);
    return await fetch(request.url, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: request.redirect,
    });
  };
  return Object.assign(dynamicFetch, { preconnect: fetch.preconnect });
}
