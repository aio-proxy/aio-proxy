import { zod } from '@aio-proxy/plugin-sdk';

export const credentialSchema = zod.object({
  oauthAccessToken: zod.string().min(1),
  apiKey: zod.string().min(1),
  email: zod.string().min(1).optional(),
  accountId: zod.string().min(1).optional(),
});

export type MuseCodeCredential = zod.infer<typeof credentialSchema>;
