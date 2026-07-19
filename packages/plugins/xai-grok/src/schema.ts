import { zod } from "@aio-proxy/plugin-sdk";

export const credentialSchema = zod.object({
  accessToken: zod.string().min(1),
  refreshToken: zod.string().min(1),
  expiresAt: zod.number(),
  email: zod.string().min(1).optional(),
  subject: zod.string().min(1).optional(),
});

export type XAIGrokCredential = zod.infer<typeof credentialSchema>;
