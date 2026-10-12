import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type {
  CredentialPort,
  LogicalRequestContext,
  OAuthRuntimeResult,
  RuntimeContext,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import {
  createOpenAIStreamFetch,
  type OpenAIStreamFetch,
  type OpenAIStreamFetchCallOptions,
} from '@aio-proxy/plugin-sdk/openai-stream';
import { isRecord } from '@aio-proxy/shared';
import { isPlainObject } from 'es-toolkit/predicate';

import { refreshAccessToken } from '../oauth-flow';
import { type ChatGPTPluginOptions, resolveChatGPTRequestIdentity } from '../plugin-options';
import type { ChatGPTCredential } from '../schema';
import { stripOrphanReasoningIds } from './orphan-reasoning-id/index';
import { createOpenAIChatGPTRealtime, mergeEndpointQuery } from './realtime';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_CODEX_COMPACT_ENDPOINT = `${CHATGPT_CODEX_RESPONSES_ENDPOINT}/compact` as const;
const CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/generations` as const;
const CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/images/edits` as const;
const PLACEHOLDER_CREDENTIAL = 'dynamic-credential' as const;

type JsonRequestReader = (request: Request) => Promise<unknown>;
type ChatGPTDynamicFetch = OpenAIStreamFetch &
  ((
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: OpenAIStreamFetchCallOptions,
    logicalRequest?: LogicalRequestContext,
  ) => Promise<Response>);
type ChatGPTRuntimeContext = RuntimeContext<ChatGPTCredential, Record<string, unknown>> & {
  // The built-in host owns decoding and request-scoped admission; avoid a core dependency here.
  readonly __aioReadJsonRequest?: JsonRequestReader;
};

export async function createOpenAIChatGPTRuntime(
  context: ChatGPTRuntimeContext,
  pluginOptions?: Partial<ChatGPTPluginOptions>,
): Promise<OAuthRuntimeResult> {
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(
    context.credentials,
    context.fetch,
    pluginOptions,
    context.__aioReadJsonRequest,
  );
  const openAI = createOpenAI({
    name: 'openai-chatgpt',
    baseURL: CHATGPT_CODEX_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: dynamicFetch,
  });

  return {
    genAiProviderName: 'openai',
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => withModelSession(openAI.languageModel(modelId)),
      embeddingModel: (modelId) => openAI.embeddingModel(modelId),
      imageModel: (modelId) => openAI.imageModel(modelId),
    },
    realtime: createOpenAIChatGPTRealtime(context.credentials, {
      fetch: context.fetch,
      proxy: context.proxy ?? null,
      pluginOptions,
    }),
    // Defensive: image dispatch resolves with `capability` absent, so this guard
    // exists to keep an embedding or audio request off the responses/image
    // passthrough rather than to gate image routing. The ChatGPT backend has no
    // /v1/audio surface, so speech and transcription can only be declined.
    raw: ({ protocol, capability }) =>
      capability !== undefined && capability !== 'language'
        ? undefined
        : protocol === 'openai-response' || protocol === 'openai-image'
          ? {
              invoke: (request, logicalRequest, options) => dynamicFetch(request, undefined, options, logicalRequest),
            }
          : undefined,
  };
}

