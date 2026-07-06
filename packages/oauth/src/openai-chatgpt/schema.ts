import { z } from "zod";

import type { OAuthLoginPayload, OAuthProviderModel } from "../oauth-provider";

export const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number().optional(),
    id_token: z.string().optional(),
    refresh_token: z.string(),
  })
  .loose();

export type TokenResponse = z.output<typeof tokenResponseSchema>;

export type ChatGPTModel = OAuthProviderModel;

export type ChatGPTPayload = OAuthLoginPayload & {
  readonly accountId: string;
  readonly models: readonly ChatGPTModel[];
};
