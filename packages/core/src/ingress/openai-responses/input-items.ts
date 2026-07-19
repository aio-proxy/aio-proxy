import { z } from "zod";

import { openAIResponsesToolSchema } from "./tools";

const idSchema = z.string().min(1);

const textPartSchema = z
  .object({
    type: z.enum(["input_text", "output_text", "text"]),
    text: z.string(),
    annotations: z.unknown().optional(),
    logprobs: z.unknown().optional(),
  })
  .passthrough();

const inputImagePartSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  })
  .passthrough();

const inputFilePartSchema = z
  .object({
    type: z.literal("input_file"),
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();

const messageContentPartSchema = z.union([textPartSchema, inputImagePartSchema, inputFilePartSchema]);
const messageContentSchema = z.union([z.string(), z.array(messageContentPartSchema).min(1)]);

const inputMessageSchema = z.object({
  type: z.literal("message").optional(),
  id: idSchema.optional(),
  status: z.string().optional(),
  phase: z.string().optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
});

const toolOutputContentPartSchema = z.union([textPartSchema, inputImagePartSchema, inputFilePartSchema]);

const functionCallItemSchema = z.object({
  type: z.literal("function_call"),
  call_id: idSchema,
  name: idSchema,
  namespace: idSchema.optional(),
  arguments: z.string(),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: idSchema,
  output: z.union([z.string(), z.array(toolOutputContentPartSchema).min(1)]),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const customToolCallItemSchema = z.object({
  type: z.literal("custom_tool_call"),
  call_id: idSchema,
  name: idSchema,
  input: z.string(),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const customToolCallOutputItemSchema = z.object({
  type: z.literal("custom_tool_call_output"),
  call_id: idSchema,
  output: z.union([z.string(), z.array(toolOutputContentPartSchema).min(1)]),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const reasoningItemSchema = z.object({
  type: z.literal("reasoning"),
  id: idSchema.optional(),
  status: z.string().optional(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(
    z.object({
      type: z.literal("summary_text"),
      text: z.string(),
    }),
  ),
});

const itemReferenceSchema = z.object({
  type: z.literal("item_reference"),
  id: idSchema,
});

const additionalToolsItemSchema = z.object({
  type: z.literal("additional_tools"),
  role: z.literal("developer"),
  tools: z.array(openAIResponsesToolSchema),
});

const agentMessageContentPartSchema = z.union([
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("encrypted_content"), encrypted_content: z.string() }),
]);

const agentMessageItemSchema = z.object({
  type: z.literal("agent_message"),
  id: idSchema.optional(),
  author: idSchema,
  recipient: idSchema,
  content: z.array(agentMessageContentPartSchema).min(1),
});

export const knownOpenAIResponsesInputItemTypes = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "item_reference",
  "additional_tools",
  "agent_message",
]);

export const openAIResponsesInputItemSchema = z.union([
  inputMessageSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  customToolCallItemSchema,
  customToolCallOutputItemSchema,
  reasoningItemSchema,
  itemReferenceSchema,
  additionalToolsItemSchema,
  agentMessageItemSchema,
]);

export type OpenAIResponsesInputMessage = z.output<typeof inputMessageSchema>;
export type OpenAIResponsesInputItem =
  | z.output<typeof openAIResponsesInputItemSchema>
  | OpenAIResponsesUnsupportedInputItem;
export type OpenAIResponsesTextPart = z.output<typeof textPartSchema>;
export type OpenAIResponsesToolOutputPart = z.output<typeof toolOutputContentPartSchema>;
export type OpenAIResponsesUnsupportedInputItem = {
  readonly type: "__aio_proxy_unsupported__";
  readonly wireType: string;
};
