import { z } from "zod";
import { IdSchema } from "./common";
import { UsageRowSchema } from "./usage";

const TraceBaseSchema = z.object({
  traceId: IdSchema,
  timestamp: z.string().datetime(),
});

export const TraceEventSchema = z.discriminatedUnion("type", [
  TraceBaseSchema.extend({
    type: z.literal("start"),
    providerId: IdSchema,
    modelId: IdSchema,
  }),
  TraceBaseSchema.extend({
    type: z.literal("delta"),
    textDelta: z.string(),
  }),
  TraceBaseSchema.extend({
    type: z.literal("end"),
    usage: UsageRowSchema.optional(),
  }),
  TraceBaseSchema.extend({
    type: z.literal("error"),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

export type TraceEventInput = z.input<typeof TraceEventSchema>;
export type TraceEvent = z.output<typeof TraceEventSchema>;
