import { z } from 'zod';

import { ModalitySchema } from '../model-metadata';

export const AGENT_ACCESS_TOKEN_PREFIX = 'aio_agent_at_v1_';
export const AGENT_REFRESH_TOKEN_PREFIX = 'aio_agent_rt_v1_';
export const AgentTargetSchema = z.enum(['opencode', 'pi', 'omp']);
export type AgentTarget = z.output<typeof AgentTargetSchema>;

export const AGENT_CLIENT_ID = {
  opencode: 'aio-proxy-opencode',
  pi: 'aio-proxy-pi',
  omp: 'aio-proxy-omp',
} as const satisfies Record<AgentTarget, string>;

const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
const isIpv4Address = (host: string): boolean => {
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
};

const LoopbackEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    (host === 'localhost' || host === '::1' || (isIpv4Address(host) && host.split('.')[0] === '127'))
  );
}, 'Agent endpoint must be an HTTP loopback URL');

export const AgentManagedMarkerSchema = z.strictObject({
  format: z.literal(1),
  managedBy: z.literal('aio-proxy'),
  agent: AgentTargetSchema,
  installationId: z.uuid(),
  adapterVersion: SemverSchema,
  endpoint: LoopbackEndpointSchema,
});
export type AgentManagedMarker = z.output<typeof AgentManagedMarkerSchema>;

export const AgentCatalogModelV1Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  temperature: z.boolean(),
  attachment: z.boolean(),
  input: z.array(ModalitySchema),
  context_window: z.number().int().positive().nullable(),
  max_output_tokens: z.number().int().positive().nullable(),
});
export const AgentCatalogV1Schema = z.strictObject({
  schema_version: z.literal(1),
  agent: AgentTargetSchema,
  models: z.array(AgentCatalogModelV1Schema),
});
export type AgentCatalogV1 = z.output<typeof AgentCatalogV1Schema>;
export const AgentCatalogErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }),
  supported_schema_versions: z.array(z.number().int().positive()).optional(),
});
export type AgentCatalogError = z.output<typeof AgentCatalogErrorSchema>;

export const AgentAdapterFailureSchema = z.enum([
  'network',
  'unauthorized',
  'server_error',
  'invalid_json',
  'invalid_catalog',
  'unsupported_schema',
]);
export type AgentAdapterFailure = z.output<typeof AgentAdapterFailureSchema>;
export const AgentManagedStateV1Schema = z
  .strictObject({
    format: z.literal(1),
    catalogSchema: z.literal(1),
    status: z.enum(['fresh', 'stale', 'missing']),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    lastError: AgentAdapterFailureSchema.nullable(),
    lkg: AgentCatalogV1Schema.nullable(),
  })
  .superRefine((state, context) => {
    const valid =
      state.status === 'fresh'
        ? state.lkg !== null && state.lastSuccessfulAt !== null && state.lastError === null
        : state.status === 'stale'
          ? state.lkg !== null && state.lastSuccessfulAt !== null && state.lastError !== null
          : state.lkg === null && state.lastSuccessfulAt === null;
    if (!valid) context.addIssue({ code: 'custom', message: 'inconsistent Agent managed state' });
  });
export type AgentManagedStateV1 = z.output<typeof AgentManagedStateV1Schema>;

export const AgentTokenResponseSchema = z.strictObject({
  token_type: z.literal('Bearer'),
  access_token: z.string().regex(/^aio_agent_at_v1_[A-Za-z0-9_-]{43}$/u),
  refresh_token: z.string().regex(/^aio_agent_rt_v1_[A-Za-z0-9_-]{43}$/u),
  expires_in: z.literal(900),
});
export type AgentTokenResponse = z.output<typeof AgentTokenResponseSchema>;

export function hasReservedAgentTokenPrefix(value: string): boolean {
  return value.startsWith('aio_agent_at_') || value.startsWith('aio_agent_rt_');
}

