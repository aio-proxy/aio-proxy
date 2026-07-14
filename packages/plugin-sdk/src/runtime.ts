import type { ProviderV4 } from "@ai-sdk/provider";
import type { JsonValue } from "./json";

export type ProtocolId = "openai-compatible" | "openai-response" | "anthropic" | "gemini";

export type RawTransport = {
  readonly invoke: (request: Request) => Promise<Response>;
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
};
