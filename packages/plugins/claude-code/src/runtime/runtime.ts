import { createAnthropic } from '@ai-sdk/anthropic';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_API_BASE_URL,
  CLAUDE_OAUTH_BETA,
  CLAUDE_REFRESH_USER_AGENT,
  currentClaudeCredential,
} from '../oauth';
import type { ClaudeCredential } from '../schema';

const PLACEHOLDER = 'dynamic-credential';

type ClaudeRuntimeOptions = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};

export async function createClaudeRuntime(
  context: RuntimeContext<ClaudeCredential, Record<string, never>>,
  options: ClaudeRuntimeOptions = {},
): Promise<OAuthRuntimeResult> {
  const fetch = options.fetch ?? context.fetch ?? globalThis.fetch;
  const anthropic = createAnthropic({
    name: 'claude-code-oauth',
    baseURL: CLAUDE_API_BASE_URL,
    authToken: PLACEHOLDER,
    fetch: createClaudeDynamicFetch(context.credentials, { ...options, fetch }),
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => anthropic.languageModel(modelId),
      embeddingModel: () => unsupported('embedding'),
      imageModel: () => unsupported('image generation'),
    },
  };
}

export function createClaudeDynamicFetch(
  credentials: CredentialPort<ClaudeCredential>,
  options: ClaudeRuntimeOptions = {},
) {
  const fetch = options.fetch ?? globalThis.fetch;
  const fetchWithCredential = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const credential = await currentClaudeCredential(credentials, {
      ...options,
      fetch,
      signal: request.signal,
    });
    const headers = claudeInferenceHeaders(request.headers, credential.accessToken);
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

function claudeInferenceHeaders(source: Headers, accessToken: string): Headers {
  const headers = new Headers(source);
  for (const key of ['authorization', 'proxy-authorization', 'x-api-key', 'anthropic-api-key']) {
    headers.delete(key);
  }
  headers.set('authorization', `Bearer ${accessToken}`);
  ensureOAuthBeta(headers);
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', CLAUDE_ANTHROPIC_VERSION);
  if (!headers.has('user-agent')) headers.set('user-agent', CLAUDE_REFRESH_USER_AGENT);
  return headers;
}

function ensureOAuthBeta(headers: Headers): void {
  const existing = headers.get('anthropic-beta');
  if (existing === null || existing.trim() === '') {
    headers.set('anthropic-beta', CLAUDE_OAUTH_BETA);
    return;
  }
  const parts = existing.split(',').map((value) => value.trim());
  if (parts.includes(CLAUDE_OAUTH_BETA)) return;
  headers.set('anthropic-beta', `${CLAUDE_OAUTH_BETA},${existing}`);
}

function unsupported(surface: string): never {
  throw new Error(`Claude OAuth does not support ${surface}`);
}
