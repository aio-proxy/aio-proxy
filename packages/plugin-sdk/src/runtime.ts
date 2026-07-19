import type { ProviderV4 } from "@ai-sdk/provider";
import type { CallSettings, ModelMessage, ToolSet } from "ai";

import type { JsonValue } from "./json";

export type ProtocolId = "openai-compatible" | "openai-response" | "anthropic" | "gemini";

export type ProviderExecutedTool = {
  readonly type: "web-search";
  readonly name: string;
  readonly maxUses?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
};

export type ProviderToolCapability = {
  readonly supported: readonly ProviderExecutedTool["type"][];
};

export type LogicalSessionSource =
  | "internal"
  | "openai-conversation"
  | "openai-prompt-cache"
  | "claude-code"
  | "body-session"
  | "body-conversation"
  | "header-session"
  | "header-conversation"
  | "previous-response"
  | "transcript"
  | "generated";

export type LogicalRequestContext = {
  readonly requestId: string;
  readonly session: {
    readonly key: `sha256:${string}`;
    readonly source: LogicalSessionSource;
  };
};

export type TokenCountInput = {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly request: Request;
  readonly context: LogicalRequestContext;
  readonly invocation: {
    readonly messages: readonly ModelMessage[];
    readonly settings?: CallSettings;
    readonly tools?: ToolSet;
    readonly providerTools?: readonly ProviderExecutedTool[];
  };
};

export type TokenCountResult = { readonly inputTokens: number };

export type TokenCountCapability = {
  readonly countTokens: (input: TokenCountInput) => Promise<TokenCountResult>;
};

export type RawTransport = {
  readonly invoke: (request: Request, context?: LogicalRequestContext) => Promise<Response>;
};

export type RawResolver = (input: {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly metadata?: JsonValue;
}) => RawTransport | undefined;

export type ModelDescriptor = {
  readonly id: string;
  readonly displayName?: string;
  readonly metadata?: JsonValue;
};

export type ModelCatalog = {
  readonly language: readonly ModelDescriptor[];
  readonly image: readonly ModelDescriptor[];
  readonly embedding: readonly ModelDescriptor[];
  readonly speech: readonly ModelDescriptor[];
  readonly transcription: readonly ModelDescriptor[];
  readonly reranking: readonly ModelDescriptor[];
};

export type OAuthRuntimeResult = {
  readonly provider: ProviderV4;
  readonly raw?: RawResolver;
  readonly tokenCount?: TokenCountCapability;
  readonly providerTools?: ProviderToolCapability;
};