export function createOpenAIChatGPTDynamicFetch(
  credentials: CredentialPort<ChatGPTCredential>,
  fetcher: RuntimeFetch = globalThis.fetch,
  pluginOptions?: Partial<ChatGPTPluginOptions>,
  readJsonRequest: JsonRequestReader = (request) => request.json(),
): ChatGPTDynamicFetch {
  const fetchOpenAIResponses = createOpenAIStreamFetch('openai-response', fetcher, {
    acceptEncoding: 'identity',
    upstreamStream: true,
  });
  const dynamicFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: OpenAIStreamFetchCallOptions,
    logicalRequest?: LogicalRequestContext,
  ): Promise<Response> => {
    const credential = await currentCredential(credentials, fetcher);
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('accept-encoding');
    headers.delete('host');
    headers.set('authorization', `Bearer ${credential.accessToken}`);
    headers.set('ChatGPT-Account-Id', credential.accountId);
    headers.set('Originator', 'codex-tui');
    headers.set(
      'User-Agent',
      (await resolveChatGPTRequestIdentity(pluginOptions, headers.get('user-agent'), fetcher)).userAgent,
    );
    const clientSession = headers.get('session_id') || headers.get('session-id') || headers.get('x-session-id');
    if (clientSession) headers.set('session-id', clientSession);
    else if (logicalRequest !== undefined && logicalRequest.session.source !== 'generated') {
      headers.set('session-id', logicalRequest.session.key);
    }
    const body = shouldRewriteResponsesBody(request)
      ? await rewriteResponsesBody(request, headers, readJsonRequest)
      : request.body;
    if (!headers.get('session-id')) headers.set('session-id', crypto.randomUUID());
    const url = rewriteCodexUrl(request.url);
    const upstreamInit = {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
      signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
      redirect: request.redirect,
    } satisfies RequestInit;

    // The image endpoints are not the Responses protocol: an Images stream
    // terminates on `image_generation.*`, which the Responses SSE normalizer
    // reads as an early EOF. Forward those bytes untouched.
    if (isCodexImageEndpoint(url)) {
      headers.set('accept-encoding', 'identity');
      return await fetcher(url, upstreamInit);
    }

    return await fetchOpenAIResponses(url, upstreamInit, options);
  };
  return dynamicFetch as ChatGPTDynamicFetch;
}

// The model transport receives the host's session via private invocation options,
// including for clients whose protocol requires conversion. Keep it call-scoped:
// a provider/model instance may serve several sessions concurrently.
function withModelSession(model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doGenerate: (options) => model.doGenerate(withModelSessionOptions(options)),
    doStream: (options) => model.doStream(withModelSessionOptions(options)),
  };
}

function withModelSessionOptions(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const context = options.providerOptions?.['aioProxy']?.['logicalRequest'];
  if (!isRecord(context) || !isRecord(context['session'])) return options;
  const session = context['session'];
  if (typeof session['source'] !== 'string' || session['source'] === 'generated') return options;
  const key = session['key'];
  if (typeof key !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(key)) return options;
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (headers.get('session_id') || headers.get('session-id') || headers.get('x-session-id')) return options;
  headers.set('session-id', key);
  return { ...options, headers: Object.fromEntries(headers) };
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

async function rewriteResponsesBody(
  request: Request,
  headers: Headers,
  readJsonRequest: JsonRequestReader,
): Promise<string> {
  const value = await readJsonRequest(request);
  if (!isPlainObject(value)) {
    throw new TypeError('ChatGPT Codex Responses request body must be an object');
  }
  const body = value as Record<string, unknown>;
  const cacheKey = body['prompt_cache_key'];
  if (!headers.get('session-id') && typeof cacheKey === 'string' && cacheKey.trim() !== '') {
    // JSON keys may contain Unicode/control characters; use a bounded header-safe identity.
    headers.set('session-id', new Bun.CryptoHasher('sha256').update(cacheKey).digest('hex'));
  }
  // Codex rejects this Responses parameter, including the one-token limit used by model probes.
  delete body['max_output_tokens'];
  headers.delete('content-encoding');
  headers.delete('content-length');
  const sanitizedInput = stripOrphanReasoningIds(body['input']);
  return JSON.stringify({
    ...body,
    store: false,
    ...(typeof body['input'] === 'string'
      ? { input: [{ role: 'user', content: [{ type: 'input_text', text: body['input'] }] }] }
      : sanitizedInput === undefined
        ? {}
        : { input: sanitizedInput }),
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
        ...(value.idToken === undefined ? {} : { idToken: value.idToken }),
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
  return mergeEndpointQuery(codexEndpoint, target).toString();
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

function isCodexImageEndpoint(url: string): boolean {
  return url.startsWith(CHATGPT_CODEX_IMAGE_GENERATIONS_ENDPOINT) || url.startsWith(CHATGPT_CODEX_IMAGE_EDITS_ENDPOINT);
}
