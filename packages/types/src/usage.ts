import { z } from "zod";
import { IdSchema } from "./common";

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});

export type UsageRowInput = z.input<typeof UsageRowSchema>;
export type UsageRow = z.output<typeof UsageRowSchema>;
