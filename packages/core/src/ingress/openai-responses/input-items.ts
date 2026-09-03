import { z } from 'zod';

import { openAIResponsesToolSchema } from './tools';

const idSchema = z.string().min(1);

const textPartSchema = z
  .object({
    type: z.enum(['input_text', 'output_text', 'text']),
    text: z.string(),
    annotations: z.unknown().optional(),
    logprobs: z.unknown().optional(),
  })
  .loose();

const inputImagePartSchema = z
  .object({
    type: z.literal('input_image'),
    image_url: z.string().optional(),
    file_id: idSchema.optional(),
    // Clients may send image detail hints outside the documented set
    // (e.g. Codex sends `original`). Detail is a best-effort hint that
    // downstream transforms already drop when unrecognized, so coerce
    // unknown values to undefined instead of rejecting the whole request.
    detail: z.enum(['auto', 'low', 'high']).optional().catch(undefined),
  })
  .loose()
  .superRefine((part, context) => {
    if ((part.image_url === undefined ? 0 : 1) + (part.file_id === undefined ? 0 : 1) !== 1) {
      context.addIssue({ code: 'custom', message: 'Expected exactly one image source' });
    }
  });

const inputFilePartSchema = z
  .object({
    type: z.literal('input_file'),
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  })
  .loose();

const messageContentPartSchema = z.union([textPartSchema, inputImagePartSchema, inputFilePartSchema]);
const messageContentSchema = z.union([z.string(), z.array(messageContentPartSchema).min(1)]);

const inputMessageSchema = z.object({
  type: z.literal('message').optional(),
  id: idSchema.optional(),
  status: z.string().optional(),
  phase: z.string().optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: messageContentSchema,
});

const encryptedContentPartSchema = z.object({
  type: z.literal('encrypted_content'),
  encrypted_content: z.string(),
});

// codex-rs FunctionCallOutputContentItem also carries encrypted_content, which
// raw passthrough must preserve; the model path already drops it.
const toolOutputContentPartSchema = z.union([
  textPartSchema,
  inputImagePartSchema,
  inputFilePartSchema,
  encryptedContentPartSchema,
]);

const functionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: idSchema,
  name: idSchema,
  namespace: idSchema.optional(),
  arguments: z.string(),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: idSchema,
  output: z.union([z.string(), z.array(toolOutputContentPartSchema).min(1)]),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const webSearchCallItemSchema = z
  .object({
    type: z.literal('web_search_call'),
    id: idSchema.optional(),
    status: z.string().optional(),
    action: z.unknown().optional(),
    results: z.unknown().optional(),
  })
  .loose();

const customToolCallItemSchema = z.object({
  type: z.literal('custom_tool_call'),
  call_id: idSchema,
  name: idSchema,
  namespace: idSchema.optional(),
  input: z.string(),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const customToolCallOutputItemSchema = z.object({
  type: z.literal('custom_tool_call_output'),
  call_id: idSchema,
  output: z.union([z.string(), z.array(toolOutputContentPartSchema).min(1)]),
  id: idSchema.optional(),
  status: z.string().optional(),
});

const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  id: idSchema.optional(),
  status: z.string().optional(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(
    z.object({
      type: z.literal('summary_text'),
      text: z.string(),
    }),
  ),
});

const itemReferenceSchema = z.object({
  type: z.literal('item_reference'),
  id: idSchema,
});

const additionalToolsItemSchema = z.object({
  type: z.literal('additional_tools'),
  role: z.literal('developer'),
  tools: z.array(openAIResponsesToolSchema),
});

const agentMessageContentPartSchema = z.union([
  z.object({ type: z.literal('input_text'), text: z.string() }),
  encryptedContentPartSchema,
]);

const agentMessageItemSchema = z.object({
  type: z.literal('agent_message'),
  id: idSchema.optional(),
  author: idSchema,
  recipient: idSchema,
  content: z.array(agentMessageContentPartSchema).min(1),
});

export const knownOpenAIResponsesInputItemTypes = new Set([
  'message',
  'function_call',
  'function_call_output',
  'web_search_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'reasoning',
  'item_reference',
  'additional_tools',
  'agent_message',
]);

export const openAIResponsesInputItemSchema = z.union([
  inputMessageSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  webSearchCallItemSchema,
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
  readonly type: '__aio_proxy_unsupported__';
  readonly wireType: string;
};
