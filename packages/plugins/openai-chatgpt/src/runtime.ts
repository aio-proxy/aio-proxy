import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from "@aio-proxy/plugin-sdk";

import { createOpenAI } from "@ai-sdk/openai";

import type { ChatGPTCredential } from "./schema";

import { refreshAccessToken } from "./oauth-flow";

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex" as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_USER_AGENT = "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)" as const;
const PLACEHOLDER_CREDENTIAL = "dynamic-credential" as const;

export async function createOpenAIChatGPTRuntime(
  context: RuntimeContext<ChatGPTCredential, Record<string, never>>,
): Promise<OAuthRuntimeResult> {
  const openAI = createOpenAI({
    name: "openai-chatgpt",
    baseURL: CHATGPT_CODEX_BASE_URL,
    apiKey: PLACEHOLDER_CREDENTIAL,
    fetch: createOpenAIChatGPTDynamicFetch(context.credentials),
  });

  return {
    provider: {
      specificationVersion: "v4",
      languageModel: (modelId) => openAI.languageModel(modelId),
      embeddingModel: (modelId) => openAI.embeddingModel(modelId),
      imageModel: (modelId) => openAI.imageModel(modelId),
    },
  };
}

export function createOpenAIChatGPTDynamicFetch(
  credentials: CredentialPort<ChatGPTCredential>,
  fetcher: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const credential = await currentCredential(credentials);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("ChatGPT-Account-Id", credential.accountId);
    headers.set("Originator", "codex-tui");
    headers.set("User-Agent", CHATGPT_USER_AGENT);
    headers.set("session-id", crypto.randomUUID());

    return await fetcher(rewriteCodexUrl(request.url), {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
      signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
      redirect: request.redirect,
    });
  };
}

export async function currentCredential(port: CredentialPort<ChatGPTCredential>): Promise<ChatGPTCredential> {
  const current = await port.read();
  if (current.value.expiresAt > Date.now() && current.value.accessToken.length > 0) return current.value;

  return (
    await port.refresh(current.revision, async ({ value }, signal) => {
      const refreshed = await refreshAccessToken(value.refreshToken, { signal });
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
  return pathname.endsWith("/responses") || pathname.endsWith("/chat/completions");
}
