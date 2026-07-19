import { z } from "zod";

import { IdSchema } from "./common";
import { UsageRowSchema } from "./usage";

const AioContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    image: z.string(),
    mediaType: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: IdSchema,
    toolName: IdSchema,
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: IdSchema,
    toolName: IdSchema,
    output: z.unknown(),
  }),
]);

export const AioModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(AioContentPartSchema)]),
});

export const AioStreamPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    messageId: IdSchema.optional(),
  }),
  z.object({
    type: z.literal("text-delta"),
    textDelta: z.string(),
  }),
  z.object({
    type: z.literal("finish"),
    usage: UsageRowSchema.optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

export type AioModelMessageInput = z.input<typeof AioModelMessageSchema>;
export type AioModelMessage = z.output<typeof AioModelMessageSchema>;
export type AioStreamPartInput = z.input<typeof AioStreamPartSchema>;
export type AioStreamPart = z.output<typeof AioStreamPartSchema>;
