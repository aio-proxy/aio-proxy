import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import {
  createOpenAIStreamFetch,
  type OpenAIStreamFetch,
  type OpenAIStreamFetchCallOptions,
} from '@aio-proxy/plugin-sdk/openai-stream';

import { refreshAccessToken } from '../oauth-flow';
import type { ChatGPTCredential } from '../schema';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_USER_AGENT = 'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)' as const;
const PLACEHOLDER_CREDENTIAL = 'dynamic-credential' as const;

export async function createOpenAIChatGPTRuntime(
  context: RuntimeContext<ChatGPTCredential, Record<string, never>>,
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(context.credentials, context.fetch);
  const openAI = createOpenAI({
    name: 'openai-chatgpt',
    baseURL: CHATGPT_CODEX_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });

  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => openAI.languageModel(modelId),
      embeddingModel: (modelId) => openAI.embeddingModel(modelId),
      imageModel: (modelId) => openAI.imageModel(modelId),
    },
    raw: ({ protocol, capability }) =>
      capability === 'embedding'
        ? undefined
        : protocol === 'openai-response'
          ? { invoke: (request, _context, options) => dynamicFetch(request, undefined, options) }
          : undefined,
  };
}

export function createOpenAIChatGPTDynamicFetch(
  credentials: CredentialPort<ChatGPTCredential>,
  fetcher: RuntimeFetch = globalThis.fetch,
): OpenAIStreamFetch {
  const fetchOpenAIResponses = createOpenAIStreamFetch('openai-response', fetcher, {
    acceptEncoding: 'identity',
    upstreamStream: true,
  });
  const dynamicFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: OpenAIStreamFetchCallOptions,
  ): Promise<Response> => {
    const credential = await currentCredential(credentials, fetcher);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('accept-encoding');
    headers.delete('host');
    headers.set('authorization', `Bearer ${credential.accessToken}`);
    headers.set('ChatGPT-Account-Id', credential.accountId);
    headers.set('Originator', 'codex-tui');
    headers.set('User-Agent', CHATGPT_USER_AGENT);
    headers.set('session-id', crypto.randomUUID());
    const body = shouldRewriteResponsesBody(request) ? await rewriteResponsesBody(request, headers) : request.body;

    return await fetchOpenAIResponses(
      rewriteCodexUrl(request.url),
      {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
        signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
        redirect: request.redirect,
      },
      options,
    );
  };
  return dynamicFetch as OpenAIStreamFetch;
}

function shouldRewriteResponsesBody(request: Request): boolean {
  return (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body !== null &&
    new URL(request.url).pathname.endsWith('/responses')
  );
}

async function rewriteResponsesBody(request: Request, headers: Headers): Promise<string> {
  const value: unknown = await request.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ChatGPT Codex Responses request body must be an object');
  }
  const body = value as Record<string, unknown>;
  headers.delete('content-encoding');
  headers.delete('content-length');
  return JSON.stringify({
    ...body,
    store: false,
    ...(typeof body['input'] === 'string'
      ? { input: [{ role: 'user', content: [{ type: 'input_text', text: body['input'] }] }] }
      : {}),
  });
}

export async function currentCredential(
  port: CredentialPort<ChatGPTCredential>,
  fetcher: RuntimeFetch = globalThis.fetch,
): Promise<ChatGPTCredential> {
  const current = await port.read();
  if (current.value.expiresAt > Date.now() && current.value.accessToken.length > 0) return current.value;

  return (
    await port.refresh(current.revision, async ({ value }, signal) => {
      const refreshed = await refreshAccessToken(value.refreshToken, { fetch: fetcher, signal });
      return { value: refreshed, metadata: { expiresAt: refreshed.expiresAt } };
    })
  ).snapshot.value;
}

function rewriteCodexUrl(input: string): string {
  const target = new URL(input);
  if (shouldRewriteCodexPath(target.pathname)) {
    const endpoint = new URL(CHATGPT_CODEX_RESPONSES_ENDPOINT);
    endpoint.search = target.search;
    return endpoint.toString();
  }
  return target.toString();
}

function shouldRewriteCodexPath(pathname: string): boolean {
  return pathname.endsWith('/responses') || pathname.endsWith('/chat/completions');
}
