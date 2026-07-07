import { createAiSdkProvider, resolveOpenAIResponsesModel } from "@aio-proxy/core";
import { Auth } from "@aio-proxy/oauth";
import type { OAuthProvider } from "@aio-proxy/types";
import { ProviderKind } from "@aio-proxy/types";
import { isPlainObject } from "es-toolkit/compat";
import type { OAuthProviderModel } from "../../oauth/src/oauth-provider";
import { refreshAccessToken } from "../../oauth/src/openai-chatgpt/oauth-flow";
import type { ChatGPTPayload } from "../../oauth/src/openai-chatgpt/schema";
import type { OAuthProviderInstance } from "./runtime";

type ChatGPTRuntimeProviderInstance = Omit<OAuthProviderInstance, "vendor"> & {
  readonly vendor: OAuthProvider["vendor"];
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ChatGPTRefresh = (refreshToken: string) => Promise<ChatGPTRefreshResult>;
type ChatGPTRefreshResult = Pick<ChatGPTPayload, "access" | "accountId" | "expires" | "refresh">;

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex" as const;
const CHATGPT_CODEX_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_BASE_URL}/responses` as const;
const CHATGPT_USER_AGENT = "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)" as const;

export type CodexFetchWrapperOptions = {
  readonly endpoint?: string;
  readonly fetch?: Fetcher;
  readonly getPayload?: () => unknown;
  readonly providerId: string;
  readonly refresh?: ChatGPTRefresh;
};

export function createOpenAIChatGPTRuntimeProvider(config: OAuthProvider): ChatGPTRuntimeProviderInstance {
  const providerId = config.id;
  const provider = createAiSdkProvider(
    {
      enabled: config.enabled,
      id: `${providerId}:chatgpt`,
      kind: ProviderKind.AiSdk,
      packageName: "@ai-sdk/openai",
      ...(config.models === undefined ? {} : { models: config.models }),
      options: {
        apiKey: "sk-oauth-placeholder",
        baseURL: CHATGPT_CODEX_BASE_URL,
        fetch: codexFetchWrapper({
          providerId,
          getPayload: () => Auth.get("openai-chatgpt", providerId)?.payload,
        }),
      },
    },
    { resolveModel: resolveOpenAIResponsesModel },
  );

  return {
    enabled: config.enabled,
    id: config.id,
    kind: ProviderKind.OAuth,
    ...(config.models === undefined ? {} : { models: config.models }),
    vendor: config.vendor,
    async ensureAvailable() {
      parseChatGPTPayload(Auth.get("openai-chatgpt", providerId)?.payload, providerId);
      await provider.ensureAvailable?.();
    },
    invoke(request: Parameters<typeof provider.invoke>[0]) {
      return provider.invoke(request);
    },
  };
}

export function codexFetchWrapper(options: CodexFetchWrapperOptions): Fetcher {
  const endpoint = options.endpoint ?? CHATGPT_CODEX_RESPONSES_ENDPOINT;
  const fetcher = options.fetch ?? globalThis.fetch;
  const loadPayload = options.getPayload ?? (() => Auth.get("openai-chatgpt", options.providerId)?.payload);
  const refresh = options.refresh ?? refreshAccessToken;
  let refreshPromise: Promise<ChatGPTPayload> | undefined;

  async function currentPayload(): Promise<ChatGPTPayload> {
    const payload = parseChatGPTPayload(loadPayload(), options.providerId);
    if (payload.expires >= Date.now() && payload.access.length > 0) {
      return payload;
    }
    refreshPromise ??= refreshPayload(payload).finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  }

  async function refreshPayload(payload: ChatGPTPayload): Promise<ChatGPTPayload> {
    const refreshed = await refresh(payload.refresh);
    const nextPayload: ChatGPTPayload = { ...payload, ...refreshed, models: payload.models };
    Auth.set("openai-chatgpt", options.providerId, nextPayload, options.providerId);
    return nextPayload;
  }

  return async (input, init) => {
    const payload = await currentPayload();
    const headers = requestHeaders(input, init);
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${payload.access}`);
    headers.set("ChatGPT-Account-Id", payload.accountId);
    headers.set("Originator", "codex-tui");
    headers.set("User-Agent", CHATGPT_USER_AGENT);
    headers.set("session-id", crypto.randomUUID());
    return fetcher(rewriteCodexInput(input, endpoint), { ...requestInitFromInput(input), ...init, headers });
  };
}

function parseChatGPTPayload(value: unknown, providerId: string): ChatGPTPayload {
  if (!isPlainObject(value)) {
    throw new ChatGPTLoginRequiredError(providerId);
  }
  const candidate = Object(value);
  const access = Reflect.get(candidate, "access");
  const refresh = Reflect.get(candidate, "refresh");
  const expires = Reflect.get(candidate, "expires");
  const accountId = Reflect.get(candidate, "accountId");
  const models = Reflect.get(candidate, "models");
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    typeof expires !== "number" ||
    typeof accountId !== "string" ||
    !isModelEntryArray(models)
  ) {
    throw new ChatGPTLoginRequiredError(providerId);
  }
  return { access, accountId, expires, models, refresh };
}

function isModelEntryArray(value: unknown): value is readonly OAuthProviderModel[] {
  return (
    Array.isArray(value) &&
    value.every((model) => {
      if (!isPlainObject(model)) {
        return false;
      }
      return typeof Reflect.get(Object(model), "id") === "string";
    })
  );
}

function requestHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

function requestInitFromInput(input: string | URL | Request): RequestInit {
  if (!(input instanceof Request)) {
    return {};
  }
  return { body: input.body, method: input.method, redirect: input.redirect, signal: input.signal };
}

function rewriteCodexInput(input: string | URL | Request, endpoint: string): string | URL | Request {
  const originalUrl = input instanceof Request ? input.url : input.toString();
  return shouldRewriteCodexPath(new URL(originalUrl).pathname) ? endpoint : input;
}

function shouldRewriteCodexPath(pathname: string): boolean {
  return (
    pathname === "/v1/responses" ||
    pathname.endsWith("/v1/responses") ||
    pathname === "/chat/completions" ||
    pathname.endsWith("/chat/completions")
  );
}

class ChatGPTLoginRequiredError extends Error {
  override readonly name = "ChatGPTLoginRequiredError";

  constructor(readonly providerId: string) {
    super(`${providerId}: ChatGPT login required`);
  }
}
