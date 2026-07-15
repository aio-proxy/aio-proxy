import { zod } from "@aio-proxy/plugin-sdk";

export const tokenResponseSchema = zod
  .object({
    access_token: zod.string(),
    expires_in: zod.number().optional(),
    id_token: zod.string().optional(),
    refresh_token: zod.string(),
  })
  .loose();

export const refreshTokenResponseSchema = tokenResponseSchema.extend({
  refresh_token: zod.string().optional(),
});

export type ChatGPTCredential = {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAt: number;
  readonly refreshToken: string;
};
