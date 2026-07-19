import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";

const IdSchema = z.string().min(1);
const MetadataSchema = z
  .object({
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
  })
  .catchall(z.unknown());

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

const UserContentBlockSchema = z.discriminatedUnion("type", [TextBlockSchema, ToolResultBlockSchema]);

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

const FunctionToolSchema = z.object({
  type: z.undefined().optional(),
  name: IdSchema,
  description: z.string().optional(),
  input_schema: z
    .object({
      type: z.literal("object"),
    })
    .catchall(z.unknown()),
}) satisfies z.ZodType<{
  name: Tool["name"];
  description?: Tool["description"] | undefined;
  input_schema: Tool["input_schema"];
}>;

const WebSearchToolSchema = z
  .object({
    type: z.enum(["web_search_20250305", "web_search_20260209", "web_search_20260318"]),
    name: z.literal("web_search"),
    max_uses: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? undefined),
    allowed_domains: z
      .array(IdSchema)
      .nullish()
      .transform((value) => value ?? undefined),
    blocked_domains: z
      .array(IdSchema)
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .superRefine((tool, context) => {
    if ((tool.allowed_domains?.length ?? 0) > 0 && (tool.blocked_domains?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["blocked_domains"],
        message: "allowed_domains and blocked_domains cannot both be non-empty",
      });
    }
  });

const ToolSchema = z.union([FunctionToolSchema, WebSearchToolSchema]);

const ThinkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("disabled") }),
  z.object({ type: z.literal("enabled"), budget_tokens: z.number().int() }),
  z.object({ type: z.literal("adaptive") }),
]);

const OutputConfigSchema = z.object({ effort: z.enum(["low", "medium", "high", "max"]).optional() }).loose();

export const AnthropicMessagesRequestSchema = z.object({
  model: IdSchema,
  system: z.union([z.string(), z.array(TextBlockSchema)]).optional(),
  messages: z.array(z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema])).min(1),
  metadata: MetadataSchema.optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  thinking: ThinkingSchema.optional(),
  output_config: OutputConfigSchema.optional(),
  tools: z.array(ToolSchema).optional(),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});

export type AnthropicCacheControl = z.output<typeof CacheControlSchema>;
export type AnthropicTextBlock = z.output<typeof TextBlockSchema>;
export type AnthropicToolUseBlock = z.output<typeof ToolUseBlockSchema>;
export type AnthropicToolResultBlock = z.output<typeof ToolResultBlockSchema>;
export type AnthropicThinkingBlock = z.output<typeof ThinkingBlockSchema>;
export type AnthropicFunctionTool = z.output<typeof FunctionToolSchema>;
export type AnthropicWebSearchTool = z.output<typeof WebSearchToolSchema>;
export type AnthropicUserContentBlock = z.output<typeof UserContentBlockSchema>;
export type AnthropicAssistantContentBlock = z.output<typeof AssistantContentBlockSchema>;
export type AnthropicMessagesRequest = z.output<typeof AnthropicMessagesRequestSchema>;

export function parseAnthropicMessages(input: unknown): AnthropicMessagesRequest {
  return AnthropicMessagesRequestSchema.parse(input);
}
