import { z } from "zod";
import { IdSchema } from "./common";

const TokenCountSchema = z.number().int().min(0);

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  cacheReadTokens: TokenCountSchema.optional(),
  cacheWriteTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  priceModelId: IdSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
});

export type UsageRowInput = z.input<typeof UsageRowSchema>;
export type UsageRow = z.output<typeof UsageRowSchema>;
