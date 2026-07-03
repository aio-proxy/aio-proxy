import type { ModelMessage } from "../ai-sdk-bridge";
import type { GeminiGenerateContentRequest } from "../ingress/gemini-generate-content";

export type GeminiGenerateContentTool = Readonly<{
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}>;

export type GeminiGenerateContentSettings = Readonly<{
  readonly generationConfig?:
    | GeminiGenerateContentRequest["generationConfig"]
    | undefined;
  readonly safetySettings?:
    | GeminiGenerateContentRequest["safetySettings"]
    | undefined;
  readonly providerOptions?:
    | {
        readonly google: {
          readonly safetySettings?: GeminiGenerateContentRequest["safetySettings"];
        };
      }
    | undefined;
}>;

export type GeminiGenerateContentModelMessages = Readonly<{
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly GeminiGenerateContentTool[] | undefined;
  readonly settings: GeminiGenerateContentSettings;
}>;

export type GeminiGenerateContentFromModelMessages =
  GeminiGenerateContentModelMessages & { readonly model: string };
