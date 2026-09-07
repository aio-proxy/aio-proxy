import { zod } from '@aio-proxy/plugin-sdk';

export const credentialSchema = zod.object({
  apiKey: zod.string().min(1),
  userId: zod.string().min(1).optional(),
});

export type OpenRouterCredential = zod.infer<typeof credentialSchema>;
