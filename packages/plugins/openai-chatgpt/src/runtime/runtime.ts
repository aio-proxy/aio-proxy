import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import {
  createOpenAIStreamFetch,
  type OpenAIStreamFetch,
  type OpenAIStreamFetchCallOptions,
} from '@aio-proxy/plugin-sdk/openai-stream';
import { isPlainObject } from 'es-toolkit/predicate';

import { CHATGPT_USER_AGENT } from '../codex-client';
import { refreshAccessToken } from '../oauth-flow';
import type { ChatGPTCredential } from '../schema';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_CODEX_COMPACT_ENDPOINT = `${CHATGPT_CODEX_RESPONSES_ENDPOINT}/compact` as const;
const CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/generations` as const;
const CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/edits` as const;
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
    // Defensive: image dispatch resolves with `capability` absent, so this guard
    // exists to keep an embedding request off the responses/image passthrough
    // rather than to gate image routing.
    raw: ({ protocol, capability }) =>
      capability === 'embedding'
        ? undefined
        : protocol === 'openai-response' || protocol === 'openai-image'
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

// Only the create endpoint. Compaction is stateless and takes no `store`, so
// `/responses/compact` bodies are forwarded exactly as the proxy produced them.
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
  if (!isPlainObject(value)) {
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
      const refreshed = await refreshAccessToken(value.refreshToken, {
        fetch: fetcher,
        signal,
        ...(value.email === undefined ? {} : { email: value.email }),
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
        },
      };
    })
  ).snapshot.value;
}

function rewriteCodexUrl(input: string): string {
  const target = new URL(input);
  const codexEndpoint = codexEndpointFor(target.pathname);
  if (codexEndpoint === undefined) return target.toString();
  const endpoint = new URL(codexEndpoint);
  endpoint.search = target.search;
  return endpoint.toString();
}

// Every inbound path this runtime accepts must map to an explicit upstream
// endpoint: an unmapped path leaves the proxy's own inbound URL in place and the
// request loops back into the proxy. `/responses/compact` therefore needs its own
// entry rather than collapsing onto create, and the image paths need theirs.
function codexEndpointFor(pathname: string): string | undefined {
  if (pathname.endsWith('/responses/compact')) return CHATGPT_CODEX_COMPACT_ENDPOINT;
  if (pathname.endsWith('/responses') || pathname.endsWith('/chat/completions')) {
    return CHATGPT_CODEX_RESPONSES_ENDPOINT;
  }
  if (pathname.endsWith('/images/generations')) return CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT;
  if (pathname.endsWith('/images/edits')) return CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT;
  return undefined;
}
