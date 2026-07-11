import type { ModelMessage } from "../ai-sdk-bridge";
import type { OpenAIResponsesRequest } from "../ingress/openai-responses";

export type OpenAIResponsesTransformTool = {
  readonly type: "function" | "custom";
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly format?: unknown;
};

export type OpenAIResponsesProviderOptions = {
  readonly openai: {
    readonly reasoningEffort?: OpenAIResponsesReasoningEffort;
    readonly reasoningSummary?: OpenAIResponsesReasoningSummary;
  };
};

export type OpenAIResponsesReasoningEffort = NonNullable<NonNullable<OpenAIResponsesRequest["reasoning"]>["effort"]>;

export type OpenAIResponsesReasoningSummary = NonNullable<NonNullable<OpenAIResponsesRequest["reasoning"]>["summary"]>;

export type OpenAIResponsesTransformSettings = {
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: OpenAIResponsesRequest["tool_choice"];
  readonly reasoning?: OpenAIResponsesReasoningEffort;
  readonly reasoningSummary?: OpenAIResponsesReasoningSummary;
  readonly providerOptions?: OpenAIResponsesProviderOptions;
};

export type OpenAIResponsesModelMessages = {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly OpenAIResponsesTransformTool[];
  readonly settings: OpenAIResponsesTransformSettings;
};

export type OpenAIResponsesFromModelMessages = OpenAIResponsesModelMessages & {
  readonly model: string;
};
