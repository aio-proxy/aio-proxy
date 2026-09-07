import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { currentMuseCodeCredential, type MuseCodeOAuthOptions } from '../oauth';
import type { MuseCodeCredential } from '../schema';

export async function createMuseCodeRuntime(
  context: RuntimeContext<MuseCodeCredential, Record<string, never>>,
  options: MuseCodeOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const openai = createOpenAI({
    name: 'muse-code-oauth',
    baseURL: 'https://api.meta.ai/v1',
    apiKey: 'dynamic-credential',
    headers: { 'x-api-version': '1.0.0' },
    fetch: createMuseCodeDynamicFetch(context.credentials, { ...options, fetch: options.fetch ?? context.fetch }),
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openai.responses(modelId),
      embeddingModel: () => unsupported('embedding'),
      imageModel: () => unsupported('image'),
    },
  };
}

export function createMuseCodeDynamicFetch(
  credentials: CredentialPort<MuseCodeCredential>,
  options: MuseCodeOAuthOptions = {},
): RuntimeFetch {
  const fetch = options.fetch ?? globalThis.fetch;
  const dynamicFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : options.signal);
    const credential = await currentMuseCodeCredential(credentials, {
      ...options,
      fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${credential.apiKey}`);
    headers.set('x-api-version', '1.0.0');
    headers.delete('content-length');
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
    return await fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: request.redirect,
    });
  };
  return Object.assign(dynamicFetch, { preconnect: globalThis.fetch.preconnect });
}

function unsupported(surface: string): never {
  throw new Error(`Muse Code OAuth does not support ${surface}`);
}
