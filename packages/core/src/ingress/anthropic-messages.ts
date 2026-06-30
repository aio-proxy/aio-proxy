import { z } from "zod";

const IdSchema = z.string().min(1);

const CacheControlSchema = z.object({
  type: z.literal("ephemeral"),
  ttl: z.enum(["5m", "1h"]).optional(),
});

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControlSchema.optional(),
});

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: IdSchema,
  name: IdSchema,
  input: z.unknown(),
  cache_control: CacheControlSchema.optional(),
});

const ToolResultTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: IdSchema.optional(),
    content: z.union([z.string(), z.array(ToolResultTextBlockSchema)]),
    cache_control: CacheControlSchema.optional(),
  })
  .superRefine((block, ctx) => {
    if (block.tool_use_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["tool_use_id"],
        message: "Required",
      });
    }
  })
  .pipe(
    z.object({
      type: z.literal("tool_result"),
      tool_use_id: IdSchema,
      content: z.union([z.string(), z.array(ToolResultTextBlockSchema)]),
      cache_control: CacheControlSchema.optional(),
    }),
  );

const ThinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: IdSchema,
    cache_control: z.unknown().optional(),
  })
  .superRefine((block, ctx) => {
    if (block.cache_control !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["cache_control"],
        message: "Thinking blocks cannot include cache_control",
      });
    }
  })
  .pipe(
    z.object({
      type: z.literal("thinking"),
      thinking: z.string(),
      signature: IdSchema,
    }),
  );

const UserContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolResultBlockSchema,
]);

const AssistantContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ThinkingBlockSchema,
]);

const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(UserContentBlockSchema)]),
});

const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([z.string(), z.array(AssistantContentBlockSchema)]),
});

export const AnthropicMessagesRequestSchema = z.object({
  model: IdSchema,
  system: z.union([z.string(), z.array(TextBlockSchema)]).optional(),
  messages: z
    .array(
      z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema]),
    )
    .min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});

export type AnthropicCacheControl = z.infer<typeof CacheControlSchema>;
export type AnthropicTextBlock = z.infer<typeof TextBlockSchema>;
export type AnthropicToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type AnthropicToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type AnthropicThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type AnthropicUserContentBlock = z.infer<typeof UserContentBlockSchema>;
export type AnthropicAssistantContentBlock = z.infer<
  typeof AssistantContentBlockSchema
>;
export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

export function parseAnthropicMessages(
  input: unknown,
): AnthropicMessagesRequest {
  return AnthropicMessagesRequestSchema.parse(input);
}
