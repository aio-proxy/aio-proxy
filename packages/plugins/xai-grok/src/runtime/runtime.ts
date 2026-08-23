import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_BASE_URL } from '../cli-headers';
import { currentXAIGrokCredential, type XAIGrokFetch, type XAIGrokOAuthOptions } from '../oauth';
import type { XAIGrokCredential } from '../schema';
import { sanitizeXAIGrokResponsesBody } from './sanitize-responses';

export async function createXAIGrokRuntime(
  context: RuntimeContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const fetch = options.fetch ?? context.fetch;
  const openai = createOpenAI({
    name: 'xai-grok-oauth',
    baseURL: XAI_GROK_CLI_BASE_URL,
    apiKey: 'dynamic-credential',
    fetch: createXAIGrokDynamicFetch(context.credentials, { ...options, fetch }),
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openai.responses(modelId),
      embeddingModel: () => unsupported('embedding'),
      imageModel: () => unsupported('image generation'),
    },
  };
}

export function createXAIGrokDynamicFetch(
  credentials: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): XAIGrokFetch {
  const fetch = options.fetch ?? globalThis.fetch;
  const dynamicFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : options.signal);
    const credential = await currentXAIGrokCredential(credentials, {
      ...options,
      fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    const request = new Request(input, init);
    const headers = createXAIGrokCLIHeaders(credential, request.headers);
    headers.delete('content-length');
    const body = await outgoingBody(request);
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
  throw new Error(`xAI Grok OAuth does not support ${surface}`);
}

async function outgoingBody(request: Request): Promise<BodyInit | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const original = new Uint8Array(await request.arrayBuffer());
  if (!new URL(request.url).pathname.endsWith('/responses')) return original;
  return sanitizeXAIGrokResponsesBody(original);
}
