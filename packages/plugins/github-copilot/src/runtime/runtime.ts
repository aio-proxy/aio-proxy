import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { OAuthRuntimeResult, ProtocolId, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { createOpenAIStreamFetch } from '@aio-proxy/plugin-sdk/openai-stream';

import {
  copilotHeaders,
  currentGitHubCopilotCredential,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
} from '../github-api';

const PLACEHOLDER_BASE_URL = 'https://api.githubcopilot.com';
const PLACEHOLDER_CREDENTIAL = 'dynamic-credential';

export async function createGitHubCopilotRuntime(
  context: RuntimeContext<GitHubCopilotCredential, GitHubAccountOptions>,
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createDynamicFetch(context.credentials, context.fetch);
  const compatibleFetch = createOpenAIStreamFetch('openai-compatible', dynamicFetch, {
    rewriteToolImages: true,
  });
  const openAICompatible = createOpenAICompatible({
    name: 'github-copilot.openai-compatible',
    baseURL: PLACEHOLDER_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: compatibleFetch,
  });
  const anthropic = createAnthropic({
    name: 'github-copilot.anthropic',
    baseURL: `${PLACEHOLDER_BASE_URL}/v1`,
    authToken: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });
  const openAI = createOpenAI({
    name: 'github-copilot.openai',
    baseURL: PLACEHOLDER_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });
  const protocolByModelId = new Map(
    context.catalog.language.flatMap((model) => {
      const protocol = catalogProtocol(model.metadata);
      return protocol === undefined ? [] : [[model.id, protocol] as const];
    }),
  );

  const provider = {
    specificationVersion: 'v4' as const,
    languageModel(modelId: string) {
      const protocol = protocolByModelId.get(modelId);
      switch (protocol) {
        case 'openai-compatible':
          return openAICompatible.languageModel(modelId);
        case 'anthropic':
          return anthropic.languageModel(modelId);
        case 'openai-response':
          return openAI.languageModel(modelId);
        default:
          throw new Error(`GitHub Copilot model ${modelId} has no supported protocol metadata`);
      }
    },
    embeddingModel(modelId: string) {
      return openAICompatible.embeddingModel(modelId);
    },
    imageModel(modelId: string) {
      return openAICompatible.imageModel(modelId);
    },
  } satisfies OAuthRuntimeResult['provider'];

  return {
    provider,
    raw(input) {
      // Language-only catalog: decline embeddings so the candidate can convert.
      if (input.capability === 'embedding') return undefined;
      if (protocolByModelId.get(input.modelId) !== input.protocol) return undefined;
      return {
        invoke: async (request) => {
          if (!advertisedRawPath(input.protocol, new URL(request.url).pathname)) {
            return unsupportedRawPath(input.protocol);
          }
          const credential = await currentGitHubCopilotCredential(context.credentials, context.fetch);
          return await fetchWithCredential(request, undefined, credential, context.fetch);
        },
      };
    },
  };
}

function createDynamicFetch(
  credentials: RuntimeContext<GitHubCopilotCredential, GitHubAccountOptions>['credentials'],
  fetcher: RuntimeFetch,
): typeof fetch {
  return async (input, init) => {
    const credential = await currentGitHubCopilotCredential(credentials, fetcher);
    return await fetchWithCredential(input, init, credential, fetcher);
  };
}

async function fetchWithCredential(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  credential: GitHubCopilotCredential,
  fetcher: RuntimeFetch,
): Promise<Response> {
  const request = new Request(input, init);
  const target = new URL(request.url);
  const baseURL = new URL(credential.baseURL);
  target.protocol = baseURL.protocol;
  target.host = baseURL.host;
  const headers = new Headers(request.headers);
  headers.delete('x-api-key');
  for (const [key, value] of Object.entries(copilotHeaders(credential.copilotToken))) headers.set(key, value);

  return await fetcher(target, {
    method: request.method,
    headers,
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
    signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
    redirect: request.redirect,
  });
}

function catalogProtocol(metadata: unknown): ProtocolId | undefined {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return undefined;
  const protocol = Reflect.get(metadata, 'protocol');
  return protocol === 'openai-compatible' || protocol === 'anthropic' || protocol === 'openai-response'
    ? protocol
    : undefined;
}

// Catalog protocol is derived from advertised endpoints (`/chat/completions`,
// `/responses`, `/v1/messages`). Raw must not invent sibling paths such as
// legacy Completions or Responses compact; those 404s are not fallback-eligible.
function advertisedRawPath(protocol: ProtocolId, pathname: string): boolean {
  switch (protocol) {
    case 'openai-compatible':
      return pathname.endsWith('/chat/completions');
    case 'openai-response':
      return pathname.endsWith('/responses');
    case 'anthropic':
      return pathname.endsWith('/messages');
    default:
      return false;
  }
}

function unsupportedRawPath(protocol: ProtocolId): Response {
  const message = 'GitHub Copilot does not serve this endpoint';
  return protocol === 'anthropic'
    ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 501 })
    : Response.json(
        { error: { code: 'unsupported_endpoint', message, type: 'invalid_request_error' } },
        { status: 501 },
      );
}
