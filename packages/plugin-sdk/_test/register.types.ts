import type { PluginApi } from "../src";

import {
  CredentialRefreshError,
  type DefaultAliasSuggestions,
  type LogicalRequestContext,
  type OAuthAdapter,
  type OAuthRuntimeResult,
  type ProviderExecutedTool,
  type ProviderToolCapability,
  type TokenCountCapability,
} from "../src";

type MyOptions = {
  readonly baseURL: string;
};

type MyCredential = {
  readonly accessToken: string;
};

declare const api: PluginApi;
declare const adapter: OAuthAdapter<MyOptions, MyCredential>;
declare const context: LogicalRequestContext;
declare const tokenCount: TokenCountCapability;
const providerTool: ProviderExecutedTool = {
  type: "web-search",
  name: "web_search",
  maxUses: 8,
  allowedDomains: ["example.com"],
};
const providerTools: ProviderToolCapability = { supported: ["web-search"] };

const aliases: DefaultAliasSuggestions = {
  "gemini-3.5-flash": {
    model: "gemini-3.5-flash-extra-low",
    preserve: false,
    variants: { high: { model: "gemini-3-flash-agent", preserve: false } },
  },
};

adapter.catalog.defaultAliases?.({
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});
adapter.catalog.initialFallback?.(new TypeError("network unavailable"));
const retryableRefresh: CredentialRefreshError = new CredentialRefreshError("temporary refresh failure", {
  retryable: true,
  reason: "network",
});
tokenCount.countTokens({
  context,
  invocation: { messages: [{ role: "user", content: "count me" }], providerTools: [providerTool] },
  modelId: "gemini-3.5-flash-extra-low",
  protocol: "gemini",
  request: new Request("https://proxy.test/v1beta/models/x:countTokens"),
});

const runtime: OAuthRuntimeResult = {
  provider: null as never,
  providerTools,
  tokenCount,
  raw: () => ({ invoke: async (_request, logical) => Response.json(logical ?? null) }),
};

api.oauth.register(adapter);
void aliases;
void retryableRefresh;
void providerTool;
void providerTools;
void runtime;
