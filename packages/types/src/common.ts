import { z } from "zod";

export const IdSchema = z.string().min(1);
export const ModelIdSchema = IdSchema.describe("Upstream model id exposed by a provider.");

const AliasTargetObjectSchema = z.object({
  model: ModelIdSchema.describe("Default upstream model id for this alias target."),
  preserve: z.boolean().default(false).describe("Expose the target model under its original id as well."),
});

export const AliasTargetSchema = z
  .union([ModelIdSchema, AliasTargetObjectSchema])
  .transform((value) => (typeof value === "string" ? { model: value, preserve: false } : value));

export const AliasConfigSchema = z
  .union([
    ModelIdSchema,
    AliasTargetObjectSchema.extend({
      variants: z.record(z.string().min(1), AliasTargetSchema).optional(),
    }),
  ])
  .transform((value) => (typeof value === "string" ? { model: value, preserve: false } : value));

export type ModelIdInput = z.input<typeof ModelIdSchema>;
export type ModelId = z.output<typeof ModelIdSchema>;
export type AliasTargetInput = z.input<typeof AliasTargetSchema>;
export type AliasTarget = z.output<typeof AliasTargetSchema>;
export type AliasConfigInput = z.input<typeof AliasConfigSchema>;
export type AliasConfig = z.output<typeof AliasConfigSchema>;
