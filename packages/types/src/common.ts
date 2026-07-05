import { z } from "zod";

export const IdSchema = z.string().min(1);

export const ModelEntrySchema = z.union([
  z.string().min(1).describe("Expose this upstream model id as-is."),
  z
    .object({
      alias: IdSchema.describe("Model name clients send to aio-proxy."),
      id: IdSchema.describe("Upstream model id sent to the provider."),
    })
    .passthrough()
    .describe("Expose an upstream model under a different client-facing alias."),
]);

export type ModelEntryInput = z.input<typeof ModelEntrySchema>;
export type ModelEntry = z.output<typeof ModelEntrySchema>;
