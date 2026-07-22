import { createOpenAIStreamFetch } from "@aio-proxy/plugin-sdk/openai-stream";
import { ProviderProtocol } from "@aio-proxy/types";

import type { ProviderFetch } from "./proxy-fetch";

export function wrapOpenAIProtocolFetch(protocol: ProviderProtocol, fetcher: ProviderFetch): ProviderFetch {
  switch (protocol) {
    case ProviderProtocol.OpenAIResponse:
      return createOpenAIStreamFetch("openai-response", fetcher);
    case ProviderProtocol.OpenAICompatible:
      return createOpenAIStreamFetch("openai-compatible", fetcher);
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
      return fetcher;
  }
}

export function wrapOpenAIPackageFetch(packageName: string, fetcher?: ProviderFetch): ProviderFetch | undefined {
  if (packageName === "@ai-sdk/openai") {
    return createOpenAIStreamFetch("openai-response", fetcher ?? globalThis.fetch);
  }
  if (packageName === "@ai-sdk/openai-compatible") {
    return createOpenAIStreamFetch("openai-compatible", fetcher ?? globalThis.fetch);
  }
  return fetcher;
}