export const AgentCatalogQuerySchema = z.strictObject({
  agent: AgentTargetSchema,
  adapter_version: SemverSchema,
  schema_version: z.literal('1'),
});

const AgentClientIdSchema = z.enum(['aio-proxy-opencode', 'aio-proxy-pi', 'aio-proxy-omp']);
export const AgentDeviceCodeRequestSchema = z.strictObject({
  client_id: AgentClientIdSchema,
  agent: AgentTargetSchema,
  installation_id: z.uuid(),
  adapter_version: SemverSchema,
});
export type AgentDeviceCodeRequest = z.output<typeof AgentDeviceCodeRequestSchema>;
export const AgentDeviceCodeResponseSchema = z.strictObject({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  user_code: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.literal(600),
  interval: z.literal(5),
});
export type AgentDeviceCodeResponse = z.output<typeof AgentDeviceCodeResponseSchema>;
export const AgentTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.strictObject({
    grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    client_id: AgentClientIdSchema,
    device_code: z.string().min(1),
  }),
  z.strictObject({
    grant_type: z.literal('refresh_token'),
    client_id: AgentClientIdSchema,
    refresh_token: z.string().min(1),
  }),
]);
export type AgentTokenRequest = z.output<typeof AgentTokenRequestSchema>;
export const AgentOAuthErrorSchema = z.strictObject({
  error: z.enum([
    'authorization_pending',
    'slow_down',
    'access_denied',
    'expired_token',
    'invalid_client',
    'invalid_grant',
    'authorization_unavailable',
    'invalid_request',
    'rate_limited',
    'capacity_exceeded',
  ]),
  error_description: z.string().min(1).optional(),
});
export type AgentOAuthError = z.output<typeof AgentOAuthErrorSchema>;

export const AgentAuthorizationResolveRequestSchema = z.strictObject({ userCode: z.string().min(1) });
const AgentAuthorizationPendingSchema = z.strictObject({
  status: z.literal('pending'),
  deviceId: z.uuid(),
  target: AgentTargetSchema,
  installationId: z.uuid(),
  adapterVersion: SemverSchema,
  expiresAt: z.iso.datetime(),
  permissions: z.tuple([z.literal('catalog'), z.literal('inference')]),
});
export const AgentAuthorizationDetailsSchema = z.discriminatedUnion('status', [
  AgentAuthorizationPendingSchema,
  z.strictObject({ status: z.literal('approved') }),
  z.strictObject({ status: z.literal('denied') }),
  z.strictObject({ status: z.literal('consumed') }),
  z.strictObject({ status: z.literal('expired') }),
]);
export type AgentAuthorizationDetails = z.output<typeof AgentAuthorizationDetailsSchema>;
export const AgentAuthorizationDecisionResponseSchema = z.strictObject({
  status: z.enum(['approved', 'denied', 'expired', 'consumed']),
});
export const AgentInstallationSummarySchema = z.strictObject({
  installationId: z.uuid(),
  target: AgentTargetSchema,
  adapterVersion: SemverSchema,
  createdAt: z.iso.datetime(),
  lastAuthorizedAt: z.iso.datetime(),
  authorization: z.enum(['active', 'expired', 'revoked']),
  accessExpiresAt: z.iso.datetime().nullable(),
});
export type AgentInstallationSummary = z.output<typeof AgentInstallationSummarySchema>;
export const AgentAdminSnapshotSchema = z.strictObject({
  installations: z.array(AgentInstallationSummarySchema),
  deviceAuthorization: z.enum(['available', 'password_required']),
  catalogSchemaVersions: z.tuple([z.literal(1)]),
});
export type AgentAdminSnapshot = z.output<typeof AgentAdminSnapshotSchema>;
export const AgentRevokeStatusSchema = z.enum(['revoked', 'expired', 'missing']);
export type AgentRevokeStatus = z.output<typeof AgentRevokeStatusSchema>;
export const AgentRevokeResponseSchema = z.strictObject({
  installationId: z.uuid(),
  status: AgentRevokeStatusSchema,
});
