import { z } from 'zod';

const CodexModelBaseSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  priority: z.number(),
  supported_in_api: z.boolean(),
  visibility: z.string(),
});

// Upstream items carry many rich fields (base_instructions, model_messages, ...);
// keep them via loose() so Case A can pass the item through verbatim.
export const CodexUpstreamModelSchema = CodexModelBaseSchema.loose();

export type CodexUpstreamModel = z.infer<typeof CodexUpstreamModelSchema>;

// Pick from the non-loose base: picking from a loose() schema inherits its
// catchall and would retain unknown keys, defeating the lean projection.
export const CodexLeanModelSchema = CodexModelBaseSchema.pick({
  slug: true,
  display_name: true,
  priority: true,
  supported_in_api: true,
  visibility: true,
});

export type CodexLeanModel = z.infer<typeof CodexLeanModelSchema>;
