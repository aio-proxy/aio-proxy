import type { JSONObject } from "@ai-sdk/provider";
import type { ModelMessage } from "../ai-sdk-bridge";
import type { OpenAIResponsesRequest } from "../ingress/openai-responses";

export type OpenAIResponsesTransformTool = {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly strict?: boolean;
  readonly metadata: JSONObject;
};

export type OpenAIResponsesWireMetadata = {
  readonly protocol: "openai-responses";
  readonly inputIndex?: number;
  readonly itemType?: string;
  readonly itemId?: string;
  readonly status?: string;
  readonly phase?: string;
  readonly wireRole?: "system" | "developer" | "user" | "assistant";
  readonly author?: string;
  readonly recipient?: string;
  readonly wireToolType?: "function" | "custom";
  readonly wireToolName?: string;
  readonly namespace?: string;
  readonly namespaceDescription?: string;
  readonly source?: "request" | "additional_tools";
  readonly outputKind?: "string" | "content";
  readonly format?: import("../ai-sdk-bridge").JSONValue;
};

export type OpenAIResponsesProviderOptions = {
  readonly openai: {
    readonly reasoningEffort?: OpenAIResponsesReasoningEffort;
    readonly reasoningSummary?: OpenAIResponsesReasoningSummary;
  };
};

export type OpenAIResponsesReasoningEffort = NonNullable<NonNullable<OpenAIResponsesRequest["reasoning"]>["effort"]>;

export type OpenAIResponsesReasoningSummary = NonNullable<NonNullable<OpenAIResponsesRequest["reasoning"]>["summary"]>;

export type OpenAIResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { readonly type: "tool"; readonly toolName: string };

export type OpenAIResponsesTransformSettings = {
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: OpenAIResponsesToolChoice;
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
