import { createOpenAIStreamFetch, type OpenAIStreamFetch } from '@aio-proxy/plugin-sdk/openai-stream';
import { ProviderProtocol } from '@aio-proxy/types';

import type { ProviderFetch } from './proxy-fetch';

export function wrapOpenAIProtocolFetch(protocol: ProviderProtocol, fetcher: ProviderFetch): OpenAIStreamFetch {
  switch (protocol) {
    case ProviderProtocol.OpenAIResponse:
      return createOpenAIStreamFetch('openai-response', fetcher, { upstreamStream: true });
    case ProviderProtocol.OpenAICompatible:
      return createOpenAIStreamFetch('openai-compatible', fetcher, { upstreamStream: true });
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
      return fetcher as OpenAIStreamFetch;
  }
}

export function wrapOpenAIPackageFetch(packageName: string, fetcher?: ProviderFetch): ProviderFetch | undefined {
  if (packageName === '@ai-sdk/openai') {
    return createOpenAIStreamFetch('openai-response', fetcher ?? globalThis.fetch, { upstreamStream: true });
  }
  if (packageName === '@ai-sdk/openai-compatible') {
    return createOpenAIStreamFetch('openai-compatible', fetcher ?? globalThis.fetch, {
      rewriteToolImages: true,
      upstreamStream: true,
    });
  }
  return fetcher;
}
