import { z } from "zod";

const IdSchema = z.string().min(1);
const LooseObjectSchema = z.object({}).catchall(z.unknown());

const ContentPartSchema = z
  .object({
    type: IdSchema,
  })
  .catchall(z.unknown());

const MessageContentSchema = z.union([z.string(), z.null(), z.array(ContentPartSchema)]);

const ToolCallSchema = z.object({
  id: IdSchema,
  type: z.literal("function"),
  function: z.object({
    name: IdSchema,
    arguments: z.string(),
  }),
});

const MessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("developer"),
    content: MessageContentSchema,
  }),
  z.object({
    role: z.literal("system"),
    content: MessageContentSchema,
  }),
  z.object({
    role: z.literal("user"),
    content: MessageContentSchema,
  }),
  z.object({
    role: z.literal("assistant"),
    content: MessageContentSchema,
    tool_calls: z.array(ToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content: MessageContentSchema,
    tool_call_id: IdSchema,
  }),
]);

const ToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: IdSchema,
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }),
});

export const OpenAICompletionsRequestSchema = z.object({
  model: IdSchema,
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolSchema).optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), LooseObjectSchema]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  response_format: LooseObjectSchema.optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

export type OpenAICompletionsRequest = z.output<typeof OpenAICompletionsRequestSchema>;

export function parseOpenAICompletions(input: unknown): OpenAICompletionsRequest {
  return OpenAICompletionsRequestSchema.parse(input);
}
