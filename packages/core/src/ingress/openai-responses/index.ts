import { compact } from "es-toolkit/array";
import { z } from "zod";

import {
  knownOpenAIResponsesInputItemTypes,
  type OpenAIResponsesInputItem,
  openAIResponsesInputItemSchema,
} from "./input-items";
import { openAIResponsesToolSchema } from "./tools";

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
const namedToolChoiceSchema = z.union([
  z.object({ type: z.literal("function"), name: idSchema }),
  z.object({ type: z.literal("custom"), name: idSchema }),
]);

const inputItemSchema = z.unknown().transform((item, context): OpenAIResponsesInputItem | undefined => {
  const parsed = openAIResponsesInputItemSchema.safeParse(item);
  if (parsed.success) return parsed.data;

  const wireType = safeWireType(item);
  if (wireType !== undefined && !knownOpenAIResponsesInputItemTypes.has(wireType)) {
    return { type: "__aio_proxy_unsupported__", wireType };
  }

  if (wireType !== undefined || hasMessageDiscriminator(item)) {
    context.addIssue({ code: "custom", message: "Invalid OpenAI Responses input item" });
    return z.NEVER;
  }

  console.warn("[aio-proxy] OpenAI Responses input item degraded", "unknown", "input", "dropped");
  return undefined;
});

export const OpenAIResponsesRequestSchema = z
  .object({
    model: idSchema,
    input: z.union([
      z.string(),
      z
        .array(inputItemSchema)
        .min(1)
        .transform((items) => compact(items))
        .refine((items) => items.length > 0, "OpenAI Responses input must contain a semantic item"),
    ]),
    tools: z.array(openAIResponsesToolSchema).optional(),
    reasoning: z
      .object({
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
        effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
        context: z.unknown().optional(),
      })
      .optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    parallel_tool_calls: z.boolean().optional(),
    tool_choice: z.union([z.enum(["none", "auto", "required"]), namedToolChoiceSchema, looseObjectSchema]).optional(),
    store: z.boolean().optional(),
    background: z.boolean().optional(),
    conversation: conversationSchema.optional(),
    previous_response_id: z.string().optional(),
    metadata: sessionMetadataSchema.optional(),
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
    include: z.array(z.string()).optional(),
    client_metadata: looseObjectSchema.optional(),
    prompt_cache_key: z.string().optional(),
    service_tier: z.string().optional(),
    text: z
      .object({
        verbosity: z.enum(["low", "medium", "high"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenAIResponsesRequest = z.output<typeof OpenAIResponsesRequestSchema>;

export type OpenAIResponsesParseResult =
  | { readonly ok: true; readonly value: OpenAIResponsesRequest }
  | { readonly ok: false; readonly error: z.ZodError };

export function safeParseOpenAIResponses(input: unknown): OpenAIResponsesParseResult {
  const parsed = OpenAIResponsesRequestSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}

export function parseOpenAIResponses(input: unknown): OpenAIResponsesRequest {
  const result = safeParseOpenAIResponses(input);
  if (!result.ok) throw result.error;
  return result.value;
}

function safeWireType(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
    ? value.type
    : undefined;
}

function hasMessageDiscriminator(value: unknown): boolean {
  return typeof value === "object" && value !== null && "role" in value;
}

export type {
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesTextPart,
  OpenAIResponsesToolOutputPart,
  OpenAIResponsesUnsupportedInputItem,
} from "./input-items";
export type {
  OpenAIResponsesCustomTool,
  OpenAIResponsesExecutableTool,
  OpenAIResponsesFunctionTool,
  OpenAIResponsesNamespaceTool,
  OpenAIResponsesTool,
  OpenAIResponsesUnsupportedTool,
} from "./tools";
