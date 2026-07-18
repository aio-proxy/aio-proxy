import { z } from "zod";
import type { OpenAIResponsesUnsupportedFeatureError } from "../../error";
import { openAIResponsesInputItemSchema, unsupportedInputItemFeature } from "./input-items";
import { openAIResponsesToolSchema, supportedTools, unsupportedToolFeature } from "./tools";

const idSchema = z.string().min(1);
const looseObjectSchema = z.object({}).catchall(z.unknown());
const sessionMetadataSchema = z
  .object({
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
  })
  .catchall(z.unknown());
const conversationSchema = z.union([
  idSchema,
  z
    .object({
      id: idSchema,
    })
    .catchall(z.unknown()),
]);

export const OpenAIResponsesRequestSchema = z.object({
  model: idSchema,
  input: z.union([z.string(), z.array(openAIResponsesInputItemSchema).min(1)]),
  conversation: conversationSchema.optional(),
  prompt_cache_key: z.string().optional(),
  previous_response_id: z.string().optional(),
  metadata: sessionMetadataSchema.optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  tools: z.array(openAIResponsesToolSchema).optional(),
  reasoning: z
    .object({
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    })
    .optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  parallel_tool_calls: z.boolean().optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), looseObjectSchema]).optional(),
  store: z.boolean().optional(),
  background: z.boolean().optional(),
});

type RawOpenAIResponsesRequest = z.output<typeof OpenAIResponsesRequestSchema>;
export type OpenAIResponsesRequest = Omit<RawOpenAIResponsesRequest, "tools"> & {
  readonly tools?: readonly import("./tools").OpenAIResponsesTool[] | undefined;
};

export type OpenAIResponsesParseResult =
  | { readonly ok: true; readonly value: OpenAIResponsesRequest }
  | {
      readonly ok: false;
      readonly error: z.ZodError | OpenAIResponsesUnsupportedFeatureError;
    };

export function safeParseOpenAIResponses(input: unknown): OpenAIResponsesParseResult {
  const unsupported = unsupportedFeature(input);
  if (unsupported !== undefined) return { ok: false, error: unsupported };

  const parsed = OpenAIResponsesRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error };

  return { ok: true, value: supportedRequest(parsed.data) };
}

export function parseOpenAIResponses(input: unknown): OpenAIResponsesRequest {
  const result = safeParseOpenAIResponses(input);
  if (!result.ok) throw result.error;
  return result.value;
}

function unsupportedFeature(input: unknown): OpenAIResponsesUnsupportedFeatureError | undefined {
  return unsupportedInputItemFeature(input) ?? unsupportedToolFeature(input);
}

function supportedRequest(request: RawOpenAIResponsesRequest): OpenAIResponsesRequest {
  const { tools, ...rest } = request;
  const supported = supportedTools(tools);
  return {
    ...rest,
    ...(supported === undefined ? {} : { tools: supported }),
  };
}

export type { OpenAIResponsesInputItem, OpenAIResponsesInputMessage, OpenAIResponsesTextPart } from "./input-items";
export type {
  OpenAIResponsesCustomTool,
  OpenAIResponsesFunctionTool,
  OpenAIResponsesTool,
} from "./tools";
