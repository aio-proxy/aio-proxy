import { z } from "zod";

export const IdSchema = z.string().min(1);

export const ModelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    alias: IdSchema,
    id: IdSchema,
  }),
]);

export type ModelEntryInput = z.input<typeof ModelEntrySchema>;
export type ModelEntry = z.output<typeof ModelEntrySchema>;
