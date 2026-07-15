import { type ProtocolId, zod } from "@aio-proxy/plugin-sdk";

export type CopilotProtocol = Exclude<ProtocolId, "gemini">;

export const deviceCodeResponseSchema = zod
  .object({
    device_code: zod.string(),
    expires_in: zod.number().default(900),
    interval: zod.number().default(5),
    user_code: zod.string(),
    verification_uri: zod.string(),
    verification_uri_complete: zod.string().optional(),
  })
  .transform((body) => ({
    deviceCode: body.device_code,
    expiresIn: body.expires_in,
    interval: body.interval,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
  }));

export const githubTokenResponseSchema = zod.object({
  access_token: zod.string().optional(),
  error: zod.string().optional(),
});

export const copilotTokenResponseSchema = zod.object({
  expires_at: zod.number().optional(),
  token: zod.string(),
});

export const githubUserResponseSchema = zod.object({
  id: zod.union([zod.number(), zod.string()]),
  login: zod.string().optional(),
});

export const modelsResponseSchema = zod.object({
  data: zod.array(zod.unknown()).default([]),
});

const endpointSchema = zod.unknown().transform((endpoint) => {
  return typeof endpoint === "string" ? endpoint : (JSON.stringify(endpoint) ?? "");
});

const capabilitiesSchema = zod.unknown().transform((capabilities) => {
  if (Array.isArray(capabilities)) return capabilities.includes("chat");
  if (typeof capabilities === "object" && capabilities !== null && "type" in capabilities) {
    return capabilities.type === "chat";
  }
  return undefined;
});

export const copilotModelSchema = zod
  .object({
    capabilities: capabilitiesSchema.optional(),
    endpoints: zod.array(endpointSchema).optional().default([]),
    id: zod.string(),
    model_picker_enabled: zod.boolean().optional(),
    name: zod.string().optional(),
    supported_endpoints: zod.array(endpointSchema).optional().default([]),
  })
  .transform(({ supported_endpoints, name, ...model }) => ({
    ...model,
    displayName: name,
    endpoints: [...model.endpoints, ...supported_endpoints],
  }));
