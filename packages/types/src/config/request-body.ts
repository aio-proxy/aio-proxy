import { z } from 'zod';

export const DEFAULT_REQUEST_BODY_MAX_BYTES = 268435456;
export const MAX_REQUEST_BODY_MAX_BYTES = 536870912;

export const ServerRequestBodySchema = z.object({
  maxBytes: z
    .number()
    .int()
    .min(1048576)
    .max(MAX_REQUEST_BODY_MAX_BYTES)
    .default(DEFAULT_REQUEST_BODY_MAX_BYTES)
    .describe('Maximum encoded and decoded bytes for ordinary inbound request bodies.'),
});
