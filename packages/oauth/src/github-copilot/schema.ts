import { z } from "zod";

export type CopilotTransport = "chat" | "messages" | "responses";

export const deviceCodeResponseSchema = z
  .object({
    device_code: z.string(),
    expires_in: z.number().default(900),
    interval: z.number().default(5),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string().optional(),
  })
  .transform((body) => ({
    deviceCode: body.device_code,
    expiresIn: body.expires_in,
    interval: body.interval,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
  }));

export const githubTokenResponseSchema = z.object({
  access_token: z.string().optional(),
  error: z.string().optional(),
});

export const copilotTokenResponseSchema = z.object({
  expires_at: z.number().optional(),
  token: z.string(),
});

export const githubUserResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  login: z.string().optional(),
});

export const modelsResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
});

const endpointSchema = z.unknown().transform((endpoint) => {
  return typeof endpoint === "string" ? endpoint : (JSON.stringify(endpoint) ?? "");
});

export const copilotModelSchema = z.object({
  capabilities: z.array(z.unknown()).optional(),
  endpoints: z.array(endpointSchema),
  id: z.string(),
  model_picker_enabled: z.boolean().optional(),
  name: z.string().optional(),
});
