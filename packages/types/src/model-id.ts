import { z } from 'zod';

export const IdSchema = z.string().min(1);
export const ModelIdSchema = IdSchema.describe('Upstream model id exposed by a provider.');

export type ModelIdInput = z.input<typeof ModelIdSchema>;
export type ModelId = z.output<typeof ModelIdSchema>;
